import { env } from "@/lib/env";
import { assertHomeCredentials } from "@/lib/platform/credentials";
import { assertVideoPixelSafe, httpErrorKind, ProviderError, type ClipRequest, type PollResult, type VideoProvider } from "@/lib/video-scale/providers/types";
import { GEMINI_API_BASE } from "@/lib/video-scale/providers/veo";

/**
 * ═══════════ GEMINI OMNI FLASH TRÊN GEMINI API ═══════════
 *
 * Tham số lấy từ tài liệu chính thức (ai.google.dev/gemini-api/docs/omni + ai.google.dev/api/interactions-api, đọc 28/09/2026):
 *
 *  · Tạo:  `POST /v1beta/interactions`, tiêu đề `x-goog-api-key`, thân
 *          `{ model: "gemini-omni-1.1-flash", input: [{ type: "image", data, mime_type }, { type: "text", text }],
 *             response_format: { type: "video", aspect_ratio: "9:16", resolution: "720p", delivery: "uri" },
 *             background: true, store: true }`.
 *          `background: true` ⇒ trả `id` ngay, hỏi lại bằng `GET /v1beta/interactions/{id}` (cần `store: true`).
 *  · Trạng thái: `queued` · `in_progress` ⇒ đang chạy; `completed` ⇒ xong; `failed` · `cancelled` · `incomplete` ⇒ hỏng.
 *  · Kết quả: `steps[]` có bước `type = "model_output"`, `content[]` có mục `type = "video"` mang `uri` (Files API) hoặc
 *    `data` (base64, khi Google trả thẳng). URI: hỏi `GET /v1beta/files/{id}` tới `state = ACTIVE`, rồi
 *    `GET /v1beta/files/{id}:download?alt=media`.
 *  · KHÔNG có trường câu lệnh phủ định và KHÔNG có ví dụ trường độ dài: cả hai đi vào câu chữ; tiền giữ chỗ tính theo 10 giây
 *    (`reserveSecondsFor`). Ảnh chỉ là ẢNH ĐẦU theo cách dặn trong câu lệnh — không có trường "khung đầu" như Veo, nên câu lệnh
 *    dặn rõ giữ nguyên sản phẩm; QC hình ảnh vẫn là hàng rào thật.
 *  · Omni luôn sinh âm thanh; mọi video mang SynthID (không nhìn thấy).
 *
 * Mã thao tác lưu ở hàng đợi dạng `interactions/{id}` — tách khỏi mã Veo (`models/…/operations/…`).
 */

const START_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

type Json = Record<string, unknown>;

