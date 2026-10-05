import { createHash } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import { env } from "@/lib/env";
import type { ConnectablePage } from "@/lib/integrations/messenger/graph";
import { brandAppOrigin } from "@/lib/platform/site-host";

/**
 * Luồng «Kết nối Facebook Page» (docs/platform/messenger.md):
 *   /api/connect/messenger/start     ⇒ `state` ngẫu nhiên trong cookie KÝ (aud riêng) ⇒ hộp thoại cấp quyền của Facebook
 *   /api/connect/messenger/callback  ⇒ khớp `state` + đúng tổ chức / người bấm ⇒ đổi `code` lấy danh sách page
 *     · một page ⇒ nối luôn;
 *     · nhiều page ⇒ danh sách (kèm page token) cất trong cookie MÃ HOÁ (A256GCM, khoá dẫn xuất riêng từ AUTH_SECRET), sống
 *       10 phút ⇒ người bấm chọn ở /ai/sales-chatbot/messenger. Token không bao giờ tới trình duyệt ở dạng đọc được, và không
 *       có bảng tạm nào giữ token người dùng.
 */

export const MESSENGER_STATE_COOKIE = "erp_msg_state";
export const MESSENGER_PAGES_COOKIE = "erp_msg_pages";
export const MESSENGER_CONNECT_TTL_SEC = 10 * 60;
export const MESSENGER_CONNECT_PATH = "/api/connect/messenger";
export const MESSENGER_SETTINGS_PATH = "/ai/sales-chatbot/messenger";
/** Trần số page giữ trong cookie (cookie ~4 KB). Người quản lý nhiều page hơn ⇒ chọn trong 12 page đầu. */
export const MESSENGER_PAGES_MAX = 12;

/**
 * Đường quay về của hộp thoại Facebook — theo GỐC PHẦN MỀM của lượt đang chạy (`appOriginForHost`, lib/auth/oauth.ts).
 * Cố định `APP_URL` thì người bấm ở `app.chotdontudong.com` bị Facebook trả về erp.vnxcommerce.com: host đó không có
 * cookie phiên lẫn cookie `state` (cả hai gắn với host) ⇒ đá ra màn đăng nhập / «loi=state». Bước đổi mã phải dùng ĐÚNG
 * chuỗi này, nên start và callback cùng tính từ một gốc.
 */
export function messengerRedirectUri(origin: string = env.appUrl): string {
  return `${origin.replace(/\/$/, "")}${MESSENGER_CONNECT_PATH}/callback`;
}

/** Mọi đường quay về phải khai ở app Meta — một cho MỖI gốc phần mềm (in ở khối «Người vận hành» của trang cài đặt). */
export function messengerRedirectUris(): string[] {
  const chotdon = brandAppOrigin("chotdon", { SITE_DOMAIN: process.env.SITE_DOMAIN, CHOTDON_DOMAIN: process.env.CHOTDON_DOMAIN, APP_URL: process.env.APP_URL, CHOTDON_APP_URL: process.env.CHOTDON_APP_URL });
  return [...new Set([env.appUrl, ...(chotdon ? [chotdon] : [])].map((o) => messengerRedirectUri(o)))];
}

function pagesKey(): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`${env.authSecret}:messenger-pages`).digest());
}

type PendingPages = { org: string; uid: string; pages: ConnectablePage[] };

export async function sealPendingPages(org: string, uid: string, pages: readonly ConnectablePage[]): Promise<string> {
  return new EncryptJWT({ org, uid, pages: pages.slice(0, MESSENGER_PAGES_MAX) } satisfies PendingPages)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${MESSENGER_CONNECT_TTL_SEC}s`)
    .setAudience("erp-messenger-pages")
    .encrypt(pagesKey());
}

/** Đọc danh sách page chờ chọn — chỉ của ĐÚNG tổ chức + người đã bấm kết nối. Sai / hết hạn ⇒ `null`. */
export async function openPendingPages(token: string | undefined | null, org: string, uid: string): Promise<ConnectablePage[] | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtDecrypt(token, pagesKey(), { audience: "erp-messenger-pages" });
    const p = payload as unknown as PendingPages;
    if (p.org !== org || p.uid !== uid || !Array.isArray(p.pages)) return null;
    return p.pages.filter((x) => typeof x?.id === "string" && typeof x?.token === "string");
  } catch {
    return null;
  }
}
