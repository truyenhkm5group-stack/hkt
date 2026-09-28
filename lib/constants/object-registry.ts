/**
 * ═══════════ SỔ ĐỐI TƯỢNG — lớp MÔ TẢ phía trên mô hình miền (Phase 2) ═══════════
 *
 * Thuần, client-safe. Hợp đồng: docs/platform/phase-2-contracts.md (M2).
 *
 * Sổ KHÔNG thay mô hình miền nào: mỗi field hệ thống trỏ một CỘT THẬT (tên thuộc tính drizzle) của
 * bảng đang chạy. Field custom của tổ chức nằm ở `meta_custom_fields` + `custom_values` trong CSDL của
 * tổ chức. Khoá đối tượng và khoá field hệ thống BẤT BIẾN — chúng nằm trong `custom_values.object_key`,
 * form, danh sách đã xuất bản.
 *
 * Chưa có đối tượng "chiến dịch": kho không có bảng chiến dịch (chiến dịch là một cột trong
 * `ad_spends` / `fb_ads`) — khai một đối tượng không có bảng là bịa ra thứ không đo được.
 */
import type { ModuleKey } from "@/lib/constants/platform-modules";
import type { CustomObjectInfo, FieldOption, SystemFieldDef } from "@/lib/metadata/types";

export const OBJECT_KEYS = ["customer", "product", "order", "order_item", "shipment", "return", "production_order", "employee"] as const;
export type ObjectKey = (typeof OBJECT_KEYS)[number];

export type ObjectCapabilities = {
  /** Tổ chức thêm được field custom. */
  customFields: boolean;
  /** Có form metadata (khoá form khai ở `forms`). */
  forms: boolean;
  /** Có danh sách chạy theo metadata. */
  lists: boolean;
  /** Có trạng thái HỆ THỐNG cho phép đổi nhãn/thứ tự (`statusFields`). */
  statuses: boolean;
  /**
   * Tạo bản ghi qua form metadata. `requiresModuleOff`: chỉ khi tổ chức KHÔNG bật module đó — vd khách
   * hàng của tổ chức dùng Pancake do đồng bộ tạo, tạo tay sẽ đụng khoá đồng bộ.
   */
  create: false | { requiresModuleOff?: ModuleKey };
};

/**
 * `K` mặc định là khoá của sổ tĩnh — mã chỉ nói về đối tượng hệ thống đọc `ObjectDef` như cũ. Phase 6 nới
 * `key: string` (`AnyObjectDef`) cho đối tượng tuỳ biến `x_…` do `resolveObject` (lib/metadata/object-resolver.ts) dựng.
 */
export type ObjectDef<K extends string = ObjectKey> = {
  key: K;
  label: string;
  labelPlural: string;
  module: ModuleKey;
  /** Tên bảng drizzle (khoá trong `schema`) và cột id. */
  table: string;
  idColumn: string;
  /** Field hiển thị làm tên bản ghi (liên kết, tìm kiếm). */
  titleField: string;
  scope: "TENANT";
  /** `false` ⇒ đối tượng tuỳ biến của tổ chức (Phase 6). */
  system: boolean;
  customizable: boolean;
  capabilities: ObjectCapabilities;
  /** Khoá form của đối tượng (form MẶC ĐỊNH dựng từ sổ khi tổ chức chưa xuất bản). */
  forms: { key: string; label: string; purpose: "create" | "edit" }[];
  /** Khoá danh sách. */
  lists: { key: string; label: string; route: string }[];
  /** Field hệ thống là trạng thái HỆ THỐNG: chỉ đổi được nhãn / thứ tự / ẩn khỏi bộ lọc (M10). */
  statusFields: string[];
  fields: SystemFieldDef[];
  why: string;
  /** Chỉ đối tượng tuỳ biến (`system: false`): phần đọc từ `meta_objects`. */
  custom?: CustomObjectInfo;
};

/** Đối tượng hệ thống HOẶC tuỳ biến (Phase 6 · X5). */
export type AnyObjectDef = ObjectDef<string>;

