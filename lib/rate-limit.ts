/**
 * ═══════════ XÔ LƯỢT — BỘ GIỚI HẠN TẦN SUẤT THUẦN, ĐỒNG HỒ TIÊM VÀO ═══════════
 *
 * Một khoá (một khách, một địa chỉ IP, một tổ chức…) có một XÔ `burst` lượt; mỗi yêu cầu lấy một lượt; xô tự đầy lại MỘT lượt
 * mỗi `refillMs`. Nghĩa là: bắn liền một mạch được tối đa `burst` lượt, rồi tốc độ bền vững là 1 lượt / `refillMs`. Người gửi
 * đều đặn đúng nhịp `refillMs` (hoặc chậm hơn) không bao giờ chạm trần, dù gửi bao lâu.
 *
 * ─── MỖI KHOÁ CHỈ GIỮ MỘT CON SỐ ───
 *
 * Số giữ lại là MỐC XÔ ĐẦY LẠI (`fullAt`, mili giây). Mốc đã qua ⇒ xô đầy, và khoá vắng mặt trong kho cũng chính là xô đầy.
 * Mỗi lượt lấy đẩy mốc đi thêm `refillMs` (tính từ `max(fullAt, now)`); mốc mới vượt `now + burst × refillMs` nghĩa là xô
 * đã cạn ⇒ CHẶN và KHÔNG đẩy mốc. Đây là dạng GCRA của token bucket — cùng hành vi, nhưng không phải lưu số lượt lẻ cùng mốc
 * cập nhật, và xô nào "đã đầy lại" thì nhận ra ngay bằng một phép so (`fullAt <= now`) để dọn.
 *
 * Đồng hồ lùi (chỉnh giờ máy) KHÔNG cộng thêm lượt: phần thời gian âm không được tính là đã chờ.
 *
 * Mọi hàm ở đây THUẦN theo tham số `now` (AGENTS.md mục 50 · 65): bài kiểm dựng đồng hồ, không chờ đồng hồ thật. Kho là một
 * `Map` do nơi gọi giữ — tệp này không có trạng thái của riêng nó.
 *
 * Nơi dùng: `lib/sales-chatbot/public-chat-limits.ts` (chat công khai). Các bộ chặn có sẵn (`lib/auth/login-throttle.ts` —
 * đếm lần SAI rồi khoá, `lib/constants/agent-ingest.ts`, trần theo phút của `/api/tech/worker`) giữ nguyên, không đổi.
 */

export type BucketRule = {
  /** Sức chứa của xô — số lượt được bắn liền một mạch khi xô đầy. */
  readonly burst: number;
  /** Cứ mỗi chừng này mili giây xô đầy lại MỘT lượt — cũng là nhịp bền vững tối đa. */
  readonly refillMs: number;
};

export type Admission = { ok: true; fullAt: number } | { ok: false; retryAfterMs: number };

/** Một lượt có được vào không, với mốc xô đầy lại hiện tại `fullAt` (`undefined` = xô đầy). Không ghi gì. */
export function admit(fullAt: number | undefined, rule: BucketRule, now: number): Admission {
  const next = Math.max(fullAt ?? now, now) + rule.refillMs;
  const over = next - now - rule.burst * rule.refillMs;
  return over > 0 ? { ok: false, retryAfterMs: over } : { ok: true, fullAt: next };
}

export type BucketItem<S extends string> = { readonly key: string; readonly rule: BucketRule; readonly scope: S };

export type TakeResult<S extends string> = { ok: true } | { ok: false; scope: S; retryAfterMs: number };

/** Đưa khoá xuống cuối thứ tự chèn của `Map` (= vừa được chạm) mà không đổi giá trị. */
function touch(store: Map<string, number>, key: string): void {
  const v = store.get(key);
  if (v === undefined) return;
  store.delete(key);
  store.set(key, v);
}

/**
 * Lấy MỘT lượt ở MỌI xô của một yêu cầu — TẤT CẢ HOẶC KHÔNG.
 *
 * Một xô cạn ⇒ không xô nào bị trừ và không khoá mới nào được tạo. Hai hệ quả, cả hai đều cố ý:
 *  · khách bị chặn vì gửi dồn KHÔNG làm cạn xô của cả shop (lượt bị chặn không tốn gì của ai);
 *  · shop đang bị bão KHÔNG làm cạn xô riêng của khách thật đang chờ.
 *
 * Bị chặn ⇒ báo xô phải chờ LÂU NHẤT (đó mới là lúc thử lại có ích). Xô đang chặn được "chạm" để nằm cuối thứ tự: lượt dọn
 * "khoá ít chạm nhất" (`pruneBuckets`) không bao giờ xoá trần của chính kẻ đang dội.
 */
export function takeAll<S extends string>(store: Map<string, number>, items: readonly BucketItem<S>[], now: number, maxKeys: number): TakeResult<S> {
  const next: number[] = [];
  let worst: { scope: S; retryAfterMs: number } | null = null;
  for (const it of items) {
    const a = admit(store.get(it.key), it.rule, now);
    if (a.ok) {
      next.push(a.fullAt);
      continue;
    }
    if (!worst || a.retryAfterMs >= worst.retryAfterMs) worst = { scope: it.scope, retryAfterMs: a.retryAfterMs };
    touch(store, it.key);
  }
  if (worst) return { ok: false, scope: worst.scope, retryAfterMs: worst.retryAfterMs };
  items.forEach((it, i) => {
    store.delete(it.key);
    store.set(it.key, next[i]);
  });
  if (store.size > maxKeys) pruneBuckets(store, now, maxKeys);
  return { ok: true };
}

