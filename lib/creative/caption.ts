import { z } from "zod";
import { COPY_CONVERSION_RULES, COPY_FORMULAS, COPY_MAX_FORMULAS, NO_PRICE_RULE, type CopyFormula } from "@/lib/constants/copy-formulas";
import { schema, type Db } from "@/db";
import { estimateCostUsd, type AiMessage, type AiProvider, type AiUsage } from "@/lib/ai/provider";
import { FOOD_CAPTION_INSTRUCTIONS, FOOD_COPY_CONVERSION_RULES, FOOD_COPY_FORMULAS, FOOD_COPY_STRUCTURE, FOOD_GENE_VALUE_LABEL, foodClaimProblems, type CreativeIndustry } from "@/lib/constants/creative-industry";
import { MODEL_BY_TIER } from "@/lib/ai/router";
import { tienAiHomNay, tranNgayUsd } from "@/lib/ai/budget";
import { xetTranNgay } from "@/lib/constants/ai-budget";
import { GENE_KEYS, GENE_LABEL, GENE_VALUE_LABEL, type Genes } from "@/lib/constants/creative-loop";
import { OPENAI_RESPONSES_URL, outputText, usageOf, type ResponsesBody } from "@/lib/creative/vision";
import { WRITER_LIMITS, clipWords, formatVnd, stripPrices, wrongPrices } from "@/lib/creative/writer";
import { env } from "@/lib/env";
import { assertHomeCredentials } from "@/lib/platform/credentials";

/**
 * ═══════════ CÂU CHỮ VIẾT THEO ẢNH ĐÃ SINH ═══════════
 *
 * Chủ shop 24/09/2026: *"Duyệt ảnh xong cần có phần soạn các thông tin sẵn để sẵn sàng đăng bài,
 * đăng camp ads như tiêu đề, content (AI suggest luôn sao cho phù hợp với ảnh đã sinh ra)."*
 *
 * `writer.ts` viết câu chữ TRƯỚC khi có ảnh — nó chỉ biết bản giao việc (gen + mã hàng). Máy vẽ ảnh
 * lại có ý riêng: bản giao việc nói "quán cà phê, tông ấm", ảnh ra có thể là góc phố tông lạnh. Câu
 * chữ khen "chiếc đầm đỏ" dưới một tấm ảnh đầm xanh là quảng cáo tự tố cáo mình. Nên câu chữ phải
 * được viết LẠI khi đã có ảnh, bởi một mô hình NHÌN thấy ảnh ấy.
 *
 * Hàm này là con đường duy nhất làm việc đó, dùng cho hai nơi:
 *  · đường sinh (`generate.ts`) — ngay sau khi ảnh được lưu, xin MỘT phương án;
 *  · nút "AI gợi ý theo ảnh" ở tab Duyệt lô — xin 2–3 phương án để người chọn (KHÔNG tự lưu).
 *
 * Gọi OpenAI Responses với `input_image` ĐÚNG cách `vision.ts` gọi (dùng lại bộ đọc phong bì của
 * nó): `AiProvider` của kho chỉ nhận khối chữ, thêm khối ảnh vào đó là sửa lớp provider cho mọi nơi
 * gọi chỉ để phục vụ một chỗ.
 *
 * ─── LUẬT GIÁ GIỮ NGUYÊN NHƯ `writer.ts` ───
 *
 * Mọi con số trông như giá phải BẰNG giá ERP (`wrongPrices`). Sai ⇒ viết lại MỘT lần kèm lý do;
 * vẫn sai ⇒ BỎ con số giá (`stripPrices`) — không đoán con số đúng thay mô hình. Không biết giá ⇒
 * không con số giá nào được đứng trên câu chữ.
 *
 * ─── LỖI TRẢ VỀ, KHÔNG NÉM ───
 *
 * Đường sinh gọi hàm này SAU khi đã tốn tiền vẽ ảnh: một lượt viết câu chữ hỏng không được làm mẫu
 * thành `GEN_FAILED` — mẫu vẫn còn câu chữ nháp của `writer.ts`. Nên mọi lỗi là `{ ok: false }`.
 */

