import { schema, type Db } from "@/db";
import { estimateCostUsd, type AiUsage } from "@/lib/ai/provider";
import { MODEL_BY_TIER } from "@/lib/ai/router";
import { tienAiHomNay, tranNgayUsd } from "@/lib/ai/budget";
import { xetTranNgay } from "@/lib/constants/ai-budget";
import { DESIGN_DNA_KEYS, DESIGN_DNA_VERSION, DESIGN_DNA_VOCAB, PRODUCT_DNA_PER_BUILD, PRODUCT_DNA_ROUTE, parsePartialDna, type DesignDna } from "@/lib/constants/creative-loop";
import { readCreativeImage, sha256Hex, sniffImageType } from "@/lib/creative/images";
import { downloadImage, type DownloadDeps } from "@/lib/creative/import";
import { OPENAI_RESPONSES_URL, outputText, usageOf, type ResponsesBody } from "@/lib/creative/vision";
import { env } from "@/lib/env";
import { pendingProductDna, type ProductDnaTarget } from "@/lib/queries/creative-design";

/**
 * ═══════════ ĐỌC DNA CỦA SẢN PHẨM ĐANG CÓ ═══════════
 *
 * Chủ shop 24/09/2026: thiết kế mới lấy "DNA" từ các mã đã bán tốt. DNA của một mã (nhóm hàng, dáng, độ
 * dài, cổ, tay, chất liệu, hoạ tiết, họ màu, chi tiết, phong cách) được một mô hình ĐỌC ẢNH trả về trong
 * từ vựng ĐÓNG `DESIGN_DNA_VOCAB` — cùng cách `vision.ts` gọi OpenAI Responses (`input_image`), cùng phanh
 * tiền AI trong ngày, và mỗi lượt vào sổ `ai_interactions` (route `creative.dna`) để phanh thấy nó.
 *
 * Ảnh ĐỌC (không phải ảnh gửi máy sinh ảnh): ảnh sản phẩm thật · quảng cáo cũ của shop gắn mã · ảnh
 * Pancake của mã (kể cả mã đã gỡ — lịch sử bán tốt vẫn là DNA quý). Điểm ảnh không được lưu thêm.
 *
 * LŨY ĐẲNG: một dòng `product_dna` mỗi mã; mã đã có DNA đúng phiên bản thì không đọc lại. Đọc hỏng ⇒ ghi
 * lỗi + mốc, thử lại sau `PRODUCT_DNA_RETRY_HOURS` (DNA cũ nếu có vẫn giữ). Chưa có khoá API / chạm trần AI
 * ngày ⇒ KHÔNG ghi gì (đó không phải lỗi của ảnh — lượt sau thử lại). Mọi lỗi trả về, không ném.
 */

const DNA_TIMEOUT_MS = 90_000;
export const DNA_SUMMARY_MAX_CHARS = 300;

export type ProductDnaDeps = {
  fetchImpl?: typeof fetch;
  /** Chỉ kiểm thử truyền. Bỏ trống ⇒ đọc `OPENAI_API_KEY`. */
  apiKey?: string;
  model?: string;
  now?: Date;
  /** Tải ảnh Pancake (kiểm thử tiêm `fetchImpl` giả). */
  download?: DownloadDeps;
};

export type ReadDnaResult = { ok: true; dna: Partial<DesignDna>; summary: string; model: string; costUsd: number | null } | { ok: false; error: string; skipped: boolean };

/** Kiểu để TIÊM vào `buildBatch`. */
export type ProductDnaReader = (db: Db, target: ProductDnaTarget) => Promise<ReadDnaResult>;

const DNA_INSTRUCTIONS = [
  "Bạn phân tích ẢNH SẢN PHẨM thời trang của một shop để hệ thống biết mẫu này thuộc kiểu thiết kế nào.",
  "Với mỗi thuộc tính của CHIẾC ÁO / VÁY / QUẦN chính trong ảnh, chọn ĐÚNG MỘT giá trị trong danh sách cho sẵn, hoặc null nếu ảnh không cho thấy rõ.",
  "neckline / sleeve = NONE khi sản phẩm không có cổ / tay (quần, chân váy) hoặc không áp dụng. detail = NONE khi không có chi tiết nổi bật.",
  `summary: tiếng Việt, tối đa ${DNA_SUMMARY_MAX_CHARS} ký tự, tả thiết kế của sản phẩm (không tả bối cảnh, người mẫu).`,
  "KHÔNG chép chữ, giá, thương hiệu hay logo trong ảnh. Không nhận diện danh tính người trong ảnh.",
].join("\n");

