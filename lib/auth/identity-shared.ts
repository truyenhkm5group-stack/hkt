/**
 * ═══════════ DANH TÍNH ĐĂNG NHẬP — HÀM THUẦN, client-safe (docs/platform/quick-start.md) ═══════════
 *
 * Một ô «Email hoặc số điện thoại» ở màn đăng nhập / đăng ký: chuẩn hoá ở MỘT chỗ để form, máy chủ và chỉ mục danh tính
 * (`platform_identities`) không bao giờ là ba luật.
 */

export const IDENTITY_KINDS = ["EMAIL", "PHONE", "GOOGLE", "FACEBOOK"] as const;
export type IdentityKind = (typeof IDENTITY_KINDS)[number];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Di động Việt Nam sau khi chuẩn hoá: 84 + đầu số 3 · 5 · 7 · 8 · 9 + 8 chữ số. */
const VN_MOBILE_RE = /^84[35789]\d{8}$/;

/**
 * SĐT di động Việt Nam ⇒ `84xxxxxxxxx`. Nhận «0912 345 678», «0912.345.678», «+84 912 345 678», «84912345678». Không
 * phải di động VN ⇒ `null` (không đoán: số bàn / số nước ngoài không đăng nhập được bằng SĐT).
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let d = raw.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  if (/\+/.test(d)) return null;
  if (d.startsWith("0") && d.length === 10) d = `84${d.slice(1)}`;
  return VN_MOBILE_RE.test(d) ? d : null;
}

/** `84912345678` ⇒ «0912 345 678». */
export function displayPhone(normalized: string | null | undefined): string {
  if (!normalized || !VN_MOBILE_RE.test(normalized)) return normalized ?? "";
  const local = `0${normalized.slice(2)}`;
  return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return v.length <= 200 && EMAIL_RE.test(v) ? v : null;
}

/** Ô đăng nhập ⇒ email hoặc SĐT đã chuẩn hoá. Có «@» ⇒ chỉ có thể là email; không ⇒ chỉ có thể là SĐT. */
export function parseLoginIdentifier(raw: unknown): { kind: "EMAIL" | "PHONE"; value: string } | null {
  if (typeof raw !== "string") return null;
  if (raw.includes("@")) {
    const email = normalizeEmail(raw);
    return email ? { kind: "EMAIL", value: email } : null;
  }
  const phone = normalizePhone(raw);
  return phone ? { kind: "PHONE", value: phone } : null;
}
