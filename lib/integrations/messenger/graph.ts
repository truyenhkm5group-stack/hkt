import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { classifyGraphError, GRAPH_ERROR_HINT, type GraphErrorKind } from "@/lib/integrations/messenger/graph-errors";

/**
 * ═══════════ MESSENGER TRỰC TIẾP — GỌI GRAPH API CỦA META (docs/platform/messenger.md) ═══════════
 *
 * Kênh thứ hai cho bot fanpage, KHÔNG cần Pancake: app Facebook của NỀN TẢNG (cùng app «Đăng nhập bằng Facebook» —
 * `FACEBOOK_LOGIN_APP_ID/SECRET`) được chủ page cấp quyền nhắn tin; webhook của Meta tới thẳng ERP; bot trả lời bằng Send API.
 *
 *  · Mọi lời gọi bằng page token đều kèm `appsecret_proof` (HMAC-SHA256 của token bằng app secret) — token lộ ra ngoài một
 *    mình không dùng được với app này.
 *  · Webhook xác thực bằng `X-Hub-Signature-256` (HMAC-SHA256 của THÂN GÓI GỐC bằng app secret), so thời gian hằng.
 *  · Địa chỉ là HẰNG SỐ `graph.facebook.com` — người dùng không nhập URL nào. Không theo chuyển hướng, có trần thời gian.
 *  · Token / app secret không bao giờ vào câu lỗi (`scrub`).
 *
 * Mọi hàm nhận `fetch` tiêm vào: bài kiểm không gọi mạng thật (luật 65).
 */

/**
 * Quyền xin chủ page. Hai quyền `instagram_*` để nối LUÔN tài khoản Instagram doanh nghiệp gắn với page (Instagram DM đi qua
 * CÙNG app, CÙNG page token, CÙNG Send API) — người chỉ dùng Messenger bỏ chọn được, phần Messenger vẫn chạy.
 */
export const MESSENGER_SCOPES = ["pages_show_list", "pages_messaging", "pages_manage_metadata", "pages_read_engagement", "business_management", "instagram_basic", "instagram_manage_messages"] as const;
/** Sự kiện trang mà app đăng ký nhận. `message_echoes`: tin page gửi đi (của bot, của nhân viên trong Hộp thư Meta). */
export const MESSENGER_FIELDS = ["messages", "messaging_postbacks", "message_echoes", "feed"] as const;
const TIMEOUT_MS = 15_000;
/** Messenger nhận tối đa 2.000 ký tự một tin. */
export const MESSENGER_TEXT_MAX = 2000;
/** Trần số trang `/me/accounts` (100 page / trang) đọc mỗi lần nối — 500 page; khớp `MESSENGER_PAGES_MAX` của bộ chọn page. */
export const ACCOUNT_PAGES_MAX_REQUESTS = 5;

export function graphBase(): string {
  const v = /^v\d+\.\d+$/.test(env.facebook.apiVersion) ? env.facebook.apiVersion : "v21.0";
  return `https://graph.facebook.com/${v}`;
}

export type MessengerApp = { appId: string; appSecret: string };

/** App Facebook của nền tảng — thiếu một trong hai ⇒ `null` (kênh Messenger chưa mở). */
export function messengerApp(): MessengerApp | null {
  const appId = env.oauth.facebookAppId;
  const appSecret = env.oauth.facebookAppSecret;
  return appId && appSecret ? { appId, appSecret } : null;
}

export function appSecretProof(token: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(token).digest("hex");
}

function scrub(s: string, secrets: readonly string[]): string {
  let out = s;
  for (const v of secrets) if (v && v.length >= 6) out = out.split(v).join("…");
  return out.slice(0, 400);
}

type Fetch = typeof fetch;
type GraphError = { error?: { message?: string; code?: number; error_subcode?: number; type?: string } };

/** Lỗi của MỘT lời gọi Graph: câu (đã che bí mật, kèm việc phải làm) + LOẠI (graph-errors.ts) để nơi gọi biết kết nối có hỏng không. */
export type GraphFailure = { ok: false; error: string; code: number | null; kind: GraphErrorKind };

async function graph(fetchImpl: Fetch, url: string, init: RequestInit, hide: readonly string[]): Promise<{ ok: true; body: Record<string, unknown> } | GraphFailure> {
  try {
    const res = await fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown> & GraphError;
    if (!res.ok || body.error) {
      const msg = body.error?.message ?? `HTTP ${res.status}`;
      const code = typeof body.error?.code === "number" ? body.error.code : null;
      const kind = classifyGraphError(code, typeof body.error?.error_subcode === "number" ? body.error.error_subcode : null);
      const hint = GRAPH_ERROR_HINT[kind];
      return { ok: false, error: scrub(`Facebook từ chối: ${msg}${hint ? ` — ${hint}` : ""}`, hide), code, kind };
    }
    return { ok: true, body };
  } catch (e) {
    return { ok: false, error: scrub(`Không gọi được Facebook: ${e instanceof Error ? e.message : String(e)}`, hide), code: null, kind: "OTHER" };
  }
}

// ─────────────────────────── Kết nối page (OAuth của chủ page) ───────────────────────────

export function messengerConnectUrl(app: MessengerApp, redirectUri: string, state: string): string {
  // `auth_type=rerequest`: tài khoản TỪNG bỏ chọn quyền page (hoặc từng đăng nhập app này chỉ để Đăng nhập bằng Facebook) thì Facebook
  // chỉ hiện «Bạn từng đăng nhập… Tiếp tục?» và KHÔNG hỏi lại — sự cố 06/10/2026: OAuth xong mà 0 page. Có cờ này Facebook hỏi lại.
  const q = new URLSearchParams({ client_id: app.appId, redirect_uri: redirectUri, response_type: "code", scope: MESSENGER_SCOPES.join(","), state, auth_type: "rerequest" });
  return `https://www.facebook.com/${graphBase().split("/").pop()}/dialog/oauth?${q}`;
}

