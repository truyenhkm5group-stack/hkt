import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { can, type SessionUser } from "@/lib/auth/session";
import { openActiveConnection } from "@/lib/connectors/service";
import { currentOrganization } from "@/lib/platform/context";
import { avatarProxyRefOfState, avatarRefVersion, isAllowedAvatarHost, isAvatarTokenHost, type PancakeAvatarRef } from "@/lib/sales-chatbot/avatar-profile";
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
 *  3. SSRF: mọi bước (kể cả chuyển hướng, tối đa `AVATAR_FETCH.maxRedirects`) phải là https tới host trong `AVATAR_PROXY_HOSTS`; bước
 *     chuyển hướng KHÔNG mang token. Hết giờ / quá cỡ / không phải ảnh raster ⇒ dừng.
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

/** Token của kết nối Pancake — chỉ khi kết nối đang bật VÀ đúng page. Không ném. */
async function defaultPageToken(pageId: string): Promise<string | null> {
  try {
    const conn = await openActiveConnection(FANPAGE_CONNECTOR);
    if (!conn.ok || (conn.settings.pageId ?? "").trim() !== pageId) return null;
    return (conn.secrets.pageAccessToken ?? "").trim() || null;
  } catch {
    return null;
  }
}

/** URL tải lần đầu: gắn token (nếu ref đòi) CHỈ cho host Pancake + đúng page. `null` ⇒ không được gọi. HÀM THUẦN. */
export function avatarFetchUrl(ref: PancakeAvatarRef, pageId: string | null, token: string | null): string | null {
  const u = new URL(ref.url);
  if (!isAllowedAvatarHost(u.hostname)) return null;
  if (!ref.tokenParams.length) return u.toString();
  if (!isAvatarTokenHost(u.hostname) || !token || !pageId) return null;
  const m = /\/pages\/([^/]+)\//.exec(u.pathname);
  if (m && decodeURIComponent(m[1]) !== pageId) return null;
  for (const name of ref.tokenParams) u.searchParams.set(name, token);
  return u.toString();
}

/** Một URL ở BẤT KỲ bước nào có được phép gọi không: https, không tài khoản / cổng lạ, host trong danh sách. HÀM THUẦN. */
export function avatarHopAllowed(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === "https:" && !u.username && !u.password && !u.port && isAllowedAvatarHost(u.hostname);
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

/** Tải ảnh: tự đi chuyển hướng (không để `fetch` tự theo), kiểm host từng bước, bước sau KHÔNG mang token. Không ném. */
export async function fetchAvatarImage(firstUrl: string, fetchImpl: typeof fetch): Promise<{ body: Uint8Array; contentType: string } | null> {
  let url = firstUrl;
  try {
    for (let hop = 0; hop <= AVATAR_FETCH.maxRedirects; hop += 1) {
      if (!avatarHopAllowed(url)) return null;
      const res = await fetchImpl(url, { method: "GET", redirect: "manual", headers: { accept: "image/*" }, signal: AbortSignal.timeout(AVATAR_FETCH.timeoutMs) });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return null;
        url = new URL(loc, url).toString();
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
  const [conv] = await db.select({ id: c.id, channel: c.channel, pageId: c.pageId, state: c.state }).from(c).where(eq(c.id, conversationId)).limit(1);
  if (!conv || conv.channel === "TEST") return { status: 404, reason: "NO_CONVERSATION" };
  const ref = avatarProxyRefOfState(conv.state);
  if (!ref) return { status: 404, reason: "NO_REF" };

  const now = (deps.now ?? Date.now)();
  const cache = deps.cache ?? SHARED_CACHE;
  const key = `${(await currentOrganization()).code}|${conv.id}|${avatarRefVersion(ref)}`;
  const hit = cache.get(key, now);
  if (hit) {
    if (!hit.ok) return { status: 404, reason: "CACHED_FAILURE" };
    return etagMatches(ifNoneMatch, hit.etag) ? { status: 304, etag: hit.etag } : { status: 200, body: hit.body, contentType: hit.contentType, etag: hit.etag };
  }

  const token = ref.tokenParams.length && conv.pageId ? await (deps.pageToken ?? defaultPageToken)(conv.pageId) : null;
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