function rec(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

/** Câu lệnh gửi Omni: cảnh + dặn ảnh là khung đầu + độ dài + điều cấm (Omni không có trường phủ định). Hàm THUẦN. */
export function omniPromptText(req: Pick<ClipRequest, "prompt" | "negativePrompt" | "seconds">): string {
  return [
    "Vertical 9:16 fashion product video. Use the attached product photo as the exact OPENING FRAME and animate it; keep the garment identical to the photo in colour, neckline, sleeves, waist, length and pattern.",
    req.prompt.trim(),
    `Length: about ${req.seconds} seconds, one continuous shot.`,
    req.negativePrompt.trim() ? `Do not show: ${req.negativePrompt.trim()}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Thân yêu cầu tạo clip — hàm THUẦN để bài kiểm khoá hình dạng. */
export function omniRequestBody(req: ClipRequest): Json {
  return {
    model: req.model,
    input: [
      { type: "image", data: Buffer.from(req.image.bytes).toString("base64"), mime_type: req.image.contentType || "image/jpeg" },
      { type: "text", text: omniPromptText(req) },
    ],
    response_format: { type: "video", aspect_ratio: "9:16", resolution: req.resolution, delivery: "uri" },
    background: true,
    store: true,
  };
}

/** Mục video trong kết quả, hoặc `null`. Hàm THUẦN. */
function videoItem(body: Json): Json | null {
  const steps = Array.isArray(body.steps) ? body.steps : [];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const s = rec(steps[i]);
    if (!s || s.type !== "model_output") continue;
    const content = Array.isArray(s.content) ? s.content : [];
    for (const c of content) {
      const item = rec(c);
      if (item?.type === "video") return item;
    }
  }
  // Một số phản hồi gói video ở `outputs[]` (dạng SDK) — đọc cả hai, không đoán thêm.
  const outputs = Array.isArray(body.outputs) ? body.outputs : [];
  for (const c of outputs) {
    const item = rec(c);
    if (item?.type === "video") return item;
  }
  return null;
}

/** Đọc một lượt hỏi interaction — hàm THUẦN. `id` dùng để dựng tham chiếu tải khi video trả thẳng base64. */
export function parseOmniInteraction(body: unknown, id: string): PollResult {
  const b = rec(body) ?? {};
  const status = typeof b.status === "string" ? b.status : "";
  if (status === "queued" || status === "in_progress" || status === "") return { state: "RUNNING" };
  if (status === "completed") {
    const v = videoItem(b);
    if (v && typeof v.uri === "string" && v.uri) return { state: "DONE", videoUri: v.uri };
    if (v && typeof v.data === "string" && v.data) return { state: "DONE", videoUri: `interaction:${id}` };
    return { state: "FAILED", error: "Omni báo xong nhưng không trả video nào (có thể bị bộ lọc an toàn chặn). Đổi câu lệnh cảnh hoặc ảnh gốc.", kind: "PERMANENT" };
  }
  const err = rec(b.error);
  const msg = err && typeof err.message === "string" ? err.message : "";
  // Hỏng do hạn mức / máy chủ ⇒ tạm thời; còn lại (bộ lọc, câu lệnh) ⇒ vĩnh viễn.
  const transient = /quota|rate|unavailable|internal|deadline|overloaded|resource/i.test(msg);
  const what = status === "cancelled" ? "đã bị huỷ" : status === "incomplete" ? "trả kết quả không đầy đủ" : "báo lỗi";
  return { state: "FAILED", error: `Omni ${what}${msg ? `: ${msg}` : ""}.`.slice(0, 600), kind: transient ? "TRANSIENT" : "PERMANENT" };
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
  return new ProviderError(`Omni từ chối ${what} (HTTP ${res.status})${msg ? `: ${msg.slice(0, 400)}` : ""}.`, httpErrorKind(res.status));
}

const INTERACTION_REF = /^interactions\/([\w.-]+)$/;
const FILE_URI = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/([\w.-]+)(?::download)?(?:\?.*)?$/;

export type OmniDeps = { fetchImpl?: typeof fetch; apiKey?: string };

export class OmniProvider implements VideoProvider {
  readonly id = "OMNI" as const;
  constructor(private readonly deps: OmniDeps = {}) {}

  private async key(): Promise<string> {
    await assertHomeCredentials("gemini");
    const k = this.deps.apiKey ?? env.gemini.apiKey;
    if (!k) throw new ProviderError("Chưa có GEMINI_API_KEY trên máy chủ ERP — thêm GitHub Secret GEMINI_API_KEY rồi chạy lại deploy (Omni dùng chung khoá Gemini API với Veo).", "BLOCKED");
    return k;
  }

  private async get(url: string, what: string): Promise<Response> {
    const apiKey = await this.key();
    const doFetch = this.deps.fetchImpl ?? fetch;
    try {
      return await doFetch(url, { headers: { "x-goog-api-key": apiKey }, redirect: "follow", signal: AbortSignal.timeout(what === "tải clip" ? DOWNLOAD_TIMEOUT_MS : POLL_TIMEOUT_MS) });
    } catch (e) {
      throw new ProviderError(`Không ${what} trên Omni: ${e instanceof Error ? e.message : String(e)}`, "TRANSIENT");
    }
  }

  async start(req: ClipRequest): Promise<{ ref: string }> {
    assertVideoPixelSafe(req.image);
    const apiKey = await this.key();
    const doFetch = this.deps.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${GEMINI_API_BASE}/interactions`, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify(omniRequestBody(req)),
        signal: AbortSignal.timeout(START_TIMEOUT_MS),
      });
    } catch (e) {
      throw new ProviderError(`Không nhận được phản hồi khi gửi yêu cầu tạo clip tới Omni (${e instanceof Error ? e.message : String(e)}) — có thể clip đã được tạo và tính tiền.`, "AMBIGUOUS");
    }
    if (!res.ok) throw await apiError(res, "tạo clip");
    const body = rec(await res.json().catch(() => null));
    const id = body?.id;
    if (typeof id !== "string" || !/^[\w.-]+$/.test(id)) throw new ProviderError("Omni nhận yêu cầu nhưng không trả mã interaction — có thể clip đã được tạo.", "AMBIGUOUS");
    return { ref: `interactions/${id}` };
  }

  async poll(ref: string): Promise<PollResult> {
    const m = INTERACTION_REF.exec(ref);
    if (!m) return { state: "FAILED", error: `Mã thao tác Omni lạ: "${ref.slice(0, 80)}".`, kind: "PERMANENT" };
    const res = await this.get(`${GEMINI_API_BASE}/interactions/${m[1]}`, "hỏi được trạng thái clip");
    if (!res.ok) throw await apiError(res, "trả trạng thái clip");
    return parseOmniInteraction(await res.json().catch(() => null), m[1]);
  }

  async download(videoUri: string): Promise<Uint8Array> {
    // Video trả thẳng base64 trong interaction ⇒ đọc lại interaction (không giữ hàng MB trong hàng đợi).
    if (videoUri.startsWith("interaction:")) {
      const id = videoUri.slice("interaction:".length);
      if (!/^[\w.-]+$/.test(id)) throw new ProviderError("Mã interaction lạ.", "PERMANENT");
      const res = await this.get(`${GEMINI_API_BASE}/interactions/${id}`, "đọc lại được clip");
      if (!res.ok) throw await apiError(res, "trả clip");
      const b = rec(await res.json().catch(() => null)) ?? {};
      const v = videoItem(b);
      if (!v || typeof v.data !== "string" || !v.data) throw new ProviderError("Omni không còn giữ dữ liệu clip trong interaction.", "PERMANENT");
      const bytes = new Uint8Array(Buffer.from(v.data, "base64"));
      if (!bytes.byteLength) throw new ProviderError("Omni trả clip rỗng.", "TRANSIENT");
      return bytes;
    }
    // Chỉ gửi khoá tới Files API của Google — một URI lạ không được làm lộ khoá.
    const m = FILE_URI.exec(videoUri);
    if (!m) throw new ProviderError(`URI video Omni lạ (${videoUri.slice(0, 80)}) — không gửi khoá tới đó.`, "PERMANENT");
    const meta = await this.get(`${GEMINI_API_BASE}/files/${m[1]}`, "hỏi được trạng thái tệp clip");
    if (!meta.ok) throw await apiError(meta, "trả trạng thái tệp clip");
    const state = rec(await meta.json().catch(() => null))?.state;
    if (state === "FAILED") throw new ProviderError("Files API báo tệp clip Omni hỏng.", "PERMANENT");
    // PROCESSING ⇒ chưa tải được; lỗi TẠM THỜI để hàng đợi hỏi lại (không mất clip đã trả tiền).
    if (state !== "ACTIVE") throw new ProviderError(`Tệp clip Omni chưa sẵn sàng (${String(state ?? "không rõ")}).`, "TRANSIENT");
    const res = await this.get(`${GEMINI_API_BASE}/files/${m[1]}:download?alt=media`, "tải clip");
    if (!res.ok) throw await apiError(res, "cho tải clip");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.byteLength) throw new ProviderError("Omni trả tệp clip rỗng.", "TRANSIENT");
    return bytes;
  }
}
