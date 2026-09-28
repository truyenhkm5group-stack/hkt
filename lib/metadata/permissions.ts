/**
 * Quyền XEM / GHI giá trị custom theo đối tượng — thuần, client-safe (giao diện đọc để ẩn nút).
 *
 * VÌ SAO LÀ MỘT BẢNG RIÊNG, KHÔNG SỬA SỔ ĐỐI TƯỢNG: sổ (`lib/constants/object-registry.ts`) là mô tả dữ
 * liệu; bảng này là quyết định PHÂN QUYỀN — hai thứ đổi vì hai lý do khác nhau. Đề xuất gộp vào sổ khi
 * sổ có trường quyền.
 *
 * XEM: khoá xem do CHÍNH module của đối tượng sở hữu (`PLATFORM_MODULES[].permissions`) — mượn khoá của module
 * khác thì tắt module đó làm mất quyền xem một thứ không liên quan.
 *
 * GHI (chốt của phiên tích hợp Phase 2):
 *  · `customer` ⇒ `customers:write` — khoá riêng cho "tạo & sửa thông tin bổ sung" (mặc định chỉ Quản trị;
 *    vai trò tuỳ chỉnh cấp được). Khách là đối tượng MẪU duy nhất có đường ghi ở Phase 2.
 *  · mọi đối tượng khác ⇒ `metadata:manage`. Phase 2 CHƯA có đường ghi runtime nào cho chúng (chỉ lưu được qua
 *    dịch vụ); cho người có quyền XEM ghi field custom của đơn / vận đơn / hàng hoàn là mở một cửa ghi mà chưa
 *    ai quyết ai được đi qua. Hẹp trước, nới bằng một khoá riêng khi có màn hình thật (như `customers:write`).
 * Muốn hẹp hơn nữa ở từng field: khai `editPermission` (máy chủ ép ở `lib/metadata/values.ts`). Field custom là
 * dữ liệu BỔ SUNG, không đi vào công thức nào (ORDER_OUTCOME, tồn kho, COD).
 */
import { isObjectKey, type AnyObjectDef, type ObjectKey } from "@/lib/constants/object-registry";

export type ObjectRecordPermissions = { view: string; edit: string };

const NARROW_EDIT = "metadata:manage";

export const OBJECT_RECORD_PERMISSIONS: Readonly<Record<ObjectKey, ObjectRecordPermissions>> = {
  customer: { view: "customers:view", edit: "customers:write" },
  product: { view: "products:view", edit: NARROW_EDIT },
  order: { view: "orders:read", edit: NARROW_EDIT },
  order_item: { view: "orders:read", edit: NARROW_EDIT },
  shipment: { view: "shipments:view", edit: NARROW_EDIT },
  return: { view: "returns:view", edit: NARROW_EDIT },
  production_order: { view: "models:view", edit: NARROW_EDIT },
  employee: { view: "users:manage", edit: NARROW_EDIT },
};

/** Khoá tĩnh của ứng dụng tuỳ biến (Phase 6 · mục 4) — mọi đối tượng `x_…` cần chúng, cộng khoá siết của riêng đối tượng. */
export const RECORDS_VIEW_PERMISSION = "records:view";
export const RECORDS_WRITE_PERMISSION = "records:write";

/**
 * Khoá quyền XEM / GHI bản ghi của MỘT đối tượng — người thao tác phải có ĐỦ mọi khoá trong danh sách.
 *  · hệ thống ⇒ đúng một khoá của `OBJECT_RECORD_PERMISSIONS` (không đổi hành vi Phase 2);
 *  · tuỳ biến ⇒ `records:view` / `records:write` CỘNG khoá siết của đối tượng (`meta_objects.view_permission` /
 *    `write_permission`, mặc định trùng khoá tĩnh). Khoá siết chỉ làm HẸP hơn — không bao giờ thay khoá tĩnh.
 *  · khoá lạ (không thuộc sổ tĩnh, không mang phần tuỳ biến) ⇒ khoá không ai có — hỏng về phía hẹp.
 */
export function objectAccess(def: Pick<AnyObjectDef, "key" | "system" | "custom">): { view: string[]; edit: string[] } {
  if (def.system && isObjectKey(def.key)) {
    const p = OBJECT_RECORD_PERMISSIONS[def.key];
    return { view: [p.view], edit: [p.edit] };
  }
  if (!def.system && def.custom) {
    const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
    return { view: uniq([RECORDS_VIEW_PERMISSION, def.custom.viewPermission]), edit: uniq([RECORDS_WRITE_PERMISSION, def.custom.writePermission]) };
  }
  return { view: ["__khong_ai_co__"], edit: ["__khong_ai_co__"] };
}
