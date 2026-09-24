import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { estimateCostUsd, type AiUsage } from "@/lib/ai/provider";
import { MODEL_BY_TIER } from "@/lib/ai/router";
import { tienAiHomNay, tranNgayUsd } from "@/lib/ai/budget";
import { xetTranNgay } from "@/lib/constants/ai-budget";
import { GENE_KEYS, GENE_VOCAB, parsePartialGenes, type Genes } from "@/lib/constants/creative-loop";
import { readCreativeImage } from "@/lib/creative/images";
import { env } from "@/lib/env";

/**
 * ═══════════ ĐỌC ẢNH NGUỒN THÀNH GEN + MÔ TẢ CHỮ ═══════════
 *
 * Đây là con đường DUY NHẤT mà ảnh spy / tay / R&D dạy được máy: một mô hình ĐỌC ảnh xem nó rồi trả
 * lại (a) gen trong từ vựng ĐÓNG và (b) một đoạn mô tả bố cục/phong cách. Điểm ảnh của những nguồn
 * ấy KHÔNG BAO GIỜ đi tiếp vào máy SINH ảnh (ranh giới 2) — chỉ hai thứ chữ này đi tiếp.
 *
 * Gửi ảnh SPY cho mô hình ĐỌC là hợp lệ: đọc để hiểu "vì sao mẫu này dừng được người xem" không
 * phải là chép lại nó. Mô tả được dặn KHÔNG chép chữ và thương hiệu trong ảnh.
 *
 * Gen lạ bị BỎ, không bị ép về giá trị gần nhất (`parsePartialGenes`) — mô hình đọc được năm gen
 * thì nguồn mang năm gen, gen thứ sáu để `planBatch()` chọn bằng thống kê.
 *
 * Mọi lỗi trả về `{ ok: false, error }`, không ném: một ảnh nguồn đọc hỏng không được làm hỏng cả
 * lượt dựng lô. Nguồn chưa đọc được giữ `vision_at = NULL`, lần dựng lô sau đọc lại — đó chính là
 * lượt thử lại, nên hàm không tự thử lại.
 */

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const VISION_ROUTE = "creative.vision";
export const VISION_SUMMARY_MAX_CHARS = 400;
const VISION_TIMEOUT_MS = 90_000;

export type DescribeSourceDeps = {
  fetchImpl?: typeof fetch;
  /** Chỉ kiểm thử truyền. Bỏ trống ⇒ đọc `OPENAI_API_KEY`. */
  apiKey?: string;
  /** Bỏ trống ⇒ bậc `routine` của OpenAI trong `lib/ai/router.ts`. */
  model?: string;
  now?: Date;
};

export type DescribeSourceResult = { ok: true; genes: Partial<Genes>; summary: string; model: string; costUsd: number | null } | { ok: false; error: string };

const VISION_INSTRUCTIONS = [
  "Bạn phân tích ảnh quảng cáo thời trang để một hệ thống học xem kiểu ảnh nào bán được.",
  "Với mỗi thuộc tính, chọn ĐÚNG MỘT giá trị trong danh sách cho sẵn, hoặc null nếu ảnh không cho thấy rõ.",
  `summary: tiếng Việt, tối đa ${VISION_SUMMARY_MAX_CHARS} ký tự, mô tả bố cục, bối cảnh, ánh sáng, cách tạo dáng, phong cách.`,
  "KHÔNG chép lại chữ, khẩu hiệu, giá, tên thương hiệu hay logo xuất hiện trong ảnh. Không nhận diện danh tính người trong ảnh.",
].join("\n");

/** JSON Schema chặt: mỗi gen là một giá trị trong từ vựng hoặc `null`. */
export function visionJsonSchema(): Record<string, unknown> {
  const geneProps: Record<string, unknown> = {};
  for (const k of GENE_KEYS) geneProps[k] = { type: ["string", "null"], enum: [...GENE_VOCAB[k], null] };
  return {
    type: "object",
    additionalProperties: false,
    required: ["genes", "summary"],
    properties: {
      genes: { type: "object", additionalProperties: false, required: [...GENE_KEYS], properties: geneProps },
      summary: { type: "string" },
    },
  };
}

type ResponsesBody = {
  model?: unknown;
  output?: { type?: unknown; content?: { type?: unknown; text?: unknown }[] }[];
  usage?: { input_tokens?: unknown; output_tokens?: unknown; input_tokens_details?: { cached_tokens?: unknown } };
};

function usageOf(body: ResponsesBody): AiUsage {
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
  const cached = n(body.usage?.input_tokens_details?.cached_tokens);
  return { inputTokens: Math.max(0, n(body.usage?.input_tokens) - cached), outputTokens: n(body.usage?.output_tokens), cacheReadTokens: cached, cacheWriteTokens: 0 };
}

function outputText(body: ResponsesBody): string {
  const parts: string[] = [];
  for (const item of body.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) if (c.type === "output_text" && typeof c.text === "string") parts.push(c.text);
  }
  return parts.join("").trim();
}

