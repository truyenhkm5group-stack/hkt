/**
 * ═══════════ PANCAKE GIỚI HẠN TỐC ĐỘ KHI GỬI ⇒ LỜI GỬI CỦA BOT ĐƯỢC ƯU TIÊN (10/10/2026) ═══════════
 *
 * Đo HSLC 10/10/2026 (ops `org-order-audit --replies`): 39/145 tin khách trong buổi sáng bot ĐÃ soạn câu trả lời nhưng Pancake
 * trả «Too many requests» lúc gửi ⇒ tin `DEAD`, khách không nhận gì (09/10 chỉ 1 tin). Mọi lời gọi Pancake của page — gửi tin
 * của bot, đọc lại hội thoại, NHẬP LỊCH SỬ hộp thư (150 lời gọi / phút liên tục) — dùng CHUNG một token page và chung một hạn
 * mức. Lời gửi của bot là thứ duy nhất khách đang chờ, nên khi nó bị 429 thì các đường đọc nền phải nhường.
 *
 * Mốc giữ trong BỘ NHỚ tiến trình (một container ứng dụng chạy cả webhook lẫn vòng nhập lịch sử): mất khi khởi động lại là chấp
 * nhận được — lần 429 kế tiếp ghi lại ngay. Không ghi CSDL mỗi lần 429 (đúng lúc hệ thống đang bị dồn).
 */

const lastLimitedAt = new Map<string, number>();

/** Đường nền (nhập lịch sử…) nhường lời gửi của bot chừng này sau lần 429 gần nhất. */
export const SEND_PRIORITY_MS = 3 * 60_000;

export function noteSendRateLimited(pageId: string, nowMs: number = Date.now()): void {
  lastLimitedAt.set(pageId, nowMs);
}

/** Lời gửi tin của page vừa bị Pancake 429 trong `withinMs` qua. */
export function sendRecentlyLimited(pageId: string, nowMs: number = Date.now(), withinMs: number = SEND_PRIORITY_MS): boolean {
  const at = lastLimitedAt.get(pageId);
  return at !== undefined && nowMs - at < withinMs;
}

/** Chỉ cho bài kiểm. */
export function resetSendPressureForTests(): void {
  lastLimitedAt.clear();
}
