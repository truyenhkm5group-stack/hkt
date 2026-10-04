import { GEMINI_BASE_URL } from "@/lib/ai-builder/providers";
import { IMAGE_SIZES, type ImageSize } from "@/lib/constants/creative-loop";
import { IMAGE_EDIT_TIMEOUT_MS, OPENAI_IMAGES_EDIT_URL, assertPixelSafe, buildImageEditForm, decodeImageEditBody, type ImageEditInput, type ImageEditResult, type ImageEditUsage } from "@/lib/integrations/openai/images";
import { assertConnectionOwner } from "@/lib/platform/credentials";

/**
 * ═══════════ MÁY VẼ ẢNH BẰNG KHOÁ CỦA TỔ CHỨC (BYOK) — CHỈ MÁY CHỦ (chủ shop 04/10/2026) ═══════════
 *
 * Tổ chức khách (vd «Hải Sản Làng Chài») vẽ ảnh quảng cáo bằng khoá AI CỦA CHÍNH HỌ — kết nối `openai-byok` (gpt-image, sửa
 * ảnh `POST /v1/images/edits`) hoặc `gemini-byok` (model vẽ ảnh của Gemini, `generateContent` trả ảnh). Khoá của nhà
 * (`OPENAI_API_KEY`, `editImage` trong lib/integrations/openai/images.ts) KHÔNG BAO GIỜ đi qua tệp này, và khoá của tổ chức
 * không bao giờ đi qua `editImage`.
 *
 * ─── HÀNG RÀO Ở LỐI GỌI MẠNG (cùng mẫu `FacebookAdsClient.fromOrgConnection`) ───
 *
 *  1. `assertPixelSafe` — đúng hàng rào điểm ảnh của vòng mẫu: chỉ ảnh CỦA SHOP, bắt buộc có ảnh sản phẩm THẬT; SPY không tới.
 *  2. `assertConnectionOwner` — khoá được mở trong ngữ cảnh tổ chức A chỉ được GỬI khi ngữ cảnh hiện hành VẪN là A. Client của A
 *     lọt sang lượt chạy của B ⇒ NÉM trước khi một byte rời máy.
 *  3. Địa chỉ là HẰNG (api.openai.com · generativelanguage.googleapis.com), không theo chuyển hướng (`redirect: "manual"`).
 *  4. Khoá chỉ nằm trong tiêu đề; mọi câu lỗi đi qua `scrub` — câu lỗi của nhà cung cấp lỡ lặp lại khoá cũng không lộ.
 *
 * Model Gemini vẽ ảnh KHÔNG được đoán (02/10/2026: khoá Gemini mới nhận 404 với dòng 2.5) — nó là ô «Model vẽ ảnh» của kết
 * nối; 404 ⇒ câu lỗi chỉ đúng ô cần sửa. Gemini không có bảng giá ảnh trong ERP ⇒ `costUsd: null` (CHƯA BIẾT, luật 42).
 */

export type ByokImageKey = { connectorKey: "openai-byok" | "gemini-byok"; owner: string; apiKey: string };
export type ByokImageDeps = { fetchImpl?: typeof fetch; timeoutMs?: number };

export function scrubKey(msg: string, apiKey: string): string {
  return apiKey ? msg.split(apiKey).join("…") : msg;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function checkPrompt(input: ImageEditInput): string {
  assertPixelSafe(input.images);
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw new Error("Câu lệnh sinh ảnh trống.");
  return prompt;
}

async function post(url: string, init: RequestInit, key: ByokImageKey, deps: ByokImageDeps, vendor: string): Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? IMAGE_EDIT_TIMEOUT_MS;
  let res: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      res = await doFetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      throw new Error(name === "TimeoutError" || name === "AbortError" ? `Sinh ảnh quá ${Math.round(timeoutMs / 1000)} giây — đã bỏ.` : scrubKey(`Không gọi được ${vendor}: ${errMsg(e)}`, key.apiKey));
    }
    // Thử lại MỘT lần, chỉ với 429 / 5xx — lỗi 4xx khác (khoá sai, model không có) gọi lại vẫn ra đúng lỗi ấy.
    if (res.ok || !(res.status === 429 || res.status >= 500) || attempt === 1) break;
  }
  if (!res) throw new Error(`Không gọi được ${vendor}.`);
  return res;
}

async function apiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } };
    return typeof body?.error?.message === "string" ? body.error.message.slice(0, 300) : "";
  } catch {
    return "";
  }
}

/** gpt-image (`/v1/images/edits`) bằng khoá `openai-byok` của tổ chức. Cùng thân yêu cầu và cùng bộ đọc phản hồi với đường của nhà. */
export async function openAiByokImage(input: ImageEditInput, key: ByokImageKey, deps: ByokImageDeps = {}): Promise<ImageEditResult> {
  const prompt = checkPrompt(input);
  await assertConnectionOwner(key.connectorKey, key.owner);
  if (!key.apiKey) throw new Error("Kết nối OpenAI của tổ chức chưa có khoá.");
  const res = await post(OPENAI_IMAGES_EDIT_URL, { method: "POST", headers: { Authorization: `Bearer ${key.apiKey}` }, body: buildImageEditForm({ ...input, prompt }) }, key, deps, "OpenAI");
  if (!res.ok) {
    const msg = await apiError(res);
    throw new Error(scrubKey(`OpenAI (khoá của tổ chức) từ chối sinh ảnh (HTTP ${res.status})${msg ? `: ${msg}` : ""}.`, key.apiKey));
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error("OpenAI trả về phản hồi không phải JSON.");
  }
  return decodeImageEditBody(body, input.model, "SYNC");
}

