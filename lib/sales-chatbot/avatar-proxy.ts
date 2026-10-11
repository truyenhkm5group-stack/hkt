import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { can, type SessionUser } from "@/lib/auth/session";
import { openActiveConnection, openChannelPageToken } from "@/lib/connectors/service";
import { currentOrganization } from "@/lib/platform/context";
import { avatarProxyRefFor, avatarRefVersion, isAllowedAvatarHost, isAvatarCdnHost, isAvatarTokenHost, isEndpointAvatarRef, pancakeAvatarEndpointUrl, stripAvatarToken, type PancakeAvatarRef } from "@/lib/sales-chatbot/avatar-profile";
import { FANPAGE_CONNECTOR } from "@/lib/sales-chatbot/fanpage";

/**
 * ═══════════ PROXY ẢNH ĐẠI DIỆN KHÁCH CỦA HỘP THƯ (chủ shop 11/10/2026, ưu tiên 2 sau P0 hộp thư) ═══════════
 *
 * Danh sách hội thoại của API Pancake trả URL ảnh khách MANG `page_access_token`. ERP chỉ cất bản ĐÃ BỎ khoá
 * (`state.pancakeAvatarRef`, avatar-profile.ts mục 1b); trình duyệt gọi `GET /api/ai-sales/avatar/<mã hội thoại>` và máy chủ:
 *
 *  1. QUYỀN: phiên + `ai_sales:view` (cùng cổng route `inbox-read` / `inbox-thread`); hội thoại tra trong CSDL của TỔ CHỨC ngữ cảnh
 *     (`getDb()` — mỗi tổ chức một CSDL), nên mã hội thoại của tổ chức khác là 404, không phải ảnh của người khác.
 *  2. TOKEN: đọc lúc tải từ kết nối «Fanpage qua Pancake» của tổ chức (`openActiveConnection`), CHỈ khi page của hội thoại đúng là
 *     page của kết nối, CHỈ gắn vào host Pancake (`AVATAR_TOKEN_HOSTS`) và — nếu đường dẫn có `/pages/<id>/` — chỉ khi id đó là page
 *     của hội thoại. Token không trả về trình duyệt, không ghi CSDL, không vào nhật ký (nhật ký không bao giờ in URL).
 *  3. SSRF: bước đầu phải là https tới host trong `AVATAR_PROXY_HOSTS`; bước chuyển hướng (tối đa `AVATAR_FETCH.maxRedirects`) chỉ
 *     tới CDN ảnh `AVATAR_CDN_HOSTS` và KHÔNG BAO GIỜ mang token (máy chủ bỏ mọi tham số khoá, kể cả khi Pancake chép token vào
 *     `Location`). Hết giờ / quá cỡ / không phải ảnh raster (200 text/html là trang SPA của Pancake) ⇒ dừng.
 *
 * Hai dạng ref (avatar-profile.ts): URL đã bỏ khoá (mục 1b) và ĐIỂM CUỐI ẢNH PANCAKE `PANCAKE_AVATAR_ENDPOINT_BASE/pages/<page>/avatar/<psid>`
 * (mục 1c — nguồn duy nhất đo được trả ảnh, 11/10/2026: 301 ⇒ CDN ảnh của Pancake). Ref lấy LÚC ĐỌC bằng `avatarProxyRefFor`.
 *  4. ĐỆM: LRU trong bộ nhớ có trần số mục + trần byte, theo (tổ chức, hội thoại, phiên bản ref); lỗi đệm ngắn hơn để không hỏi
 *     Pancake mỗi lần mở trang mà cũng không kẹt mãi. Trình duyệt giữ `private, max-age=86400` + ETag.
 *
 * Lỗi nào cũng ra 404 (client lùi về chữ cái đầu) — không 500, không câu lỗi chứa URL.
 */

export const AVATAR_FETCH = {
  timeoutMs: 5_000,
  maxBytes: 1_000_000,
  maxRedirects: 3,
  /** Ảnh tốt trong đệm máy chủ. URL Pancake ổn định theo khách; ảnh đổi ⇒ ref đổi ⇒ khoá đệm đổi. */
  okTtlMs: 12 * 3_600_000,
  /** Lần tải hỏng — chờ chừng này mới hỏi lại Pancake cho đúng hội thoại đó. */
  failTtlMs: 10 * 60_000,
  maxEntries: 500,
  maxTotalBytes: 32 * 1024 * 1024,
} as const;

/** Ảnh raster được trả — KHÔNG có SVG (SVG chở được script). */
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

export type AvatarCacheEntry = { at: number; ok: true; body: Uint8Array; contentType: string; etag: string } | { at: number; ok: false };