/** JSON Schema chặt: mỗi thuộc tính là một giá trị trong từ vựng hoặc `null`. */
export function dnaJsonSchema(): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const k of DESIGN_DNA_KEYS) props[k] = { type: ["string", "null"], enum: [...DESIGN_DNA_VOCAB[k], null] };
  return {
    type: "object",
    additionalProperties: false,
    required: ["dna", "summary"],
    properties: { dna: { type: "object", additionalProperties: false, required: [...DESIGN_DNA_KEYS], properties: props }, summary: { type: "string" } },
  };
}

/** Đọc câu trả lời — giá trị lạ bị BỎ (thuộc tính ấy CHƯA BIẾT), không ép về giá trị gần nhất. */
export function parseDnaAnswer(text: string): { dna: Partial<DesignDna>; summary: string } | null {
  try {
    const obj = JSON.parse(text) as { dna?: unknown; summary?: unknown };
    return { dna: parsePartialDna(obj.dna), summary: typeof obj.summary === "string" ? obj.summary.trim().slice(0, DNA_SUMMARY_MAX_CHARS) : "" };
  } catch {
    return null;
  }
}

async function logDna(db: Db, row: { model: string; productId: string; answer: string; usage: AiUsage; costUsd: number | null; latencyMs: number; status: "OK" | "ERROR"; error: string | null }) {
  try {
    await db.insert(schema.aiInteractions).values({
      userId: null,
      userEmail: "",
      provider: "openai",
      model: row.model,
      route: PRODUCT_DNA_ROUTE,
      entityType: "product",
      entityId: row.productId,
      prompt: "Đọc ảnh sản phẩm thành DNA thiết kế.",
      answer: row.answer.slice(0, 8000),
      usage: row.usage,
      costUsd: row.costUsd === null ? "" : row.costUsd.toFixed(6),
      latencyMs: row.latencyMs,
      rounds: 1,
      status: row.status,
      error: row.error,
    });
  } catch {
    // Sổ hỏng không làm mất kết quả đọc; trần ngày sẽ đếm thiếu lượt này.
  }
}

/** Ghi kết quả vào `product_dna` — một dòng mỗi mã. Lỗi thì GIỮ DNA cũ, chỉ ghi lỗi + mốc. */
async function saveDna(db: Db, productId: string, now: Date, r: { ok: true; dna: Partial<DesignDna>; summary: string; model: string; source: string; sha: string } | { ok: false; error: string; source: string }) {
  const pd = schema.productDna;
  if (r.ok) {
    const row = { dna: r.dna as Record<string, string>, dnaVersion: DESIGN_DNA_VERSION, imageSource: r.source, imageSha256: r.sha, summary: r.summary, model: r.model, error: "", readAt: now };
    await db
      .insert(pd)
      .values({ productId, ...row })
      .onConflictDoUpdate({ target: pd.productId, set: { ...row, updatedAt: now } });
    return;
  }
  await db
    .insert(pd)
    .values({ productId, dna: {}, dnaVersion: DESIGN_DNA_VERSION, imageSource: r.source, error: r.error.slice(0, 1000), readAt: now })
    .onConflictDoUpdate({ target: pd.productId, set: { error: r.error.slice(0, 1000), readAt: now, updatedAt: now } });
}

