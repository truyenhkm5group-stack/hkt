import type { AiImage, AiImageMime } from "@/lib/ai/images";
import type { AiProvider, AiResponse } from "@/lib/ai/provider";

/**
 * ═══════════ BOT ĐỌC ẢNH KHÁCH GỬI (docs/platform/quick-start.md §8) ═══════════
 *
 * Trước: khách gửi ảnh không chữ («còn mẫu này không shop») ⇒ webhook bỏ qua «để nhân viên xem» — bot im, khách chờ. Khách
 * thời trang / hải sản gửi ảnh chụp mẫu RẤT hay, và đó là lúc họ muốn mua nhất.
 *
 * Sau: ảnh của tin khách được giữ địa chỉ (`sales_chat_inbound.image_urls`, 0195). Tới lượt trả lời, máy chủ tải ảnh (chỉ tên
 * miền ảnh của Facebook / Pancake, có trần dung lượng, nhận kiểu ảnh bằng CHỮ KÝ tệp — không tin đầu phản hồi) và nhờ CHÍNH AI
 * của bot (cùng khoá, cùng hạn mức, cùng sổ chi phí) mô tả ngắn. Mô tả vào lượt dưới dạng MỘT dòng chữ
 * «[Khách gửi ảnh: …]» — mọi đường sau (câu mẫu, công cụ tìm sản phẩm, lịch sử, sổ tay, bài học) không cần biết ảnh là gì.
 *
 * Không đọc được (tên miền lạ, tệp hỏng, AI lỗi, hết hạn mức) ⇒ dòng «[Khách gửi N ảnh — bot chưa xem được]»: bot vẫn trả lời
 * (hỏi khách mô tả mẫu / gửi tên mẫu) thay vì im lặng. Không bao giờ bịa nội dung ảnh.
 */

export const VISION_LIMITS = {
  /** Ảnh tối đa mỗi lượt — khách gửi album 10 ảnh thì 3 ảnh đầu đủ để hiểu ý; mỗi ảnh là tiền. */
  imagesPerTurn: 3,
  /** Ảnh lớn hơn ⇒ bỏ (ảnh Messenger thường < 1 MB). */
  maxBytes: 5_000_000,
  fetchTimeoutMs: 10_000,
  describeMaxTokens: 300,
  /** Mô tả dài hơn ⇒ cắt (một dòng trong tin khách, không phải bài văn). */
  descriptionMax: 600,
} as const;

/**
 * Tên miền ảnh được tải: CDN ảnh của Facebook / Messenger / Instagram và Pancake. Địa chỉ ảnh tới từ webhook (đã xác thực bằng
 * bí mật trong URL) — vẫn KHÔNG tải tên miền khác: máy chủ đi lấy một URL bất kỳ là cửa SSRF vào mạng nội bộ.
 */
export const VISION_HOST_SUFFIXES = ["fbcdn.net", "fbsbx.com", "cdninstagram.com", "pancake.vn", "pages.fm"] as const;

export function allowedImageUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  const host = u.hostname.toLowerCase();
  return VISION_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Địa chỉ ẢNH trong một tin Pancake (`message.attachments`). Nhận `photo` / `image` (và tệp không khai loại mà có `image_data`
 * hoặc đuôi ảnh). KHÔNG nhận nhãn dán (`sticker`, có `sticker_id`) — 👍 không phải câu hỏi; không nhận video / ghi âm / tệp.
 * Trùng ⇒ một. Tối đa `VISION_LIMITS.imagesPerTurn`. HÀM THUẦN.
 */
export function pancakeImageUrls(message: unknown): string[] {
  const m = (message && typeof message === "object" ? message : {}) as { attachments?: unknown };
  const list = Array.isArray(m.attachments) ? m.attachments : [];
  const out: string[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    const type = str(a.type).toLowerCase();
    if (type === "sticker" || a.sticker_id) continue;
    const payload = (a.payload && typeof a.payload === "object" ? a.payload : {}) as Record<string, unknown>;
    const url = str(a.url) || str(payload.url) || str((a.image_data as Record<string, unknown> | undefined)?.url) || str(a.preview_url);
    if (!url) continue;
    const looksImage = type === "photo" || type === "image" || (!type && (Boolean(a.image_data) || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url)));
    if (!looksImage || out.includes(url)) continue;
    out.push(url);
    if (out.length >= VISION_LIMITS.imagesPerTurn) break;
  }
  return out;
}

