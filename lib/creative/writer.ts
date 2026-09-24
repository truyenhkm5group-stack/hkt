import { z } from "zod";
import { getDb, schema } from "@/db";
import { estimateCostUsd, getAiProvider, type AiMessage, type AiProvider, type AiUsage } from "@/lib/ai/provider";
import { aiDisabledReason } from "@/lib/ai/router";
import { tienAiHomNay, tranNgayUsd } from "@/lib/ai/budget";
import { xetTranNgay } from "@/lib/constants/ai-budget";
import { GENE_KEYS, GENE_LABEL, GENE_VALUE_LABEL, type GeneKey, type Genes, type SlotMode } from "@/lib/constants/creative-loop";

/**
 * ═══════════ VIẾT CÂU LỆNH ẢNH + CÂU CHỮ CHO MỘT Ô ĐÃ ĐƯỢC CHỌN ═══════════
 *
 * Ranh giới 1 của vòng mẫu: mô hình KHÔNG quyết định. Bộ gen, mã hàng, chế độ ô đều đã được
 * `planBatch()` chọn; LLM chỉ DIỄN ĐẠT chúng thành chữ.
 *
 * Hai phần của câu lệnh ảnh KHÔNG giao cho LLM, mà mã nguồn tự gắn vào cuối, tất định:
 *  · CHỈ THỊ GEN — mỗi gen một câu tiếng Anh cố định. "Diễn đạt đủ sáu gen" là điều kiện để việc học
 *    có nghĩa: một mẫu mang nhãn `scene = CAFE` mà ảnh lại là phòng trơn thì thống kê gen đang đếm
 *    sai. Nhờ LLM nhớ thì có ngày nó quên; gắn bằng mã thì không.
 *  · CÂU GIỮ SẢN PHẨM — giữ nguyên màu, hoạ tiết, chất liệu, dáng như ảnh tham chiếu (ranh giới 3).
 *
 * ─── GIÁ TRÊN CÂU CHỮ PHẢI LÀ GIÁ ERP ───
 *
 * Quảng cáo ghi 199K trong khi đơn chốt 299K là một cuộc gọi khiếu nại và một đơn hoàn. Mọi con số
 * TRÔNG NHƯ GIÁ (có đơn vị tiền, hoặc đứng sau "giá" / "chỉ") phải BẰNG ĐÚNG `priceVnd`. Sai ⇒ viết
 * lại MỘT lần kèm lý do; vẫn sai ⇒ BỎ con số giá khỏi câu chữ. Không biết giá (`priceVnd = null`)
 * thì KHÔNG con số giá nào được đứng trên câu chữ — biết đâu mà khẳng định.
 */

export type WriterInput = {
  genes: Genes;
  mode: SlotMode;
  why: string;
  product: { name: string; code: string; priceVnd: number | null };
  /** Mô tả CHỮ của nguồn cảm hứng — thứ DUY NHẤT của ảnh spy/tay/R&D đi vào câu lệnh. */
  inspirationSummary: string | null;
  winningExamples: { primaryText: string; headline: string }[];
};

export type WriterOutput = {
  /** Câu lệnh tiếng Anh cho gpt-image — đã gắn chỉ thị gen + câu giữ sản phẩm. */
  imagePrompt: string;
  primaryText: string;
  headline: string;
  model: string;
  /** `null` = CHƯA BIẾT (model chưa có trong bảng giá). */
  costUsd: number | null;
  /** Số lượt gọi mô hình (1 hoặc 2). */
  attempts: number;
  /** Đã phải bỏ con số giá vì mô hình viết sai hai lần. */
  priceStripped: boolean;
};

export type WriterDeps = {
  /** `undefined` ⇒ `getAiProvider("routine")`; `null` ⇒ coi như AI tắt. */
  provider?: AiProvider | null;
  now?: Date;
  /** Mẫu đang được viết — chỉ để ghi sổ `ai_interactions`. */
  entityId?: string;
};

export const WRITER_LIMITS = { headlineMaxChars: 40, primaryTextMaxChars: 500 } as const;

export const WRITER_ROUTE = "creative.writer";

// ───────────────────────────── GIÁ TRÊN CÂU CHỮ ─────────────────────────────

export type PriceMention = { raw: string; index: number; vnd: number };

