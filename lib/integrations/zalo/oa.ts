/**
 * ═══════════ ZALO OFFICIAL ACCOUNT — CLIENT (kênh chat thứ ba cho chatbot bán hàng · MIGRATION_PLAN.md M11) ═══════════
 *
 * Chủ shop chốt 04/10/2026 (Q3): khách KHÔNG dùng Pancake vẫn phải dùng được bot. Zalo OA là kênh chat lớn nhất ở Việt Nam.
 * Mô hình: MỖI SHOP DÙNG ZALO APP CỦA CHÍNH MÌNH (BYO, như khoá AI BYOK) — webhook riêng theo tổ chức (token ký trong đường
 * dẫn, lib/platform/webhooks.ts), không có app chung của nền tảng nào phải duyệt.
 *
 * Bốn sự thật vận hành (đối chiếu Zalo Open API v3 + tài liệu vận hành OA, hiệu lực 01/01/2026):
 *  1. CHỮ KÝ WEBHOOK: header `X-ZEvent-Signature: mac=<hex>`, mac = SHA256(app_id + THÂN THÔ + timestamp + OA Secret Key).
 *     Ký trên thân THÔ — parse rồi dump lại là sai chữ ký. OA Secret Key KHÁC App Secret (dùng cho OAuth).
 *  2. REFRESH TOKEN DÙNG MỘT LẦN: mỗi lần làm mới Zalo trả cặp access + refresh MỚI và huỷ cặp cũ ⇒ phải lưu cặp mới NGAY,
 *     và chỉ MỘT luồng được làm mới cùng lúc (lib/connectors/service.ts::rotateOrgConnectionSecrets — khoá tư vấn).
 *  3. CỬA SỔ TIN TƯ VẤN: ≤ 48 giờ từ tương tác cuối của khách ⇒ miễn phí; 48 giờ – 7 ngày ⇒ gửi được nhưng ZALO TÍNH PHÍ;
 *     > 7 ngày ⇒ API từ chối (-230 / -232). Mặc định CHẶN mọi tin ngoài 48 giờ — đốt tiền âm thầm là lỗi, không phải tính năng.
 *  4. Sự kiện `oa_send_*` là tin của CHÍNH OA (bot, hoặc nhân viên trả lời trong OA Manager) — không đưa cho bot, nếu không bot
 *     tự trả lời chính mình.
 *
 * Mọi hàm nhận `fetch` tiêm vào (luật 65 — bài kiểm không gọi mạng thật). Không in token: lỗi đi qua `scrub`.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const ZALO_OAUTH_TOKEN_URL = "https://oauth.zaloapp.com/v4/oa/access_token";
export const ZALO_MESSAGE_CS_URL = "https://openapi.zalo.me/v3.0/oa/message/cs";
export const ZALO_GET_OA_URL = "https://openapi.zalo.me/v2.0/oa/getoa";

export const ZALO_LIMITS = {
  timeoutMs: 10_000,
  /** Làm mới sớm hơn hạn chừng này — tránh dùng token hết hạn giữa đường. */
  refreshSkewMs: 2 * 60_000,
  /** Zalo cắt tin tư vấn dài; 2.000 ký tự là trần an toàn của một tin chữ. */
  textMax: 2000,
  freeWindowHours: 48,
  apiWindowDays: 7,
} as const;

export const ZALO_ID_PATTERN = /^[0-9]{5,30}$/;
export const ZALO_SECRET_PATTERN = /^[A-Za-z0-9_-]{8,200}$/;
export const ZALO_OA_TOKEN_PATTERN = /^[A-Za-z0-9._-]{20,2000}$/;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type ZaloDeps = { fetch?: FetchLike; now?: () => Date };

/** Mã lỗi Zalo nói «ngoài cửa sổ tương tác / khách chặn / chưa quan tâm OA» — không phải lỗi kết nối, không gửi lại. */
export const ZALO_WINDOW_ERRORS = new Set([-213, -217, -227, -230, -232, -234, -244]);

function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("«đã che»");
  return out.slice(0, 300);
}

// ─────────────────────────── WEBHOOK ───────────────────────────

/** Kiểm chữ ký webhook trên THÂN THÔ. `header` = giá trị `X-ZEvent-Signature` («mac=<hex>» hoặc chỉ hex). HÀM THUẦN. */
export function verifyZaloSignature(input: { appId: string; rawBody: string; timestamp: string; oaSecretKey: string; header: string | null }): boolean {
  const got = (input.header ?? "").trim().replace(/^mac=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(got) || !input.oaSecretKey || !input.appId) return false;
  const want = createHash("sha256").update(`${input.appId}${input.rawBody}${input.timestamp}${input.oaSecretKey}`, "utf8").digest("hex");
  return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(want, "hex"));
}