export type ConnectablePage = { id: string; name: string; token: string; canMessage: boolean };

/**
 * ═══ KHÁM PHÁ PAGE — VÌ SAO KHÔNG CÓ PAGE NÀO (sự cố 06/10/2026) ═══
 *
 * Trước bản này mọi thất bại sau OAuth gộp thành MỘT câu «không quản lý page nào có quyền nhắn tin», trong khi các tình huống
 * dưới đây sửa ở những chỗ khác nhau — và người dùng (lẫn kỹ thuật) không biết nhìn vào đâu. Thứ tự là thứ tự ƯU TIÊN:
 *  · TOKEN_EXPIRED               — token người dùng không còn hợp lệ (`/debug_token` is_valid=false hoặc expires_at đã qua).
 *  · PERMISSION_DECLINED         — quyền bắt buộc bị BỎ CHỌN ở hộp thoại (`/me/permissions` status = declined). Chủ page sửa.
 *  · PERMISSION_NOT_IN_APP       — quyền bắt buộc không được cấp DÙ người bấm CÓ vai trò trong app (admin / developer / tester):
 *                                  người có vai trò luôn được Standard Access ⇒ quyền chưa được THÊM vào app (use case Messenger
 *                                  chưa thêm / chưa tuỳ chỉnh). Chủ nền tảng sửa ở App Dashboard.
 *  · PERMISSION_NEEDS_APP_REVIEW — quyền bắt buộc không được cấp và người bấm KHÔNG có vai trò: cần Advanced Access (App Review +
 *                                  Business Verification). Chủ nền tảng sửa.
 *  · PERMISSION_NOT_GRANTED      — quyền bắt buộc không được cấp nhưng KHÔNG xác định được vai trò (gọi `/{app}/roles` lỗi) — giữ
 *                                  tên cũ để tương thích; không đoán là thiếu quyền ở app hay thiếu App Review.
 *  · NO_PAGES                    — có quyền, Meta trả 0 page (kể cả qua Business Portfolio).
 *  · NO_PAGE_TOKEN               — Meta trả page nhưng KHÔNG kèm token: chưa tích page ở bước «Chọn trang», hoặc page chỉ thuộc
 *                                  Business Portfolio mà tài khoản không có quyền trực tiếp.
 *  · NO_MESSAGING_TASK           — có page + token nhưng tài khoản không có quyền quản trị / Nhắn tin trên page nào.
 * Quyền đi TRƯỚC page: page token thiếu `pages_messaging` không gửi được tin dù page hiện ra đủ.
 * Webhook chưa đăng ký (sau khi đã lưu page) là chẩn đoán THEO PAGE — `checkPageWebhook`, không phải lý do khám phá.
 * HÀM THUẦN — không token nào đi vào kết quả (chỉ tên quyền, tên page, vai trò, đếm).
 */
export const MESSENGER_REQUIRED_PERMISSIONS = ["pages_show_list", "pages_messaging", "pages_manage_metadata", "pages_read_engagement"] as const;
export type RequiredPermission = (typeof MESSENGER_REQUIRED_PERMISSIONS)[number];
export const DISCOVERY_REASONS = [
  "TOKEN_EXPIRED",
  "PERMISSION_DECLINED",
  "PERMISSION_NOT_IN_APP",
  "PERMISSION_NEEDS_APP_REVIEW",
  "PERMISSION_NOT_GRANTED",
  "NO_PAGES",
  "NO_PAGE_TOKEN",
  "NO_MESSAGING_TASK",
] as const;
export type DiscoveryReason = (typeof DISCOVERY_REASONS)[number];
export type RawPage = { id: string; name: string; hasToken: boolean; tasks: string[] | null; viaBusiness: boolean };

/** Vai trò trong app cho phép dùng quyền ở mức Standard Access. «insights users» KHÔNG đủ. */
export const APP_ROLES_WITH_STANDARD_ACCESS = ["administrators", "developers", "testers"] as const;
export type AppRoleCheck =
  | { state: "HAS_ROLE"; role: (typeof APP_ROLES_WITH_STANDARD_ACCESS)[number] }
  /** `role` = vai trò không đủ (vd «insights users»), `null` = không có vai trò nào. */
  | { state: "NO_ROLE"; role: string | null }
  /** Không đọc được — KHÔNG kết luận. `why` đã che bí mật. */
  | { state: "UNKNOWN"; why: string };

/** Kết quả `/debug_token`. `expiresAt` ISO; `null` = không hết hạn (expires_at = 0) hoặc không đọc được. */
export type TokenCheck = { state: "VALID" | "EXPIRED" | "UNKNOWN"; expiresAt: string | null; why: string | null };

export type DiscoveryDiagnostic = {
  /** Quyền Facebook xác nhận ĐÃ cấp — `null` = không đọc được `/me/permissions` (không suy đoán). */
  granted: string[] | null;
  declined: string[];
  /** Quyền BẮT BUỘC chưa có (bị từ chối hoặc không có trong danh sách). */
  missing: string[];
  /** Vai trò của người bấm trong app — chỉ hỏi khi thiếu quyền mà không do bỏ chọn; `null` = không cần hỏi. */
  appRole: AppRoleCheck | null;
  /** Tình trạng token người dùng — chỉ hỏi khi không đọc được quyền; `null` = không cần hỏi. */
  userToken: TokenCheck | null;
  accountsSeen: number;
  viaBusiness: number;
  withoutToken: string[];
  withoutMessaging: { name: string; tasks: string[] }[];
  eligible: number;
  reason: DiscoveryReason | null;
};

const MESSAGING_TASKS = new Set(["MESSAGING", "MANAGE", "MODERATE"]);
export const pageCanMessage = (tasks: readonly string[] | null) => tasks === null || tasks.some((t) => MESSAGING_TASKS.has(t));

