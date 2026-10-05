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
  const q = new URLSearchParams({ client_id: app.appId, redirect_uri: redirectUri, response_type: "code", scope: MESSENGER_SCOPES.join(","), state });
  return `https://www.facebook.com/${graphBase().split("/").pop()}/dialog/oauth?${q}`;
}

export type ConnectablePage = { id: string; name: string; token: string; canMessage: boolean };

/**
 * `code` ⇒ token người dùng (đổi sang token DÀI HẠN — page token dẫn xuất từ nó không hết hạn) ⇒ danh sách page người đó
 * quản lý, kèm page token. Token người dùng KHÔNG được lưu ở đâu cả.
 */
export async function pagesFromCode(app: MessengerApp, code: string, redirectUri: string, fetchImpl: Fetch = fetch): Promise<{ pages: ConnectablePage[] } | { error: string }> {
  const base = graphBase();
  const hide = [app.appSecret, code];
  const short = await graph(fetchImpl, `${base}/oauth/access_token?${new URLSearchParams({ client_id: app.appId, client_secret: app.appSecret, redirect_uri: redirectUri, code })}`, { method: "GET" }, hide);
  if (!short.ok) return { error: short.error };
  const shortToken = typeof short.body.access_token === "string" ? short.body.access_token : "";
  if (!shortToken) return { error: "Facebook không trả token." };
  const long = await graph(fetchImpl, `${base}/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: app.appId, client_secret: app.appSecret, fb_exchange_token: shortToken })}`, { method: "GET" }, [...hide, shortToken]);
  const userToken = long.ok && typeof long.body.access_token === "string" ? long.body.access_token : shortToken;
  const hideAll = [...hide, shortToken, userToken];
  const acc = await graph(
    fetchImpl,
    `${base}/me/accounts?${new URLSearchParams({ fields: "id,name,access_token,tasks", limit: "100", access_token: userToken, appsecret_proof: appSecretProof(userToken, app.appSecret) })}`,
    { method: "GET" },
    hideAll,
  );
  if (!acc.ok) return { error: acc.error };
  const data = Array.isArray(acc.body.data) ? (acc.body.data as Record<string, unknown>[]) : [];
  const pages = data
    .map((p) => ({
      id: typeof p.id === "string" ? p.id : "",
      name: typeof p.name === "string" ? p.name.slice(0, 120) : "",
      token: typeof p.access_token === "string" ? p.access_token : "",
      canMessage: !Array.isArray(p.tasks) || (p.tasks as unknown[]).some((t) => t === "MESSAGING" || t === "MANAGE" || t === "MODERATE"),
    }))
    .filter((p) => /^\d{5,30}$/.test(p.id) && p.token);
  return { pages };
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
