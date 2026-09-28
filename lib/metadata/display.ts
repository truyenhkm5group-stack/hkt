/**
 * Giá trị custom ⇒ chữ để HIỂN THỊ / XUẤT CSV — thuần, client-safe.
 *
 * Khoá vắng mặt ⇒ `""` trong CSV và `—` trên màn hình (qua `lib/format.ts` ở nơi vẽ): CHƯA BIẾT, không
 * bao giờ in thành 0 hay "Không" (luật 42). `false` THẬT của field có/không thì in "Không".
 */
import type { CustomFieldDef } from "@/lib/metadata/types";

export function customValueText(def: CustomFieldDef, value: unknown): string {
  if (value === undefined || value === null) return "";
  const label = (v: unknown) => (typeof v === "string" ? (def.options.find((o) => o.value === v)?.label ?? v) : String(v));
  switch (def.type) {
    case "boolean":
      return value === true ? "Có" : value === false ? "Không" : "";
    case "select":
    case "status":
      return label(value);
    case "multi_select":
      return Array.isArray(value) ? value.map(label).join("; ") : label(value);
    case "relation_many":
      return Array.isArray(value) ? value.map(String).join("; ") : String(value);
    case "number":
    case "currency":
      // Số nguyên VND in THÔ (không dấu phân cách) để bảng tính đọc được thành số.
      return typeof value === "number" ? String(value) : "";
    default:
      return typeof value === "string" ? value : JSON.stringify(value);
  }
}

// ─────────────────────────── Tệp của field `file` ───────────────────────────

/** Đường tải MỘT tệp của field `file` (`app/api/metadata/files/[id]/route.ts`). Giá trị field lưu id, không lưu đường này. */
export function customFileHref(id: string): string {
  return `/api/metadata/files/${encodeURIComponent(id)}`;
}

/** Id tệp hợp lệ — `custom_files.id` là UUID (`crypto.randomUUID()`); sai định dạng thì không hỏi CSDL. */
export const CUSTOM_FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Kiểu được phép MỞ NGAY trong trình duyệt. Danh sách ĐÓNG, và cố ý KHÔNG có `image/svg+xml`, `text/html`,
 * `text/xml`, `application/xhtml+xml`, `text/javascript`: đó là những kiểu trình duyệt CHẠY được — một tệp khai
 * kiểu ấy mở inline trên miền ERP là XSS lưu trữ (tệp do người dùng tải lên, người khác bấm xem).
 */
export const CUSTOM_FILE_INLINE_MIME: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"];

/** Tên tệp cho `Content-Disposition` — bỏ đường dẫn, ký tự điều khiển, dấu nháy / chấm phẩy / gạch ngược. */
export function safeDownloadName(name: string): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f"';\\]/g, "").trim().slice(0, 200);
  return cleaned || "tep";
}

/** RFC 5987: `encodeURIComponent` để lọt `'()*` — mã hoá nốt để `filename*` không bị cắt. */
function rfc5987(s: string): string {
  return encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Tiêu đề phản hồi của một lượt tải tệp — hàm THUẦN để kiểm được ngoài máy chủ. Kiểu trong danh sách mở-ngay ⇒
 * giữ kiểu + `inline`; mọi kiểu khác (kể cả kiểu khai sai / trống) ⇒ `application/octet-stream` + `attachment`.
 * Luôn `nosniff` (trình duyệt không được đoán lại kiểu) và `private, no-store` (tệp nội bộ, không nằm lại ở đệm
 * dùng chung hay đệm đĩa của máy dùng chung). Ảnh mở-ngay còn mang CSP `sandbox` — một ảnh không cần chạy gì.
 */
export function customFileResponseHeaders(file: { filename: string; mime: string; size: number }): Record<string, string> {
  const mime = String(file.mime ?? "").toLowerCase().trim();
  const inline = CUSTOM_FILE_INLINE_MIME.includes(mime);
  const name = safeDownloadName(file.filename);
  const ascii = name.replace(/[^\x20-\x7e]/g, "_");
  const headers: Record<string, string> = {
    "content-type": inline ? mime : "application/octet-stream",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${rfc5987(name)}`,
    "content-length": String(file.size),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
  if (inline && mime.startsWith("image/")) headers["content-security-policy"] = "sandbox; default-src 'none'";
  return headers;
}