export function diagnosePageDiscovery(x: { permissions: { permission: string; status: string }[] | null; raw: readonly RawPage[]; appRole?: AppRoleCheck | null; userToken?: TokenCheck | null }): DiscoveryDiagnostic {
  const granted = x.permissions ? x.permissions.filter((p) => p.status === "granted").map((p) => p.permission) : null;
  const declined = x.permissions ? x.permissions.filter((p) => p.status === "declined").map((p) => p.permission) : [];
  const missing = granted ? MESSENGER_REQUIRED_PERMISSIONS.filter((p) => !granted.includes(p)) : [];
  const seen = new Map<string, RawPage>();
  for (const p of x.raw) if (!seen.has(p.id) || (p.hasToken && !seen.get(p.id)?.hasToken)) seen.set(p.id, p);
  const all = [...seen.values()];
  const withToken = all.filter((p) => p.hasToken);
  const eligible = withToken.filter((p) => pageCanMessage(p.tasks));
  const appRole = x.appRole ?? null;
  const userToken = x.userToken ?? null;
  const d: DiscoveryDiagnostic = {
    granted,
    declined,
    missing: [...missing],
    appRole,
    userToken,
    accountsSeen: all.length,
    viaBusiness: all.filter((p) => p.viaBusiness).length,
    withoutToken: all.filter((p) => !p.hasToken).map((p) => p.name || p.id).slice(0, 20),
    withoutMessaging: withToken.filter((p) => !pageCanMessage(p.tasks)).map((p) => ({ name: p.name || p.id, tasks: p.tasks ?? [] })).slice(0, 20),
    eligible: eligible.length,
    reason: null,
  };
  const declinedRequired = missing.filter((p) => declined.includes(p));
  if (userToken?.state === "EXPIRED") d.reason = "TOKEN_EXPIRED";
  else if (declinedRequired.length) d.reason = "PERMISSION_DECLINED";
  else if (missing.length) d.reason = appRole?.state === "HAS_ROLE" ? "PERMISSION_NOT_IN_APP" : appRole?.state === "NO_ROLE" ? "PERMISSION_NEEDS_APP_REVIEW" : "PERMISSION_NOT_GRANTED";
  else if (eligible.length) d.reason = null;
  else if (!all.length) d.reason = "NO_PAGES";
  else if (!withToken.length) d.reason = "NO_PAGE_TOKEN";
  else d.reason = "NO_MESSAGING_TASK";
  return d;
}

/** Lý do này là vấn đề QUYỀN / TOKEN (chặn trước, kể cả khi page hiện đủ). */
export const isPermissionReason = (r: DiscoveryReason | null): boolean => r === "TOKEN_EXPIRED" || (r ?? "").startsWith("PERMISSION_");

/** App access token `<app_id>|<app_secret>` — CHỨA app secret: luôn nằm trong danh sách che (`scrub`). */
const appAccessToken = (app: MessengerApp) => `${app.appId}|${app.appSecret}`;

/**
 * Token có còn dùng được không (`GET /debug_token`, hỏi bằng app access token + appsecret_proof). `is_valid=false` hoặc
 * `expires_at` đã qua ⇒ EXPIRED; `expires_at = 0` = không hết hạn. Lỗi gọi ⇒ UNKNOWN (không kết luận). Token của app KHÁC ⇒
 * EXPIRED (không dùng được với app này).
 */
export async function inspectToken(app: MessengerApp, token: string, fetchImpl: Fetch = fetch, now: Date = new Date()): Promise<TokenCheck> {
  const appToken = appAccessToken(app);
  const hide = [token, app.appSecret, appToken];
  const r = await graph(fetchImpl, `${graphBase()}/debug_token?${new URLSearchParams({ input_token: token, access_token: appToken, appsecret_proof: appSecretProof(appToken, app.appSecret) })}`, { method: "GET" }, hide);
  if (!r.ok) return { state: "UNKNOWN", expiresAt: null, why: r.error };
  const data = (r.body.data ?? {}) as { is_valid?: unknown; expires_at?: unknown; app_id?: unknown; error?: { message?: unknown } };
  const exp = typeof data.expires_at === "number" && data.expires_at > 0 ? new Date(data.expires_at * 1000) : null;
  const expiresAt = exp ? exp.toISOString() : null;
  if (data.is_valid === false) return { state: "EXPIRED", expiresAt, why: scrub(typeof data.error?.message === "string" ? data.error.message : "Meta báo token không còn hợp lệ.", hide) };
  if (exp && exp.getTime() <= now.getTime()) return { state: "EXPIRED", expiresAt, why: "Token đã quá hạn." };
  if (typeof data.app_id === "string" && data.app_id && data.app_id !== app.appId) return { state: "EXPIRED", expiresAt, why: "Token thuộc một app Facebook khác." };
  if (data.is_valid === true) return { state: "VALID", expiresAt, why: null };
  return { state: "UNKNOWN", expiresAt, why: "Meta không trả is_valid." };
}

/**
 * Người bấm có vai trò trong app không: `/me?fields=id` (token người dùng ⇒ mã người dùng theo app) so với
 * `GET /{app-id}/roles` (app access token). Bất kỳ bước nào lỗi ⇒ UNKNOWN — không đoán.
 */
