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
      { key: "orders:read", label: "Đơn hàng: xem", hint: "Danh sách & chi tiết đơn" },
      { key: "orders:export", label: "Đơn hàng: xuất CSV" },
      { key: "shipments:view", label: "Vận đơn", hint: "Vận đơn, hành trình, cập nhật từ Viettel Post" },
      { key: "shipments:manage", label: "Vận đơn: thao tác Viettel Post", hint: "Phát tiếp, duyệt hoàn, gửi lại, huỷ, sửa người nhận / COD ngay trên ERP" },
      { key: "alerts:view", label: "Cần xử lý: xem", hint: "Danh sách cảnh báo vận hành" },
      { key: "alerts:manage", label: "Cần xử lý: cấu hình", hint: "Ngưỡng cảnh báo, Lark / Telegram, đóng cảnh báo" },
      { key: "cs:view", label: "CSKH: xem case" },
      { key: "cs:manage", label: "CSKH: xử lý case", hint: "Tạo / cập nhật case đổi size, đổi màu, sai địa chỉ, sai SĐT, trả hàng" },
      { key: "cs:config", label: "CSKH: quy tắc & mẫu tin", hint: "Từ khoá nhận diện, mẫu tin nhắn khách giao không thành / xác nhận SĐT" },
      { key: "outreach:view", label: "Chăm sóc & bán chéo: xem" },
      { key: "outreach:send", label: "Chăm sóc & bán chéo: gửi tin / cập nhật" },
      { key: "outreach:config", label: "Chăm sóc & bán chéo: kịch bản", hint: "Mẫu tin, bước chăm sóc, ưu đãi, ảnh/video" },
      { key: "landing:view", label: "Đơn landing page: xem", hint: "Đơn từ Google Sheet, trạng thái, cảnh báo trùng / rủi ro" },
      { key: "landing:manage", label: "Đơn landing page: xử lý", hint: "Xác nhận / huỷ, chọn mẫu mã, gửi đơn nháp lên POS, nhập lại sheet" },
      { key: "landing:config", label: "Đơn landing page: cấu hình sheet", hint: "Link Google Sheet, cột, phí ship, kho mặc định" },
      { key: "returns:view", label: "Đổi / trả hàng" },
      { key: "customers:view", label: "Khách hàng" },
    ],
  },
  {
    module: "Kho & sản xuất",
    items: [
      { key: "products:view", label: "Sản phẩm & tồn kho", hint: "Sản phẩm, tồn kho, nhật ký kho" },
      { key: "inventory:write", label: "Nhập hàng & kiểm kê", hint: "Tạo / xoá phiếu nhập, điều chỉnh kiểm kê" },
      { key: "planning:view", label: "Kế hoạch đặt hàng SX: xem", hint: "Đề xuất đặt hàng, bảng đặt hàng chốt" },
      { key: "planning:write", label: "Kế hoạch đặt hàng SX: lập bảng", hint: "Tạo / sửa / duyệt bảng đặt hàng gửi xưởng, sửa tham số" },
    ],
  },
  {
    module: "Tài chính",
    items: [
      { key: "cod:view", label: "Đối soát COD: xem" },
      { key: "cod:write", label: "Đối soát COD: cập nhật", hint: "Đánh dấu đã thu / đã về ngân hàng, nhập bảng kê, tạo đợt nhận tiền" },
      { key: "expenses:view", label: "Chi phí & quảng cáo: xem", hint: "Chi phí, chi tiêu QC, hiệu quả marketer, ngưỡng thanh toán" },
      { key: "expenses:write", label: "Chi phí & quảng cáo: sửa", hint: "Thêm chi phí, nhập sao kê, ghép chiến dịch, gán marketer" },
    ],
  },
  {
    module: "Báo cáo lợi nhuận",
    items: [
      { key: "reports:delivered", label: "BCLN theo đơn giao thành công" },
      { key: "reports:cash", label: "BCLN theo dòng tiền thực", hint: "Tiền COD về, tiền ra, lợi nhuận tiền mặt" },
      { key: "reports:nominal", label: "BCLN danh nghĩa theo mã hàng & marketer" },
      { key: "reports:returns", label: "Tỷ lệ hoàn theo mã hàng" },
      { key: "reports:assumptions", label: "Sửa giả định báo cáo", hint: "Cước, đóng hàng, NV vận đơn, cố định, rủi ro tồn kho, thuế…" },
    ],
  },
  {
    module: "Lương & hoa hồng",
    items: [
      { key: "payroll:view-own", label: "Lương: xem của mình", hint: "Chỉ dòng lương / lợi nhuận cá nhân của chính mình (khớp email hoặc tên nhân sự)" },
      { key: "payroll:view", label: "Lương: xem toàn bộ", hint: "Lương và lợi nhuận của mọi nhân sự (trưởng nhóm, kế toán)" },
      { key: "payroll:manage", label: "Lương: khai báo nhân sự & chia mã", hint: "Cơ chế lương, người phụ trách mã, % chủ mã, fanpage → marketer" },
    ],
  },
  {
    module: "Hệ thống",
    items: [
      { key: "integrations:view", label: "Kết nối dữ liệu: xem" },
      { key: "integrations:manage", label: "Kết nối dữ liệu: cấu hình", hint: "Secret webhook, tài khoản Viettel Post, cấu hình đồng bộ" },
      { key: "sync:run", label: "Chạy đồng bộ", hint: "Bấm đồng bộ Pancake / Viettel Post / Facebook" },
      { key: "audit:view", label: "Nhật ký hệ thống" },
      { key: "users:manage", label: "Quản lý người dùng & phân quyền" },
      { key: "settings:manage", label: "Cấu hình hệ thống khác" },
    ],
  },
] as const;

