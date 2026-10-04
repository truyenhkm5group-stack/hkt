import { createHash, createHmac, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { env } from "@/lib/env";
import { brandAppOrigin, brandOfHost, type SiteEnv } from "@/lib/platform/site-host";

/**
 * ═══════════ ĐĂNG NHẬP / ĐĂNG KÝ BẰNG GOOGLE · FACEBOOK (0193, docs/platform/quick-start.md) — CHỈ MÁY CHỦ ═══════════
 *
 * Luồng «authorization code» chuẩn, không thư viện ngoài:
 *   /login/oauth/<nhà cung cấp>?intent=login|signup  ⇒ tạo `state` (+ PKCE với Google), cất trong cookie KÝ ⇒ sang nhà cung cấp
 *   /login/oauth/<nhà cung cấp>/callback             ⇒ khớp `state` ⇒ đổi `code` lấy hồ sơ (mã người dùng, email, tên)
 *
 * Hồ sơ chỉ được TIN khi nó tới thẳng từ máy chủ của nhà cung cấp qua TLS bằng khoá bí mật của ứng dụng (không bao giờ
 * từ trình duyệt). Email của Google chỉ dùng khi `email_verified = true`; Facebook chỉ trả email ĐÃ XÁC NHẬN của tài khoản.
 *
 * Cookie của luồng này ký bằng khoá DẪN XUẤT riêng từ `AUTH_SECRET` (nhãn «oauth») và mang `aud` riêng: một token của
 * luồng OAuth không bao giờ dùng được làm cookie phiên, và ngược lại.
 */

export const OAUTH_PROVIDERS = ["google", "facebook"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];
export type OAuthIntent = "login" | "signup";

export const OAUTH_PROVIDER_LABEL: Record<OAuthProvider, string> = { google: "Google", facebook: "Facebook" };
export const OAUTH_IDENTITY_KIND: Record<OAuthProvider, "GOOGLE" | "FACEBOOK"> = { google: "GOOGLE", facebook: "FACEBOOK" };

const FB_GRAPH = "https://graph.facebook.com/v21.0";

export function isOAuthProvider(v: unknown): v is OAuthProvider {
  return typeof v === "string" && (OAUTH_PROVIDERS as readonly string[]).includes(v);
}

/** `origin` = gốc phần mềm của lượt này (mặc định `APP_URL`) — quyết định `redirect_uri`. */
type ProviderConfig = { clientId: string; clientSecret: string; origin?: string };

export function providerConfig(p: OAuthProvider): ProviderConfig | null {
  const id = p === "google" ? env.oauth.googleClientId : env.oauth.facebookAppId;
  const secret = p === "google" ? env.oauth.googleClientSecret : env.oauth.facebookAppSecret;
  return id && secret ? { clientId: id, clientSecret: secret } : null;
}

/** Nhà cung cấp nào đang dùng được — màn hình chỉ vẽ nút của những nhà cung cấp này. */
export function enabledProviders(): Record<OAuthProvider, boolean> {
  return { google: providerConfig("google") !== null, facebook: providerConfig("facebook") !== null };
}

/**
 * GỐC PHẦN MỀM của host đang gọi — chỉ nhận đúng các host trong danh sách (`APP_URL` và `app.<CHOTDON_DOMAIN>`), KHÔNG
 * bao giờ dựng từ header Host thô: một host lạ ⇒ `APP_URL`. Cả lượt OAuth (URL nhà cung cấp, đổi mã, cookie, chuyển hướng
 * cuối) đi theo gốc này, nên người bắt đầu ở `app.chotdontudong.com` kết thúc ở đó với phiên của chính host đó.
 */
export function appOriginForHost(host: string | null | undefined): string {
  const e: SiteEnv = { SITE_DOMAIN: process.env.SITE_DOMAIN, CHOTDON_DOMAIN: process.env.CHOTDON_DOMAIN, APP_URL: process.env.APP_URL, CHOTDON_APP_URL: process.env.CHOTDON_APP_URL };
  if (brandOfHost(host, e) === "chotdon") {
    const o = brandAppOrigin("chotdon", e);
    if (o) return o;
  }
  return env.appUrl;
}

/** Đường quay về của nhà cung cấp — PHẢI khai đủ ở Google Console / Facebook cho MỖI gốc phần mềm. */
export function redirectUri(p: OAuthProvider, origin: string = env.appUrl): string {
  return `${origin.replace(/\/$/, "")}/login/oauth/${p}/callback`;
}

// ─────────────────────────── Cookie ký ───────────────────────────

export const OAUTH_STATE_COOKIE = "erp_oauth";
/** Hồ sơ của người vừa xác minh ở nhà cung cấp mà chưa có cửa hàng — `/start` đọc để điền sẵn. */
export const SOCIAL_SIGNUP_COOKIE = "erp_social";
/** Danh tính khớp NHIỀU tổ chức — trang chọn tổ chức đọc. */
export const SOCIAL_PICK_COOKIE = "erp_pick";
export const OAUTH_STATE_TTL_SEC = 10 * 60;
export const SOCIAL_SIGNUP_TTL_SEC = 30 * 60;

function oauthKey(): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`${env.authSecret}:oauth`).digest());
}