export async function appRoleOf(app: MessengerApp, userToken: string, fetchImpl: Fetch = fetch): Promise<AppRoleCheck> {
  if (!/^\d{5,30}$/.test(app.appId)) return { state: "UNKNOWN", why: "Mã app không hợp lệ." };
  const appToken = appAccessToken(app);
  const hide = [userToken, app.appSecret, appToken];
  const me = await graph(fetchImpl, `${graphBase()}/me?${new URLSearchParams({ fields: "id", access_token: userToken, appsecret_proof: appSecretProof(userToken, app.appSecret) })}`, { method: "GET" }, hide);
  const uid = me.ok && typeof me.body.id === "string" ? me.body.id : "";
  if (!me.ok || !uid) return { state: "UNKNOWN", why: me.ok ? "Meta không trả mã người dùng." : me.error };
  let after: string | null = null;
  for (let i = 0; i < 5; i++) {
    const q = new URLSearchParams({ limit: "500", access_token: appToken, appsecret_proof: appSecretProof(appToken, app.appSecret) });
    if (after) q.set("after", after);
    const r = await graph(fetchImpl, `${graphBase()}/${app.appId}/roles?${q}`, { method: "GET" }, hide);
    if (!r.ok) return { state: "UNKNOWN", why: r.error };
    const rows = Array.isArray(r.body.data) ? (r.body.data as Record<string, unknown>[]) : [];
    const mine = rows.find((x) => String(x.user ?? "") === uid);
    if (mine) {
      const role = String(mine.role ?? "").trim().toLowerCase();
      const ok = APP_ROLES_WITH_STANDARD_ACCESS.find((x) => x === role);
      return ok ? { state: "HAS_ROLE", role: ok } : { state: "NO_ROLE", role: role.slice(0, 40) || null };
    }
    const paging = (r.body.paging ?? {}) as { cursors?: { after?: unknown }; next?: unknown };
    after = typeof paging.cursors?.after === "string" && paging.next ? paging.cursors.after : null;
    if (!after) break;
  }
  return { state: "NO_ROLE", role: null };
}

const roleTag = (r: AppRoleCheck | null) => (!r ? "-" : r.state === "HAS_ROLE" ? `has:${r.role}` : r.state === "NO_ROLE" ? `none${r.role ? `:${r.role.replace(/\s+/g, "_")}` : ""}` : "?");

/** Một dòng vết cho log máy chủ — CHỈ tên quyền + vai trò + số đếm (không token, không tên page, không mã người dùng). */
export function discoveryLogLine(org: string, d: DiscoveryDiagnostic): string {
  return `[messenger-connect] org=${org} reason=${d.reason ?? "OK"} granted=${d.granted ? d.granted.join(",") || "-" : "?"} declined=${d.declined.join(",") || "-"} missing=${d.missing.join(",") || "-"} appRole=${roleTag(d.appRole)} userToken=${d.userToken ? d.userToken.state : "-"} accounts=${d.accountsSeen} viaBusiness=${d.viaBusiness} noToken=${d.withoutToken.length} noMessaging=${d.withoutMessaging.length} eligible=${d.eligible}`;
}

/**
 * `code` ⇒ token người dùng (đổi sang token DÀI HẠN — page token dẫn xuất từ nó không hết hạn) ⇒ danh sách page người đó
 * quản lý, kèm page token. Token người dùng KHÔNG được lưu ở đâu cả.
 */
export async function pagesFromCode(app: MessengerApp, code: string, redirectUri: string, fetchImpl: Fetch = fetch): Promise<{ pages: ConnectablePage[]; diagnostic: DiscoveryDiagnostic } | { error: string }> {
  const base = graphBase();
  const hide = [app.appSecret, code];
  const short = await graph(fetchImpl, `${base}/oauth/access_token?${new URLSearchParams({ client_id: app.appId, client_secret: app.appSecret, redirect_uri: redirectUri, code })}`, { method: "GET" }, hide);
  if (!short.ok) return { error: short.error };
  const shortToken = typeof short.body.access_token === "string" ? short.body.access_token : "";
  if (!shortToken) return { error: "Facebook không trả token." };
  const long = await graph(fetchImpl, `${base}/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: app.appId, client_secret: app.appSecret, fb_exchange_token: shortToken })}`, { method: "GET" }, [...hide, shortToken]);
  const userToken = long.ok && typeof long.body.access_token === "string" ? long.body.access_token : shortToken;
  const hideAll = [...hide, shortToken, userToken];
  const proof = appSecretProof(userToken, app.appSecret);
  // Quyền THẬT SỰ được cấp — không đọc được thì để `null` (không đoán), phần khám phá page vẫn chạy.
  const permsRes = await graph(fetchImpl, `${base}/me/permissions?${new URLSearchParams({ access_token: userToken, appsecret_proof: proof })}`, { method: "GET" }, hideAll);
  const permissions = permsRes.ok && Array.isArray(permsRes.body.data)
    ? (permsRes.body.data as Record<string, unknown>[]).filter((p) => typeof p.permission === "string" && typeof p.status === "string").map((p) => ({ permission: String(p.permission), status: String(p.status) }))
    : null;
  // Không đọc được quyền ⇒ hỏi xem token có còn hợp lệ không (hết hạn thì mọi bước sau đều vô nghĩa — dừng, nói rõ).
  let userTokenCheck: TokenCheck | null = null;
  if (permissions === null) {
    userTokenCheck = await inspectToken(app, userToken, fetchImpl);
    if (userTokenCheck.state === "EXPIRED") return { pages: [], diagnostic: diagnosePageDiscovery({ permissions, raw: [], userToken: userTokenCheck }) };
  }
  // Thiếu quyền bắt buộc mà KHÔNG do bỏ chọn ⇒ hỏi vai trò của người bấm trong app để tách «quyền chưa thêm vào app» với
  // «cần App Review». Chỉ hỏi khi cần — luồng bình thường không tốn thêm lời gọi nào.
  const appRole = diagnosePageDiscovery({ permissions, raw: [] }).reason === "PERMISSION_NOT_GRANTED" ? await appRoleOf(app, userToken, fetchImpl) : null;
  // Phân trang bằng con trỏ `after` (không theo URL `next` — URL đó chứa token). Shop quản > 100 page trước đây chỉ thấy 100 page đầu.
  const data: Record<string, unknown>[] = [];
  let after: string | null = null;
  for (let i = 0; i < ACCOUNT_PAGES_MAX_REQUESTS; i++) {
    const q = new URLSearchParams({ fields: "id,name,access_token,tasks", limit: "100", access_token: userToken, appsecret_proof: appSecretProof(userToken, app.appSecret) });
    if (after) q.set("after", after);
    const acc = await graph(fetchImpl, `${base}/me/accounts?${q}`, { method: "GET" }, hideAll);
    if (!acc.ok) {
      if (!data.length) return { error: acc.error };
      break;
    }
    data.push(...(Array.isArray(acc.body.data) ? (acc.body.data as Record<string, unknown>[]) : []));
    const paging = (acc.body.paging ?? {}) as { cursors?: { after?: unknown }; next?: unknown };
    after = typeof paging.cursors?.after === "string" && paging.next ? paging.cursors.after : null;
    if (!after) break;
  }
  // Không page nào qua `/me/accounts` ⇒ hỏi thêm Business Portfolio (page chỉ được giao qua doanh nghiệp). Chỉ khi có
  // `business_management` (hoặc chưa đọc được quyền) — không có quyền đó thì hỏi cũng chỉ nhận lỗi.
  const viaBusiness: Record<string, unknown>[] = [];
  if (!data.length && (permissions === null || permissions.some((p) => p.permission === "business_management" && p.status === "granted"))) {
    const biz = await graph(fetchImpl, `${base}/me/businesses?${new URLSearchParams({ fields: "id", limit: "25", access_token: userToken, appsecret_proof: proof })}`, { method: "GET" }, hideAll);
    const ids = biz.ok && Array.isArray(biz.body.data) ? (biz.body.data as Record<string, unknown>[]).map((b) => (typeof b.id === "string" ? b.id : "")).filter((id) => /^\d{5,30}$/.test(id)).slice(0, 10) : [];
    for (const id of ids)
      for (const edge of ["owned_pages", "client_pages"]) {
        const r = await graph(fetchImpl, `${base}/${id}/${edge}?${new URLSearchParams({ fields: "id,name,access_token,tasks", limit: "100", access_token: userToken, appsecret_proof: proof })}`, { method: "GET" }, hideAll);
        if (r.ok && Array.isArray(r.body.data)) viaBusiness.push(...(r.body.data as Record<string, unknown>[]));
      }
  }
  const toRaw = (p: Record<string, unknown>, business: boolean): RawPage & { token: string } => ({
    id: typeof p.id === "string" ? p.id : "",
    name: typeof p.name === "string" ? p.name.slice(0, 120) : "",
    token: typeof p.access_token === "string" ? p.access_token : "",
    hasToken: typeof p.access_token === "string" && p.access_token.length > 0,
    tasks: Array.isArray(p.tasks) ? (p.tasks as unknown[]).filter((t): t is string => typeof t === "string") : null,
    viaBusiness: business,
  });
  const raw = [...data.map((p) => toRaw(p, false)), ...viaBusiness.map((p) => toRaw(p, true))].filter((p) => /^\d{5,30}$/.test(p.id));
  const diagnostic = diagnosePageDiscovery({ permissions, raw: raw.map((p) => ({ id: p.id, name: p.name, hasToken: p.hasToken, tasks: p.tasks, viaBusiness: p.viaBusiness })), appRole, userToken: userTokenCheck });
  const seen = new Set<string>();
  const pages = raw
    .filter((p) => p.hasToken && !seen.has(p.id) && Boolean(seen.add(p.id)))
    .map((p) => ({ id: p.id, name: p.name, token: p.token, canMessage: pageCanMessage(p.tasks) }));
  return { pages, diagnostic };
}