export type ZaloEvent =
  | { kind: "CUSTOMER"; oaId: string; userId: string; msgId: string; text: string; imageUrls: string[]; at: Date; eventName: string }
  | { kind: "OA_ECHO"; oaId: string; userId: string; msgId: string; text: string; at: Date; eventName: string }
  | { kind: "INTERACTION"; oaId: string; userId: string; at: Date; eventName: string }
  | { kind: "IGNORED"; reason: string };

const INTERACTION_EVENTS = new Set(["follow", "unfollow", "user_seen_message", "user_received_message", "user_submit_info"]);

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

/** Bóc MỘT sự kiện webhook Zalo OA thành dạng chuẩn của kênh. HÀM THUẦN. */
export function parseZaloEvent(raw: unknown): ZaloEvent {
  if (!raw || typeof raw !== "object") return { kind: "IGNORED", reason: "Gói không phải đối tượng JSON" };
  const e = raw as Record<string, unknown>;
  const name = str(e.event_name);
  if (!name) return { kind: "IGNORED", reason: "Thiếu event_name" };
  const sender = (e.sender && typeof e.sender === "object" ? e.sender : {}) as Record<string, unknown>;
  const recipient = (e.recipient && typeof e.recipient === "object" ? e.recipient : {}) as Record<string, unknown>;
  const follower = (e.follower && typeof e.follower === "object" ? e.follower : {}) as Record<string, unknown>;
  const tsNum = Number(str(e.timestamp));
  const at = Number.isFinite(tsNum) && tsNum > 0 ? new Date(tsNum) : new Date(0);
  const isEcho = name.startsWith("oa_send_");
  // Hội thoại luôn theo NGƯỜI DÙNG: họ là sender ở tin đến, là recipient ở tin OA gửi ra.
  const userId = str(isEcho ? recipient.id : sender.id) || str(follower.id);
  const oaId = str(isEcho ? sender.id : recipient.id) || str(e.oa_id);
  if (!userId) return { kind: "IGNORED", reason: "Thiếu mã người dùng" };
  if (INTERACTION_EVENTS.has(name)) return { kind: "INTERACTION", oaId, userId, at, eventName: name };
  const message = (e.message && typeof e.message === "object" ? e.message : {}) as Record<string, unknown>;
  const msgId = str(message.msg_id);
  const text = str(message.text).trim();
  if (isEcho) return msgId ? { kind: "OA_ECHO", oaId, userId, msgId, text, at, eventName: name } : { kind: "IGNORED", reason: "Tin OA thiếu msg_id" };
  if (!name.startsWith("user_send_")) return { kind: "IGNORED", reason: `Sự kiện ${name} không phải tin khách` };
  if (!msgId) return { kind: "IGNORED", reason: "Tin khách thiếu msg_id (không chống trùng được)" };
  const atts = Array.isArray(message.attachments) ? (message.attachments as unknown[]) : [];
  const imageUrls: string[] = [];
  for (const a of atts) {
    if (!a || typeof a !== "object") continue;
    const p = ((a as Record<string, unknown>).payload ?? {}) as Record<string, unknown>;
    const u = str(p.url);
    if (u.startsWith("https://") && (name === "user_send_image" || name === "user_send_gif")) imageUrls.push(u);
  }
  // Tin không chữ không ảnh (nhãn dán, ghi âm, vị trí…) ⇒ vẫn là KHÁCH vừa tương tác (mở cửa sổ 48 giờ), nhưng bot không trả lời.
  return { kind: "CUSTOMER", oaId, userId, msgId, text, imageUrls, at, eventName: name };
}

// ─────────────────────────── CỬA SỔ TIN TƯ VẤN ───────────────────────────

export type ZaloWindow = "FREE" | "PAID" | "CLOSED" | "UNKNOWN";

/** Tin gửi lúc `now` cho khách tương tác lần cuối lúc `lastCustomerAt` thuộc cửa sổ nào. HÀM THUẦN. */
export function zaloWindow(lastCustomerAt: Date | null, now: Date): ZaloWindow {
  if (!lastCustomerAt) return "UNKNOWN";
  const h = (now.getTime() - lastCustomerAt.getTime()) / 3_600_000;
  if (h < 0) return "FREE";
  if (h <= ZALO_LIMITS.freeWindowHours) return "FREE";
  if (h <= ZALO_LIMITS.apiWindowDays * 24) return "PAID";
  return "CLOSED";
}

// ─────────────────────────── OAUTH: LÀM MỚI TOKEN ───────────────────────────

export type ZaloTokenPair = { accessToken: string; refreshToken: string; expiresAt: Date };

/**
 * Đổi refresh token lấy cặp MỚI. Refresh token cũ BỊ HUỶ ngay khi Zalo trả lời thành công — người gọi PHẢI lưu cặp mới trước
 * khi làm gì khác (lib/connectors/service.ts::rotateOrgConnectionSecrets).
 */
