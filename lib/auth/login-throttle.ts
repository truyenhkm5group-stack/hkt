/**
 * ═══════════ CHẶN DÒ MẬT KHẨU Ở MÀN ĐĂNG NHẬP ═══════════
 *
 * ERP mở ra internet, phiên đăng nhập sống 7 ngày, và trước đây `loginAction` chỉ ngủ 400 ms sau
 * mỗi lần sai — một vòng lặp gửi 150 mật khẩu/phút vẫn chạy thoải mái.
 *
 * ─── KHOÁ THEO CẶP (EMAIL, IP), KHÔNG THEO EMAIL ───
 *
 * Bản đầu khoá theo EMAIL. Nghe chặt, nhưng nó biến bộ chặn thành vũ khí: ai biết email của chủ
 * shop chỉ cần gõ sai 5 lần từ BẤT KỲ máy nào là khoá chủ shop khỏi ERP 15 phút — lặp lại mãi. Nay:
 *
 *  · CẶP `(email, IP)`: 5 lần sai ⇒ khoá cặp đó 15 phút. Kẻ dò ở máy khác không đụng được tới
 *    người thật đang ngồi ở IP của họ.
 *  · IP: trần CAO hơn (`maxFailuresPerIp`) cho mọi email từ một máy — chặn quét nhiều tài khoản.
 *    Văn phòng dùng chung một IP thì trần này phải đủ rộng cho vài người gõ nhầm cùng lúc.
 *
 * Đăng nhập đúng chỉ xoá CẶP, không xoá IP: xoá cả IP thì ai có MỘT tài khoản thật trên cùng máy
 * có thể "đặt lại" bộ đếm IP sau mỗi 29 lần dò tài khoản khác.
 *
 * Giới hạn đã biết: dò PHÂN TÁN (nhiều IP nhắm một email) chỉ bị chặn bởi trần mỗi cặp + độ chậm
 * của phép băm mật khẩu. Chặn nó theo email là mở lại đúng cửa khoá-người-khác ở trên — chọn không.
 *
 * ─── BỘ NHỚ CÓ TRẦN ───
 *
 * `Map` trong tiến trình (production chạy một container `app`; khởi động lại là xoá — chấp nhận
 * được). Không có trần thì mỗi cặp (email bịa, IP) là một mục mới và kẻ dò làm phình bộ nhớ tới lúc
 * tiến trình chết. Đầy thì loại mục CŨ NHẤT — nhưng ưu tiên loại mục CHƯA BỊ KHOÁ, để kẻ dò không
 * "xả" được khoá của chính mình bằng cách đổ vào vài nghìn khoá rác.
 *
 * Hàm THUẦN theo tham số `now` để kiểm thử không phải chờ đồng hồ.
 */
export const LOGIN_THROTTLE = {
  /** Số lần sai của MỘT cặp (email, IP) trong cửa sổ trước khi khoá cặp đó. */
  maxFailures: 5,
  /** Số lần sai từ MỘT IP (mọi email cộng lại) trước khi khoá IP đó. */
  maxFailuresPerIp: 30,
  /** Cửa sổ đếm lần sai. */
  windowMs: 15 * 60_000,
  /** Thời gian chặn sau khi vượt ngưỡng. */
  lockMs: 15 * 60_000,
  /** Trần số mục trong bộ nhớ. */
  maxEntries: 10_000,
} as const;

type Entry = { failures: number[]; lockedUntil: number };

const store = new Map<string, Entry>();

/** Hai khoá của một lượt đăng nhập. Nơi gọi KHÔNG tự dựng khoá — một chỗ khai, một chỗ đếm. */
export function loginThrottleKeys(email: string, ip: string): string[] {
  return [`pair:${email}|${ip}`, `ip:${ip}`];
}

function limitOf(key: string): number {
  return key.startsWith("ip:") ? LOGIN_THROTTLE.maxFailuresPerIp : LOGIN_THROTTLE.maxFailures;
}

function evictIfFull(now: number) {
  if (store.size < LOGIN_THROTTLE.maxEntries) return;
  // Lượt 1: mục hết hạn (không khoá, không còn lần sai nào trong cửa sổ) — không mất thông tin gì.
  for (const [k, e] of store) {
    if (e.lockedUntil <= now && e.failures.every((t) => now - t >= LOGIN_THROTTLE.windowMs)) store.delete(k);
  }
  if (store.size < LOGIN_THROTTLE.maxEntries) return;
  // Lượt 2: mục cũ nhất CHƯA bị khoá (Map giữ thứ tự chèn).
  for (const [k, e] of store) {
    if (e.lockedUntil <= now) {
      store.delete(k);
      return;
    }
  }
  // Lượt 3: toàn mục đang khoá — loại cái cũ nhất. Trần bộ nhớ thắng.
  const oldest = store.keys().next();
  if (!oldest.done) store.delete(oldest.value);
}

function entryOf(key: string, now: number): Entry {
  let e = store.get(key);
  if (!e) {
    evictIfFull(now);
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

/** Ghi một lần sai; vượt ngưỡng của khoá đó trong cửa sổ thì khoá. */
export function recordLoginFailure(keys: readonly string[], now = Date.now()): void {
  for (const key of keys) {
    const e = entryOf(key, now);
    e.failures = e.failures.filter((t) => now - t < LOGIN_THROTTLE.windowMs);
    e.failures.push(now);
    if (e.failures.length >= limitOf(key)) {
      e.lockedUntil = now + LOGIN_THROTTLE.lockMs;
      e.failures = [];
      // Đưa mục vừa khoá xuống cuối thứ tự chèn: lượt loại "cũ nhất" gặp mục chưa khoá trước.
      store.delete(key);
      store.set(key, e);
    }
  }
}

/** Đăng nhập đúng thì xoá lịch sử sai của CẶP (không xoá IP — xem đầu tệp). */
export function clearLoginFailures(keys: readonly string[]): void {
  for (const key of keys) if (key.startsWith("pair:")) store.delete(key);
}

/** Chỉ cho kiểm thử: số mục đang giữ. */
export function loginThrottleSize(): number {
  return store.size;
}

/** Chỉ cho kiểm thử: xoá toàn bộ trạng thái. */
export function resetLoginThrottle(): void {
  store.clear();
}