/** Đăng ký app nhận webhook của page (tin nhắn + tiếng vọng). */
export async function subscribePage(app: MessengerApp, pageId: string, pageToken: string, fetchImpl: Fetch = fetch): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await graph(
    fetchImpl,
    `${graphBase()}/${encodeURIComponent(pageId)}/subscribed_apps?${new URLSearchParams({ subscribed_fields: MESSENGER_FIELDS.join(","), access_token: pageToken, appsecret_proof: appSecretProof(pageToken, app.appSecret) })}`,
    { method: "POST" },
    [pageToken, app.appSecret],
  );
  if (!r.ok) return { ok: false, error: r.error };
  return r.body.success === true ? { ok: true } : { ok: false, error: "Facebook không xác nhận đăng ký webhook cho page." };
}

/**
 * ═══ WEBHOOK CỦA PAGE CÓ THẬT SỰ ĐĂNG KÝ KHÔNG (chỉ ĐỌC) ═══
 *
 * Lưu page xong chưa chắc tin đã về: `POST subscribed_apps` có thể bị Meta gỡ sau đó (chủ page gỡ app trong Business Suite,
 * đổi quyền, token bị thu hồi). `GET /{page}/subscribed_apps` nói app NÀO đang nhận sự kiện của page, với những TRƯỜNG nào:
 *  · OK              — app của nền tảng có trong danh sách và đủ `MESSENGER_FIELDS`;
 *  · NOT_SUBSCRIBED  — app không có trong danh sách (tin khách nhắn không bao giờ tới ERP);
 *  · MISSING_FIELDS  — có app nhưng thiếu trường (vd thiếu `feed` ⇒ không trả lời bình luận);
 *  · TOKEN_EXPIRED   — `/debug_token` báo token page hết hạn / không hợp lệ, hoặc Meta trả mã 190;
 *  · UNKNOWN         — không đọc được (mạng, quyền) — KHÔNG kết luận.
 * Không gọi POST nào: hàm này không sửa gì ở Meta.
 */
export const WEBHOOK_STATES = ["OK", "NOT_SUBSCRIBED", "MISSING_FIELDS", "TOKEN_EXPIRED", "UNKNOWN"] as const;
export type WebhookState = (typeof WEBHOOK_STATES)[number];
export type PageWebhookCheck = { pageId: string; state: WebhookState; missingFields: string[]; token: TokenCheck; detail: string | null };