/** LRU có trần — `Map` giữ thứ tự chèn: đọc lại một mục là đưa nó ra cuối, vượt trần thì bỏ từ đầu. */
export class AvatarLru {
  private map = new Map<string, AvatarCacheEntry>();
  private bytes = 0;
  constructor(
    private maxEntries: number = AVATAR_FETCH.maxEntries,
    private maxTotalBytes: number = AVATAR_FETCH.maxTotalBytes,
  ) {}
  get(key: string, now: number): AvatarCacheEntry | null {
    const e = this.map.get(key);
    if (!e) return null;
    if (now - e.at >= (e.ok ? AVATAR_FETCH.okTtlMs : AVATAR_FETCH.failTtlMs)) {
      this.delete(key);
      return null;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return e;
  }
  set(key: string, e: AvatarCacheEntry): void {
    this.delete(key);
    this.map.set(key, e);
    if (e.ok) this.bytes += e.body.byteLength;
    while (this.map.size > this.maxEntries || this.bytes > this.maxTotalBytes) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }
  private delete(key: string) {
    const e = this.map.get(key);
    if (e?.ok) this.bytes -= e.body.byteLength;
    this.map.delete(key);
  }
  get size() {
    return this.map.size;
  }
}

const SHARED_CACHE = new AvatarLru();

export type AvatarProxyDeps = {
  fetch?: typeof fetch;
  /** Token page Pancake của tổ chức ngữ cảnh cho `pageId` — `null` khi không có / page khác. Mặc định: kết nối «Fanpage qua Pancake». */
  pageToken?: (pageId: string) => Promise<string | null>;
  cache?: AvatarLru;
  now?: () => number;
};

export type AvatarProxyResult =
  | { status: 200; body: Uint8Array; contentType: string; etag: string }
  | { status: 304; etag: string }
  | { status: 403 | 404; reason: "NO_PERMISSION" | "NO_CONVERSATION" | "NO_REF" | "NO_TOKEN" | "FETCH_FAILED" | "CACHED_FAILURE" };

/** Token Pancake của ĐÚNG page: hàng page riêng (đang bật) trước, chưa có hàng thì kết nối đơn cũ khi đúng page. Không ném. */
async function defaultPageToken(pageId: string): Promise<string | null> {
  try {
    const own = await openChannelPageToken(FANPAGE_CONNECTOR, pageId);
    if (own.ok) return own.token;
    if (own.known) return null;
    const conn = await openActiveConnection(FANPAGE_CONNECTOR);
    if (!conn.ok || (conn.settings.pageId ?? "").trim() !== pageId) return null;
    return (conn.secrets.pageAccessToken ?? "").trim() || null;
  } catch {
    return null;
  }
}

/** URL tải lần đầu: gắn token (nếu ref đòi) CHỈ cho host Pancake + đúng page. `null` ⇒ không được gọi. HÀM THUẦN. */
export function avatarFetchUrl(ref: PancakeAvatarRef, pageId: string | null, token: string | null): string | null {
  if (isEndpointAvatarRef(ref)) {
    // Điểm cuối ảnh Pancake: ĐÚNG page của hội thoại, có token — không thì không gọi.
    if (!pageId || ref.pageId !== pageId || !token) return null;
    const e = new URL(pancakeAvatarEndpointUrl(ref));
    if (!isAvatarTokenHost(e.hostname)) return null;
    e.searchParams.set("page_access_token", token);
    return e.toString();
  }
  const u = new URL(ref.url);
  if (!isAllowedAvatarHost(u.hostname)) return null;
  if (!ref.tokenParams.length) return u.toString();
  if (!isAvatarTokenHost(u.hostname) || !token || !pageId) return null;
  const m = /\/pages\/([^/]+)\//.exec(u.pathname);
  if (m && decodeURIComponent(m[1]) !== pageId) return null;
  for (const name of ref.tokenParams) u.searchParams.set(name, token);
  return u.toString();
}

/**
 * Một URL có được phép gọi ở bước `hop` không: https, không tài khoản / cổng lạ; bước 0 host trong `AVATAR_PROXY_HOSTS`, bước chuyển
 * hướng chỉ CDN ảnh (`AVATAR_CDN_HOSTS`). HÀM THUẦN.
 */
export function avatarHopAllowed(raw: string, hop = 0): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === "https:" && !u.username && !u.password && !u.port && (hop === 0 ? isAllowedAvatarHost(u.hostname) : isAvatarCdnHost(u.hostname));
}

async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) return null;
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength <= max ? buf : null;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/**
 * Header `accept` theo bước — ĐO trên production (ops avatar-proxy-check, run 38115995755, HSLC 5/5 hội thoại): điểm cuối ảnh Pancake
 * trả **406** với `accept: image/*` và **301** sang CDN với accept MỌI KIỂU; bước CDN ảnh của Pancake trả 200 image/jpeg với
 * `image/*`. Nên bước đầu nhận mọi kiểu, bước chuyển hướng giữ `image/*` (đã đo chạy) — và bước cuối VẪN phải là ảnh raster
 * (`IMAGE_TYPES`), nên nới header bước đầu không làm proxy nhận HTML. HÀM THUẦN.
 */