/** Đọc kết quả mô hình — gen lọc qua từ vựng, mô tả cắt về trần. */
export function parseVisionAnswer(text: string): { genes: Partial<Genes>; summary: string } | null {
  try {
    const obj = JSON.parse(text) as { genes?: unknown; summary?: unknown };
    const summary = typeof obj.summary === "string" ? obj.summary.trim().slice(0, VISION_SUMMARY_MAX_CHARS) : "";
    return { genes: parsePartialGenes(obj.genes), summary };
  } catch {
    return null;
  }
}

async function logVision(db: Db, row: { model: string; sourceId: string; answer: string; usage: AiUsage; costUsd: number | null; latencyMs: number; status: "OK" | "ERROR"; error: string | null }) {
  try {
    await db.insert(schema.aiInteractions).values({
      userId: null,
      userEmail: "",
      provider: "openai",
      model: row.model,
      route: VISION_ROUTE,
      entityType: "creative_source",
      entityId: row.sourceId,
      // Không ghi điểm ảnh (base64) vào sổ — chỉ ghi việc đã hỏi.
      prompt: "Đọc ảnh nguồn thành gen + mô tả phong cách.",
      answer: row.answer.slice(0, 8000),
      usage: row.usage,
      costUsd: row.costUsd === null ? "" : row.costUsd.toFixed(6),
      latencyMs: row.latencyMs,
      rounds: 1,
      status: row.status,
      error: row.error,
    });
  } catch {
    // Không ghi được sổ thì kết quả đọc vẫn dùng được; trần ngày sẽ đếm thiếu lượt này.
  }
}

export async function describeSource(db: Db, sourceId: string, deps: DescribeSourceDeps = {}): Promise<DescribeSourceResult> {
  const now = deps.now ?? new Date();
  const model = deps.model ?? MODEL_BY_TIER.openai.routine;
  try {
    const [src] = await db
      .select({ id: schema.creativeSources.id, imageId: schema.creativeSources.imageId })
      .from(schema.creativeSources)
      .where(eq(schema.creativeSources.id, sourceId))
      .limit(1);
    if (!src) return { ok: false, error: "Không tìm thấy nguồn ảnh." };
    if (!src.imageId) return { ok: false, error: "Nguồn này chưa có ảnh." };
    const img = await readCreativeImage(db, src.imageId);
    if (!img) return { ok: false, error: "Ảnh của nguồn đã bị xoá điểm ảnh." };

    const apiKey = deps.apiKey ?? env.openaiRest.apiKey;
    if (!apiKey) return { ok: false, error: "Chưa có OPENAI_API_KEY trên máy chủ — không đọc được ảnh." };

    const [daTieu, tran] = await Promise.all([tienAiHomNay(now), tranNgayUsd()]);
    const vTran = xetTranNgay({ daTieu: daTieu.usd, tran });
    if (!vTran.choPhep) return { ok: false, error: vTran.ly };

    const started = Date.now();
    const doFetch = deps.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          instructions: VISION_INSTRUCTIONS,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "Phân tích ảnh quảng cáo này." },
                { type: "input_image", image_url: `data:${img.contentType};base64,${img.bytes.toString("base64")}`, detail: "low" },
              ],
            },
          ],
          text: { format: { type: "json_schema", name: "creative_genes", strict: true, schema: visionJsonSchema() } },
          reasoning: { effort: "low" },
          max_output_tokens: 1200,
          // ERP tự giữ nhật ký; không lưu hội thoại phía OpenAI.
          store: false,
        }),
        signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
      });
    } catch (e) {
      const error = `Không gọi được OpenAI: ${e instanceof Error ? e.message : String(e)}`;
      await logVision(db, { model, sourceId, answer: "", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: null, latencyMs: Date.now() - started, status: "ERROR", error });
      return { ok: false, error };
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
    const parsed = res.ok ? parseVisionAnswer(answer) : null;
    if (!res.ok || !parsed) {
      const apiMsg = (body as { error?: { message?: unknown } }).error?.message;
      const error = !res.ok ? `OpenAI từ chối đọc ảnh (HTTP ${res.status})${typeof apiMsg === "string" ? `: ${apiMsg.slice(0, 300)}` : ""}.` : "Mô hình đọc ảnh không trả về JSON đúng dạng.";
      await logVision(db, { model: usedModel, sourceId, answer, usage, costUsd, latencyMs: Date.now() - started, status: "ERROR", error });
      return { ok: false, error };
    }

    await db
      .update(schema.creativeSources)
      .set({ genes: parsed.genes as Record<string, string>, visionSummary: parsed.summary, visionModel: usedModel, visionAt: now })
      .where(eq(schema.creativeSources.id, sourceId));
    await logVision(db, { model: usedModel, sourceId, answer, usage, costUsd, latencyMs: Date.now() - started, status: "OK", error: null });
    return { ok: true, genes: parsed.genes, summary: parsed.summary, model: usedModel, costUsd };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Kiểu để TIÊM vào `buildBatch`. */
export type SourceDescriber = (db: Db, sourceId: string) => Promise<DescribeSourceResult>;