/** Đọc DNA của MỘT mã từ ảnh đã chọn (`pendingProductDna`). */
export async function readProductDna(db: Db, target: ProductDnaTarget, deps: ProductDnaDeps = {}): Promise<ReadDnaResult> {
  const now = deps.now ?? new Date();
  const model = deps.model ?? MODEL_BY_TIER.openai.routine;
  // Khoá + phanh tiền TRƯỚC mọi thứ chạm mạng (kể cả tải ảnh Pancake).
  const apiKey = deps.apiKey ?? env.openaiRest.apiKey;
  if (!apiKey) return { ok: false, error: "Chưa có OPENAI_API_KEY trên máy chủ — chưa đọc được DNA.", skipped: true };
  try {
    const [daTieu, tran] = await Promise.all([tienAiHomNay(now), tranNgayUsd()]);
    const vTran = xetTranNgay({ daTieu: daTieu.usd, tran });
    if (!vTran.choPhep) return { ok: false, error: vTran.ly, skipped: true };

    let bytes: Uint8Array;
    try {
      if (target.imageId) {
        const img = await readCreativeImage(db, target.imageId);
        if (!img) throw new Error("Ảnh của mã đã bị xoá điểm ảnh.");
        bytes = new Uint8Array(img.bytes);
      } else if (target.url) {
        bytes = await downloadImage(target.url, deps.download);
      } else {
        throw new Error("Mã không có ảnh nào để đọc.");
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await saveDna(db, target.productId, now, { ok: false, error, source: target.source });
      return { ok: false, error, skipped: false };
    }
    const type = sniffImageType(bytes);
    if (!type) {
      const error = "Tệp ảnh của mã không phải JPEG / PNG / WebP.";
      await saveDna(db, target.productId, now, { ok: false, error, source: target.source });
      return { ok: false, error, skipped: false };
    }

    const started = Date.now();
    let res: Response;
    try {
      res = await (deps.fetchImpl ?? fetch)(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          instructions: DNA_INSTRUCTIONS,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "Phân tích thiết kế của sản phẩm trong ảnh." },
                { type: "input_image", image_url: `data:${type};base64,${Buffer.from(bytes).toString("base64")}`, detail: "low" },
              ],
            },
          ],
          text: { format: { type: "json_schema", name: "product_dna", strict: true, schema: dnaJsonSchema() } },
          reasoning: { effort: "low" },
          max_output_tokens: 1200,
          store: false,
        }),
        signal: AbortSignal.timeout(DNA_TIMEOUT_MS),
      });
    } catch (e) {
      const error = `Không gọi được OpenAI: ${e instanceof Error ? e.message : String(e)}`;
      await logDna(db, { model, productId: target.productId, answer: "", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: null, latencyMs: Date.now() - started, status: "ERROR", error });
      // Mạng hỏng không phải lỗi của ảnh — không ghi lỗi vào `product_dna`, lượt sau thử lại.
      return { ok: false, error, skipped: true };
    }
    let body: ResponsesBody = {};
    try {
      body = (await res.json()) as ResponsesBody;
    } catch {
      body = {};
    }
    const usage = usageOf(body);
    const usedModel = typeof body.model === "string" && body.model ? body.model : model;
    const costUsd = estimateCostUsd(usedModel, usage);
    const answer = outputText(body);
    const parsed = res.ok ? parseDnaAnswer(answer) : null;
    if (!res.ok || !parsed || Object.keys(parsed.dna).length === 0) {
      const apiMsg = (body as { error?: { message?: unknown } }).error?.message;
      const error = !res.ok ? `OpenAI từ chối đọc ảnh (HTTP ${res.status})${typeof apiMsg === "string" ? `: ${apiMsg.slice(0, 300)}` : ""}.` : !parsed ? "Mô hình đọc ảnh không trả về JSON đúng dạng." : "Mô hình không nhận ra thuộc tính thiết kế nào trong từ vựng.";
      await logDna(db, { model: usedModel, productId: target.productId, answer, usage, costUsd, latencyMs: Date.now() - started, status: "ERROR", error });
      await saveDna(db, target.productId, now, { ok: false, error, source: target.source });
      return { ok: false, error, skipped: false };
    }
    await saveDna(db, target.productId, now, { ok: true, dna: parsed.dna, summary: parsed.summary, model: usedModel, source: target.source, sha: sha256Hex(bytes) });
    await logDna(db, { model: usedModel, productId: target.productId, answer, usage, costUsd, latencyMs: Date.now() - started, status: "OK", error: null });
    return { ok: true, dna: parsed.dna, summary: parsed.summary, model: usedModel, costUsd };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), skipped: true };
  }
}

/**
 * Đọc DNA cho tối đa `limit` mã còn thiếu — gọi trước khi lập lô, như `describePending` cho nguồn cảm
 * hứng. Một mã hỏng không chặn mã khác.
 */
export async function describePendingProducts(db: Db, reader: ProductDnaReader, now: Date, limit: number = PRODUCT_DNA_PER_BUILD): Promise<{ read: number; failed: number }> {
  const targets = await pendingProductDna(db, now, limit);
  let read = 0;
  let failed = 0;
  for (const t of targets) {
    const r = await reader(db, t);
    if (r.ok) read += 1;
    else failed += 1;
  }
  return { read, failed };
}
