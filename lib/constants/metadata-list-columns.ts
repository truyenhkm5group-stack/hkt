/**
 * FIELD HỆ THỐNG ⇒ CỘT MÃ NGUỒN của các danh sách chạy theo metadata (Phase 2, M9). Thuần,
 * client-safe: client wrapper dùng để áp thứ tự/ẩn cột, trang máy chủ dùng để đổi sắp xếp mặc định.
 *
 * Một cột có thể gánh NHIỀU field (cột "Khách hàng" in cả tên lẫn SĐT); cột ẩn khi mọi field của
 * nó ẩn. Khoá bên trái là khoá field trong `lib/constants/object-registry.ts`; bên phải là `id` cột
 * trong `app/(dashboard)/<module>/columns.tsx` — `tests/metadata-runtime.test.ts` giữ hai bên khớp.
 * Cột không field nào trỏ tới (vd "Thành công / hoàn", "Vận chuyển") luôn giữ như mã nguồn.
 */
export const CUSTOMER_LIST_REF_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  name: ["name"],
  phone: ["name"],
  address: ["address"],
  province: ["address"],
  order_count: ["orderCount"],
  purchased_amount: ["purchasedAmount"],
  last_order_at: ["lastOrderAt"],
};

export const ORDER_LIST_REF_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  id: ["systemId"],
  customer_name: ["customer"],
  phone: ["customer"],
  stage: ["status"],
  total: ["total"],
  inserted_at: ["insertedAt"],
};
