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
  LEADER: "Xem lương & lợi nhuận cả nhóm, BCLN danh nghĩa / giao thành công / tỷ lệ hoàn; không xem dòng tiền thực, không sửa cấu hình",
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
