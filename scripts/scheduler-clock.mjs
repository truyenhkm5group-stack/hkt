/**
 * ═══════════ LỊCH THEO ĐỒNG HỒ, KHÔNG THEO LÚC KHỞI ĐỘNG ═══════════
 *
 * Bản cũ: lượt đầu của mỗi job chạy `offset` phút SAU khi bộ lập lịch khởi động, rồi `setInterval`.
 * Mỗi lượt deploy khởi động lại bộ lập lịch, nên job có `offset` lớn hơn khoảng cách giữa hai lượt
 * deploy KHÔNG BAO GIỜ chạy. Đo 28/09/2026: deploy xong lúc 09:23 · 09:43 · 10:09 UTC (cách 20–25
 * phút), `care-return-check` (offset 27) có lịch mà `sync_runs` rỗng sau 50 phút; cùng số phận với
 * mọi job offset ≥ 20 trong ngày deploy dày.
 *
 * Nay: job chạy ở các mốc CỐ ĐỊNH trên đồng hồ — thời điểm t mà (t − offset) chia hết cho `every`,
 * tính từ mốc Unix. Job 30 phút offset 27 luôn chạy ở phút :27 và :57 mỗi giờ, dù bộ lập lịch khởi
 * động lại bao nhiêu lần. `offset` vẫn giữ đúng vai trò cũ: tách các job cùng chu kỳ ra khỏi nhau.
 *
 * Hàm THUẦN (không đọc đồng hồ, không hẹn giờ) để bài kiểm gọi thẳng — tests/scheduler-clock.test.ts.
 */

const PHUT = 60_000;

/**
 * Mốc chạy kế tiếp SAU `nowMs` (không bằng — gọi ngay tại một mốc thì trả mốc sau, để một lượt vừa
 * chạy không hẹn lại chính nó). `everyMin > 0`; `offsetMin` được đưa về [0, everyMin).
 */
export function nextRunAt(nowMs, everyMin, offsetMin = 0) {
  const every = everyMin * PHUT;
  if (!(every > 0)) throw new Error(`chu kỳ không hợp lệ: ${everyMin}`);
  const offset = (((offsetMin * PHUT) % every) + every) % every;
  const k = Math.floor((nowMs - offset) / every) + 1;
  return k * every + offset;
}

/** Khoảng chờ tới mốc kế tiếp, tính bằng mili-giây. */
export function delayUntilNext(nowMs, everyMin, offsetMin = 0) {
  return nextRunAt(nowMs, everyMin, offsetMin) - nowMs;
}
