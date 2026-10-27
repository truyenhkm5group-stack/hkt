/**
 * ═══════════ LINK HUỶ ĐĂNG KÝ EMAIL BÁN SỈ — HẰNG SỐ DÙNG CHUNG (E1, 0264) ═══════════
 *
 * Tệp THUẦN, không import gì — middleware (Edge) nạp được để khai đường công khai, route và lõi máy chủ cùng đọc một luật.
 */

/** Đường công khai của link huỷ đăng ký (middleware khai ở PUBLIC_PREFIXES). GET = trang xác nhận; POST = huỷ một chạm (RFC 8058). */
export const WHOLESALE_UNSUBSCRIBE_PREFIX = "/api/wholesale/unsubscribe/";

/**
 * Token huỷ đăng ký: `vnxu1.<mã tổ chức>.<bí mật 32 byte base64url>`. Mã tổ chức chọn CSDL (như lịch .ics / token tiện ích
 * 1688); bí mật chỉ lưu BĂM sha256 trong CSDL của CHÍNH tổ chức đó ⇒ token tổ chức A gắn nhãn tổ chức B không khớp dòng nào.
 */
export const UNSUBSCRIBE_TOKEN_RE = /^vnxu1\.([a-z0-9][a-z0-9-]{0,62})\.([A-Za-z0-9_-]{43})$/;

export function parseUnsubscribeToken(raw: string): { orgCode: string; secret: string } | null {
  const m = UNSUBSCRIBE_TOKEN_RE.exec(raw.trim());
  return m ? { orgCode: m[1]!, secret: m[2]! } : null;
}
