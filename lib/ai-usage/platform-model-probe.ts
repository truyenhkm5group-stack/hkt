/**
 * ═══════════ KIỂM TRA KHẢ DỤNG MODEL VỚI KHOÁ NỀN TẢNG — MỘT LỜI GỌI CỰC NHỎ, KHÔNG IN KHOÁ (docs/platform/ai-model-control.md) ═══════════
 *
 * Vì sao phải gọi THẬT thay vì đọc danh sách model: 02/10/2026 khoá Gemini MỚI của HSLC đọc được `gemini-2.5-flash-lite` ở
 * `GET /v1beta/models` nhưng `generateContent` trả 404 «no longer available to new users» (03/10 bot HSLC chết cả tối vì
 * đúng chuyện đó). Danh sách model nói "model tồn tại", không nói "khoá NÀY được gọi nó". Nên phép thử là MỘT
 * `generateContent` một chữ, `maxOutputTokens` 8, tắt suy nghĩ khi model cho tắt — chi phí cỡ 1/1.000.000 USD.
 *
 * Năm câu trả lời, mỗi câu dẫn tới một việc khác nhau — gộp lại là đẩy người đọc đi sửa nhầm chỗ (luật 55):
 *   AVAILABLE           — khoá gọi được model ⇒ được chạy thử / áp dụng.
 *   MODEL_UNAVAILABLE   — 404 / «not found» / «no longer available» ⇒ GIỮ model cũ, không có gì để sửa ở khoá.
 *   KEY_REJECTED        — 401 / 403 (khoá sai, bị thu hồi, project không bật API) ⇒ sửa khoá, KHÔNG phải model.
 *   QUOTA               — 429 / hết credit trả trước ⇒ nạp tiền / chờ; chưa kết luận được model.
 *   OTHER               — 5xx, hết giờ, mạng ⇒ thử lại sau; chưa kết luận được.
 *
 * Khoá chỉ đi trong header `x-goog-api-key`, không vào URL; mọi câu lỗi được che khoá rồi cắt 160 ký tự trước khi trả ra.
 */
import { MODEL_UNAVAILABLE_RE } from "@/lib/constants/ai-incidents";
import { GEMINI_BASE_URL, geminiThinkingConfig } from "@/lib/ai-builder/providers";
import type { PlatformAiProviderName } from "@/lib/ai-usage/platform-ai";

export const MODEL_PROBE_VERDICTS = ["AVAILABLE", "MODEL_UNAVAILABLE", "KEY_REJECTED", "QUOTA", "OTHER"] as const;
export type ModelProbeVerdict = (typeof MODEL_PROBE_VERDICTS)[number];

export const MODEL_PROBE_LABEL: Record<ModelProbeVerdict, string> = {
  AVAILABLE: "Dùng được với khoá nền tảng",
  MODEL_UNAVAILABLE: "Khoá này KHÔNG được gọi model (404 / không còn cấp)",
  KEY_REJECTED: "Khoá bị từ chối (401 / 403) — sửa khoá, không phải model",
  QUOTA: "Hết hạn mức / hết credit (429) — chưa kết luận được model",
  OTHER: "Lỗi khác (mạng / 5xx / hết giờ) — thử lại sau",
};

export type ModelProbeResult = { model: string; provider: PlatformAiProviderName; verdict: ModelProbeVerdict; httpStatus: number | null; latencyMs: number; message: string | null; modelVersion: string | null };

export const MODEL_PROBE_TIMEOUT_MS = 20_000;
const CREDIT_RE = /prepayment credits|credits? (?:are |is )?depleted|exceeded your current quota|insufficient[_ ]?quota|billing/i;
const KEY_RE = /api key not valid|api_key_invalid|permission[_ ]?denied|unauthenticated|has not been used in project|is disabled/i;

/** Câu trả lời của Gemini ⇒ phán quyết. HÀM THUẦN — thứ tự kiểm CÓ Ý: mã HTTP trước, chữ chỉ để tách các ca mã mơ hồ. */
export function classifyProbe(status: number | null, message: string | null): ModelProbeVerdict {
  const m = message ?? "";
  if (status !== null && status >= 200 && status < 300) return "AVAILABLE";
  if (status === 404 || (status !== null && MODEL_UNAVAILABLE_RE.test(m) && !KEY_RE.test(m) && !CREDIT_RE.test(m))) return "MODEL_UNAVAILABLE";
  if (status === 429 || CREDIT_RE.test(m)) return "QUOTA";
  if (status === 401 || status === 403 || KEY_RE.test(m)) return "KEY_REJECTED";
  return "OTHER";
}

/** Che khoá + cắt ngắn. HÀM THUẦN. */
export function redactProbeMessage(message: string, apiKey: string): string {
  const masked = apiKey ? message.split(apiKey).join("…") : message;
  return masked.replace(/AIza[0-9A-Za-z_\-]{20,}/g, "AIza…").replace(/\s+/g, " ").trim().slice(0, 160);
}

/** Thân yêu cầu thử — nhỏ nhất có thể. HÀM THUẦN (bài kiểm so nguyên văn). */
export function probeRequestBody(model: string): Record<string, unknown> {
  const thinking = geminiThinkingConfig(model, "low");
  return { contents: [{ role: "user", parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 8, ...(thinking ? { thinkingConfig: thinking } : {}) } };
}

/**
 * MỘT lời gọi thử. Không thử lại (thử lại là gấp đôi tiền và che mất 429 thật), không theo chuyển hướng, trần 20 giây.
 * Provider khác Gemini ⇒ `OTHER` kèm câu nói rõ chưa hỗ trợ — không giả vờ đã kiểm.
 */
export async function probePlatformModel(input: { apiKey: string; provider: PlatformAiProviderName; model: string; fetch?: typeof fetch }): Promise<ModelProbeResult> {
  const started = Date.now();
  const base = { model: input.model, provider: input.provider, modelVersion: null };
  if (input.provider !== "gemini") return { ...base, verdict: "OTHER", httpStatus: null, latencyMs: 0, message: "Kiểm tra khả dụng hiện chỉ hỗ trợ khoá Gemini." };
  const url = `${GEMINI_BASE_URL}/models/${encodeURIComponent(input.model)}:generateContent`;
  try {
    const res = await (input.fetch ?? fetch)(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": input.apiKey }, body: JSON.stringify(probeRequestBody(input.model)), redirect: "manual", signal: AbortSignal.timeout(MODEL_PROBE_TIMEOUT_MS) });
    const data = (await res.json().catch(() => null)) as { error?: { message?: unknown }; modelVersion?: unknown } | null;
    const raw = typeof data?.error?.message === "string" ? data.error.message : "";
    const message = raw ? redactProbeMessage(raw, input.apiKey) : null;
    return { ...base, verdict: classifyProbe(res.status, raw || null), httpStatus: res.status, latencyMs: Date.now() - started, message, modelVersion: res.ok && typeof data?.modelVersion === "string" ? data.modelVersion : null };
  } catch (error) {
    return { ...base, verdict: "OTHER", httpStatus: null, latencyMs: Date.now() - started, message: redactProbeMessage(error instanceof Error ? error.message : String(error), input.apiKey) };
  }
}