const NUM = String.raw`(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)`;
const UNIT = String.raw`(vnđ|vnd|đồng|nghìn|ngàn|triệu|tr|k|đ|₫)`;
const WITH_UNIT = new RegExp(String.raw`${NUM}\s*${UNIT}(?!\p{L})`, "giu");
const AFTER_KEYWORD = new RegExp(String.raw`(?:giá|price|chỉ|only)[^\d\n]{0,15}?${NUM}`, "giu");

function numberOf(raw: string): number | null {
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(raw)) return Number(raw.replace(/[.,]/g, ""));
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function multiplierOf(unit: string): number {
  const u = unit.toLowerCase();
  if (u === "k" || u === "nghìn" || u === "ngàn") return 1_000;
  if (u === "tr" || u === "triệu") return 1_000_000;
  return 1;
}

/**
 * Mọi con số TRÔNG NHƯ GIÁ trong một đoạn chữ, quy ra VND. Hai dạng:
 *  · số kèm đơn vị tiền (`299k`, `299.000đ`, `1,2tr`, `299.000 VND`);
 *  · số ≥ 1.000 đứng ngay sau "giá" / "chỉ" / "price" / "only" (`Giá chỉ 299.000`).
 * Số trơn khác ("3 màu", "size 38") không phải giá.
 */