/** Kiểu ảnh theo CHỮ KÝ tệp (không tin `content-type`). Không phải bốn kiểu nhận được ⇒ `null`. HÀM THUẦN. */
export function sniffImageMime(b: Uint8Array): AiImageMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/**
 * Tải MỘT ảnh: tên miền trong danh sách, chuyển hướng chỉ tới tên miền trong danh sách (tối đa 3 lần), trần dung lượng ĐỌC
 * TỪNG KHÚC (không tin `content-length`), kiểu theo chữ ký. Hỏng ⇒ `null`, không ném.
 */
export async function fetchCustomerImage(url: string, fetchImpl: typeof fetch = fetch): Promise<AiImage | null> {
  let current = url;
  try {
    for (let hop = 0; hop <= 3; hop++) {
      if (!allowedImageUrl(current)) return null;
      const res = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(VISION_LIMITS.fetchTimeoutMs) });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get("location");
        if (!next) return null;
        current = new URL(next, current).toString();
        continue;
      }
      if (!res.ok || !res.body) return null;
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > VISION_LIMITS.maxBytes) {
          await reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      const mimeType = sniffImageMime(bytes);
      return mimeType ? { mimeType, data: Buffer.from(bytes).toString("base64") } : null;
    }
    return null;
  } catch {
    return null;
  }
}

export const VISION_SYSTEM = [
  "Bạn mô tả ảnh khách hàng gửi cho một shop bán hàng online, để nhân viên bán hàng (không nhìn thấy ảnh) hiểu khách muốn gì.",
  "Viết tiếng Việt, tối đa 2 câu ngắn, KHÔNG chào hỏi, KHÔNG đoán giá, KHÔNG đoán tên thương hiệu nếu không đọc được chữ trên ảnh.",
  "Ưu tiên: đây là sản phẩm gì, màu, kiểu dáng / chất liệu / kích cỡ nhìn thấy, và MỌI CHỮ đọc được trên ảnh (tên mẫu, mã, size, giá in trên ảnh).",
  "Ảnh chụp màn hình chuyển khoản / hoá đơn ⇒ nói rõ «ảnh chụp chuyển khoản», chép số tiền và nội dung chuyển khoản đọc được.",
  "Ảnh chụp tin nhắn / bài đăng / địa chỉ / số điện thoại ⇒ chép lại phần chữ chính.",
  "Ảnh không rõ / không liên quan mua bán ⇒ nói ngắn đó là ảnh gì.",
].join("\n");

/** Gọi AI mô tả ảnh. Ném khi nhà cung cấp lỗi (nơi gọi ghi sổ lỗi và lùi về dòng «chưa xem được»). */
export async function describeImages(provider: AiProvider, images: readonly AiImage[]): Promise<{ text: string; res: AiResponse }> {
  const res = await provider.complete({
    system: VISION_SYSTEM,
    messages: [{ role: "user", content: [{ type: "text", text: images.length > 1 ? `Khách vừa gửi ${images.length} ảnh. Mô tả chung các ảnh.` : "Khách vừa gửi ảnh này." }] }],
    tools: [],
    images: [...images],
    maxTokens: VISION_LIMITS.describeMaxTokens,
    reasoning: "low",
  });
  const text = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, VISION_LIMITS.descriptionMax);
  return { text, res };
}

/** Dòng chữ đưa vào lượt của khách. `description` rỗng / `null` ⇒ nói thẳng là chưa xem được. HÀM THUẦN. */
export function imageLine(count: number, description: string | null): string {
  const n = Math.max(1, count);
  const d = (description ?? "").replace(/[[\]]/g, "").trim();
  if (d) return `[Khách gửi ${n > 1 ? `${n} ảnh` : "ảnh"}: ${d}]`;
  return `[Khách gửi ${n > 1 ? `${n} ảnh` : "ảnh"} — bot chưa xem được ảnh]`;
}

/** Luật cho lời nhắc hệ thống — cách bot dùng dòng ảnh. */
export const IMAGE_PROMPT_RULE =
  "9. ẢNH KHÁCH GỬI: dòng «[Khách gửi ảnh: …]» là MÔ TẢ do máy đọc ảnh, có thể sai — dùng nó để search_products tìm mẫu gần nhất rồi HỎI KHÁCH XÁC NHẬN đúng mẫu («có phải mẫu … không ạ?»), không khẳng định chắc chắn. Ảnh chụp chuyển khoản ⇒ cảm ơn ngắn, nói shop sẽ kiểm tra, handoff_to_human với reason «Khách gửi ảnh chuyển khoản». Dòng «bot chưa xem được ảnh» ⇒ nhờ khách gửi tên / mô tả mẫu bằng chữ, KHÔNG đoán nội dung ảnh.";
