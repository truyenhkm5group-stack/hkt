/**
 * Danh mục quyền theo module (client-safe, không đụng DB).
 * Mỗi người dùng có vai trò (mẫu quyền) và có thể được tuỳ chỉnh riêng từng quyền;
 * mẫu quyền của từng vai trò cũng chỉnh được (lưu trong settings "auth.rolePermissions").
 * Quản trị (ADMIN) luôn có toàn quyền.
 */
import type { Role } from "@/db/schema";

export const PERMISSION_GROUPS = [
  {
    module: "Vận hành",
    items: [
      { key: "dashboard:view", label: "Tổng quan", hint: "Trang tổng quan, KPI, biểu đồ" },
      { key: "orders:read", label: "Đơn hàng", hint: "Danh sách & chi tiết đơn, xuất CSV" },
      { key: "shipments:view", label: "Vận đơn", hint: "Vận đơn, hành trình, cập nhật từ Viettel Post" },
      { key: "returns:view", label: "Đổi / trả hàng" },
      { key: "customers:view", label: "Khách hàng" },
    ],
  },
  {
    module: "Kho & tài chính",
    items: [
      { key: "products:view", label: "Sản phẩm & tồn kho", hint: "Sản phẩm, tồn kho, nhật ký kho" },
      { key: "inventory:write", label: "Nhập hàng & kiểm kê", hint: "Tạo / xoá phiếu nhập, điều chỉnh kiểm kê" },
      { key: "cod:view", label: "Đối soát COD: xem" },
      { key: "cod:write", label: "Đối soát COD: cập nhật", hint: "Đánh dấu đã thu / đã về ngân hàng, tạo đợt nhận tiền" },
      { key: "expenses:view", label: "Chi phí & quảng cáo: xem" },
      { key: "expenses:write", label: "Chi phí & quảng cáo: sửa", hint: "Thêm chi phí, nhập sao kê, ghép chiến dịch, gán marketer" },
      { key: "reports:view", label: "Báo cáo lợi nhuận & tỷ lệ hoàn" },
      { key: "payroll:view", label: "Lương & hoa hồng: xem" },
      { key: "payroll:manage", label: "Lương & hoa hồng: khai báo nhân sự" },
    ],
  },
  {
    module: "Hệ thống",
    items: [
      { key: "integrations:view", label: "Kết nối dữ liệu: xem" },
      { key: "sync:run", label: "Chạy đồng bộ", hint: "Bấm đồng bộ Pancake / Viettel Post / Facebook" },
      { key: "audit:view", label: "Nhật ký hệ thống" },
      { key: "users:manage", label: "Quản lý người dùng & phân quyền" },
      { key: "settings:manage", label: "Cấu hình hệ thống", hint: "Giả định báo cáo, cấu hình khác" },
    ],
  },
] as const;

export type Permission = (typeof PERMISSION_GROUPS)[number]["items"][number]["key"];

export const ALL_PERMISSIONS: Permission[] = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key));

export const PERMISSION_LABEL: Record<string, string> = Object.fromEntries(PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => [i.key, i.label])));

const VIEW_ALL: Permission[] = ["dashboard:view", "orders:read", "shipments:view", "returns:view", "customers:view", "products:view"];

/** Mẫu quyền mặc định của từng vai trò (có thể chỉnh trên trang Người dùng) */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  ADMIN: [...ALL_PERMISSIONS],
  MANAGER: ALL_PERMISSIONS.filter((p) => !["users:manage", "settings:manage", "payroll:manage"].includes(p)),
  ACCOUNTANT: [...VIEW_ALL, "cod:view", "cod:write", "expenses:view", "expenses:write", "reports:view", "payroll:view", "integrations:view"],
  WAREHOUSE: [...VIEW_ALL, "inventory:write"],
  CS: [...VIEW_ALL, "cod:view"],
  MARKETING: [...VIEW_ALL, "expenses:view", "expenses:write", "reports:view"],
  VIEWER: [...VIEW_ALL, "cod:view", "expenses:view", "reports:view"],
};

export type RolePermissionMap = Partial<Record<Role, string[]>>;

/** Quyền mẫu của một vai trò: bản chỉnh trong settings nếu có, không thì mặc định */
export function rolePermissions(role: Role, templates?: RolePermissionMap | null): string[] {
  if (role === "ADMIN") return [...ALL_PERMISSIONS];
  const custom = templates?.[role];
  return Array.isArray(custom) ? custom.filter((p) => (ALL_PERMISSIONS as string[]).includes(p)) : [...DEFAULT_ROLE_PERMISSIONS[role]];
}

/** Quyền thực tế của một người dùng: tuỳ chỉnh riêng (nếu có) → mẫu vai trò. ADMIN luôn toàn quyền. */
export function resolvePermissions(role: Role, custom: string[] | null | undefined, templates?: RolePermissionMap | null): string[] {
  if (role === "ADMIN") return [...ALL_PERMISSIONS];
  if (Array.isArray(custom)) return custom.filter((p) => (ALL_PERMISSIONS as string[]).includes(p));
  return rolePermissions(role, templates);
}

export function hasPermission(perms: readonly string[] | Set<string> | null | undefined, permission: string) {
  if (!perms) return false;
  return perms instanceof Set ? perms.has(permission) : perms.includes(permission);
}
