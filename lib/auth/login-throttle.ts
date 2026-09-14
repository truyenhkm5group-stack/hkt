/**
 * ═══════════ CHẶN DÒ MẬT KHẨU Ở MÀN ĐĂNG NHẬP ═══════════
 *
 * ERP mở ra internet, phiên đăng nhập sống 7 ngày, và trước đây `loginAction` chỉ ngủ 400 ms sau
 * mỗi lần sai — một vòng lặp gửi 150 mật khẩu/phút vẫn chạy thoải mái. Bộ đếm này giữ theo hai khoá
 * độc lập: EMAIL (chặn dò một tài khoản từ nhiều IP) và IP (chặn quét nhiều tài khoản từ một máy).
 *
 * Nằm trong bộ nhớ tiến trình: đủ cho một máy chủ ứng dụng (production chạy một container `app`);
 * khởi động lại là xoá — chấp nhận được, vì mục tiêu là làm cho việc dò trở nên tốn thời gian, không
 * phải khoá tài khoản vĩnh viễn. Hàm THUẦN theo tham số `now` để kiểm thử không phải chờ đồng hồ.
 */
export const LOGIN_THROTTLE = {
  /** Số lần sai trong cửa sổ trước khi bị chặn. */
  maxFailures: 5,
  /** Cửa sổ đếm lần sai. */
  windowMs: 15 * 60_000,
  /** Thời gian chặn sau khi vượt ngưỡng. */
  lockMs: 15 * 60_000,
} as const;

type Entry = { failures: number[]; lockedUntil: number };

const store = new Map<string, Entry>();

function entryOf(key: string): Entry {
  let e = store.get(key);
  if (!e) {
    e = { failures: [], lockedUntil: 0 };
    store.set(key, e);
  }
  return e;
}

export type LoginGate = { ok: true } | { ok: false; retryAfterSec: number };

/** Còn được thử không. Gọi TRƯỚC khi kiểm mật khẩu để lần thử bị chặn không tốn một lượt băm. */
export function loginAllowed(keys: readonly string[], now = Date.now()): LoginGate {
  let retryAfterSec = 0;
  for (const key of keys) {
    const e = store.get(key);
    if (!e) continue;
    if (e.lockedUntil > now) retryAfterSec = Math.max(retryAfterSec, Math.ceil((e.lockedUntil - now) / 1000));
  }
  return retryAfterSec > 0 ? { ok: false, retryAfterSec } : { ok: true };
}

/** Ghi một lần sai; vượt ngưỡng trong cửa sổ thì khoá. */
export function recordLoginFailure(keys: readonly string[], now = Date.now()): void {
  for (const key of keys) {
    const e = entryOf(key);
    e.failures = e.failures.filter((t) => now - t < LOGIN_THROTTLE.windowMs);
    e.failures.push(now);
    if (e.failures.length >= LOGIN_THROTTLE.maxFailures) {
      e.lockedUntil = now + LOGIN_THROTTLE.lockMs;
      e.failures = [];
    }
  }
}

/** Đăng nhập đúng thì xoá lịch sử sai của các khoá đó. */
export function clearLoginFailures(keys: readonly string[]): void {
  for (const key of keys) store.delete(key);
}

/** Chỉ cho kiểm thử: xoá toàn bộ trạng thái. */
export function resetLoginThrottle(): void {
  store.clear();
}