export async function checkPageWebhook(app: MessengerApp, pageId: string, pageToken: string, fetchImpl: Fetch = fetch, now: Date = new Date()): Promise<PageWebhookCheck> {
  const unknownToken: TokenCheck = { state: "UNKNOWN", expiresAt: null, why: null };
  if (!/^\d{5,30}$/.test(pageId)) return { pageId, state: "UNKNOWN", missingFields: [], token: unknownToken, detail: "Mã page không hợp lệ." };
  const token = await inspectToken(app, pageToken, fetchImpl, now);
  if (token.state === "EXPIRED") return { pageId, state: "TOKEN_EXPIRED", missingFields: [], token, detail: token.why };
  const r = await graph(fetchImpl, `${graphBase()}/${encodeURIComponent(pageId)}/subscribed_apps?${new URLSearchParams({ fields: "id,name,subscribed_fields", access_token: pageToken, appsecret_proof: appSecretProof(pageToken, app.appSecret) })}`, { method: "GET" }, [pageToken, app.appSecret]);
  if (!r.ok) return { pageId, state: r.kind === "TOKEN" ? "TOKEN_EXPIRED" : "UNKNOWN", missingFields: [], token, detail: r.error };
  const rows = Array.isArray(r.body.data) ? (r.body.data as Record<string, unknown>[]) : [];
  const mine = rows.find((x) => String(x.id ?? "") === app.appId);
  if (!mine) return { pageId, state: "NOT_SUBSCRIBED", missingFields: [...MESSENGER_FIELDS], token, detail: rows.length ? `Page đang gửi sự kiện cho ${rows.length} app khác, không có app của nền tảng.` : null };
  if (!Array.isArray(mine.subscribed_fields)) return { pageId, state: "UNKNOWN", missingFields: [], token, detail: "Meta không trả danh sách trường đã đăng ký." };
  const fields = (mine.subscribed_fields as unknown[]).map((f) => String(f));
  const missingFields = MESSENGER_FIELDS.filter((f) => !fields.includes(f));
  return { pageId, state: missingFields.length ? "MISSING_FIELDS" : "OK", missingFields: [...missingFields], token, detail: null };
}

/**
 * GỠ đăng ký webhook của app nền tảng khỏi page (`DELETE /{page}/subscribed_apps`) — gọi khi shop gỡ page khỏi ERP, để Meta thôi gửi
 * tin của page tới nền tảng (trước đây chỉ xoá chỉ mục: Meta vẫn gửi, webhook bỏ qua «page lạ» mãi mãi). Token đã hỏng ⇒ không gỡ được,
 * nơi gọi vẫn gỡ phía ERP (chỉ mục mất ⇒ tin tới vẫn bị bỏ qua, không rơi về tổ chức nào).
 */
export async function unsubscribePage(app: MessengerApp, pageId: string, pageToken: string, fetchImpl: Fetch = fetch): Promise<{ ok: true } | { ok: false; error: string; kind: GraphErrorKind }> {
  if (!/^\d{5,30}$/.test(pageId)) return { ok: false, error: "Mã page không hợp lệ", kind: "OTHER" };
  const r = await graph(fetchImpl, `${graphBase()}/${encodeURIComponent(pageId)}/subscribed_apps?${new URLSearchParams({ access_token: pageToken, appsecret_proof: appSecretProof(pageToken, app.appSecret) })}`, { method: "DELETE" }, [pageToken, app.appSecret]);
  if (!r.ok) return { ok: false, error: r.error, kind: r.kind };
  return r.body.success === true ? { ok: true } : { ok: false, error: "Facebook không xác nhận gỡ đăng ký webhook.", kind: "OTHER" };
}

/** Kiểm tra kết nối: page token đọc được ĐÚNG page đã khai (chỉ đọc). */
export async function checkPage(app: MessengerApp, pageId: string, pageToken: string, fetchImpl: Fetch = fetch): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const r = await graph(fetchImpl, `${graphBase()}/me?${new URLSearchParams({ fields: "id,name", access_token: pageToken, appsecret_proof: appSecretProof(pageToken, app.appSecret) })}`, { method: "GET" }, [pageToken, app.appSecret]);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.body.id !== pageId) return { ok: false, error: "Token không thuộc page đã khai." };
  return { ok: true, name: typeof r.body.name === "string" ? r.body.name : pageId };
}

/** Tài khoản Instagram doanh nghiệp gắn với page (`instagram_business_account`) — không có / không đọc được ⇒ `null`. */
export async function instagramAccountOf(app: MessengerApp, pageId: string, pageToken: string, fetchImpl: Fetch = fetch): Promise<{ id: string; username: string } | null> {
  const r = await graph(
    fetchImpl,
    `${graphBase()}/${encodeURIComponent(pageId)}?${new URLSearchParams({ fields: "instagram_business_account{id,username}", access_token: pageToken, appsecret_proof: appSecretProof(pageToken, app.appSecret) })}`,
    { method: "GET" },
    [pageToken, app.appSecret],
  );
  if (!r.ok) return null;
  const ig = r.body.instagram_business_account as { id?: unknown; username?: unknown } | undefined;
  const id = typeof ig?.id === "string" ? ig.id : "";
  return /^\d{5,30}$/.test(id) ? { id, username: typeof ig?.username === "string" ? ig.username.slice(0, 60) : "" } : null;
}

/**
 * Gửi MỘT tin chữ cho khách (Send API, `messaging_type: RESPONSE` — trả lời trong khung 24 giờ kể từ tin cuối của khách).
 * Chữ dài hơn 2.000 ký tự ⇒ nơi gọi chia trước (`chunkText`).
 */
