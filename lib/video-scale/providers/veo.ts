import { env } from "@/lib/env";
import { assertHomeCredentials } from "@/lib/platform/credentials";
import { assertVideoPixelSafe, httpErrorKind, ProviderError, type ClipRequest, type PollResult, type VideoProvider } from "@/lib/video-scale/providers/types";

/**
 * ═══════════ VEO TRÊN GEMINI API ═══════════
 *
 * Tham số lấy từ tài liệu chính thức (ai.google.dev/gemini-api/docs/veo, đọc 27/09/2026):
 *
 *  · Tạo:  `POST /v1beta/models/{model}:predictLongRunning`, tiêu đề `x-goog-api-key`, thân
 *          `{ instances: [{ prompt, image: { inlineData: { mimeType, data } } }], parameters: { aspectRatio, resolution, durationSeconds, personGeneration, negativePrompt } }`.
 *          Image-to-video chỉ nhận `personGeneration = "allow_adult"`. `aspectRatio` "9:16" có ở mọi model 3.1.
 *          `durationSeconds` "4" · "6" · "8" (1080p bắt buộc "8").
 *  · Hỏi:  `GET /v1beta/{operation.name}` → `.done`; kết quả ở `.response.generateVideoResponse.generatedSamples[0].video.uri`.
 *  · Tải:  `GET {uri}` kèm `x-goog-api-key`, theo chuyển hướng.
 *  · Video nằm trên máy chủ Google 2 ngày — tải về ngay khi xong (hàng đợi làm việc đó trong cùng lượt hỏi).
 *  · Veo 3.1 luôn sinh âm thanh.
 *
 * Khoá `GEMINI_API_KEY` chỉ đi vào tiêu đề; câu lỗi dựng từ mã HTTP + câu lỗi Google trả, không bao giờ từ tiêu đề.
 */

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const START_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

type Json = Record<string, unknown>;

