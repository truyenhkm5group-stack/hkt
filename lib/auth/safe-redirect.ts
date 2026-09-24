/**
 * ═══════════ ĐÍCH CHUYỂN HƯỚNG SAU ĐĂNG NHẬP CHỈ ĐƯỢC LÀ MỘT ĐƯỜNG DẪN NỘI BỘ ═══════════
 *
 * `?next=` đến từ URL — ai cũng gõ được. Một liên kết `https://erp…/login?next=…` trỏ ra ngoài là
 * mồi lừa đảo hoàn hảo: người dùng thấy đúng tên miền ERP, đăng nhập thật, rồi bị đưa sang trang giả
 * xin "đăng nhập lại".
 *
 * Phép kiểm cũ `next.startsWith("/") && !next.startsWith("//")` để lọt:
 *
 *   /\evil.com       trình duyệt đổi `\` thành `/` ⇒ `//evil.com` ⇒ sang tên miền khác
 *   /<TAB>/evil.com  trình duyệt BỎ tab/xuống dòng trong URL ⇒ `//evil.com`
 *   /..//evil.com    chuẩn hoá đường dẫn ra `//evil.com`
 *
 * Nên: chặn `\` và ký tự điều khiển ở ĐẦU VÀO, dựng URL trên một gốc giả rồi so ORIGIN, và kiểm lại
 * đường dẫn SAU chuẩn hoá — kết quả trả về là thứ đã chuẩn hoá, không phải chuỗi gốc.
 * Mọi nhánh lạ trả `/` (trang chủ) — hướng hẹp hơn.
 */
const BASE = "http://erp.invalid";

export function safeNextPath(next: unknown): string {
  if (typeof next !== "string" || next === "" || next.length > 2048) return "/";
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  if (next.includes("\\") || /[\u0000-\u001f\u007f]/.test(next)) return "/";
  let url: URL;
  try {
    url = new URL(next, BASE);
  } catch {
    return "/";
  }
  if (url.origin !== BASE) return "/";
  const out = `${url.pathname}${url.search}${url.hash}`;
  if (!out.startsWith("/") || out.startsWith("//") || out.includes("\\")) return "/";
  return out;
}