export const CAPTION_ROUTE = "creative.caption";
/** Số phương án tối đa một lượt gợi ý. */
export const CAPTION_MAX_OPTIONS = 3;
const CAPTION_TIMEOUT_MS = 90_000;
const SEEN_MAX_CHARS = 300;

export type CaptionInput = {
  /** Điểm ảnh SẼ ĐƯỢC ĐĂNG — ảnh máy vừa sinh, hoặc ảnh mẫu tự làm. */
  image: { bytes: Uint8Array; contentType: string };
  product: { name: string; code: string; priceVnd: number | null };
  genes: Partial<Genes>;
  /** Câu chữ đang có (nháp của máy viết, hoặc câu người đã sửa). `null` = chưa có. */
  draft: { headline: string; primaryText: string } | null;
  winningExamples: { primaryText: string; headline: string }[];
  /**
   * Ghi chú về sản phẩm cho người viết — ô THIẾT KẾ MỚI (`DESIGN`) dùng để nói "đây là mẫu MỚI của shop,
   * mã TK-…" (chủ shop 24/09/2026). Không đổi luật giá: giá vẫn chỉ là `product.priceVnd`.
   */
  productNote?: string;
  /** Số phương án xin (1…3). Đường sinh xin 1; nút gợi ý xin 3. */
  options?: number;
  /**
   * Công thức content (chủ shop 29/09/2026) — có thì MỖI phương án theo đúng một công thức, theo thứ tự; số phương án = số công
   * thức (tối đa `COPY_MAX_FORMULAS`), bỏ qua `options`.
   */
  formulas?: CopyFormula[];
  /** KHÔNG ghi giá (chủ shop: "không để giá bán trên content") — mọi con số giá là lỗi, viết lại rồi bỏ. */
  noPrice?: boolean;
  /** Gói ngành (lib/constants/creative-industry.ts). Vắng = thời trang — câu lệnh của tổ chức nhà giữ nguyên từng chữ. */
  industry?: CreativeIndustry;
  /**
   * DỮ KIỆN SẢN PHẨM (thực phẩm): dòng "Nhãn: giá trị" từ field sản phẩm (quy cách, khối lượng tịnh, bảo quản…) + tên shop —
   * thứ DUY NHẤT câu chữ được dựa vào khi nói khối lượng / xuất xứ / chứng nhận (`foodClaimProblems`).
   */
  facts?: string[];
};

export type CaptionOption = { headline: string; primaryText: string; formula?: CopyFormula };

export type CaptionResult =
  | {
      ok: true;
      /** Phương án đầu — thứ đường sinh ghi vào mẫu. */
      headline: string;
      primaryText: string;
      options: CaptionOption[];
      /** Mô hình tả lại ảnh nó thấy — để người duyệt đối chiếu câu chữ với ảnh. */
      seen: string;
      model: string;
      /** `null` = CHƯA BIẾT (model chưa có trong bảng giá), không phải 0. */
      costUsd: number | null;
      attempts: number;
      /** Đã phải bỏ con số giá vì mô hình viết sai hai lần. */
      priceStripped: boolean;
    }
  | { ok: false; error: string };

export type CaptionDeps = {
  fetchImpl?: typeof fetch;
  /** Chỉ kiểm thử truyền. Bỏ trống ⇒ đọc `OPENAI_API_KEY`. */
  apiKey?: string;
  /** Bỏ trống ⇒ bậc `routine` của OpenAI. */
  model?: string;
  now?: Date;
  /** Mẫu đang được viết — chỉ để ghi sổ `ai_interactions`. */
  entityId?: string;
};

/** Tiền tố của `gen_error` trên một mẫu `GENERATED`: câu chữ vẫn là nháp viết TRƯỚC khi có ảnh. */
export const CAPTION_FALLBACK_PREFIX = "Câu chữ theo ảnh chưa viết được — đang dùng câu nháp: ";