const ORDER_STAGE_OPTIONS: FieldOption[] = (
  [
    ["NEW", "Mới"],
    ["WAITING", "Chờ hàng"],
    ["CONFIRMED", "Đã xác nhận"],
    ["PACKING", "Đang đóng hàng"],
    ["READY_TO_SHIP", "Chờ chuyển hàng"],
    ["SHIPPED", "Đã gửi hàng"],
    ["DELIVERED", "Đã nhận"],
    ["PAID", "Đã thu tiền"],
    ["RETURNING", "Đang hoàn"],
    ["PARTIAL_RETURN", "Hoàn một phần"],
    ["RETURNED", "Đã hoàn"],
    ["CANCELLED", "Đã hủy"],
    ["DELETED", "Đã xóa"],
  ] as const
).map(([value, label], i) => ({ value, label, active: true, position: i }));

const f = (key: string, label: string, type: SystemFieldDef["type"], column: string, extra: Partial<SystemFieldDef> = {}): SystemFieldDef => ({
  key,
  label,
  type,
  column,
  required: false,
  editable: false,
  listable: true,
  filterable: false,
  ...extra,
});

export const OBJECT_REGISTRY: readonly ObjectDef[] = [
  {
    key: "customer",
    label: "Khách hàng",
    labelPlural: "Khách hàng",
    module: "customers",
    table: "customers",
    idColumn: "id",
    titleField: "name",
    scope: "TENANT",
    system: true,
    customizable: true,
    capabilities: { customFields: true, forms: true, lists: true, statuses: false, create: { requiresModuleOff: "connector_pancake" } },
    forms: [
      { key: "profile", label: "Hồ sơ bổ sung", purpose: "edit" },
      { key: "create", label: "Tạo khách hàng", purpose: "create" },
    ],
    lists: [{ key: "default", label: "Danh sách khách hàng", route: "/customers" }],
    statusFields: [],
    fields: [
      f("name", "Tên khách", "text", "name", { required: true, editable: true, filterable: true }),
      f("phone", "Số điện thoại", "phone", "phone", { editable: true, filterable: true }),
      f("address", "Địa chỉ", "textarea", "address", { editable: true }),
      f("province", "Tỉnh / thành", "text", "province", { editable: true, filterable: true }),
      // Đếm đơn của MỘT khách (đồng bộ Pancake) — cộng / trung bình được. `purchased_amount` là TIỀN (đồng bộ
      // Pancake, không qua ORDER_OUTCOME) nên KHÔNG khai tổng hợp: cộng nó là một công thức doanh thu thứ hai.
      f("order_count", "Số đơn", "number", "orderCount", { aggregatable: true }),
      f("purchased_amount", "Đã mua", "currency", "purchasedAmount"),
      f("last_order_at", "Đơn gần nhất", "datetime", "lastOrderAt"),
    ],
    why: "Đối tượng MẪU của Phase 2: chưa có đường sửa nào nên field custom + form không đụng luật nghiệp vụ nào; khách của tổ chức dùng Pancake vẫn do đồng bộ tạo.",
  },
  {
    key: "product",
    label: "Sản phẩm",
    labelPlural: "Sản phẩm",
    module: "products",
    table: "products",
    idColumn: "id",
    titleField: "name",
    scope: "TENANT",
    system: true,
    customizable: true,
    capabilities: { customFields: true, forms: false, lists: false, statuses: false, create: false },
    forms: [],
    lists: [],
    statusFields: [],
    fields: [f("name", "Tên sản phẩm", "text", "name", { required: true }), f("custom_id", "Mã sản phẩm", "text", "customId", { filterable: true })],
    why: "Sản phẩm đồng bộ từ Pancake; Phase 2 chỉ cho lưu field custom qua dịch vụ, chưa có form runtime.",
  },
  {
    key: "order",
    label: "Đơn hàng",
    labelPlural: "Đơn hàng",
    module: "orders",
    table: "orders",
    idColumn: "id",
    titleField: "id",
    scope: "TENANT",
    system: true,
    customizable: true,
    capabilities: { customFields: true, forms: false, lists: true, statuses: true, create: false },
    forms: [],
    lists: [{ key: "default", label: "Danh sách đơn hàng", route: "/orders" }],
    statusFields: ["stage"],
    fields: [
      f("id", "Mã đơn", "text", "id", { filterable: true }),
      f("customer_name", "Khách", "text", "billFullName", { filterable: true }),
      f("phone", "Điện thoại", "phone", "billPhone", { filterable: true }),
      f("stage", "Trạng thái", "select", "stage", { filterable: true, options: ORDER_STAGE_OPTIONS }),
      f("total", "Tổng tiền", "currency", "totalPriceAfterDiscount"),
      f("inserted_at", "Ngày tạo", "datetime", "insertedAt"),
    ],
    why: "Đơn hàng mang luật không thương lượng (ORDER_OUTCOME): Phase 2 chỉ cho cấu hình HIỂN THỊ danh sách, field custom và nhãn trạng thái — không form ghi, không đổi chuyển trạng thái.",
  },
  {
    key: "order_item",
    label: "Dòng đơn",
    labelPlural: "Dòng đơn",
    module: "orders",
    table: "orderItems",
    idColumn: "id",
    titleField: "id",
    scope: "TENANT",
    system: true,
    customizable: false,
    capabilities: { customFields: false, forms: false, lists: false, statuses: false, create: false },
    forms: [],
    lists: [],
    statusFields: [],
    fields: [f("id", "Mã dòng", "text", "id")],
    why: "Khai để đối tượng quan hệ trỏ tới được; chưa cho tuỳ biến.",
  },
  {
    key: "shipment",
    label: "Vận đơn",
    labelPlural: "Vận đơn",
    module: "logistics",
    table: "shipments",
    idColumn: "id",
    titleField: "vtp_order_number",
    scope: "TENANT",
    system: true,
    customizable: true,
    capabilities: { customFields: true, forms: false, lists: false, statuses: false, create: false },
    forms: [],
    lists: [],
    statusFields: [],
    fields: [f("vtp_order_number", "Mã vận đơn", "text", "vtpOrderNumber", { filterable: true })],
    why: "Trạng thái vận đơn là của Viettel Post + luật logistics: KHÔNG cho cấu hình; chỉ field custom.",
  },
  {
    key: "return",
    label: "Hàng hoàn",
    labelPlural: "Hàng hoàn",
    module: "returns",
    table: "orderReturns",
    idColumn: "id",
    titleField: "reference",
    scope: "TENANT",
    system: true,
    customizable: true,
    capabilities: { customFields: true, forms: false, lists: false, statuses: false, create: false },
    forms: [],
    lists: [],
    statusFields: [],
    fields: [f("reference", "Mã phiếu hoàn", "text", "reference", { filterable: true })],
    why: "Hàng hoàn chỉ vào tồn khi kho xác nhận (luật 4) — không cho form ghi; chỉ field custom.",
  },
  {
    key: "production_order",
    label: "Lệnh sản xuất",
    labelPlural: "Lệnh sản xuất",
    module: "production",
    table: "productionOrders",
    idColumn: "id",
    titleField: "code",
    scope: "TENANT",
    system: true,
    customizable: true,
    capabilities: { customFields: true, forms: false, lists: false, statuses: false, create: false },
    forms: [],
    lists: [],
    statusFields: [],
    fields: [f("code", "Mã lệnh", "text", "code", { filterable: true })],
    why: "Chỉ field custom ở Phase 2.",
  },
  {
    key: "employee",
    label: "Nhân viên",
    labelPlural: "Nhân viên",
    module: "core",
    table: "users",
    idColumn: "id",
    titleField: "name",
    scope: "TENANT",
    system: true,
    customizable: true,
    capabilities: { customFields: true, forms: false, lists: false, statuses: false, create: false },
    forms: [],
    lists: [],
    statusFields: [],
    fields: [f("name", "Họ tên", "text", "name"), f("email", "Email", "email", "email")],
    why: "Nhân viên = tài khoản (`users`); quyền/vai trò do RBAC giữ, field custom KHÔNG bao giờ tham gia tính quyền.",
  },
];

const BY_KEY: ReadonlyMap<string, ObjectDef> = new Map(OBJECT_REGISTRY.map((o) => [o.key, o]));

export function objectDef(key: string): ObjectDef | null {
  return BY_KEY.get(key) ?? null;
}

export function isObjectKey(key: string): key is ObjectKey {
  return BY_KEY.has(key);
}

/** Khoá field hệ thống — field custom không được trùng. */
export function systemFieldKeys(key: string): Set<string> {
  return new Set((objectDef(key)?.fields ?? []).map((x) => x.key));
}
