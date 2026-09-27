import { schema, type Db } from "@/db";
import { tienAiHomNay, tranNgayUsd } from "@/lib/ai/budget";
import { estimateCostUsd, type AiUsage } from "@/lib/ai/provider";
import { xetTranNgay } from "@/lib/constants/ai-budget";
import { OPENAI_RESPONSES_URL, outputText, usageOf, type ResponsesBody } from "@/lib/creative/vision";
import { env } from "@/lib/env";
import { assertHomeCredentials } from "@/lib/platform/credentials";

/**
 * ═══════════ MỘT ĐƯỜNG GỌI OPENAI TRẢ JSON CHO VIDEO SCALE ═══════════
 *
 * Kịch bản, câu chữ, QC hình ảnh đều là: bản giao việc (chữ + ảnh) → JSON đúng lược đồ → hàm THUẦN kiểm → sai thì viết lại
 * MỘT lần kèm lỗi. Một đường duy nhất để luật chung (trần chi AI ngày, ghi sổ `ai_interactions`, không lưu hội thoại phía
 * OpenAI, không ghi điểm ảnh vào sổ) không phải chép ba lần.
 *
 * Không ném: trả `{ ok: false, error }` tiếng Việt.
 */

export type JsonCallInput<T> = {
  route: string;
  entityType: string;
  entityId: string;
  model: string;
  instructions: string;
  text: string;
  images?: { bytes: Uint8Array; contentType: string; detail?: "low" | "high" }[];
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  parse: (text: string) => T | null;
  /** Lỗi của một câu trả lời đã đọc được — rỗng là đạt. Có lỗi ⇒ viết lại MỘT lần. */
  problems: (value: T) => string[];
  maxOutputTokens?: number;
  effort?: "low" | "medium" | "high";
  timeoutMs?: number;
};

export type JsonCallDeps = { fetchImpl?: typeof fetch; apiKey?: string; now?: Date };

export type JsonCallResult<T> =
  | { ok: true; value: T; problems: string[]; model: string; costUsd: number | null; attempts: number }
  | { ok: false; error: string; model: string; costUsd: number | null };

const ZERO: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const add = (a: AiUsage, b: AiUsage): AiUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});

type InputItem = { role: "user" | "assistant"; content: Record<string, unknown>[] };

async function logRow(db: Db, row: { route: string; entityType: string; entityId: string; model: string; prompt: string; answer: string; usage: AiUsage; costUsd: number | null; latencyMs: number; rounds: number; error: string | null }) {
  try {
    await db.insert(schema.aiInteractions).values({
      userId: null,
      userEmail: "",
      provider: "openai",
      model: row.model,
      route: row.route,
      entityType: row.entityType,
      entityId: row.entityId,
      prompt: row.prompt.slice(0, 4000),
      answer: row.answer.slice(0, 8000),
      usage: row.usage,
      // Chuỗi rỗng = CHƯA BIẾT giá (mục 42), không phải 0.
      costUsd: row.costUsd === null ? "" : row.costUsd.toFixed(6),
      latencyMs: row.latencyMs,
      rounds: row.rounds,
      status: row.error ? "ERROR" : "OK",
      error: row.error,
    });
  } catch {
    // Sổ không ghi được thì kết quả vẫn dùng được; trần ngày sẽ đếm thiếu lượt này.
  }
}