/** Kiểu để TIÊM vào đường sinh và vào server action. */
export type VariantCaptioner = (db: Db, input: CaptionInput, deps: CaptionDeps) => Promise<CaptionResult>;

const CAPTION_INSTRUCTIONS = [
  "Bạn viết câu chữ quảng cáo Facebook (chiến dịch tin nhắn) cho một shop thời trang Việt Nam.",
  "Ảnh đính kèm là ĐÚNG ảnh sẽ được đăng. Câu chữ phải khớp với thứ NHÌN THẤY trong ảnh: màu sắc, kiểu dáng, bối cảnh, người mẫu, tư thế.",
  "Luật:",
  "- Không nhắc màu, chi tiết, phụ kiện hay bối cảnh KHÔNG có trong ảnh.",
  "- Không bịa chất liệu (cotton, lụa, linen, len…) trừ khi tên sản phẩm ghi rõ chất liệu đó.",
  "- Không bịa khuyến mãi, giảm giá, quà tặng, miễn phí vận chuyển, số khách đã mua, số lượng còn lại.",
  "- Nếu nhắc giá thì CHỈ dùng đúng giá được cung cấp. Không có giá thì KHÔNG viết con số giá nào.",
  "- Ảnh có chữ in sẵn thì câu chữ không được mâu thuẫn với chữ ấy.",
  "- Không nhắc thương hiệu khác, không chép câu chữ của đối thủ. Có thể mời khách nhắn tin để được tư vấn.",
  `- headline: tiếng Việt, tối đa ${WRITER_LIMITS.headlineMaxChars} ký tự. primaryText: tiếng Việt, tối đa ${WRITER_LIMITS.primaryTextMaxChars} ký tự.`,
  "- Các phương án phải khác nhau thật (cách mở đầu, điểm nhấn), không chỉ đổi vài chữ.",
  `seen: một câu tiếng Việt (tối đa ${SEEN_MAX_CHARS} ký tự) tả lại sản phẩm và bối cảnh bạn thấy trong ảnh.`,
].join("\n");

/** Lời dặn hệ thống theo ngành — thời trang là `CAPTION_INSTRUCTIONS` NGUYÊN VĂN. Hàm THUẦN. */
export function captionInstructionsFor(industry: CreativeIndustry | undefined): string {
  if (industry !== "FOOD") return CAPTION_INSTRUCTIONS;
  return [
    FOOD_CAPTION_INSTRUCTIONS,
    `- headline: tiếng Việt, tối đa ${WRITER_LIMITS.headlineMaxChars} ký tự. primaryText: tiếng Việt, tối đa ${WRITER_LIMITS.primaryTextMaxChars} ký tự.`,
    "- Các phương án phải khác nhau thật (cách mở đầu, điểm nhấn), không chỉ đổi vài chữ.",
    `seen: một câu tiếng Việt (tối đa ${SEEN_MAX_CHARS} ký tự) tả lại món ăn và bối cảnh bạn thấy trong ảnh.`,
  ].join("\n");
}

/** Chuỗi dữ kiện để soi khẳng định (tên + dòng dữ kiện + ghi chú). `null` = ngành không có luật khẳng định riêng. Hàm THUẦN. */
export function claimFactsOf(input: Pick<CaptionInput, "industry" | "facts" | "product" | "productNote">): string | null {
  if (input.industry !== "FOOD") return null;
  return [input.product.name, ...(input.facts ?? []), input.productNote ?? ""].join("\n");
}

export function captionJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["seen", "options"],
    properties: {
      seen: { type: "string" },
      options: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["headline", "primaryText"], properties: { headline: { type: "string" }, primaryText: { type: "string" } } },
      },
    },
  };
}

const CaptionJson = z.object({
  seen: z.string().default(""),
  options: z.array(z.object({ headline: z.string().trim(), primaryText: z.string().trim() })).min(1),
});
type CaptionJson = z.infer<typeof CaptionJson>;

