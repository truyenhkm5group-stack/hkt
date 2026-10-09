import type { Role } from "@/db/schema";

/** Thứ tự vai trò hiển thị (client-safe; nhãn trùng với ROLE_LABEL trong lib/auth/session.ts) */
export const ROLE_ORDER: Role[] = ["ADMIN", "MANAGER", "LEADER", "ACCOUNTANT", "WAREHOUSE", "CS", "MARKETING", "VIEWER"];

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Quản trị",
  MANAGER: "Quản lý",
  LEADER: "Trưởng nhóm",
  ACCOUNTANT: "Kế toán",
  WAREHOUSE: "Kho",
  CS: "CSKH",
  MARKETING: "Marketing",
  VIEWER: "Chỉ xem",
};

export const ROLE_HINT: Record<Role, string> = {
  ADMIN: "Toàn quyền: quản lý người dùng, cấu hình, đồng bộ",
  MANAGER: "Vận hành, đối soát COD, chi phí, chạy đồng bộ, xem nhật ký",
  LEADER: "Xem lương & lợi nhuận cả nhóm, BCLN danh nghĩa / theo đơn giao / tỷ lệ giao thành công; không xem dòng tiền thực, không sửa cấu hình",
  ACCOUNTANT: "Đối soát COD, chi phí, báo cáo",
  WAREHOUSE: "Kho, tồn kho, vận đơn",
  CS: "Đơn hàng, khách hàng, xem đối soát COD",
  MARKETING: "Chi phí quảng cáo, báo cáo",
  VIEWER: "Chỉ xem",
};