export async function sendMessengerText(app: MessengerApp, pageToken: string, psid: string, text: string, fetchImpl: Fetch = fetch): Promise<{ ok: true; id: string | null } | { ok: false; error: string; kind: GraphErrorKind }> {
  const r = await graph(
    fetchImpl,
    `${graphBase()}/me/messages?${new URLSearchParams({ access_token: pageToken, appsecret_proof: appSecretProof(pageToken, app.appSecret) })}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recipient: { id: psid }, messaging_type: "RESPONSE", message: { text: text.slice(0, MESSENGER_TEXT_MAX) } }) },
    [pageToken, app.appSecret],
  );
  if (!r.ok) return { ok: false, error: r.error, kind: r.kind };
  return { ok: true, id: typeof r.body.message_id === "string" ? r.body.message_id : null };
}

/**
 * Gửi MỘT ảnh cho khách qua Send API — tải TỆP lên cùng lời gọi (`filedata`, multipart), không cần URL công khai của ảnh.
 * Cùng khung 24 giờ / `RESPONSE` với tin chữ. Trả mã tin Meta để tiếng vọng nhận ra là tin của chính page.
 */
export async function sendMessengerImage(app: MessengerApp, pageToken: string, psid: string, image: { data: Uint8Array; contentType: string }, fetchImpl: Fetch = fetch): Promise<{ ok: true; id: string | null } | { ok: false; error: string; kind: GraphErrorKind }> {
  const form = new FormData();
  form.append("recipient", JSON.stringify({ id: psid }));
  form.append("messaging_type", "RESPONSE");
  form.append("message", JSON.stringify({ attachment: { type: "image", payload: { is_reusable: false } } }));
  form.append("filedata", new Blob([new Uint8Array(image.data)], { type: image.contentType }), `anh.${image.contentType.split("/")[1] ?? "jpg"}`);
  const r = await graph(fetchImpl, `${graphBase()}/me/messages?${new URLSearchParams({ access_token: pageToken, appsecret_proof: appSecretProof(pageToken, app.appSecret) })}`, { method: "POST", body: form }, [pageToken, app.appSecret]);
  if (!r.ok) return { ok: false, error: r.error, kind: r.kind };
  return { ok: true, id: typeof r.body.message_id === "string" ? r.body.message_id : null };
}

/**
 * TIN RIÊNG trả lời MỘT bình luận (Private Replies): người nhận là `comment_id`, mở hộp thư Messenger với người bình luận.
 * Meta chỉ cho MỘT tin riêng mỗi bình luận, trong 7 ngày.
 */
export async function sendPrivateReply(app: MessengerApp, pageToken: string, commentId: string, text: string, fetchImpl: Fetch = fetch): Promise<{ ok: true; id: string | null; recipientId: string | null } | { ok: false; error: string; kind: GraphErrorKind }> {
  const r = await graph(
    fetchImpl,
    `${graphBase()}/me/messages?${new URLSearchParams({ access_token: pageToken, appsecret_proof: appSecretProof(pageToken, app.appSecret) })}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text: text.slice(0, MESSENGER_TEXT_MAX) } }) },
    [pageToken, app.appSecret],
  );
  if (!r.ok) return { ok: false, error: r.error, kind: r.kind };
  return { ok: true, id: typeof r.body.message_id === "string" ? r.body.message_id : null, recipientId: typeof r.body.recipient_id === "string" ? r.body.recipient_id : null };
}

/** Nội dung bài viết khách bình luận dưới (để bot hiểu «cho giá» là giá món nào). Không đọc được ⇒ `null`. */
export async function postMessage(app: MessengerApp, pageToken: string, postId: string, fetchImpl: Fetch = fetch): Promise<string | null> {
  if (!/^[0-9_]{5,80}$/.test(postId)) return null;
  const r = await graph(fetchImpl, `${graphBase()}/${encodeURIComponent(postId)}?${new URLSearchParams({ fields: "message", access_token: pageToken, appsecret_proof: appSecretProof(pageToken, app.appSecret) })}`, { method: "GET" }, [pageToken, app.appSecret]);
  return r.ok && typeof r.body.message === "string" ? r.body.message.slice(0, 2000) : null;
}

// ─────────────────────────── Webhook ───────────────────────────

/** `X-Hub-Signature-256: sha256=<hex>` khớp HMAC của THÂN GỐC. So thời gian hằng; thiếu / sai dạng ⇒ `false`. HÀM THUẦN. */
export function verifyMessengerSignature(raw: Uint8Array | string, header: string | null | undefined, appSecret: string): boolean {
  const m = /^sha256=([0-9a-f]{64})$/i.exec((header ?? "").trim());
  if (!m || !appSecret) return false;
  const expected = createHmac("sha256", appSecret).update(typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw)).digest();
  const got = Buffer.from(m[1], "hex");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Mã xác minh khi khai webhook ở trang quản trị app Meta — DẪN XUẤT từ `AUTH_SECRET`, không phải biến môi trường thứ hai. */
export function messengerVerifyToken(): string {
  return createHmac("sha256", env.authSecret).update("messenger-webhook-verify/v1").digest("base64url").slice(0, 32);
}

export type MessengerEvent = {
  /** Kênh của gói: Messenger (object «page») hay Instagram DM (object «instagram»). */
  platform: "MESSENGER" | "INSTAGRAM";
  /** Mã page (Messenger) hoặc mã tài khoản Instagram doanh nghiệp (Instagram) — đều tra ở `platform_messenger_pages`. */
  pageId: string;
  /** Mã khách trong phạm vi page (PSID) — là «hội thoại». */
  psid: string;
  mid: string;
  text: string;
  imageUrls: string[];
  /** Tin page GỬI ĐI (tiếng vọng): của bot nếu `appId` = app nền tảng, còn lại là người / app khác. */
  isEcho: boolean;
  appId: string | null;
  at: Date | null;
  /** Bình luận dưới bài viết của page (trường `feed`): trả lời bằng TIN RIÊNG, không bao giờ công khai. `psid` = người bình luận. */
  comment?: { commentId: string; postId: string };
};

const s = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/**
 * Gói webhook (object = "page" — Messenger, hoặc "instagram" — Instagram DM; cùng khuôn `messaging`) ⇒ các sự kiện TIN NHẮN. Bỏ: đã nhận / đã xem, tin bị xoá, phản ứng; nhãn dán (👍) không có chữ
 * ⇒ không thành sự kiện. Nút bấm (postback) ⇒ dùng tiêu đề nút như chữ khách gõ. HÀM THUẦN.
 */