/** Đọc câu trả lời (chịu được rào ```json). Hỏng hoặc không có phương án nào ⇒ `null`. */
export function parseCaptionAnswer(text: string): CaptionJson | null {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    const parsed = CaptionJson.safeParse(JSON.parse(text.slice(s, e + 1)));
    if (!parsed.success) return null;
    const options = parsed.data.options.filter((o) => o.primaryText.length > 0);
    return options.length ? { seen: parsed.data.seen.trim(), options } : null;
  } catch {
    return null;
  }
}

/** Những điều các phương án đang vi phạm — rỗng là đạt. */
export function captionProblems(options: CaptionOption[], priceVnd: number | null, claimFacts: string | null = null): string[] {
  const out: string[] = [];
  options.forEach((o, i) => {
    const n = `Phương án ${i + 1}`;
    if (claimFacts !== null) for (const c of foodClaimProblems(`${o.headline}\n${o.primaryText}`, claimFacts)) out.push(`${n}: ${c} — bỏ khẳng định ấy.`);
    if (o.headline.length > WRITER_LIMITS.headlineMaxChars) out.push(`${n}: headline dài ${o.headline.length} ký tự, tối đa ${WRITER_LIMITS.headlineMaxChars}.`);
    if (o.primaryText.length > WRITER_LIMITS.primaryTextMaxChars) out.push(`${n}: primaryText dài ${o.primaryText.length} ký tự, tối đa ${WRITER_LIMITS.primaryTextMaxChars}.`);
    for (const [field, text] of [["headline", o.headline], ["primaryText", o.primaryText]] as const) {
      const bad = wrongPrices(text, priceVnd);
      if (bad.length) out.push(`${n}: ${field} có con số giá "${bad.map((b) => b.raw).join('", "')}" ${priceVnd === null ? "trong khi giá chưa rõ — bỏ mọi con số giá" : `khác giá ERP ${formatVnd(priceVnd)}`}.`);
    }
  });
  return out;
}

/**
 * Chốt một phương án: bỏ con số giá sai, cắt ở ranh giới từ. Hàm thuần — dùng chung cho đường sinh,
 * nút gợi ý và bài kiểm.
 */
export function finalizeCaption(o: CaptionOption, priceVnd: number | null): CaptionOption & { priceStripped: boolean } {
  let priceStripped = false;
  const fix = (text: string) => {
    const bad = wrongPrices(text, priceVnd);
    if (!bad.length) return text;
    priceStripped = true;
    return stripPrices(text, bad);
  };
  return { headline: clipWords(fix(o.headline), WRITER_LIMITS.headlineMaxChars), primaryText: clipWords(fix(o.primaryText), WRITER_LIMITS.primaryTextMaxChars), priceStripped };
}

/**
 * Chốt danh sách phương án từ câu trả lời đã đọc — hàm THUẦN, dùng chung cho đường khoá của nhà và đường khoá của tổ chức.
 * Lượt viết lại vẫn sai giá ⇒ BỎ con số giá; vẫn dài ⇒ cắt ở ranh giới từ; trùng ⇒ bỏ bản sau. Thực phẩm: phương án còn
 * khẳng định BỊA (khối lượng, xuất xứ, sức khoẻ, chứng nhận…) sau lượt viết lại ⇒ BỎ CẢ PHƯƠNG ÁN — cắt một cụm khẳng định
 * ra giữa câu thì câu còn lại có thể nói ngược nghĩa, không vá hộ được như con số giá.
 */
export function pickCaptionOptions(parsed: CaptionJson, input: CaptionInput, n: number, priceVnd: number | null): { options: CaptionOption[]; priceStripped: boolean; claimDropped: number } {
  let priceStripped = false;
  let claimDropped = 0;
  const facts = claimFactsOf(input);
  const options: CaptionOption[] = [];
  for (const [i, o] of parsed.options.slice(0, n).entries()) {
    const f = finalizeCaption(o, priceVnd);
    priceStripped = priceStripped || f.priceStripped;
    if (!f.primaryText) continue;
    if (facts !== null && foodClaimProblems(`${f.headline}\n${f.primaryText}`, facts).length) {
      claimDropped += 1;
      continue;
    }
    if (options.some((x) => x.headline === f.headline && x.primaryText === f.primaryText)) continue;
    const formula = input.formulas?.[i];
    options.push({ headline: f.headline, primaryText: f.primaryText, ...(formula ? { formula } : {}) });
  }
  return { options, priceStripped, claimDropped };
}

