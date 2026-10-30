/**
 * ═══════════ THU THẬP EMAIL B2B — HẰNG SỐ & NHÃN DÙNG CHUNG (an toàn cho client) ═══════════
 *
 * Bộ thu thập (`lib/wholesale/email-discovery.ts`) đọc email doanh nghiệp TỰ CÔNG BỐ trên website của họ, phân loại vai
 * trò, kiểm tên miền có nhận thư không (bản ghi MX — KHÔNG gửi thư, KHÔNG dò SMTP). Tệp này chỉ giữ kiểu + nhãn + ngưỡng
 * có tên, để màn hình (kể cả client component) và lõi đọc cùng một chỗ.
 */

/** Câu bắt buộc in cạnh mọi chỗ hiện email thu thập được (giao diện + tài liệu). */
export const EMAIL_CONSENT_NOTICE = "Email thu thập công khai ≠ đồng ý nhận tiếp thị — chưa được gửi tự động.";

export const EMAIL_ROLES = ["PURCHASING", "SALES", "GENERAL", "PERSONAL", "OTHER"] as const;
export type EmailRole = (typeof EMAIL_ROLES)[number];

export const EMAIL_ROLE_LABEL: Record<EmailRole, string> = {
  PURCHASING: "Mua hàng",
  SALES: "Kinh doanh",
  GENERAL: "Liên hệ chung",
  PERSONAL: "Cá nhân (có thể)",
  OTHER: "Khác",
};

/**
 * Thứ tự chọn «email tốt nhất». `OTHER` (kế toán, tuyển dụng, chuỗi không đọc được vai trò) KHÔNG BAO GIỜ được tự điền
 * vào ô email của lead — nhân viên vẫn thấy nó trong danh sách tìm được.
 */
export const EMAIL_ROLE_RANK: Record<EmailRole, number> = { PURCHASING: 4, SALES: 3, GENERAL: 2, PERSONAL: 1, OTHER: 0 };

/**
 * Kết quả kiểm tên miền nhận thư:
 *  · `VALID_MX` — có bản ghi MX (hoặc không có MX nhưng có A/AAAA: «MX ngầm định» theo RFC 5321 §5.1);
 *  · `NO_MX`    — tên miền không tồn tại, không có MX lẫn A, hoặc khai «null MX» (RFC 7505: không nhận thư);
 *  · `UNKNOWN`  — DNS lỗi / quá giờ / chưa kiểm. CHƯA BIẾT, không phải «hỏng» (AGENTS mục 0.3).
 */
export const EMAIL_MX_STATUSES = ["VALID_MX", "NO_MX", "UNKNOWN"] as const;
export type EmailMxStatus = (typeof EMAIL_MX_STATUSES)[number];

export const EMAIL_MX_LABEL: Record<EmailMxStatus, string> = {
  VALID_MX: "Tên miền nhận thư",
  NO_MX: "Tên miền không nhận thư",
  UNKNOWN: "Chưa kiểm được",
};

/** Email lấy ra từ đâu trên trang — để người đọc biết độ chắc của phát hiện. */
export type EmailVia = "MAILTO" | "JSON_LD" | "CLOUDFLARE" | "TEXT" | "OBFUSCATED";

export const EMAIL_VIA_LABEL: Record<EmailVia, string> = {
  MAILTO: "liên kết mailto",
  JSON_LD: "dữ liệu cấu trúc (JSON-LD)",
  CLOUDFLARE: "email được Cloudflare che",
  TEXT: "chữ trên trang",
  OBFUSCATED: "chữ viết che (at / dot)",
};

/** Sau bao nhiêu ngày một lead đã quét mà vẫn chưa có email được xếp quét lại (nút «Thu thập email»). */
export const EMAIL_RESCAN_DAYS = 30;
/** Trần số lead một lần bấm «Thu thập email» được đưa vào hàng đợi (job đọc dần, mỗi lượt vài lead). */
export const EMAIL_QUEUE_MAX = 500;
export const EMAIL_QUEUE_DEFAULT = 200;
/** Trần email giữ lại trên MỘT trang và trên CẢ website — trang liệt kê hàng trăm địa chỉ không phải trang liên hệ. */
export const EMAIL_MAX_PER_PAGE = 20;
export const EMAIL_MAX_PER_SITE = 20;
/** Trần số tên miền email được hỏi DNS cho một website (mỗi lượt hỏi có trần thời gian riêng). */
export const EMAIL_MX_MAX_DOMAINS = 5;
export const EMAIL_DNS_TIMEOUT_MS = 2_500;
/** Phiên bản luật thu thập — ghi vào `meta` của lượt quét để biết con số đến từ luật nào. */
export const EMAIL_DISCOVERY_VERSION = 1;

/** Một email đã phân loại + kiểm tên miền — dạng lưu trong `wholesale_lead_activities.meta.emailChecks`. */
export type EmailCheck = {
  email: string;
  role: EmailRole;
  mx: EmailMxStatus;
  /** `MX` · `A` (MX ngầm định) · null khi không có / chưa kiểm. */
  mxVia: "MX" | "A" | null;
  sameDomain: boolean;
  sourceUrl: string;
  via: EmailVia;
};

/** Bộ lọc «Email» trên danh sách lead (khoá `email` trong URL). */
export const EMAIL_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "has", label: "Có email" },
  { value: "none", label: "Chưa có email" },
  { value: "valid", label: "Email: tên miền nhận thư" },
  { value: "no_mx", label: "Email: tên miền không nhận thư" },
  { value: "role_PURCHASING", label: "Email mua hàng" },
  { value: "role_SALES", label: "Email kinh doanh" },
  { value: "role_GENERAL", label: "Email liên hệ chung" },
  { value: "role_PERSONAL", label: "Email cá nhân" },
];

export function isEmailRole(v: unknown): v is EmailRole {
  return typeof v === "string" && (EMAIL_ROLES as readonly string[]).includes(v);
}

export function isEmailMxStatus(v: unknown): v is EmailMxStatus {
  return typeof v === "string" && (EMAIL_MX_STATUSES as readonly string[]).includes(v);
}
