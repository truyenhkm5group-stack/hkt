import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * ═══════════ TẢI MỘT ĐỊA CHỈ CÔNG KHAI DO NGƯỜI DÙNG GÕ — KHÔNG PHẢI CỬA VÀO MẠNG NỘI BỘ (SSRF) ═══════════
 *
 * Dùng khi máy chủ phải đi lấy một URL người dùng đưa (vd «nhập sản phẩm từ website»). Luật:
 *  · chỉ `http` / `https`, cổng mặc định, không userinfo;
 *  · tên máy phân giải ra địa chỉ RIÊNG / nội bộ (loopback, 10/8, 172.16/12, 192.168/16, 169.254/16 — siêu dữ liệu đám mây,
 *    100.64/10, 0/8, IPv6 riêng / liên kết cục bộ / ánh xạ IPv4 riêng) ⇒ từ chối, kể cả khi chỉ MỘT trong các địa chỉ là riêng;
 *  · chuyển hướng tự đi tay, tối đa 3 lần, KIỂM LẠI từng đích;
 *  · trần thời gian + trần dung lượng đọc từng khúc (không tin `content-length`).
 *
 * Giới hạn đã biết: kiểm DNS rồi mới kết nối nên một tên miền đổi bản ghi giữa hai bước (DNS rebinding) vẫn lọt được về lý
 * thuyết. Người gọi chỉ là quản trị đã đăng nhập của tổ chức, và nơi dùng chỉ đọc ra các ô sản phẩm (không trả nội dung thô).
 */

export const PUBLIC_FETCH_LIMITS = { timeoutMs: 12_000, maxBytes: 3_000_000, maxRedirects: 3 } as const;

/** Địa chỉ IP (chuỗi) thuộc dải riêng / nội bộ / đặc biệt. HÀM THUẦN. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s);
  }
  return true;
}

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** URL người dùng gõ ⇒ URL chuẩn (thêm `https://` khi thiếu), hoặc câu lỗi. HÀM THUẦN. */
export function normalizeUserUrl(raw: string): URL | { error: string } {
  const t = raw.trim();
  if (!t) return { error: "Nhập địa chỉ website." };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return { error: "Địa chỉ website không hợp lệ." };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "Chỉ nhận địa chỉ http / https." };
  if (u.username || u.password) return { error: "Địa chỉ không được kèm tên đăng nhập / mật khẩu." };
  if (u.port && u.port !== "80" && u.port !== "443") return { error: "Chỉ nhận cổng web mặc định." };
  if (!u.hostname.includes(".") && !isIP(u.hostname)) return { error: "Địa chỉ phải là tên miền công khai (vd shop.vn)." };
  return u;
}

async function assertPublicHost(u: URL, resolve: Resolver): Promise<string | null> {
  // Dấu chấm cuối («localhost.») là tên đầy đủ hợp lệ của CÙNG máy — bỏ trước khi so tên.
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (/^localhost$/i.test(host) || /\.(local|internal|localhost)$/i.test(host)) return "Không nhận địa chỉ nội bộ.";
  let addrs: string[];
  try {
    addrs = isIP(host) ? [host] : await resolve(host);
  } catch {
    return `Không tìm thấy tên miền ${host}.`;
  }
  if (!addrs.length) return `Không tìm thấy tên miền ${host}.`;
  if (addrs.some(isPrivateAddress)) return "Không nhận địa chỉ nội bộ.";
  return null;
}

export type PublicFetchResult = { ok: true; status: number; url: string; contentType: string; body: Uint8Array } | { ok: false; error: string };

/** Tải MỘT địa chỉ công khai theo luật ở đầu tệp. Không ném. */
export async function fetchPublicUrl(raw: string | URL, deps: { fetch?: typeof fetch; resolve?: Resolver; accept?: string } = {}): Promise<PublicFetchResult> {
  const first = typeof raw === "string" ? normalizeUserUrl(raw) : raw;
  if ("error" in first) return { ok: false, error: first.error };
  const doFetch = deps.fetch ?? fetch;
  const resolve = deps.resolve ?? defaultResolver;
  let current = first;
  try {
    for (let hop = 0; hop <= PUBLIC_FETCH_LIMITS.maxRedirects; hop++) {
      const bad = await assertPublicHost(current, resolve);
      if (bad) return { ok: false, error: bad };
      const res = await doFetch(current.toString(), {
        redirect: "manual",
        signal: AbortSignal.timeout(PUBLIC_FETCH_LIMITS.timeoutMs),
        headers: { accept: deps.accept ?? "text/html,application/json;q=0.9,*/*;q=0.5", "user-agent": "VNXcommerce-ProductImport/1.0" },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { ok: false, error: `Website chuyển hướng không có đích (HTTP ${res.status}).` };
        const next = normalizeUserUrl(new URL(loc, current).toString());
        if ("error" in next) return { ok: false, error: `Website chuyển hướng tới địa chỉ không nhận: ${next.error}` };
        current = next;
        continue;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > PUBLIC_FETCH_LIMITS.maxBytes) {
            await reader.cancel().catch(() => undefined);
            return { ok: false, error: "Trang quá lớn (trên 3 MB)." };
          }
          chunks.push(value);
        }
      }
      const body = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        body.set(c, at);
        at += c.byteLength;
      }
      return { ok: true, status: res.status, url: current.toString(), contentType: res.headers.get("content-type") ?? "", body };
    }
    return { ok: false, error: "Website chuyển hướng quá nhiều lần." };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: /timeout|abort/i.test(msg) ? "Website không trả lời kịp (quá 12 giây)." : "Không tải được website." };
  }
}