export function parseMessengerWebhook(payload: unknown): MessengerEvent[] {
  const p = (payload && typeof payload === "object" ? payload : {}) as { object?: unknown; entry?: unknown };
  if ((p.object !== "page" && p.object !== "instagram") || !Array.isArray(p.entry)) return [];
  const platform = p.object === "instagram" ? ("INSTAGRAM" as const) : ("MESSENGER" as const);
  const out: MessengerEvent[] = [];
  for (const entry of p.entry as Record<string, unknown>[]) {
    const pageId = s(entry?.id);
    const list = Array.isArray(entry?.messaging) ? (entry.messaging as Record<string, unknown>[]) : [];
    for (const m of list) {
      const sender = s((m.sender as { id?: unknown } | undefined)?.id);
      const recipient = s((m.recipient as { id?: unknown } | undefined)?.id);
      const at = typeof m.timestamp === "number" ? new Date(m.timestamp) : null;
      const msg = m.message as Record<string, unknown> | undefined;
      const postback = m.postback as Record<string, unknown> | undefined;
      if (msg) {
        const mid = s(msg.mid);
        if (!mid || msg.is_deleted === true) continue;
        const isEcho = msg.is_echo === true;
        const atts = Array.isArray(msg.attachments) ? (msg.attachments as Record<string, unknown>[]) : [];
        const sticker = Boolean(msg.sticker_id);
        const imageUrls = sticker
          ? []
          : atts
              .filter((a) => a.type === "image")
              .map((a) => s((a.payload as { url?: unknown } | undefined)?.url))
              .filter(Boolean)
              .slice(0, 3);
        const text = s(msg.text).slice(0, 2000);
        if (!text && !imageUrls.length && !isEcho) continue;
        out.push({ platform, pageId, psid: isEcho ? recipient : sender, mid, text, imageUrls, isEcho, appId: msg.app_id === undefined || msg.app_id === null ? null : s(msg.app_id), at });
      } else if (postback) {
        const title = s(postback.title) || s(postback.payload);
        const mid = s(postback.mid) || `postback:${sender}:${s(m.timestamp)}`;
        if (title) out.push({ platform, pageId, psid: sender, mid, text: title.slice(0, 2000), imageUrls: [], isEcho: false, appId: null, at });
      }
    }
  }
  // Bình luận (trường `feed`, chỉ của page — Instagram không có ở đây): bình luận MỚI của người khác, có chữ.
  if (platform === "MESSENGER") {
    for (const entry of p.entry as Record<string, unknown>[]) {
      const pageId = s(entry?.id);
      const changes = Array.isArray(entry?.changes) ? (entry.changes as Record<string, unknown>[]) : [];
      for (const ch of changes) {
        const v = (ch.value ?? {}) as Record<string, unknown>;
        if (ch.field !== "feed" || v.item !== "comment" || v.verb !== "add") continue;
        const from = (v.from ?? {}) as { id?: unknown };
        const fromId = s(from.id);
        const commentId = s(v.comment_id);
        const postId = s(v.post_id);
        const text = s(v.message).slice(0, 2000);
        if (!fromId || fromId === pageId || !commentId || !text) continue;
        out.push({ platform, pageId, psid: fromId, mid: `comment:${commentId}`, text, imageUrls: [], isEcho: false, appId: null, at: typeof v.created_time === "number" ? new Date(v.created_time * 1000) : null, comment: { commentId, postId } });
      }
    }
  }
  return out.filter((e) => /^\d{5,30}$/.test(e.pageId) && /^\d{5,30}$/.test(e.psid));
}

// ─────────────────────────── Hội thoại cũ của page (Conversations API) ───────────────────────────

/** Trường đọc mỗi hội thoại: người tham gia (PSID / IGSID của khách), mốc cập nhật, tối đa N tin GẦN NHẤT kèm ảnh. */
function conversationFields(messages: number): string {
  return `participants,updated_time,messages.limit(${Math.max(1, Math.min(20, messages))}){id,message,from,created_time,attachments{image_data{url},mime_type}}`;
}

/**
 * MỘT trang danh sách hội thoại của page (`GET /{page}/conversations?platform=…`, mới cập nhật → cũ) — Meta chỉ cho đọc 20 tin GẦN
 * NHẤT mỗi hội thoại; hội thoại «Tin nhắn chờ» không hoạt động 30 ngày không trả về. Instagram đọc qua PAGE CHA với
 * `platform=instagram`. Phân trang bằng con trỏ `after` (không theo URL `next` Meta trả — URL chứa token và không phải hằng số
 * của ta). Quyền: `pages_messaging` + `pages_manage_metadata` + `pages_read_engagement` (Instagram: `instagram_manage_messages`).
 */
export async function pageConversations(
  app: MessengerApp,
  pageToken: string,
  pageId: string,
  opts: { platform: "messenger" | "instagram"; after: string | null; limit: number; messages: number },
  fetchImpl: Fetch = fetch,
): Promise<{ ok: true; items: Record<string, unknown>[]; after: string | null } | { ok: false; error: string; kind: GraphErrorKind }> {
  if (!/^\d{5,30}$/.test(pageId)) return { ok: false, error: "Mã page không hợp lệ", kind: "OTHER" };
  const q = new URLSearchParams({ platform: opts.platform, fields: conversationFields(opts.messages), limit: String(Math.max(1, Math.min(50, opts.limit))), access_token: pageToken, appsecret_proof: appSecretProof(pageToken, app.appSecret) });
  if (opts.after) q.set("after", opts.after);
  const r = await graph(fetchImpl, `${graphBase()}/${encodeURIComponent(pageId)}/conversations?${q}`, { method: "GET" }, [pageToken, app.appSecret]);
  if (!r.ok) return { ok: false, error: r.error, kind: r.kind };
  const data = Array.isArray(r.body.data) ? (r.body.data as Record<string, unknown>[]) : [];
  const paging = (r.body.paging ?? {}) as { cursors?: { after?: unknown }; next?: unknown };
  const after = typeof paging.cursors?.after === "string" && paging.next ? paging.cursors.after : null;
  return { ok: true, items: data, after };
}