export function briefOf(input: CaptionInput, priceVnd: number | null, n: number): string {
  const formulas = input.formulas?.length ? input.formulas.slice(0, n) : null;
  const food = input.industry === "FOOD";
  const formulaDefs = food ? FOOD_COPY_FORMULAS : COPY_FORMULAS;
  const geneLabel = (v: string) => (food ? (FOOD_GENE_VALUE_LABEL[v] ?? GENE_VALUE_LABEL[v]) : GENE_VALUE_LABEL[v]) ?? v;
  // Thực phẩm: gen "người mẫu" / "chữ trên ảnh" luôn là "không" — nhắc ra chỉ làm nhiễu người viết.
  const genes = GENE_KEYS.filter((k) => input.genes[k] && !(food && (k === "model" || k === "textOverlay")))
    .map((k) => `- ${GENE_LABEL[k]}: ${geneLabel(input.genes[k] as string)}`)
    .join("\n");
  const examples = input.winningExamples
    .slice(0, 3)
    .map((e, i) => `${i + 1}. Tiêu đề: ${e.headline}\n   Câu chữ: ${e.primaryText}`)
    .join("\n");
  return [
    `Viết ${n} phương án câu chữ cho ảnh quảng cáo đính kèm.`,
    formulas ? `MỖI phương án theo ĐÚNG một công thức, theo thứ tự:\n${formulas.map((f, i) => `${i + 1}. ${formulaDefs[f].label}: ${formulaDefs[f].instruction}`).join("\n")}` : "",
    formulas ? `Để tăng tỷ lệ nhấp và tỷ lệ nhắn tin:\n${food ? FOOD_COPY_CONVERSION_RULES : COPY_CONVERSION_RULES}` : "",
    food ? FOOD_COPY_STRUCTURE : "",
    `Sản phẩm: ${input.product.name} (mã ${input.product.code || "không rõ"})`,
    food
      ? `DỮ KIỆN SẢN PHẨM (shop tự khai — thứ DUY NHẤT được dùng cho khối lượng, quy cách, xuất xứ, bảo quản):\n${input.facts?.length ? input.facts.map((f) => `- ${f}`).join("\n") : "- (không có dữ kiện nào — KHÔNG viết khối lượng, quy cách, xuất xứ, chứng nhận)"}`
      : "",
    input.noPrice ? `Giá bán: KHÔNG GHI GIÁ.\n${NO_PRICE_RULE}` : `Giá bán ERP: ${priceVnd !== null ? formatVnd(priceVnd) : "KHÔNG RÕ — không được viết con số giá nào"}`,
    input.productNote ? input.productNote : "",
    genes ? `Ý đồ của mẫu (tham khảo — ảnh thật mới là căn cứ, ảnh khác ý đồ thì theo ảnh):\n${genes}` : "",
    input.draft && (input.draft.headline || input.draft.primaryText) ? `Câu chữ nháp viết TRƯỚC khi có ảnh (có thể không khớp ảnh — sửa theo ảnh):\nTiêu đề: ${input.draft.headline}\nCâu chữ: ${input.draft.primaryText}` : "",
    examples ? `Câu chữ của các mẫu đã thắng (tham khảo giọng văn, không chép nguyên văn):\n${examples}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const ZERO_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens };
}

async function logCaption(db: Db, row: { model: string; entityId: string; prompt: string; answer: string; usage: AiUsage; costUsd: number | null; latencyMs: number; rounds: number; status: "OK" | "ERROR"; error: string | null }) {
  try {
    await db.insert(schema.aiInteractions).values({
      userId: null,
      userEmail: "",
      provider: "openai",
      model: row.model,
      route: CAPTION_ROUTE,
      entityType: "creative_variant",
      entityId: row.entityId,
      // Không ghi điểm ảnh (base64) vào sổ — chỉ ghi bản giao việc bằng chữ.
      prompt: row.prompt.slice(0, 4000),
      answer: row.answer.slice(0, 8000),
      usage: row.usage,
      // Chuỗi rỗng = CHƯA BIẾT giá (mục 42), không phải 0.
      costUsd: row.costUsd === null ? "" : row.costUsd.toFixed(6),
      latencyMs: row.latencyMs,
      rounds: row.rounds,
      status: row.status,
      error: row.error,
    });
  } catch {
    // Sổ không ghi được thì câu chữ vẫn dùng được; trần ngày sẽ đếm thiếu lượt này.
  }
}

type InputItem = { role: "user" | "assistant"; content: Record<string, unknown>[] };

/**
 * Viết câu chữ theo ảnh. Trả `{ ok: false, error }` (tiếng Việt) khi thiếu khoá, chạm trần chi AI
 * ngày, OpenAI lỗi, hoặc hai lượt không ra nổi một phương án dùng được — KHÔNG ném.
 */
export async function captionFromImage(db: Db, input: CaptionInput, deps: CaptionDeps = {}): Promise<CaptionResult> {
  const now = deps.now ?? new Date();
  const model = deps.model ?? MODEL_BY_TIER.openai.routine;
  const entityId = deps.entityId ?? "";
  const n = input.formulas?.length ? Math.min(COPY_MAX_FORMULAS, input.formulas.length) : Math.max(1, Math.min(CAPTION_MAX_OPTIONS, Math.floor(input.options ?? 1)));
  // Không ghi giá ⇒ coi như KHÔNG BIẾT giá: mọi con số giá là lỗi (viết lại một lần, còn thì bỏ) — cùng luật `wrongPrices`.
  const priceVnd = !input.noPrice && input.product.priceVnd !== null && input.product.priceVnd > 0 ? Math.round(input.product.priceVnd) : null;
  const brief = briefOf(input, priceVnd, n);
  const started = Date.now();
  let usage = ZERO_USAGE;
  let usedModel = model;
  let lastAnswer = "";
  let attempts = 0;

  try {
    if (!input.image.bytes.length) return { ok: false, error: "Mẫu không có điểm ảnh để đọc." };
    // Khoá OpenAI trong môi trường là của tổ chức nhà (P12) — chặn trước khi đọc khoá.
    await assertHomeCredentials("openai");
    const apiKey = deps.apiKey ?? env.openaiRest.apiKey;
    if (!apiKey) return { ok: false, error: "Chưa có OPENAI_API_KEY trên máy chủ — không đọc được ảnh để viết câu chữ." };

    const [daTieu, tran] = await Promise.all([tienAiHomNay(now), tranNgayUsd()]);
    const vTran = xetTranNgay({ daTieu: daTieu.usd, tran });
    if (!vTran.choPhep) return { ok: false, error: vTran.ly };

    const doFetch = deps.fetchImpl ?? fetch;
    const imageUrl = `data:${input.image.contentType || "image/jpeg"};base64,${Buffer.from(input.image.bytes).toString("base64")}`;
    const conversation: InputItem[] = [
      {
        role: "user",
        content: [
          { type: "input_text", text: brief },
          { type: "input_image", image_url: imageUrl, detail: "low" },
        ],
      },
    ];
    let parsed: CaptionJson | null = null;
    let problems: string[] = [];

    for (attempts = 1; attempts <= 2; attempts += 1) {
      let res: Response;
      try {
        res = await doFetch(OPENAI_RESPONSES_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            instructions: captionInstructionsFor(input.industry),
            input: conversation,
            text: { format: { type: "json_schema", name: "creative_caption", strict: true, schema: captionJsonSchema() } },
            reasoning: { effort: "low" },
            max_output_tokens: 2500,
            // ERP tự giữ nhật ký; không lưu hội thoại phía OpenAI.
            store: false,
          }),
          signal: AbortSignal.timeout(CAPTION_TIMEOUT_MS),
        });
      } catch (e) {
        const error = `Không gọi được OpenAI: ${e instanceof Error ? e.message : String(e)}`;
        await logCaption(db, { model: usedModel, entityId, prompt: brief, answer: lastAnswer, usage, costUsd: estimateCostUsd(usedModel, usage), latencyMs: Date.now() - started, rounds: attempts, status: "ERROR", error });
        return { ok: false, error };
      }
      let body: ResponsesBody = {};
      try {
        body = (await res.json()) as ResponsesBody;
      } catch {
        body = {};
      }
      usage = addUsage(usage, usageOf(body));
      if (typeof body.model === "string" && body.model) usedModel = body.model;
      lastAnswer = outputText(body);
      if (!res.ok) {
        const apiMsg = (body as { error?: { message?: unknown } }).error?.message;
        const error = `OpenAI từ chối viết câu chữ (HTTP ${res.status})${typeof apiMsg === "string" ? `: ${apiMsg.slice(0, 300)}` : ""}.`;
        await logCaption(db, { model: usedModel, entityId, prompt: brief, answer: lastAnswer, usage, costUsd: estimateCostUsd(usedModel, usage), latencyMs: Date.now() - started, rounds: attempts, status: "ERROR", error });
        return { ok: false, error };
      }
      const got = parseCaptionAnswer(lastAnswer);
      problems = got ? captionProblems(got.options.slice(0, n), priceVnd, claimFactsOf(input)) : ["Câu trả lời không phải JSON đúng dạng {seen, options: [{headline, primaryText}]}."];
      if (got) parsed = got;
      if (problems.length === 0 || attempts === 2) break;
      conversation.push({ role: "assistant", content: [{ type: "output_text", text: lastAnswer || "(trống)" }] });
      conversation.push({ role: "user", content: [{ type: "input_text", text: `Viết lại, sửa đúng các lỗi sau và giữ nguyên mọi luật:\n- ${problems.join("\n- ")}` }] });
    }
    attempts = Math.min(attempts, 2);
    const costUsd = estimateCostUsd(usedModel, usage);

    if (!parsed) {
      await logCaption(db, { model: usedModel, entityId, prompt: brief, answer: lastAnswer, usage, costUsd, latencyMs: Date.now() - started, rounds: attempts, status: "ERROR", error: "Không đọc được JSON" });
      return { ok: false, error: "Mô hình không trả về câu chữ đúng dạng sau hai lượt." };
    }

    const { options, priceStripped } = pickCaptionOptions(parsed, input, n, priceVnd);
    if (!options.length) {
      await logCaption(db, { model: usedModel, entityId, prompt: brief, answer: lastAnswer, usage, costUsd, latencyMs: Date.now() - started, rounds: attempts, status: "ERROR", error: "Không còn phương án nào sau khi bỏ giá sai" });
      return { ok: false, error: "Mọi phương án đều rỗng sau khi bỏ con số giá sai." };
    }

    await logCaption(db, { model: usedModel, entityId, prompt: brief, answer: lastAnswer, usage, costUsd, latencyMs: Date.now() - started, rounds: attempts, status: "OK", error: null });
    return { ok: true, headline: options[0].headline, primaryText: options[0].primaryText, options, seen: parsed.seen.slice(0, SEEN_MAX_CHARS), model: usedModel, costUsd, attempts, priceStripped };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ───────────────────────────── KHOÁ CỦA TỔ CHỨC (BYOK) ─────────────────────────────

export type ProviderCaptionOutcome = { result: CaptionResult; usage: AiUsage; requests: number; model: string };

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

/**
 * Viết câu chữ theo ảnh bằng một `AiProvider` của TỔ CHỨC (ByokOpenAiProvider / ByokGeminiProvider — lib/ai-builder/providers.ts,
 * ảnh đi qua `AiRequest.images`). CÙNG bản giao việc (`briefOf`), CÙNG lời dặn theo ngành, CÙNG luật giá + luật khẳng định và
 * CÙNG phép chốt phương án (`pickCaptionOptions`) với đường của nhà — chỉ khác ĐƯỜNG GỬI. `guard` chạy trước MỖI lời gọi model
 * (chủ khoá + công tắc + hạn mức — lib/creative/org-ai.ts). Không ném: lỗi là `{ ok: false }`; số token / lời gọi trả kèm để nơi
 * gọi ghi sổ dùng AI của tổ chức.
 */
export async function captionFromImageWithProvider(input: CaptionInput, deps: { provider: AiProvider; guard: () => Promise<void> }): Promise<ProviderCaptionOutcome> {
  const n = input.formulas?.length ? Math.min(COPY_MAX_FORMULAS, input.formulas.length) : Math.max(1, Math.min(CAPTION_MAX_OPTIONS, Math.floor(input.options ?? 1)));
  const priceVnd = !input.noPrice && input.product.priceVnd !== null && input.product.priceVnd > 0 ? Math.round(input.product.priceVnd) : null;
  let usage = ZERO_USAGE;
  let model = deps.provider.model;
  let requests = 0;
  const done = (result: CaptionResult): ProviderCaptionOutcome => ({ result, usage, requests, model });
  if (!input.image.bytes.length) return done({ ok: false, error: "Mẫu không có điểm ảnh để đọc." });
  const mime = (IMAGE_MIMES as readonly string[]).includes(input.image.contentType) ? (input.image.contentType as (typeof IMAGE_MIMES)[number]) : "image/jpeg";
  const images = [{ mimeType: mime, data: Buffer.from(input.image.bytes).toString("base64") }];
  const system = `${captionInstructionsFor(input.industry)}\n\nTrả về DUY NHẤT một đối tượng JSON đúng dạng {"seen": "...", "options": [{"headline": "...", "primaryText": "..."}]} — không kèm chữ nào khác.`;
  const messages: AiMessage[] = [{ role: "user", content: [{ type: "text", text: briefOf(input, priceVnd, n) }] }];
  let parsed: CaptionJson | null = null;
  let attempts = 0;
  try {
    for (attempts = 1; attempts <= 2; attempts += 1) {
      await deps.guard();
      const res = await deps.provider.complete({ system, messages, tools: [], maxTokens: 2500, reasoning: "low", images });
      requests += 1;
      usage = addUsage(usage, res.usage);
      if (res.model) model = res.model;
      const text = res.content
        .filter((b): b is Extract<AiMessage["content"][number], { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      const got = parseCaptionAnswer(text);
      const problems = got ? captionProblems(got.options.slice(0, n), priceVnd, claimFactsOf(input)) : ["Câu trả lời không phải JSON đúng dạng {seen, options: [{headline, primaryText}]}."];
      if (got) parsed = got;
      if (problems.length === 0 || attempts === 2) break;
      messages.push({ role: "assistant", content: [{ type: "text", text: text || "(trống)" }] });
      messages.push({ role: "user", content: [{ type: "text", text: `Viết lại, sửa đúng các lỗi sau và giữ nguyên mọi luật:\n- ${problems.join("\n- ")}` }] });
    }
  } catch (e) {
    return done({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
  attempts = Math.min(attempts, 2);
  if (!parsed) return done({ ok: false, error: "Mô hình không trả về câu chữ đúng dạng sau hai lượt." });
  const { options, priceStripped, claimDropped } = pickCaptionOptions(parsed, input, n, priceVnd);
  if (!options.length) return done({ ok: false, error: claimDropped ? "Mọi phương án đều còn khẳng định bịa (khối lượng / xuất xứ / sức khoẻ / chứng nhận) sau lượt viết lại — bấm viết lại hoặc bổ sung dữ kiện sản phẩm." : "Mọi phương án đều rỗng sau khi bỏ con số giá sai." });
  return done({ ok: true, headline: options[0].headline, primaryText: options[0].primaryText, options, seen: parsed.seen.slice(0, SEEN_MAX_CHARS), model, costUsd: estimateCostUsd(model, usage), attempts, priceStripped });
}