export function findPriceMentions(text: string): PriceMention[] {
  const out: PriceMention[] = [];
  for (const m of text.matchAll(WITH_UNIT)) {
    const n = numberOf(m[1]);
    if (n === null) continue;
    out.push({ raw: m[0], index: m.index ?? 0, vnd: Math.round(n * multiplierOf(m[2])) });
  }
  for (const m of text.matchAll(AFTER_KEYWORD)) {
    const numIndex = (m.index ?? 0) + m[0].length - m[1].length;
    if (out.some((o) => numIndex >= o.index && numIndex < o.index + o.raw.length)) continue;
    const n = numberOf(m[1]);
    if (n === null || n < 1_000) continue;
    out.push({ raw: m[1], index: numIndex, vnd: Math.round(n) });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Con số giá nào SAI so với giá ERP. Không biết giá ⇒ mọi con số giá đều sai. */
export function wrongPrices(text: string, priceVnd: number | null): PriceMention[] {
  return findPriceMentions(text).filter((m) => priceVnd === null || m.vnd !== priceVnd);
}

/** Bỏ các con số giá sai khỏi câu chữ, dọn khoảng trắng và dấu câu lơ lửng. */
export function stripPrices(text: string, mentions: PriceMention[]): string {
  let out = text;
  for (const m of [...mentions].sort((a, b) => b.index - a.index)) out = out.slice(0, m.index) + out.slice(m.index + m.raw.length);
  return out
    .replace(/[ \t]+([,.!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .trim();
}

/** Cắt ở ranh giới từ, thêm "…". Không cắt giữa chữ. */
export function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

export function formatVnd(vnd: number): string {
  return `${Math.round(vnd).toLocaleString("vi-VN")}đ`;
}

// ───────────────────────────── CHỈ THỊ GEN (tiếng Anh, tất định) ─────────────────────────────

const GENE_PROMPT_EN: { [K in Exclude<GeneKey, "textOverlay">]: Record<Genes[K], string> } = {
  angle: {
    PRICE_DEAL: "Selling angle: a great deal — the image feels like an attractive offer.",
    QUALITY_DETAIL: "Selling angle: quality — make fabric texture and stitching clearly visible.",
    SOCIAL_PROOF: "Selling angle: social proof — the product looks loved and worn by real customers.",
    LIFESTYLE: "Selling angle: lifestyle — show the product as part of an aspirational everyday moment.",
    PROBLEM_SOLUTION: "Selling angle: problem–solution — the product visibly solves a comfort or fit problem.",
    NEW_ARRIVAL: "Selling angle: new arrival — fresh, just-launched feeling.",
    COMBO: "Selling angle: combo — present the product as a coordinated set.",
  },
  scene: {
    STUDIO_PLAIN: "Scene: clean plain studio background.",
    STREET: "Scene: urban street setting.",
    HOME: "Scene: cozy home interior.",
    CAFE: "Scene: a bright cafe.",
    OFFICE: "Scene: a modern office.",
    OUTDOOR_NATURE: "Scene: outdoors in nature.",
    FLATLAY: "Scene: top-down flat lay on a surface.",
  },
  model: {
    NONE: "No person in the image — the product alone.",
    FEMALE_YOUNG: "Worn by a young Vietnamese woman.",
    FEMALE_MATURE: "Worn by a mature Vietnamese woman in her 40s.",
    MALE: "Worn by a Vietnamese man.",
    GROUP: "A small group of Vietnamese people wearing the product.",
  },
  composition: {
    SINGLE_HERO: "Composition: one hero shot, product centered and dominant.",
    COLOR_GRID: "Composition: a neat grid showing the available colors of the SAME product.",
    DETAIL_CLOSEUP: "Composition: close-up on product details.",
    COLLAGE: "Composition: a clean collage of several angles of the SAME product.",
    MIRROR_SELFIE: "Composition: mirror selfie style shot.",
  },
  palette: {
    WARM: "Color palette: warm tones.",
    COOL: "Color palette: cool tones.",
    NEUTRAL: "Color palette: neutral tones.",
    VIVID: "Color palette: vivid, saturated tones.",
    PASTEL: "Color palette: soft pastel tones.",
  },
};

function textOverlayDirective(value: Genes["textOverlay"], priceVnd: number | null, headline: string): string {
  const price = priceVnd !== null ? `a clean price badge that reads exactly "${formatVnd(priceVnd)}"` : null;
  const head = headline ? `a bold Vietnamese headline that reads exactly "${headline}"` : null;
  const none = "No text, letters or numbers anywhere in the image.";
  if (value === "NONE") return none;
  if (value === "PRICE_BADGE") return price ? `Text on image: ${price}. No other text or numbers.` : none;
  if (value === "HEADLINE") return head ? `Text on image: ${head}. No numbers.` : none;
  const parts = [price, head].filter((x): x is string => Boolean(x));
  return parts.length ? `Text on image: ${parts.join(" and ")}. No other text or numbers.` : none;
}

/** Sáu câu chỉ thị, một câu cho mỗi gen — thứ tự theo `GENE_KEYS`. */
export function geneDirectives(genes: Genes, priceVnd: number | null, headline: string): string[] {
  return GENE_KEYS.map((k) => (k === "textOverlay" ? textOverlayDirective(genes.textOverlay, priceVnd, headline) : (GENE_PROMPT_EN[k] as Record<string, string>)[genes[k]]));
}

export const PRESERVE_PRODUCT_CLAUSE =
  "IMPORTANT: keep the product EXACTLY as in the reference product photo(s) — same colors, pattern, print, fabric, cut and silhouette. " +
  "Do not redesign, recolor or add details to the product. Do not add any logo, brand name or watermark. Photorealistic advertising photo.";

// ───────────────────────────── LỜI GỌI MÔ HÌNH ─────────────────────────────

const WRITER_SYSTEM = [
  "Bạn là người viết quảng cáo Facebook cho một shop thời trang Việt Nam.",
  "Bạn KHÔNG chọn ý tưởng: bộ gen (góc bán, bối cảnh, người mẫu, bố cục, chữ trên ảnh, tông màu) đã được chọn sẵn. Bạn chỉ diễn đạt đúng bộ gen ấy.",
  "Trả về DUY NHẤT một đối tượng JSON, không kèm chữ nào khác:",
  '{"imagePrompt": "<tiếng Anh: mô tả cảnh, ánh sáng, tư thế, góc máy — diễn đạt đủ sáu gen>", "primaryText": "<tiếng Việt, ≤ 500 ký tự>", "headline": "<tiếng Việt, ≤ 40 ký tự>"}',
  "Luật:",
  "- imagePrompt mô tả một ảnh quảng cáo dựa trên ẢNH SẢN PHẨM THẬT đính kèm: giữ nguyên sản phẩm (màu, hoạ tiết, chất liệu, dáng). Không mô tả thiết kế sản phẩm khác đi.",
  "- imagePrompt KHÔNG chứa chữ hay con số sẽ in lên ảnh — phần chữ trên ảnh do hệ thống tự thêm.",
  "- Không nhắc tên thương hiệu khác, không chép câu chữ của đối thủ, không hứa hẹn sai sự thật (không bịa số khách đã mua, không bịa giảm giá).",
  "- Nếu nhắc giá thì CHỈ dùng đúng giá được cung cấp. Không có giá thì KHÔNG viết con số giá nào.",
].join("\n");

function briefOf(input: WriterInput): string {
  const genes = GENE_KEYS.map((k) => `- ${GENE_LABEL[k]} (${k}): ${input.genes[k]} — ${GENE_VALUE_LABEL[input.genes[k]] ?? input.genes[k]}`).join("\n");
  const examples = input.winningExamples
    .slice(0, 3)
    .map((e, i) => `${i + 1}. Tiêu đề: ${e.headline}\n   Câu chữ: ${e.primaryText}`)
    .join("\n");
  return [
    `Sản phẩm: ${input.product.name} (mã ${input.product.code || "không rõ"})`,
    `Giá bán ERP: ${input.product.priceVnd !== null ? formatVnd(input.product.priceVnd) : "KHÔNG RÕ — không được viết con số giá nào"}`,
    `Loại ô: ${input.mode === "EXPLOIT" ? "biến thể của một mẫu đã chạy tốt" : "thử ý mới"}. Vì sao: ${input.why}`,
    `Bộ gen phải diễn đạt:\n${genes}`,
    input.inspirationSummary ? `Mô tả phong cách tham khảo (chỉ lấy tinh thần bố cục/phong cách, KHÔNG chép):\n${input.inspirationSummary}` : "",
    examples ? `Câu chữ của các mẫu đã thắng (tham khảo giọng văn, không chép nguyên văn):\n${examples}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const WriterJson = z.object({
  imagePrompt: z.string().trim().min(10),
  primaryText: z.string().trim().min(1),
  headline: z.string().trim().min(1),
});
type WriterJson = z.infer<typeof WriterJson>;

/** Đọc JSON từ câu trả lời (chịu được rào ```json). Hỏng ⇒ `null`. */
export function parseWriterJson(text: string): WriterJson | null {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    const parsed = WriterJson.safeParse(JSON.parse(text.slice(s, e + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Những điều câu chữ đang vi phạm — rỗng là đạt. */
export function copyProblems(copy: WriterJson, priceVnd: number | null): string[] {
  const out: string[] = [];
  if (copy.headline.length > WRITER_LIMITS.headlineMaxChars) out.push(`headline dài ${copy.headline.length} ký tự, tối đa ${WRITER_LIMITS.headlineMaxChars}.`);
  if (copy.primaryText.length > WRITER_LIMITS.primaryTextMaxChars) out.push(`primaryText dài ${copy.primaryText.length} ký tự, tối đa ${WRITER_LIMITS.primaryTextMaxChars}.`);
  for (const [field, text] of [["headline", copy.headline], ["primaryText", copy.primaryText], ["imagePrompt", copy.imagePrompt]] as const) {
    const bad = wrongPrices(text, priceVnd);
    if (bad.length) out.push(`${field} có con số giá "${bad.map((b) => b.raw).join('", "')}" ${priceVnd === null ? "trong khi giá chưa rõ — bỏ mọi con số giá" : `khác giá ERP ${formatVnd(priceVnd)}`}.`);
  }
  return out;
}

function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens };
}

const ZERO_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

async function logInteraction(row: { provider: string; model: string; prompt: string; answer: string; usage: AiUsage; costUsd: number | null; latencyMs: number; rounds: number; status: "OK" | "ERROR"; error: string | null; entityId: string }): Promise<void> {
  try {
    const db = await getDb();
    await db.insert(schema.aiInteractions).values({
      userId: null,
      userEmail: "",
      provider: row.provider,
      model: row.model,
      route: WRITER_ROUTE,
      entityType: "creative_variant",
      entityId: row.entityId,
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
    // Sổ không ghi được thì lượt viết vẫn có giá trị; trần ngày đọc sổ nên lượt này sẽ bị đếm thiếu.
  }
}

/**
 * Viết câu lệnh ảnh + câu chữ + tiêu đề cho một ô. Ném lỗi (tiếng Việt) khi AI tắt, chạm trần chi
 * AI ngày, hoặc mô hình không trả nổi một JSON dùng được sau hai lượt.
 */
export async function writeVariantCopy(input: WriterInput, deps: WriterDeps = {}): Promise<WriterOutput> {
  const now = deps.now ?? new Date();
  const provider = deps.provider === undefined ? getAiProvider("routine") : deps.provider;
  if (!provider) throw new Error(`AI đang tắt nên không viết được câu chữ (${aiDisabledReason() ?? "chưa có khoá API"}).`);

  const [daTieu, tran] = await Promise.all([tienAiHomNay(now), tranNgayUsd()]);
  const vTran = xetTranNgay({ daTieu: daTieu.usd, tran });
  if (!vTran.choPhep) throw new Error(vTran.ly);

  const priceVnd = input.product.priceVnd !== null && input.product.priceVnd > 0 ? Math.round(input.product.priceVnd) : null;
  const brief = briefOf({ ...input, product: { ...input.product, priceVnd } });
  const messages: AiMessage[] = [{ role: "user", content: [{ type: "text", text: brief }] }];
  const started = Date.now();
  let usage = ZERO_USAGE;
  let model = provider.model;
  let copy: WriterJson | null = null;
  let problems: string[] = [];
  let attempts = 0;
  let lastAnswer = "";

  try {
    for (attempts = 1; attempts <= 2; attempts += 1) {
      const res = await provider.complete({ system: WRITER_SYSTEM, messages, tools: [], maxTokens: 1500 });
      usage = addUsage(usage, res.usage);
      model = res.model || model;
      lastAnswer = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      const parsed = parseWriterJson(lastAnswer);
      problems = parsed ? copyProblems(parsed, priceVnd) : ["Câu trả lời không phải JSON đúng dạng {imagePrompt, primaryText, headline}."];
      if (parsed) copy = parsed;
      if (problems.length === 0 || attempts === 2) break;
      messages.push({ role: "assistant", content: [{ type: "text", text: lastAnswer || "(trống)" }] });
      messages.push({ role: "user", content: [{ type: "text", text: `Viết lại, sửa đúng các lỗi sau và giữ nguyên mọi luật:\n- ${problems.join("\n- ")}` }] });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logInteraction({ provider: provider.name, model, prompt: brief, answer: lastAnswer, usage, costUsd: estimateCostUsd(model, usage), latencyMs: Date.now() - started, rounds: attempts, status: "ERROR", error: msg, entityId: deps.entityId ?? "" });
    throw new Error(`Mô hình viết câu chữ lỗi: ${msg}`);
  }
  attempts = Math.min(attempts, 2);
  const costUsd = estimateCostUsd(model, usage);

  if (!copy) {
    await logInteraction({ provider: provider.name, model, prompt: brief, answer: lastAnswer, usage, costUsd, latencyMs: Date.now() - started, rounds: attempts, status: "ERROR", error: "Không đọc được JSON", entityId: deps.entityId ?? "" });
    throw new Error("Mô hình không trả về câu chữ đúng dạng sau hai lượt.");
  }

  // Lượt viết lại vẫn sai giá ⇒ BỎ con số giá, không đoán con số đúng thay mô hình.
  let priceStripped = false;
  const fix = (text: string) => {
    const bad = wrongPrices(text, priceVnd);
    if (!bad.length) return text;
    priceStripped = true;
    return stripPrices(text, bad);
  };
  const headline = clipWords(fix(copy.headline), WRITER_LIMITS.headlineMaxChars);
  const primaryText = clipWords(fix(copy.primaryText), WRITER_LIMITS.primaryTextMaxChars);
  const body = fix(copy.imagePrompt);
  const imagePrompt = [body, geneDirectives(input.genes, priceVnd, headline).join(" "), PRESERVE_PRODUCT_CLAUSE].join("\n\n");

  await logInteraction({ provider: provider.name, model, prompt: brief, answer: lastAnswer, usage, costUsd, latencyMs: Date.now() - started, rounds: attempts, status: "OK", error: null, entityId: deps.entityId ?? "" });
  return { imagePrompt, primaryText, headline, model, costUsd, attempts, priceStripped };
}

/** Kiểu để TIÊM vào `buildBatch`. */
export type CopyWriter = typeof writeVariantCopy;
