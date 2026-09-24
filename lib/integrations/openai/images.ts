import { PIXEL_SAFE_EDIT_LABEL, PIXEL_SAFE_SOURCE_KINDS, type ImageQuality, type ImageSize } from "@/lib/constants/creative-loop";
import { env } from "@/lib/env";

/**
 * ═══════════ OPENAI gpt-image — SỬA ẢNH SẢN PHẨM THẬT ═══════════
 *
 * Một lời gọi `POST /v1/images/edits` (multipart), KHÔNG phụ thuộc CSDL, không cần SDK: `FormData`
 * + `Blob` của Node 22 là đủ, và giữ tệp này đọc được từ đầu tới cuối.
 *
 * ─── HÀNG RÀO Ở RANH GIỚI HÀM (đặc tả `docs/creative-loop.md` §2, ranh giới 2) ───
 *
 * Điểm ảnh gửi sang máy SINH ảnh chỉ được là ảnh CỦA SHOP: ảnh sản phẩm thật (`PRODUCT_PHOTO`) và
 * ảnh của chính shop (`OWN_VARIANT` — mẫu cha của vòng, HOẶC quảng cáo cũ của shop nguồn `OWN_AD`).
 * Ảnh SPY / tay / R&D không bao giờ tới đây. Kiểu TypeScript
 * đã nói điều đó, nhưng kiểu biến mất lúc chạy — một `as` ở nơi gọi là đủ để lọt. Nên hàm KIỂM LẠI
 * từng ảnh lúc chạy và NÉM LỖI trước khi dựng một byte nào của yêu cầu.
 *
 * Và mọi lượt sửa phải có ít nhất một ảnh `PRODUCT_PHOTO` (ranh giới 3): máy không được vẽ một sản
 * phẩm nó không nhìn thấy.
 *
 * ─── KHOÁ ───
 *
 * `OPENAI_API_KEY` qua `env.openaiRest.apiKey`, chỉ đi vào tiêu đề `Authorization`. Câu lỗi dựng từ
 * mã HTTP + câu lỗi OpenAI trả về, không bao giờ từ tiêu đề đã gửi.
 */

export const OPENAI_IMAGES_EDIT_URL = "https://api.openai.com/v1/images/edits";

/**
 * NHÃN ảnh được gửi điểm ảnh: ảnh sản phẩm thật + ảnh của chính shop. Mọi loại nguồn trong
 * `PIXEL_SAFE_SOURCE_KINDS` quy về đúng hai nhãn này qua `PIXEL_SAFE_EDIT_LABEL` (`PRODUCT_PHOTO` giữ
 * nhãn, `OWN_AD` đi dưới nhãn `OWN_VARIANT`) — `tests/creative-loop.test.ts` khoá phép quy ấy. Nhãn
 * nguồn thô (`OWN_AD`, `SPY`…) tới đây là bị chặn: chỉ `gatherPixels()` đặt nhãn, sau khi kiểm loại
 * trong CSDL.
 */
export const IMAGE_EDIT_ALLOWED_KINDS = [...new Set([...PIXEL_SAFE_SOURCE_KINDS.flatMap((k) => PIXEL_SAFE_EDIT_LABEL[k] ?? []), "OWN_VARIANT"])] as readonly string[];
export type ImageEditKind = "PRODUCT_PHOTO" | "OWN_VARIANT";

export type ImageEditInputImage = { kind: ImageEditKind; bytes: Uint8Array; contentType: string };

export type ImageEditInput = {
  model: string;
  prompt: string;
  images: ImageEditInputImage[];
  size: ImageSize;
  quality: ImageQuality;
};

/** `usage` OpenAI trả về cho gpt-image — giữ nguyên số token, không làm tròn. */
export type ImageEditUsage = {
  inputTokens: number;
  outputTokens: number;
  textInputTokens: number;
  imageInputTokens: number;
};

