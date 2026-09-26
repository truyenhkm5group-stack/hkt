/**
 * ═══════ GỬI LẠI TIN CẢNH BÁO LARK / TELEGRAM HỎNG (Company OS · Agent N) ═══════
 *
 * Trước bản này một dòng `notifications` gửi hỏng thì `notified_at` nằm NULL vĩnh viễn: lượt quét
 * chỉ gửi dòng VỪA TẠO, nên một lần Lark chập chờn 10 giây là nhóm vận đơn không bao giờ biết có
 * việc. Nay lượt `alerts` (đã chạy mỗi 10 phút — KHÔNG thêm lịch mới) thử lại trong giới hạn.
 *
 * Ba hằng số dưới đây là THAM SỐ KỸ THUẬT (độ bền đường truyền), KHÔNG phải ngưỡng nghiệp vụ: đổi
 * chúng không đổi việc nào sinh ra, không đổi con số nào — chỉ đổi số lần gõ cửa Lark. Khai ĐÚNG MỘT
 * CHỖ ở đây; `lib/alerts/notification-delivery.ts` và kiểm thử đọc từ đây, không gõ lại con số.
 */

/**
 * CỬA SỔ GỬI LẠI — tính từ lúc dòng được TẠO. Quá cửa sổ thì thôi: một cảnh báo "đơn chờ quá hạn" tới
 * muộn nửa ngày là tiếng ồn, và nó vẫn nằm trên `/alerts` cho người mở ra xem. 6 giờ đủ phủ trọn
 * `NOTIFY_MAX_ATTEMPTS` lần thử với nhịp lùi bên dưới (kiểm thử khoá bất đẳng thức đó).
 */
export const NOTIFY_RETRY_WINDOW_MINUTES = 360;

/**
 * TRẦN SỐ LẦN THỬ — tính CẢ lần gửi đầu. Tới trần mà vẫn hỏng ⇒ "bỏ cuộc": không gõ nữa, dòng vẫn
 * mở trên `/alerts`, và trang Cần xử lý in số dòng bỏ cuộc + câu lỗi (đã che) để người cấu hình sửa.
 */
export const NOTIFY_MAX_ATTEMPTS = 5;

/**
 * NHỊP LÙI — sau lần thử thứ k (k ≥ 1) phải đợi `NOTIFY_BACKOFF_BASE_MINUTES · 2^(k−1)` phút mới thử
 * tiếp: 10 · 20 · 40 · 80 phút. Gốc 10 phút = nhịp chạy của job `alerts`; gốc nhỏ hơn không nhanh
 * hơn được, chỉ làm nhịp lùi mất nghĩa.
 */
export const NOTIFY_BACKOFF_BASE_MINUTES = 10;

/** Số phút phải đợi SAU lần thử thứ `attempts` (≥ 1) trước lần kế tiếp. */
export function notifyBackoffMinutes(attempts: number): number {
  const k = Math.max(1, Math.floor(attempts));
  return NOTIFY_BACKOFF_BASE_MINUTES * 2 ** (k - 1);
}

/** Tổng phút chờ từ lần đầu tới lần thử cuối cùng được phép — phải nhỏ hơn cửa sổ. */
export function notifyTotalBackoffMinutes(): number {
  let s = 0;
  for (let k = 1; k < NOTIFY_MAX_ATTEMPTS; k++) s += notifyBackoffMinutes(k);
  return s;
}

/** Độ dài tối đa của câu lỗi lưu vào `notify_last_error`. */
const ERROR_MAX = 300;

/**
 * CHE CÂU LỖI trước khi lưu / in. Kho PUBLIC và nhật ký job công khai: câu lỗi của `fetch` có thể mang
 * nguyên URL webhook Lark (bí mật nằm trong đường dẫn) hoặc token bot Telegram (`bot<id>:<khoá>`).
 * Che mọi URL, mọi chuỗi dạng token Telegram, mọi chuỗi dài giống khoá; cắt ngắn.
 */
export function maskDeliveryError(raw: string | null | undefined): string {
  const t = String(raw ?? "").trim() || "Gửi hỏng mà không có câu lỗi";
  const masked = t
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b(?:bot)?\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[token]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[khoá]");
  return masked.length > ERROR_MAX ? `${masked.slice(0, ERROR_MAX)}…` : masked;
}