function rec(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

/** Thân yêu cầu tạo clip — hàm THUẦN để bài kiểm khoá hình dạng. */
export function veoRequestBody(req: ClipRequest): Json {
  const parameters: Json = {
    aspectRatio: "9:16",
    resolution: req.resolution,
    durationSeconds: String(req.resolution === "1080p" ? 8 : req.seconds),
    personGeneration: "allow_adult",
  };
  if (req.negativePrompt.trim()) parameters.negativePrompt = req.negativePrompt.trim();
  return {
    instances: [{ prompt: req.prompt, image: { inlineData: { mimeType: req.image.contentType || "image/jpeg", data: Buffer.from(req.image.bytes).toString("base64") } } }],
    parameters,
  };
}

/** Đọc phản hồi của lượt hỏi thao tác — hàm THUẦN. */
export function parseVeoOperation(body: unknown): PollResult {
  const op = rec(body) ?? {};
  if (op.done !== true) return { state: "RUNNING" };
  const err = rec(op.error);
  if (err) {
    const code = typeof err.code === "number" ? err.code : 0;
    // Mã lỗi gRPC trong thao tác: 4 DEADLINE_EXCEEDED · 8 RESOURCE_EXHAUSTED · 13 INTERNAL · 14 UNAVAILABLE ⇒ tạm thời.
    const transient = [4, 8, 13, 14].includes(code);
    return { state: "FAILED", error: `Veo báo lỗi${code ? ` (mã ${code})` : ""}: ${String(err.message ?? "không rõ")}`.slice(0, 600), kind: transient ? "TRANSIENT" : "PERMANENT" };
  }
  const gvr = rec(rec(op.response)?.generateVideoResponse) ?? {};
  const samples = Array.isArray(gvr.generatedSamples) ? gvr.generatedSamples : [];
  const uri = rec(rec(samples[0])?.video)?.uri;
  if (typeof uri === "string" && uri) return { state: "DONE", videoUri: uri };
  const reasons = Array.isArray(gvr.raiMediaFilteredReasons) ? gvr.raiMediaFilteredReasons.filter((x): x is string => typeof x === "string") : [];
  if (reasons.length || typeof gvr.raiMediaFilteredCount === "number") {
    return { state: "FAILED", error: `Bộ lọc an toàn của Veo chặn clip${reasons.length ? `: ${reasons.join("; ")}` : ""}. Đổi câu lệnh cảnh hoặc ảnh gốc.`.slice(0, 600), kind: "PERMANENT" };
  }
  return { state: "FAILED", error: "Veo báo xong nhưng không trả video nào.", kind: "PERMANENT" };
}

async function apiError(res: Response, what: string): Promise<ProviderError> {
  let msg = "";
  try {
    const body = rec(await res.json());
    const e = rec(body?.error);
    if (e && typeof e.message === "string") msg = e.message;
  } catch {
    // thân không phải JSON
  }
  return new ProviderError(`Veo từ chối ${what} (HTTP ${res.status})${msg ? `: ${msg.slice(0, 400)}` : ""}.`, httpErrorKind(res.status));
}

export type VeoDeps = { fetchImpl?: typeof fetch; apiKey?: string };

export class VeoProvider implements VideoProvider {
  readonly id = "VEO" as const;
  constructor(private readonly deps: VeoDeps = {}) {}

  private async key(): Promise<string> {
    // Khoá trong môi trường là của tổ chức nhà (P12) — chặn trước khi đọc khoá.
    await assertHomeCredentials("gemini");
    const k = this.deps.apiKey ?? env.gemini.apiKey;
    if (!k) throw new ProviderError("Chưa có GEMINI_API_KEY trên máy chủ ERP — thêm GitHub Secret GEMINI_API_KEY rồi chạy lại deploy (khoá của bot chat nằm trong container riêng, ERP không đọc được).", "BLOCKED");
    return k;
  }

  async start(req: ClipRequest): Promise<{ ref: string }> {
    assertVideoPixelSafe(req.image);
    const apiKey = await this.key();
    const doFetch = this.deps.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${GEMINI_API_BASE}/models/${encodeURIComponent(req.model)}:predictLongRunning`, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify(veoRequestBody(req)),
        signal: AbortSignal.timeout(START_TIMEOUT_MS),
      });
    } catch (e) {
      // KHÔNG có phản hồi cho lời gọi TẠO ⇒ không biết Google đã nhận chưa (ranh giới 3).
      throw new ProviderError(`Không nhận được phản hồi khi gửi yêu cầu tạo clip tới Veo (${e instanceof Error ? e.message : String(e)}) — có thể clip đã được tạo và tính tiền.`, "AMBIGUOUS");
    }
    if (!res.ok) throw await apiError(res, "tạo clip");
    const body = rec(await res.json().catch(() => null));
    const name = body?.name;
    if (typeof name !== "string" || !name) throw new ProviderError("Veo nhận yêu cầu nhưng không trả mã thao tác — có thể clip đã được tạo.", "AMBIGUOUS");
    return { ref: name };
  }

  async poll(ref: string): Promise<PollResult> {
    if (!/^models\/[\w.-]+\/operations\/[\w.-]+$/.test(ref)) return { state: "FAILED", error: `Mã thao tác Veo lạ: "${ref.slice(0, 80)}".`, kind: "PERMANENT" };
    const apiKey = await this.key();
    const doFetch = this.deps.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${GEMINI_API_BASE}/${ref}`, { headers: { "x-goog-api-key": apiKey }, signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
    } catch (e) {
      throw new ProviderError(`Không hỏi được trạng thái clip trên Veo: ${e instanceof Error ? e.message : String(e)}`, "TRANSIENT");
    }
    if (!res.ok) throw await apiError(res, "trả trạng thái clip");
    return parseVeoOperation(await res.json().catch(() => null));
  }

  async download(videoUri: string): Promise<Uint8Array> {
    const u = new URL(videoUri);
    // Chỉ gửi khoá tới máy chủ của Google — một URI lạ trong phản hồi không được làm lộ khoá.
    if (u.protocol !== "https:" || !/(^|\.)googleapis\.com$/.test(u.hostname)) throw new ProviderError(`URI video lạ (${u.hostname}) — không gửi khoá tới đó.`, "PERMANENT");
    const apiKey = await this.key();
    const doFetch = this.deps.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(videoUri, { headers: { "x-goog-api-key": apiKey }, redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (e) {
      throw new ProviderError(`Không tải được clip từ Veo: ${e instanceof Error ? e.message : String(e)}`, "TRANSIENT");
    }
    if (!res.ok) throw await apiError(res, "cho tải clip");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.byteLength) throw new ProviderError("Veo trả tệp clip rỗng.", "TRANSIENT");
    return bytes;
  }
}