export async function zaloRefreshTokens(input: { appId: string; appSecret: string; refreshToken: string }, deps: ZaloDeps = {}): Promise<{ ok: true; pair: ZaloTokenPair } | { ok: false; error: string }> {
  const hide = [input.appSecret, input.refreshToken];
  if (!ZALO_ID_PATTERN.test(input.appId)) return { ok: false, error: "App ID không đúng dạng (chỉ chữ số)." };
  if (!input.appSecret || !input.refreshToken) return { ok: false, error: "Thiếu App Secret hoặc refresh token." };
  const now = (deps.now ?? (() => new Date()))();
  const body = new URLSearchParams({ app_id: input.appId, grant_type: "refresh_token", refresh_token: input.refreshToken });
  try {
    const res = await (deps.fetch ?? fetch)(ZALO_OAUTH_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", secret_key: input.appSecret }, body: body.toString(), redirect: "manual", signal: AbortSignal.timeout(ZALO_LIMITS.timeoutMs) });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const access = str(j.access_token);
    const refresh = str(j.refresh_token);
    if (!res.ok || !access || !refresh) {
      const why = str(j.error_name) || str(j.message) || str(j.error_description) || `HTTP ${res.status}`;
      return { ok: false, error: scrub(`Zalo không cấp token mới: ${why} (mã ${str(j.error) || "?"}). Refresh token hết hạn / đã dùng ⇒ lấy cặp mới ở Zalo API Explorer rồi dán lại.`, hide) };
    }
    const sec = Number(str(j.expires_in));
    return { ok: true, pair: { accessToken: access, refreshToken: refresh, expiresAt: new Date(now.getTime() + (Number.isFinite(sec) && sec > 0 ? sec : 3600) * 1000) } };
  } catch (e) {
    return { ok: false, error: scrub(`Không gọi được Zalo OAuth: ${e instanceof Error ? e.message : String(e)}`, hide) };
  }
}

// ─────────────────────────── GỬI TIN · ĐỌC OA ───────────────────────────

type Envelope = { error: number; message: string; data: Record<string, unknown> };

async function callZalo(url: string, init: RequestInit, hide: readonly string[], deps: ZaloDeps): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; code: number | null; error: string }> {
  try {
    const res = await (deps.fetch ?? fetch)(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(ZALO_LIMITS.timeoutMs) });
    const j = (await res.json().catch(() => null)) as Partial<Envelope> | null;
    // Zalo trả HTTP 200 kèm `error ≠ 0` — đọc phong bì, không tin mã HTTP (như Viettel Post, AGENTS §5).
    if (!j || typeof j !== "object") return { ok: false, code: null, error: `Zalo trả về không phải JSON (HTTP ${res.status})` };
    const code = Number(j.error ?? 0);
    if (code !== 0) return { ok: false, code, error: scrub(`Zalo từ chối (${code}): ${str(j.message)}`, hide) };
    return { ok: true, data: (j.data && typeof j.data === "object" ? j.data : {}) as Record<string, unknown> };
  } catch (e) {
    return { ok: false, code: null, error: scrub(`Không gọi được Zalo: ${e instanceof Error ? e.message : String(e)}`, hide) };
  }
}

/** Gửi MỘT tin tư vấn chữ. `window` = lỗi thuộc nhóm ngoài cửa sổ / khách chặn — không gửi lại. */
export async function zaloSendText(input: { accessToken: string; userId: string; text: string }, deps: ZaloDeps = {}): Promise<{ ok: true; messageId: string | null } | { ok: false; error: string; window: boolean }> {
  const text = input.text.trim().slice(0, ZALO_LIMITS.textMax);
  if (!text) return { ok: false, error: "Tin trống.", window: false };
  const r = await callZalo(ZALO_MESSAGE_CS_URL, { method: "POST", headers: { "content-type": "application/json", access_token: input.accessToken }, body: JSON.stringify({ recipient: { user_id: input.userId }, message: { text } }) }, [input.accessToken], deps);
  if (!r.ok) return { ok: false, error: r.error, window: r.code !== null && ZALO_WINDOW_ERRORS.has(r.code) };
  return { ok: true, messageId: str(r.data.message_id) || null };
}

/** Đọc thông tin OA của access token — kiểm kết nối, KHÔNG gửi tin cho ai. */
export async function zaloGetOa(accessToken: string, deps: ZaloDeps = {}): Promise<{ ok: true; oaId: string; name: string } | { ok: false; error: string }> {
  const r = await callZalo(ZALO_GET_OA_URL, { method: "GET", headers: { access_token: accessToken } }, [accessToken], deps);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, oaId: str(r.data.oa_id), name: str(r.data.name) };
}