export function avatarAcceptFor(hop: number): string {
  return hop === 0 ? "*/*" : "image/*";
}

/** Tải ảnh: tự đi chuyển hướng (không để `fetch` tự theo), kiểm host từng bước, bước sau KHÔNG mang token. Không ném. */
export async function fetchAvatarImage(firstUrl: string, fetchImpl: typeof fetch): Promise<{ body: Uint8Array; contentType: string } | null> {
  let url = firstUrl;
  try {
    for (let hop = 0; hop <= AVATAR_FETCH.maxRedirects; hop += 1) {
      if (!avatarHopAllowed(url, hop)) return null;
      const res = await fetchImpl(url, { method: "GET", redirect: "manual", headers: { accept: avatarAcceptFor(hop) }, signal: AbortSignal.timeout(AVATAR_FETCH.timeoutMs) });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return null;
        // Bước sau KHÔNG mang token: bỏ mọi tham số khoá (Pancake có thể chép token vào Location); bỏ không được ⇒ dừng.
        const next = stripAvatarToken(new URL(loc, url).toString());
        if (!next) return null;
        url = next;
        continue;
      }
      if (res.status !== 200) return null;
      const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!IMAGE_TYPES.has(contentType)) return null;
      const body = await readCapped(res, AVATAR_FETCH.maxBytes);
      return body && body.byteLength > 0 ? { body, contentType } : null;
    }
    return null;
  } catch {
    return null;
  }
}

const etagOf = (body: Uint8Array) => `"${createHash("sha256").update(body).digest("hex").slice(0, 24)}"`;
const etagMatches = (header: string | null, etag: string) =>
  Boolean(header) &&
  header!
    .split(",")
    .map((x) => x.trim().replace(/^W\//, ""))
    .some((x) => x === etag || x === "*");

/**
 * Lõi của route `GET /api/ai-sales/avatar/[conversationId]` — người gọi đã qua `apiGuard`. Trả ảnh, 304, hoặc 403/404 kèm LÝ DO máy
 * (không câu nào chứa URL / token). Không ném.
 */
export async function avatarProxyCore(user: SessionUser, conversationId: unknown, ifNoneMatch: string | null, deps: AvatarProxyDeps = {}): Promise<AvatarProxyResult> {
  if (!can(user, "ai_sales:view")) return { status: 403, reason: "NO_PERMISSION" };
  if (typeof conversationId !== "string" || !/^[0-9a-f-]{36}$/i.test(conversationId)) return { status: 404, reason: "NO_CONVERSATION" };
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [conv] = await db.select({ id: c.id, channel: c.channel, pageId: c.pageId, threadId: c.threadId, state: c.state }).from(c).where(eq(c.id, conversationId)).limit(1);
  if (!conv || conv.channel === "TEST") return { status: 404, reason: "NO_CONVERSATION" };
  const ref = avatarProxyRefFor(conv.state, conv)?.ref;
  if (!ref) return { status: 404, reason: "NO_REF" };

  const now = (deps.now ?? Date.now)();
  const cache = deps.cache ?? SHARED_CACHE;
  const key = `${(await currentOrganization()).code}|${conv.id}|${avatarRefVersion(ref)}`;
  const hit = cache.get(key, now);
  if (hit) {
    if (!hit.ok) return { status: 404, reason: "CACHED_FAILURE" };
    return etagMatches(ifNoneMatch, hit.etag) ? { status: 304, etag: hit.etag } : { status: 200, body: hit.body, contentType: hit.contentType, etag: hit.etag };
  }

  const needsToken = isEndpointAvatarRef(ref) || ref.tokenParams.length > 0;
  const token = needsToken && conv.pageId ? await (deps.pageToken ?? defaultPageToken)(conv.pageId) : null;
  const first = avatarFetchUrl(ref, conv.pageId, token);
  if (!first) {
    cache.set(key, { at: now, ok: false });
    return { status: 404, reason: "NO_TOKEN" };
  }
  const img = await fetchAvatarImage(first, deps.fetch ?? fetch);
  if (!img) {
    cache.set(key, { at: now, ok: false });
    return { status: 404, reason: "FETCH_FAILED" };
  }
  const etag = etagOf(img.body);
  cache.set(key, { at: now, ok: true, body: img.body, contentType: img.contentType, etag });
  return etagMatches(ifNoneMatch, etag) ? { status: 304, etag } : { status: 200, body: img.body, contentType: img.contentType, etag };
}
