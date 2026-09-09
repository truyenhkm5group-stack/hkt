/**
 * PHIÊN BẢN LUẬT KẾT QUẢ ĐƠN.
 *
 * Tăng số này MỖI KHI `ORDER_OUTCOME` đổi nghĩa. Dòng đã vật chất hoá mang phiên bản cũ sẽ tự động
 * bị bỏ qua — báo cáo quay về tính trực tiếp bằng luật mới thay vì âm thầm phục vụ kết luận cũ.
 *
 * Nằm ở hằng số dùng chung để `return-rate.ts` (nơi định nghĩa luật) và `canonical-outcome.ts` (nơi
 * ghi bảng) cùng đọc được mà không tạo vòng lặp import.
 */
export const CANONICAL_OUTCOME_VERSION = 1;