export type ImageEditResult = {
  bytes: Uint8Array;
  contentType: "image/jpeg";
  usage: ImageEditUsage | null;
  /** Ước tính theo bảng giá token bên dưới. `null` = CHƯA BIẾT (không có `usage` hoặc model lạ). */
  costUsd: number | null;
};

export type ImageEditDeps = {
  fetchImpl?: typeof fetch;
  /** Chỉ kiểm thử truyền. Bỏ trống ⇒ đọc `OPENAI_API_KEY`. */
  apiKey?: string;
  timeoutMs?: number;
};

/** Trần chờ một lượt sinh ảnh — gpt-image chất lượng cao có lúc mất hơn một phút. */
export const IMAGE_EDIT_TIMEOUT_MS = 180_000;

/** gpt-image nhận tối đa 16 ảnh đầu vào. */
const MAX_INPUT_IMAGES = 16;

/**
 * ═══ BẢNG GIÁ TOKEN — ƯỚC TÍNH, KHÔNG PHẢI HOÁ ĐƠN ═══
 *
 * Nguồn: trang giá công bố của OpenAI cho `gpt-image-1` (USD / 1 triệu token): chữ đầu vào $5,
 * ảnh đầu vào $10, ảnh đầu ra $40. Bảng GIÁ MỘT ẢNH dùng để CHẶN TRƯỚC khi gọi nằm ở hợp đồng
 * (`estimateImageUsd`); bảng này dùng để ghi chi phí SAU khi gọi, theo đúng số token OpenAI đếm.
 *
 * Model không có trong bảng ⇒ `null` (CHƯA BIẾT), không đoán — cập nhật bảng khi có giá niêm yết.
 * Chỉ khớp đúng tên hoặc tên kèm hậu tố NGÀY (`gpt-image-1-2025…`): `gpt-image-1-mini` là một model
 * khác với giá khác, khớp theo tiền tố trần sẽ tính nhầm giá.
 */
export const GPT_IMAGE_TOKEN_PRICE_PER_MTOK: Record<string, { textInput: number; imageInput: number; imageOutput: number }> = {
  "gpt-image-1": { textInput: 5, imageInput: 10, imageOutput: 40 },
};

function priceKeyOf(model: string): string | null {
  for (const k of Object.keys(GPT_IMAGE_TOKEN_PRICE_PER_MTOK)) {
    if (model === k || new RegExp(`^${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{4}`).test(model)) return k;
  }
  return null;
}

export function imageEditCostUsd(model: string, usage: ImageEditUsage | null): number | null {
  if (!usage) return null;
  const k = priceKeyOf(model);
  if (!k) return null;
  const p = GPT_IMAGE_TOKEN_PRICE_PER_MTOK[k];
  const usd = (usage.textInputTokens * p.textInput + usage.imageInputTokens * p.imageInput + usage.outputTokens * p.imageOutput) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null;
}

/** Đọc `usage` từ phong bì. Thiếu số nào quan trọng ⇒ `null` (CHƯA BIẾT), không điền 0. */
export function parseImageUsage(raw: unknown): ImageEditUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null || output === null) return null;
  const d = u.input_tokens_details && typeof u.input_tokens_details === "object" ? (u.input_tokens_details as Record<string, unknown>) : null;
  const text = num(d?.text_tokens);
  const image = num(d?.image_tokens);
  // Không tách được chữ / ảnh thì tính cả phần đầu vào theo giá ẢNH (đắt hơn) — hướng an toàn.
  return { inputTokens: input, outputTokens: output, textInputTokens: text ?? (image === null ? 0 : Math.max(0, input - image)), imageInputTokens: image ?? (text === null ? input : Math.max(0, input - text)) };
}

