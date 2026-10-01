/**
 * ═══════════ GỐC API TELEGRAM — ĐI THẲNG HAY QUA RELAY (01/10/2026) ═══════════
 *
 * Đo trên production: máy chủ ERP (Việt Nam) tới api.telegram.org lúc được lúc không — 16:42 gửi được, từ 21:12 liên tục
 * `ETIMEDOUT` (nhà mạng chặn Telegram ở tầng IP). Thử lại không vượt được một lần chặn kéo dài; cần một đường KHÁC.
 *
 * `TELEGRAM_API_BASE` (biến của máy chủ, chủ nền tảng đặt qua GitHub Variable → deploy) trỏ tới relay của CHÍNH nền tảng
 * ngoài Việt Nam — `deploy/telegram-relay-worker.js` (Cloudflare Worker, chỉ chuyển tiếp `getMe` · `getUpdates` ·
 * `sendMessage`, không lưu gì). Trống / sai dạng ⇒ đi thẳng `https://api.telegram.org` như cũ — hỏng về phía an toàn.
 *
 * CHỈ nhận `https://<tên miền>[/đường]` — không IP, không cổng, không truy vấn, không thông tin đăng nhập: bot token của tổ
 * chức nằm trong ĐƯỜNG DẪN, nên địa chỉ này là nơi token được gửi tới. Đây là biến HẠ TẦNG do chủ nền tảng đặt (cùng người
 * kiểm soát mã nguồn), không phải cấu hình của tổ chức. Tệp không import gì — client import được (form đọc mẫu token).
 */
export const TELEGRAM_API_DEFAULT = "https://api.telegram.org";

/** Tên miền thật (nhãn cuối là chữ — không IP), không cổng / truy vấn / đăng nhập; đường dẫn tuỳ chọn. */
const BASE_PATTERN = /^https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(\/[A-Za-z0-9._~-]+)*$/;

/** Gốc API Telegram đang dùng. HÀM THUẦN theo `raw` (mặc định đọc biến của máy chủ; ở trình duyệt luôn là mặc định). */
export function telegramApiBase(raw: string | undefined = typeof process !== "undefined" ? process.env.TELEGRAM_API_BASE : undefined): string {
  const v = (raw ?? "").trim().replace(/\/+$/, "");
  return BASE_PATTERN.test(v) ? v : TELEGRAM_API_DEFAULT;
}

/** Tên máy để in trong câu lỗi (không bao giờ in token). */
export function telegramApiHost(raw?: string): string {
  return new URL(telegramApiBase(raw)).host;
}