/**
 * Quyền cũ (bản lưu trước khi tách chi tiết) → các quyền mới được suy ra, để cấu hình đã lưu vẫn chạy đúng.
 * Khi lưu lại trên trang Người dùng, hệ thống ghi thẳng quyền mới.
 */
export const LEGACY_IMPLIES: Record<string, string[]> = {
  "reports:view": ["reports:delivered", "reports:cash", "reports:nominal", "reports:returns"],
  "orders:read": ["orders:export", "cs:view", "outreach:view", "landing:view"],
  "shipments:view": ["alerts:view"],
  "cs:manage": ["cs:view", "outreach:send", "landing:manage", "shipments:manage"],
  "settings:manage": ["cs:config", "outreach:config", "alerts:manage", "integrations:manage", "landing:config"],
  "expenses:write": ["reports:assumptions"],
  "products:view": ["planning:view"],
  "inventory:write": ["planning:write"],
  "payroll:view": ["payroll:view-own"],
};

export type Permission = (typeof PERMISSION_GROUPS)[number]["items"][number]["key"];

export const ALL_PERMISSIONS: Permission[] = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key));

export const PERMISSION_LABEL: Record<string, string> = Object.fromEntries(PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => [i.key, i.label])));

const VIEW_ALL: Permission[] = ["dashboard:view", "orders:read", "shipments:view", "alerts:view", "cs:view", "outreach:view", "landing:view", "returns:view", "customers:view", "products:view", "planning:view"];

/** Mẫu quyền mặc định của từng vai trò (có thể chỉnh trên trang Người dùng) */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  ADMIN: [...ALL_PERMISSIONS],
  MANAGER: ALL_PERMISSIONS.filter((p) => !["users:manage", "settings:manage", "payroll:manage"].includes(p)),
  // Trưởng nhóm: xem lương & LN của cả nhóm, báo cáo danh nghĩa / tỷ lệ hoàn / theo đơn giao; không xem dòng tiền thực, không sửa cấu hình
  LEADER: [...VIEW_ALL, "orders:export", "cs:manage", "outreach:send", "landing:manage", "shipments:manage", "inventory:write", "planning:write", "cod:view", "expenses:view", "expenses:write", "reports:delivered", "reports:nominal", "reports:returns", "payroll:view-own", "payroll:view", "integrations:view", "sync:run"],
  ACCOUNTANT: [...VIEW_ALL, "orders:export", "cod:view", "cod:write", "expenses:view", "expenses:write", "reports:delivered", "reports:cash", "reports:nominal", "reports:returns", "payroll:view-own", "payroll:view", "integrations:view"],
  WAREHOUSE: [...VIEW_ALL, "inventory:write", "planning:write"],
  CS: [...VIEW_ALL, "cod:view", "cs:manage", "outreach:send", "landing:manage", "shipments:manage"],
  MARKETING: [...VIEW_ALL, "expenses:view", "expenses:write", "reports:nominal", "reports:returns", "payroll:view-own"],
  VIEWER: [...VIEW_ALL, "cod:view", "expenses:view", "reports:delivered", "reports:returns"],
};

/** Mở rộng quyền cũ thành quyền mới (giữ cả khoá cũ để không phá chỗ nào còn kiểm tra khoá cũ) */
export function expandLegacy(perms: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of perms) {
    out.add(p);
    for (const implied of LEGACY_IMPLIES[p] ?? []) out.add(implied);
  }
  return [...out];
}

export type RolePermissionMap = Partial<Record<Role, string[]>>;

/** Quyền mẫu của một vai trò: bản chỉnh trong settings nếu có, không thì mặc định */
export function rolePermissions(role: Role, templates?: RolePermissionMap | null): string[] {
  if (role === "ADMIN") return [...ALL_PERMISSIONS];
  const custom = templates?.[role];
  if (Array.isArray(custom)) return expandLegacy(custom).filter((p) => (ALL_PERMISSIONS as string[]).includes(p));
  return [...(DEFAULT_ROLE_PERMISSIONS[role] ?? DEFAULT_ROLE_PERMISSIONS.VIEWER)];
}

/** Quyền thực tế của một người dùng: tuỳ chỉnh riêng (nếu có) → mẫu vai trò. ADMIN luôn toàn quyền. */
export function resolvePermissions(role: Role, custom: string[] | null | undefined, templates?: RolePermissionMap | null): string[] {
  if (role === "ADMIN") return [...ALL_PERMISSIONS];
  if (Array.isArray(custom)) return expandLegacy(custom).filter((p) => (ALL_PERMISSIONS as string[]).includes(p));
  return rolePermissions(role, templates);
}

export function hasPermission(perms: readonly string[] | Set<string> | null | undefined, permission: string) {
  if (!perms) return false;
  return perms instanceof Set ? perms.has(permission) : perms.includes(permission);
}