/** Hàng rào lúc chạy — xem đầu tệp. Ném lỗi tiếng Việt nêu đúng ảnh vi phạm. */
export function assertPixelSafe(images: readonly { kind: unknown }[]): void {
  if (!Array.isArray(images) || images.length === 0) throw new Error("Sinh ảnh cần ít nhất một ảnh sản phẩm thật làm gốc.");
  if (images.length > MAX_INPUT_IMAGES) throw new Error(`Tối đa ${MAX_INPUT_IMAGES} ảnh đầu vào cho một lượt sinh ảnh.`);
  images.forEach((img, i) => {
    if (!(IMAGE_EDIT_ALLOWED_KINDS as readonly unknown[]).includes(img.kind)) {
      throw new Error(`Ảnh #${i + 1} mang loại "${String(img.kind)}" — chỉ ảnh sản phẩm thật và ảnh mẫu của chính shop được gửi sang máy sinh ảnh (ranh giới 2 của vòng mẫu).`);
    }
  });
  if (!images.some((img) => img.kind === "PRODUCT_PHOTO")) throw new Error("Thiếu ảnh sản phẩm thật (PRODUCT_PHOTO) — máy không vẽ sản phẩm nó không nhìn thấy (ranh giới 3 của vòng mẫu).");
}

function extOf(contentType: string): string {
  return contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function buildForm(input: ImageEditInput): FormData {
  const form = new FormData();
  form.append("model", input.model);
  input.images.forEach((img, i) => {
    // Chép sang một ArrayBuffer riêng: `Blob` không nhận thẳng một view trên bộ đệm dùng chung.
    const copy = new Uint8Array(img.bytes.byteLength);
    copy.set(img.bytes);
    form.append("image[]", new Blob([copy.buffer], { type: img.contentType }), `ref-${i + 1}-${img.kind.toLowerCase()}.${extOf(img.contentType)}`);
  });
  form.append("prompt", input.prompt);
  form.append("size", input.size);
  form.append("quality", input.quality);
  form.append("output_format", "jpeg");
  form.append("n", "1");
  return form;
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } };
    const msg = typeof body?.error?.message === "string" ? body.error.message : "";
    return msg.slice(0, 300);
  } catch {
    return "";
  }
}

/**
 * Sửa ảnh sản phẩm thật theo câu lệnh. Thử lại tối đa MỘT lần, và CHỈ với 429 / 5xx — lỗi 4xx khác
 * (câu lệnh bị từ chối, khoá sai) gọi lại cũng ra đúng lỗi ấy, chỉ tốn thêm thời gian.
 */
export async function editImage(input: ImageEditInput, deps: ImageEditDeps = {}): Promise<ImageEditResult> {
  assertPixelSafe(input.images);
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw new Error("Câu lệnh sinh ảnh trống.");
  const apiKey = deps.apiKey ?? env.openaiRest.apiKey;
  if (!apiKey) throw new Error("Chưa có OPENAI_API_KEY trên máy chủ — không sinh ảnh được.");
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? IMAGE_EDIT_TIMEOUT_MS;

  let res: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      res = await doFetch(OPENAI_IMAGES_EDIT_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: buildForm({ ...input, prompt }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      throw new Error(name === "TimeoutError" || name === "AbortError" ? `Sinh ảnh quá ${Math.round(timeoutMs / 1000)} giây — đã bỏ.` : `Không gọi được OpenAI: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.ok || !retryable(res.status) || attempt === 1) break;
  }
  if (!res) throw new Error("Không gọi được OpenAI.");
  if (!res.ok) {
    const msg = await errorText(res);
    throw new Error(`OpenAI từ chối sinh ảnh (HTTP ${res.status})${msg ? `: ${msg}` : ""}.`);
  }

  let body: { data?: { b64_json?: unknown }[]; usage?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new Error("OpenAI trả về phản hồi không phải JSON.");
  }
  const b64 = body.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || !b64) throw new Error("OpenAI không trả về ảnh nào.");
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (!isJpeg(bytes)) throw new Error("Ảnh OpenAI trả về không phải JPEG.");
  const usage = parseImageUsage(body.usage);
  return { bytes, contentType: "image/jpeg", usage, costUsd: imageEditCostUsd(input.model, usage) };
}

/** Kiểu để TIÊM: kiểm thử truyền một bản giả cùng hình dạng, không gọi mạng. */
export type ImageEditClient = typeof editImage;