export async function callOpenAiJson<T>(db: Db, input: JsonCallInput<T>, deps: JsonCallDeps = {}): Promise<JsonCallResult<T>> {
  const now = deps.now ?? new Date();
  const started = Date.now();
  let usage = ZERO;
  let usedModel = input.model;
  let lastAnswer = "";
  const finish = async (error: string | null, rounds: number) => {
    const costUsd = estimateCostUsd(usedModel, usage);
    await logRow(db, { route: input.route, entityType: input.entityType, entityId: input.entityId, model: usedModel, prompt: input.text, answer: lastAnswer, usage, costUsd, latencyMs: Date.now() - started, rounds, error });
    return costUsd;
  };

  try {
    await assertHomeCredentials("openai");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), model: usedModel, costUsd: null };
  }
  const apiKey = deps.apiKey ?? env.openaiRest.apiKey;
  if (!apiKey) return { ok: false, error: "Chưa có OPENAI_API_KEY trên máy chủ.", model: usedModel, costUsd: null };
  const [daTieu, tran] = await Promise.all([tienAiHomNay(now), tranNgayUsd()]);
  const vTran = xetTranNgay({ daTieu: daTieu.usd, tran });
  if (!vTran.choPhep) return { ok: false, error: vTran.ly, model: usedModel, costUsd: null };

  const doFetch = deps.fetchImpl ?? fetch;
  const content: Record<string, unknown>[] = [{ type: "input_text", text: input.text }];
  for (const img of input.images ?? []) {
    content.push({ type: "input_image", image_url: `data:${img.contentType || "image/jpeg"};base64,${Buffer.from(img.bytes).toString("base64")}`, detail: img.detail ?? "low" });
  }
  const conversation: InputItem[] = [{ role: "user", content }];
  let parsed: T | null = null;
  let problems: string[] = [];
  let attempts = 0;
  for (attempts = 1; attempts <= 2; attempts += 1) {
    let res: Response;
    try {
      res = await doFetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: input.model,
          instructions: input.instructions,
          input: conversation,
          text: { format: { type: "json_schema", name: input.schemaName, strict: true, schema: input.jsonSchema } },
          reasoning: { effort: input.effort ?? "low" },
          max_output_tokens: input.maxOutputTokens ?? 4000,
          // ERP tự giữ nhật ký; không lưu hội thoại phía OpenAI.
          store: false,
        }),
        signal: AbortSignal.timeout(input.timeoutMs ?? 120_000),
      });
    } catch (e) {
      const error = `Không gọi được OpenAI: ${e instanceof Error ? e.message : String(e)}`;
      return { ok: false, error, model: usedModel, costUsd: await finish(error, attempts) };
    }
    let body: ResponsesBody = {};
    try {
      body = (await res.json()) as ResponsesBody;
    } catch {
      body = {};
    }
    usage = add(usage, usageOf(body));
    if (typeof body.model === "string" && body.model) usedModel = body.model;
    lastAnswer = outputText(body);
    if (!res.ok) {
      const apiMsg = (body as { error?: { message?: unknown } }).error?.message;
      const error = `OpenAI từ chối (HTTP ${res.status})${typeof apiMsg === "string" ? `: ${apiMsg.slice(0, 300)}` : ""}.`;
      return { ok: false, error, model: usedModel, costUsd: await finish(error, attempts) };
    }
    const got = input.parse(lastAnswer);
    problems = got ? input.problems(got) : ["Câu trả lời không phải JSON đúng lược đồ."];
    if (got) parsed = got;
    if (problems.length === 0 || attempts === 2) break;
    // Viết lại MỘT lần — chỉ gửi lại chữ, ảnh đã nằm trong lượt đầu của hội thoại.
    conversation.push({ role: "assistant", content: [{ type: "output_text", text: lastAnswer || "(trống)" }] });
    conversation.push({ role: "user", content: [{ type: "input_text", text: `Viết lại, sửa đúng các lỗi sau và giữ nguyên mọi luật:\n- ${problems.join("\n- ")}` }] });
  }
  attempts = Math.min(attempts, 2);
  if (!parsed) {
    const error = `Mô hình không trả được JSON dùng được sau ${attempts} lượt.`;
    return { ok: false, error, model: usedModel, costUsd: await finish(error, attempts) };
  }
  const costUsd = await finish(null, attempts);
  return { ok: true, value: parsed, problems, model: usedModel, costUsd, attempts };
}

/** Lấy khối JSON ngoài cùng của một câu trả lời (chịu được rào ```json). Hàm THUẦN. */
export function extractJson(text: string): unknown {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    return JSON.parse(text.slice(s, e + 1));
  } catch {
    return null;
  }
}
