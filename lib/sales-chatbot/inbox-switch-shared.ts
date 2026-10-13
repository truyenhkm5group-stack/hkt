/**
 * ═══════════ CHUYỂN HỘI THOẠI + TỰ LÀM MỚI HỘP THƯ — PHẦN THUẦN (P0 inbox-list-perf 13/10/2026) ═══════════
 *
 * Production HSLC 13/10: mở hội thoại kẹt «Đang mở hội thoại…». Đo (ops inbox-perf-probe): nạp MỘT hội thoại 155 ms (p95 606 ms) nhưng
 * dựng lại danh sách (`listInbox`) 13–29 giây. Hai lối làm danh sách chạy lại khi người chỉ bấm sang hội thoại khác:
 *  1. khung chat gọi `router.refresh()` 1,5 giây sau mỗi lần chuyển («đối soát nền») — dựng lại CẢ trang;
 *  2. tự làm mới mỗi 5 giây, nhả cờ «bận» sau 4 giây dù lượt trước chưa xong ⇒ máy chủ chậm 13 giây là ba lượt chồng nhau trên bể 2
 *     kết nối, và lượt nạp hội thoại (route riêng) phải xếp hàng sau chúng.
 * Nay: chuyển hội thoại CHỈ gọi route nạp hội thoại (không làm mới trang); tự làm mới không bao giờ chồng lượt và giãn nhịp theo thời
 * gian lượt trước thật sự mất; nạp hội thoại có hạn chờ + nút thử lại, câu trả lời cũ không đè hội thoại đang chọn.
 * Tệp này không import gì của máy chủ — client component dùng được.
 */

/** Hạn chờ một lượt nạp hội thoại (route `/api/ai-sales/inbox-thread`). Quá hạn ⇒ huỷ request, hiện lỗi + «Thử lại». */
export const THREAD_FETCH_TIMEOUT_MS = 20_000;
/** Trần giãn nhịp tự làm mới khi máy chủ chậm. */
export const REFRESH_MAX_DELAY_MS = 60_000;

/**
 * Nhịp tới lượt tự làm mới kế tiếp, tính từ lúc lượt trước XONG: bình thường `everyMs`; lượt trước mất lâu hơn `everyMs` ⇒ chờ gấp đôi
 * thời gian nó mất (máy chủ đang quá tải — hỏi dồn chỉ làm nó chậm thêm), trần `REFRESH_MAX_DELAY_MS`. HÀM THUẦN.
 */
export function nextRefreshDelayMs(everyMs: number, tookMs: number | null): number {
  const base = Math.max(1_000, everyMs);
  if (tookMs === null || !Number.isFinite(tookMs) || tookMs <= base) return base;
  return Math.min(REFRESH_MAX_DELAY_MS, Math.max(base, Math.round(tookMs * 2)));
}

/** Có tới lượt tự làm mới chưa: không lượt nào đang chạy, đã qua mốc hẹn, và tab đang mở (tab ẩn: thưa gấp `hiddenFactor`). HÀM THUẦN. */
export function refreshDue(s: { pending: boolean; now: number; notBefore: number; visible: boolean; lastDoneAt: number; everyMs: number; hiddenFactor?: number }): boolean {
  if (s.pending || s.now < s.notBefore) return false;
  if (s.visible) return true;
  return s.now - s.lastDoneAt >= Math.max(1_000, s.everyMs) * (s.hiddenFactor ?? 6);
}

/** Một bản payload hội thoại kèm mốc nhận (ms) — bản trang dựng hoặc bản route trả. */
export type StampedPayload<P> = { at: number; payload: P };

/**
 * Bản khung chat hiện cho hội thoại `selected`: MỚI NHẤT trong hai — bản trang dựng (chỉ khi đúng hội thoại đó) và bản route đã nạp CHO
 * ĐÚNG hội thoại đó. Không có bản nào ⇒ `null` («Đang mở…»). Câu trả lời của hội thoại khác không bao giờ được chọn. HÀM THUẦN.
 */
export function pickThreadPayload<P>(selected: string | null, fromServer: { id: string | null; s: StampedPayload<P> | null }, fetched: ReadonlyMap<string, StampedPayload<P>>): StampedPayload<P> | null {
  if (!selected) return null;
  const a = fromServer.id === selected ? fromServer.s : null;
  const b = fetched.get(selected) ?? null;
  return a && b ? (a.at >= b.at ? a : b) : (a ?? b);
}

/** Câu trả lời của route có được ghi không: chỉ khi hội thoại người dùng ĐANG chọn vẫn là hội thoại đã hỏi (bấm A→B→C nhanh: A, B về muộn thì bỏ). HÀM THUẦN. */
export function acceptThreadResponse(requested: string, currentlyWanted: string | null): boolean {
  return currentlyWanted === requested;
}

/** Bản trang dựng còn đủ mới để KHỎI nạp lại bằng route (vừa mở bằng đường dẫn / vừa làm mới). HÀM THUẦN. */
export function serverPayloadFresh<P>(selected: string, fromServer: { id: string | null; s: StampedPayload<P> | null }, now: number, maxAgeMs = 2_000): boolean {
  return fromServer.id === selected && fromServer.s !== null && now - fromServer.s.at < maxAgeMs;
}