/** Khổ ảnh của ERP ⇒ câu tỉ lệ khung cho Gemini (đặt trong câu lệnh — không dựa vào một tham số mà không phải model nào cũng nhận). */
export const GEMINI_ASPECT: Record<ImageSize, string> = { "1024x1024": "square 1:1", "1024x1536": "portrait 2:3", "1088x1360": "portrait 4:5" };

type GeminiImagePart = { text?: string; inlineData?: { mimeType?: string; data?: string }; thought?: boolean };
type GeminiImageBody = {
  candidates?: { content?: { parts?: GeminiImagePart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: Record<string, number>;
  modelVersion?: string;
};

function sniff(bytes: Uint8Array): ImageEditResult["contentType"] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

/** Đọc thân phản hồi `generateContent` có ảnh — HÀM THUẦN (bài kiểm gọi thẳng). Không có ảnh ⇒ ném câu lỗi nói vì sao. */
export function decodeGeminiImageBody(raw: unknown): ImageEditResult {
  const body = (raw && typeof raw === "object" ? raw : {}) as GeminiImageBody;
  const cand = body.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  const img = parts.find((p) => typeof p.inlineData?.data === "string" && p.inlineData.data.length > 0 && String(p.inlineData.mimeType ?? "").startsWith("image/"));
  if (!img?.inlineData?.data) {
    const said = parts
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text)
      .join(" ")
      .trim()
      .slice(0, 200);
    const why = body.promptFeedback?.blockReason ? `bị chặn (${body.promptFeedback.blockReason})` : cand?.finishReason && cand.finishReason !== "STOP" ? `dừng vì ${cand.finishReason}` : said ? `chỉ trả lời chữ: «${said}»` : "không trả về ảnh nào";
    throw new Error(`Gemini ${why} — model này có thể không vẽ được ảnh; kiểm ô «Model vẽ ảnh» của kết nối Gemini.`);
  }
  const bytes = new Uint8Array(Buffer.from(img.inlineData.data, "base64"));
  const contentType = sniff(bytes);
  if (!contentType) throw new Error("Ảnh Gemini trả về không phải JPEG / PNG / WEBP.");
  const u = body.usageMetadata ?? {};
  const input = Number(u.promptTokenCount);
  const output = Number(u.candidatesTokenCount);
  const usage: ImageEditUsage | null = Number.isFinite(input) && Number.isFinite(output) ? { inputTokens: input, outputTokens: output, textInputTokens: input, imageInputTokens: 0 } : null;
  // ERP chưa có bảng giá ảnh Gemini ⇒ tiền CHƯA BIẾT (null), không phải 0 — màn hình in "—" và đếm riêng "ảnh chưa có giá".
  return { bytes, contentType, usage, costUsd: null };
}

/** Ảnh bằng model vẽ của Gemini (`generateContent`, ảnh tham chiếu đi dạng `inlineData`) với khoá `gemini-byok` của tổ chức. */
export async function geminiByokImage(input: ImageEditInput, key: ByokImageKey, deps: ByokImageDeps = {}): Promise<ImageEditResult> {
  const prompt = checkPrompt(input);
  await assertConnectionOwner(key.connectorKey, key.owner);
  if (!key.apiKey) throw new Error("Kết nối Gemini của tổ chức chưa có khoá.");
  const model = input.model.trim();
  if (!/^[a-z][a-z0-9.-]{2,60}$/.test(model)) throw new Error("Chưa khai «Model vẽ ảnh» hợp lệ cho kết nối Gemini.");
  const size: ImageSize = (IMAGE_SIZES as readonly string[]).includes(input.size) ? input.size : "1024x1024";
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: `${prompt}\nOutput: ONE photorealistic image, ${GEMINI_ASPECT[size]} aspect ratio. The first attached image(s) are the REAL product photo(s).` },
          ...input.images.map((img) => ({ inlineData: { mimeType: img.contentType || "image/jpeg", data: Buffer.from(img.bytes).toString("base64") } })),
        ],
      },
    ],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  };
  const url = `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`;
  const res = await post(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key.apiKey }, body: JSON.stringify(body) }, key, deps, "Gemini");
  if (!res.ok) {
    const msg = await apiError(res);
    const hint = res.status === 404 ? ` — khoá này không gọi được model «${model}». Mở Kết nối dữ liệu → Google Gemini, sửa ô «Model vẽ ảnh» theo danh sách model khoá của bạn dùng được trong AI Studio.` : "";
    throw new Error(scrubKey(`Gemini (khoá của tổ chức) từ chối vẽ ảnh (HTTP ${res.status})${msg ? `: ${msg}` : ""}${hint}`, key.apiKey));
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new Error("Gemini trả về phản hồi không phải JSON.");
  }
  return decodeGeminiImageBody(raw);
}
