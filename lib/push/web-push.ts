import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from "node:crypto";
import { env } from "@/lib/env";

/**
 * ═══════════ WEB PUSH — THÔNG BÁO ĐẨY TỚI ĐIỆN THOẠI / MÁY TÍNH ĐÃ CÀI ERP (docs/platform/pwa.md) ═══════════
 *
 * Chuẩn mở, không qua dịch vụ trả tiền nào: trình duyệt cấp một `endpoint` (máy chủ đẩy của Google / Mozilla / Apple /
 * Microsoft) + hai khoá; ERP mã hoá nội dung theo RFC 8291 (aes128gcm) và ký yêu cầu theo VAPID (RFC 8292). Chỉ dùng
 * `node:crypto` — không thêm gói ngoài.
 *
 *  · Khoá VAPID DẪN XUẤT từ `AUTH_SECRET` (HMAC, nhãn riêng) — không thêm biến môi trường, không lưu khoá riêng ở đâu. Đổi
 *    `AUTH_SECRET` ⇒ các đăng ký cũ hết hiệu lực (máy chủ đẩy trả 401/403 ⇒ ERP xoá), người dùng bấm bật lại.
 *  · `endpoint` do trình duyệt đưa lên ⇒ CHỈ nhận máy chủ đẩy đã biết (`allowedPushEndpoint`) — không biến ERP thành máy gửi
 *    request tới địa chỉ tuỳ ý (SSRF).
 *  · Nội dung tối đa ~3.000 byte; trình duyệt hiện tiêu đề + một dòng, bấm vào mở đúng trang.
 */

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

/** Máy chủ đẩy của các trình duyệt lớn. Thêm nhà cung cấp mới = thêm hậu tố ở đây (có bài kiểm). */
export const PUSH_HOST_SUFFIXES = ["fcm.googleapis.com", "push.services.mozilla.com", "notify.windows.com", "push.apple.com"] as const;

export function allowedPushEndpoint(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

export type VapidKeys = { publicKey: string; privateKey: Buffer; publicRaw: Buffer };

/** Cặp khoá VAPID (P-256) dẫn xuất từ một bí mật. HÀM THUẦN với cùng bí mật ⇒ cùng khoá. */
export function vapidKeysFrom(secret: string): VapidKeys {
  for (let i = 0; i < 8; i++) {
    const d = createHmac("sha256", secret).update(`vapid-p256/v1/${i}`).digest();
    try {
      const ecdh = createECDH("prime256v1");
      ecdh.setPrivateKey(d);
      const pub = ecdh.getPublicKey();
      return { publicKey: b64u(pub), privateKey: d, publicRaw: pub };
    } catch {
      // d ngoài miền hợp lệ của P-256 (xác suất ~2^-32) ⇒ thử nhãn kế tiếp.
    }
  }
  throw new Error("Không dẫn xuất được khoá VAPID.");
}

export function vapidKeys(): VapidKeys {
  return vapidKeysFrom(env.authSecret);
}

/** Tiêu đề `Authorization: vapid t=<JWT ES256>, k=<khoá công khai>` cho MỘT endpoint. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now: Date = new Date()): string {
  const aud = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: subject })));
  const key = createPrivateKey({ key: { kty: "EC", crv: "P-256", d: b64u(keys.privateKey), x: b64u(keys.publicRaw.subarray(1, 33)), y: b64u(keys.publicRaw.subarray(33, 65)) }, format: "jwk" });
  const sig = sign("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${keys.publicKey}`;
}

const hmac = (key: Uint8Array, data: Uint8Array) => createHmac("sha256", key).update(data).digest();

/**
 * Mã hoá nội dung theo RFC 8291 (Content-Encoding: aes128gcm), MỘT bản ghi. `opts` chỉ để bài kiểm tái dựng véc-tơ của RFC.
 * HÀM THUẦN khi `opts` đủ.
 */
export function encryptPushPayload(plaintext: Uint8Array, uaPublicB64: string, authSecretB64: string, opts: { salt?: Uint8Array; asPrivate?: Uint8Array } = {}): Buffer {
  const uaPublic = unb64u(uaPublicB64);
  const authSecret = unb64u(authSecretB64);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("Khoá p256dh của trình duyệt không hợp lệ.");
  if (authSecret.length !== 16) throw new Error("Khoá auth của trình duyệt không hợp lệ.");
  const as = createECDH("prime256v1");
  if (opts.asPrivate) as.setPrivateKey(Buffer.from(opts.asPrivate));
  else as.generateKeys();
  const asPublic = as.getPublicKey();
  const ecdhSecret = as.computeSecret(uaPublic);
  const salt = Buffer.from(opts.salt ?? randomBytes(16));
  // HKDF(auth_secret, ecdh_secret, "WebPush: info\0" || ua_public || as_public, 32)
  const prkKey = hmac(authSecret, ecdhSecret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])])).subarray(0, 32);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

export type PushSubscriptionKeys = { endpoint: string; p256dh: string; auth: string };
export type PushMessage = { title: string; body: string; href: string; tag?: string };
export type PushResult = { ok: true } | { ok: false; gone: boolean; status: number | null; error: string };

/** Gửi MỘT thông báo tới MỘT đăng ký. `gone` = đăng ký không còn dùng được (xoá đi). Không ném. */
export async function sendWebPush(sub: PushSubscriptionKeys, msg: PushMessage, deps: { fetch?: typeof fetch; keys?: VapidKeys; subject?: string; now?: Date } = {}): Promise<PushResult> {
  if (!allowedPushEndpoint(sub.endpoint)) return { ok: false, gone: true, status: null, error: "Máy chủ đẩy lạ — bỏ." };
  try {
    const payload = Buffer.from(JSON.stringify({ title: msg.title.slice(0, 120), body: msg.body.slice(0, 400), href: msg.href.slice(0, 500), tag: msg.tag?.slice(0, 120) }));
    const body = encryptPushPayload(payload, sub.p256dh, sub.auth);
    const keys = deps.keys ?? vapidKeys();
    const res = await (deps.fetch ?? fetch)(sub.endpoint, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(8_000),
      headers: { "content-type": "application/octet-stream", "content-encoding": "aes128gcm", ttl: "86400", urgency: "high", authorization: vapidAuthorization(sub.endpoint, keys, deps.subject ?? "mailto:support@vnxcommerce.com", deps.now) },
      body: new Uint8Array(body),
    });
    if (res.status >= 200 && res.status < 300) return { ok: true };
    // 404 / 410: đăng ký đã huỷ; 401 / 403: khoá VAPID không còn khớp (đổi AUTH_SECRET) — cả hai đều phải bật lại.
    return { ok: false, gone: [401, 403, 404, 410].includes(res.status), status: res.status, error: `Máy chủ đẩy trả HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, gone: false, status: null, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}