export const ROLE_TONE: Record<Role, string> = {
  ADMIN: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  MANAGER: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
  LEADER: "bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300",
  ACCOUNTANT: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  WAREHOUSE: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  CS: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  MARKETING: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  VIEWER: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

/*
  ═══════════ VAI TRÒ Ở VỎ CHỐT ĐƠN — CHỈ TRÌNH BÀY + GIỚI HẠN LỰA CHỌN ═══════════

  Khách Chốt Đơn không thuê ERP: tám vai trò hệ thống (Quản lý · Trưởng nhóm · Kế toán · Kho · CSKH…) không nói gì với một
  cửa hàng, và đo 09/10/2026 KHÔNG vai trò hệ thống nào vừa với «nhân viên bán hàng» mà không thừa quyền: CS / LEADER không có
  `ai_sales:view` (không mở nổi hộp thư), MANAGER không tạo đơn / khách mà lại kéo theo COD, chi phí, đồng bộ… Vai trò đúng
  việc đã CÓ SẴN: mẫu «AI bán hàng» (`lib/blueprints/templates/ai-sales.ts`, cài cho mọi khách chỉ thuê Chốt Đơn) dựng vai
  trò tuỳ chỉnh khoá `ban_hang` ⇒ mã `BAN_HANG`. Nên vỏ cho chọn ĐÚNG ba thứ, nhận ra vai trò bán hàng bằng MÃ (không bằng
  tên — tên sửa được), và không bao giờ lùi sang vai trò nào khác khi mã ấy thiếu / tắt.

  KHÔNG đổi quyền nào: ba lựa chọn ánh xạ thẳng vào ADMIN · vai trò `BAN_HANG` (nền VIEWER) · VIEWER đang có. ERP / nhà không
  đọc gì ở đây.
*/

/** Mã vai trò tuỳ chỉnh «Nhân viên bán hàng» do mẫu AI bán hàng cài (khoá `ban_hang` viết HOA — bài kiểm so với mẫu). */
export const SHELL_SALES_STAFF_ROLE_CODE = "BAN_HANG";

export type ShellRoleKey = "OWNER" | "SALES" | "VIEWER";

export const SHELL_ROLE_LABEL: Record<ShellRoleKey, string> = {
  OWNER: "Chủ cửa hàng",
  SALES: "Nhân viên bán hàng",
  VIEWER: "Chỉ xem",
};

/** Một câu mỗi lựa chọn — nói đúng điều vai trò làm được (trả lời khách trong hộp thư: chủ shop duyệt 09/10/2026). */
export const SHELL_ROLE_HINT: Record<ShellRoleKey, string> = {
  OWNER: "Toàn quyền: nhân viên, kênh kết nối, gói dịch vụ, cấu hình bot.",
  SALES: "Đọc và trả lời hội thoại, tạo / sửa khách và đơn, xem sản phẩm & tồn — không sửa cấu hình.",
  VIEWER: "Chỉ xem, không sửa được gì.",
};

export const SHELL_SALES_STAFF_MISSING_NOTE = "Vai trò Nhân viên bán hàng chưa được cài — liên hệ hỗ trợ";
export const SHELL_ROLE_REJECTED = "Ở Chốt Đơn chỉ chọn được: Chủ cửa hàng · Nhân viên bán hàng · Chỉ xem";

/** Giá trị ô chọn của hộp thoại mời (`inviteChoiceToInput`) cho từng lựa chọn của vỏ. */
export const SHELL_ROLE_INVITE_CHOICE: Record<ShellRoleKey, string> = {
  OWNER: "role:ADMIN",
  SALES: `access:${SHELL_SALES_STAFF_ROLE_CODE}`,
  VIEWER: "role:VIEWER",
};

/** Vai trò hệ thống mà từng lựa chọn ghi vào `users.role` (vai trò bán hàng có nền VIEWER). */
export const SHELL_ROLE_SYSTEM_ROLE: Record<ShellRoleKey, Role> = { OWNER: "ADMIN", SALES: "VIEWER", VIEWER: "VIEWER" };

/** Vai trò bán hàng của tổ chức: ĐÚNG mã, đang bật, không lấy ADMIN làm nền (luật 31). Không có ⇒ `null`, không lùi. */
export function salesStaffRoleOf<T extends { code: string; active: boolean; baseRole: string }>(roles: readonly T[]): T | null {
  return roles.find((r) => r.code === SHELL_SALES_STAFF_ROLE_CODE && r.active && r.baseRole !== "ADMIN") ?? null;
}

/** Các lựa chọn vỏ hiện ra, theo thứ tự. Thiếu vai trò bán hàng ⇒ chỉ Chủ cửa hàng + Chỉ xem. */
export function shellRoleKeys(salesInstalled: boolean): ShellRoleKey[] {
  return salesInstalled ? ["OWNER", "SALES", "VIEWER"] : ["OWNER", "VIEWER"];
}

/**
 * Lựa chọn gửi lên máy chủ có thuộc bộ của vỏ không. `accessRoleCode` khác rỗng ⇒ PHẢI là mã bán hàng VÀ mã ấy đang cài;
 * còn lại chỉ nhận vai trò hệ thống ADMIN / VIEWER. Mọi nhánh lạ rơi về «không».
 */
export function shellRoleChoiceOk(choice: { role?: unknown; accessRoleCode?: unknown }, salesInstalled: boolean): boolean {
  if (typeof choice.accessRoleCode === "string" && choice.accessRoleCode !== "") return salesInstalled && choice.accessRoleCode === SHELL_SALES_STAFF_ROLE_CODE;
  return choice.role === "ADMIN" || choice.role === "VIEWER";
}

/** Lựa chọn vỏ HIỆN TẠI của một tài khoản; vai trò cũ ngoài bộ (vd CSKH tạo trước) ⇒ `null` (hiện nhãn ERP, chọn lại). */
export function shellRoleKeyOf(user: { role: string }, accessRoleId: string | null | undefined, salesRoleId: string | null): ShellRoleKey | null {
  if (user.role === "ADMIN") return "OWNER";
  if (salesRoleId && accessRoleId === salesRoleId) return "SALES";
  if (user.role === "VIEWER" && !accessRoleId) return "VIEWER";
  return null;
}