/**
 * KHO CÓ TRẦN: không có trần thì mỗi khách bịa / mỗi IP lạ là một mục mới, và chính bộ chặn thành chỗ làm tràn RAM.
 *  · Lượt 1 — xoá mọi xô ĐÃ ĐẦY LẠI (mốc đã qua): không mất thông tin gì, vì khoá vắng mặt chính là xô đầy.
 *  · Lượt 2 — vẫn quá trần (đang có bão) ⇒ xoá khoá ÍT ĐƯỢC CHẠM NHẤT (`Map` giữ thứ tự chèn, mỗi lượt chạm đưa khoá xuống
 *    cuối) cho tới còn 90% trần — dọn một mẻ để các lượt chèn sau không phải quét lại cả kho. Khoá bị xoá ở lượt này chỉ
 *    được ĐẦY LẠI sớm (người đó được thêm lượt), không bao giờ bị chặn oan.
 */
export function pruneBuckets(store: Map<string, number>, now: number, maxKeys: number): void {
  for (const [k, fullAt] of store) if (fullAt <= now) store.delete(k);
  if (store.size <= maxKeys) return;
  const target = Math.floor(maxKeys * 0.9);
  for (const k of store.keys()) {
    if (store.size <= target) break;
    store.delete(k);
  }
}

/* ═════════════════ KHOÁ IP — CHỈ KHI ĐỊA CHỈ NÓI ĐƯỢC AI ĐANG GỌI ═════════════════ */

function parseV4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** IPv4 có định tuyến công khai — tức là địa chỉ của MỘT khách (hoặc một cổng NAT của nhà mạng), không phải một chặng nội bộ. */
function v4Public([a, b]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // "mạng này" · riêng 10/8 · loopback · đa hướng + dành riêng
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64/10: dải dùng chung PHÍA TRONG nhà mạng (CGNAT), không ra internet
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // riêng 172.16/12 — gồm cả cổng mạng docker (172.17–172.31)
  if (a === 192 && b === 168) return false; // riêng 192.168/16
  return true;
}

/** Tám nhóm 16 bit của một địa chỉ IPv6 (nhận `::` và IPv4 nhúng ở cuối), hoặc `null`. */
function parseV6(s: string): number[] | null {
  if (!/^[0-9a-f:.]+$/.test(s) || !s.includes(":")) return null;
  const dbl = s.indexOf("::");
  if (dbl !== s.lastIndexOf("::")) return null;
  const head = dbl >= 0 ? (s.slice(0, dbl) ? s.slice(0, dbl).split(":") : []) : s.split(":");
  const tail = dbl >= 0 ? (s.slice(dbl + 2) ? s.slice(dbl + 2).split(":") : []) : [];
  const groups = (parts: string[], v4LastAllowed: boolean): number[] | null => {
    const out: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.includes(".")) {
        const v4 = v4LastAllowed && i === parts.length - 1 ? parseV4(p) : null;
        if (!v4) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else if (/^[0-9a-f]{1,4}$/.test(p)) out.push(parseInt(p, 16));
      else return null;
    }
    return out;
  };
  const h = groups(head, dbl < 0);
  const t = groups(tail, true);
  if (!h || !t) return null;
  if (dbl < 0) return h.length === 8 ? h : null;
  if (h.length + t.length > 7) return null;
  return [...h, ...new Array<number>(8 - h.length - t.length).fill(0), ...t];
}

/**
 * Khoá IP cho bộ giới hạn, hoặc `null` khi địa chỉ KHÔNG nói được ai đang gọi — nơi gọi khi ấy BỎ chiều IP (vẫn còn trần theo
 * khách và theo tổ chức), không bao giờ chặn mù:
 *  · không phải IP hợp lệ (`clientIpFrom` trả `unknown`, hay một chuỗi chỉ có chữ số hex như `deadbeef`);
 *  · địa chỉ nội bộ / loopback / link-local / 100.64/10 / đa hướng: đó là một chặng proxy hay mạng docker — mọi khách đi qua
 *    nó sẽ cùng MỘT khoá, đếm theo nó là chặn cả shop vì một người.
 *
 * IPv6 gom theo /64: mỗi thuê bao được cả dải /64 và tự đổi 64 bit cuối (địa chỉ tạm thời) — khoá theo cả địa chỉ thì một máy
 * có 2^64 khoá để xoay vòng. IPv4 nằm trong IPv6 (`::ffff:1.2.3.4`) quy về chính IPv4 đó.
 */
export function rateLimitIpKey(ip: string | null | undefined): string | null {
  const s = String(ip ?? "").trim().toLowerCase();
  if (!s || s.length > 64) return null;
  const v4 = parseV4(s);
  if (v4) return v4Public(v4) ? `4:${v4.join(".")}` : null;
  const h = parseV6(s);
  if (!h) return null;
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    const mapped = [h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff];
    return v4Public(mapped) ? `4:${mapped.join(".")}` : null;
  }
  if (h.slice(0, 4).every((x) => x === 0)) return null; // ::/64 — `::` (chưa chỉ định) · `::1` (loopback) · IPv4 nhúng kiểu cũ
  if ((h[0] & 0xffc0) === 0xfe80) return null; // fe80::/10 link-local
  if ((h[0] & 0xfe00) === 0xfc00) return null; // fc00::/7 địa chỉ nội bộ
  if ((h[0] & 0xff00) === 0xff00) return null; // ff00::/8 đa hướng
  return `6:${h.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}
