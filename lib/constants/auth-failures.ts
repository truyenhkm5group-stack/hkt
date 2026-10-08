/**
 * ═══════════ LỖI ĐĂNG NHẬP CÓ LÝ DO — DANH SÁCH ĐÓNG + CHE ĐỊNH DANH (sứ mệnh saas-ops-signals · LAUNCH SPRINT §11) ═══════════
 *
 * Trước bản này lỗi đăng nhập chỉ nằm trong `Map` bộ nhớ của bộ chặn dò (lib/auth/login-throttle.ts): sai mật khẩu, không có tài
 * khoản, tổ chức sai hay đình chỉ đều gộp thành MỘT câu và không để lại gì. Khách gọi «không đăng nhập được» thì người vận hành
 * không có gì để đọc. Sổ `platform_auth_failures` (CSDL nhà) ghi LÝ DO — nhưng câu trả cho người đang đăng nhập GIỮ NGUYÊN chung
 * chung: một câu riêng cho «không có tài khoản này» là máy dò danh sách khách hàng của nền tảng.
 *
 * Danh sách ĐÓNG: cột `reason_code` có CHECK cùng đúng các giá trị này (drizzle/0237_saas_ops_signals.sql) — thêm lý do là thêm
 * một migration, không có ô chữ tự do. Tệp client-safe: màn hình và máy chủ dùng chung nhãn + hàm che.
 */

/** Đường đăng nhập sinh ra lỗi: màn đăng nhập · liên kết đặt lại / kích hoạt mật khẩu · liên kết mời. */
export const AUTH_FAILURE_FLOWS = ["LOGIN", "RESET_LINK", "INVITE"] as const;
export type AuthFailureFlow = (typeof AUTH_FAILURE_FLOWS)[number];

export const AUTH_FAILURE_REASONS = [
  /** Không tài khoản nào khớp email / SĐT (trong tổ chức đã chọn, hoặc ở mọi tổ chức dò được). */
  "NO_IDENTITY",
  /** Có tài khoản, sai mật khẩu. */
  "BAD_PASSWORD",
  /** Tài khoản bị khoá (`users.active = false`). */
  "USER_INACTIVE",
  /** Tổ chức có nhưng không ACTIVE (đình chỉ · lưu trữ · dựng hỏng). */
  "ORG_INACTIVE",
  /** Mã tổ chức gõ / trên đường dẫn không tồn tại. Dòng KHÔNG mang mã đó (chuỗi kẻ dò gõ không vào sổ). */
  "ORG_NOT_FOUND",
  /** Bộ chặn dò đang khoá — MỘT dòng cho mỗi (định danh hoặc máy, cửa sổ khoá), không một dòng mỗi lượt thử. */
  "THROTTLED",
  "RESET_LINK_INVALID",
  "RESET_LINK_EXPIRED",
  "RESET_LINK_USED",
  /** Đã có liên kết mới hơn cho cùng người (liên kết cũ bị thu hồi). */
  "RESET_LINK_REVOKED",
  "INVITE_INVALID",
  "INVITE_EXPIRED",
  "INVITE_USED",
  "INVITE_REVOKED",
] as const;
export type AuthFailureReason = (typeof AUTH_FAILURE_REASONS)[number];

export const AUTH_FAILURE_REASON_LABEL: Record<AuthFailureReason, string> = {
  NO_IDENTITY: "Không có tài khoản này",
  BAD_PASSWORD: "Sai mật khẩu",
  USER_INACTIVE: "Tài khoản đang khoá",
  ORG_INACTIVE: "Tổ chức không hoạt động",
  ORG_NOT_FOUND: "Mã tổ chức không tồn tại",
  THROTTLED: "Bị chặn dò (sai quá nhiều lần)",
  RESET_LINK_INVALID: "Liên kết đặt mật khẩu sai / không khớp",
  RESET_LINK_EXPIRED: "Liên kết đặt mật khẩu đã hết hạn",
  RESET_LINK_USED: "Liên kết đặt mật khẩu đã dùng",
  RESET_LINK_REVOKED: "Liên kết đặt mật khẩu đã bị thay bằng liên kết mới",
  INVITE_INVALID: "Liên kết mời sai / không khớp",
  INVITE_EXPIRED: "Liên kết mời đã hết hạn",
  INVITE_USED: "Liên kết mời đã được nhận",
  INVITE_REVOKED: "Liên kết mời đã bị thu hồi",
};

export const AUTH_FAILURE_FLOW_LABEL: Record<AuthFailureFlow, string> = { LOGIN: "Đăng nhập", RESET_LINK: "Liên kết đặt mật khẩu", INVITE: "Liên kết mời" };

/** Hạn giữ dòng sổ lỗi đăng nhập — dọn trong lượt `alerts` của tổ chức nhà (lib/platform/auth-failures.ts::pruneAuthFailures). */
export const AUTH_FAILURE_RETENTION_DAYS = 90;

/**
 * Che một định danh đăng nhập ĐÃ CHUẨN HOÁ để người vận hành nhận ra mà không đọc lại được: email ⇒ «ng***@gmail.com» (phần trước
 * @ dài < 4 ký tự chỉ giữ 1 ký tự), SĐT ⇒ «0912****78», chuỗi khác ⇒ «***». Kết quả LUÔN chứa «***» — cột CSDL có CHECK đúng điều
 * đó, nên một lượt ghi lỡ đưa email thô vào bị từ chối ở tầng CSDL. HÀM THUẦN.
 */
export function maskLoginIdentifier(kind: "EMAIL" | "PHONE" | null, value: string): string {
  const v = value.trim();
  if (kind === "EMAIL") {
    const at = v.lastIndexOf("@");
    if (at <= 0) return "***";
    const local = v.slice(0, at);
    const domain = v.slice(at + 1).slice(0, 60);
    return `${local.slice(0, local.length >= 4 ? 2 : 1)}***@${domain}`;
  }
  if (kind === "PHONE") return v.length > 6 ? `${v.slice(0, 4)}***${v.slice(-2)}` : "***";
  return "***";
}