export async function signOAuthToken(aud: string, payload: Record<string, unknown>, ttlSec: number): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setAudience(aud).setIssuedAt().setExpirationTime(`${ttlSec}s`).sign(oauthKey());
}

export async function readOAuthToken<T>(aud: string, token: string | undefined | null): Promise<T | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, oauthKey(), { audience: aud });
    return payload as unknown as T;
  } catch {
    return null;
  }
}

/** `o` = gốc phần mềm lúc bắt đầu — lượt đổi mã phải gửi ĐÚNG `redirect_uri` đã gửi lúc bắt đầu. */
export type OAuthState = { p: OAuthProvider; state: string; verifier: string; intent: OAuthIntent; next: string; o?: string };
export type SocialProfile = { provider: OAuthProvider; subject: string; email: string | null; name: string | null };
export type SocialPick = { provider: OAuthProvider; subject: string; choices: { orgCode: string; userId: string }[] };

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Bắt đầu một lượt: `state` + PKCE ngẫu nhiên, và URL của nhà cung cấp. */
export function beginOAuth(p: OAuthProvider, cfg: ProviderConfig): { state: string; verifier: string; url: string } {
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const ru = redirectUri(p, cfg.origin);
  if (p === "google") {
    const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: ru, response_type: "code", scope: "openid email profile", state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account" });
    return { state, verifier, url: `https://accounts.google.com/o/oauth2/v2/auth?${q}` };
  }
  const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: ru, response_type: "code", scope: "email,public_profile", state });
  return { state, verifier, url: `https://www.facebook.com/v21.0/dialog/oauth?${q}` };
}

type Fetch = typeof fetch;

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Đổi `code` lấy HỒ SƠ đã xác minh. Lỗi ⇒ `{ error }` với câu cho người dùng (chi tiết kỹ thuật chỉ vào log máy chủ, không
 * in token).
 */
export async function exchangeCode(p: OAuthProvider, code: string, verifier: string, cfg: ProviderConfig, fetchImpl: Fetch = fetch, now: Date = new Date()): Promise<SocialProfile | { error: string }> {
  const fail = (why: string) => {
    console.warn(`[oauth:${p}] ${why}`);
    return { error: `Không xác minh được tài khoản ${OAUTH_PROVIDER_LABEL[p]} — thử lại.` };
  };
  try {
    if (p === "google") {
      const res = await fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri(p, cfg.origin), grant_type: "authorization_code", code_verifier: verifier }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => null)) as { id_token?: unknown } | null;
      if (!res.ok || typeof body?.id_token !== "string") return fail(`đổi code lỗi HTTP ${res.status}`);
      // id_token nhận THẲNG từ máy chủ Google qua TLS bằng khoá bí mật ⇒ được tin mà không cần kiểm chữ ký (tài liệu
      // OpenID của Google), nhưng vẫn kiểm người nhận, người phát và hạn.
      const c = decodeJwtPayload(body.id_token);
      if (!c) return fail("id_token hỏng");
      if (c.aud !== cfg.clientId) return fail("aud sai");
      if (c.iss !== "https://accounts.google.com" && c.iss !== "accounts.google.com") return fail("iss sai");
      if (typeof c.exp !== "number" || c.exp * 1000 < now.getTime()) return fail("id_token hết hạn");
      if (typeof c.sub !== "string" || !c.sub) return fail("thiếu sub");
      const email = typeof c.email === "string" && c.email_verified === true ? c.email.toLowerCase() : null;
      return { provider: p, subject: c.sub, email, name: typeof c.name === "string" ? c.name : null };
    }
    const q = new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri(p, cfg.origin), code });
    const res = await fetchImpl(`${FB_GRAPH}/oauth/access_token?${q}`, { signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
    if (!res.ok || typeof body?.access_token !== "string") return fail(`đổi code lỗi HTTP ${res.status}`);
    const token = body.access_token;
    const proof = createHmac("sha256", cfg.clientSecret).update(token).digest("hex");
    const me = await fetchImpl(`${FB_GRAPH}/me?${new URLSearchParams({ fields: "id,name,email", access_token: token, appsecret_proof: proof })}`, { signal: AbortSignal.timeout(15_000) });
    const m = (await me.json().catch(() => null)) as { id?: unknown; name?: unknown; email?: unknown } | null;
    if (!me.ok || typeof m?.id !== "string" || !m.id) return fail(`đọc hồ sơ lỗi HTTP ${me.status}`);
    return { provider: p, subject: m.id, email: typeof m.email === "string" ? m.email.toLowerCase() : null, name: typeof m.name === "string" ? m.name : null };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
