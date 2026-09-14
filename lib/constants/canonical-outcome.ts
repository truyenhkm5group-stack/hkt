/**
 * PHIÊN BẢN LUẬT KẾT QUẢ ĐƠN.
 *
 * Tăng số này MỖI KHI `ORDER_OUTCOME` đổi nghĩa. Dòng đã vật chất hoá mang phiên bản cũ sẽ tự động
 * bị bỏ qua — báo cáo quay về tính trực tiếp bằng luật mới thay vì âm thầm phục vụ kết luận cũ.
 *
 * Nằm ở hằng số dùng chung để `return-rate.ts` (nơi định nghĩa luật) và `canonical-outcome.ts` (nơi
 * ghi bảng) cùng đọc được mà không tạo vòng lặp import.
 *
 * ─── THÊM CỘT MỚI THÌ SAO? Đừng mặc định tăng số này. ───
 *
 * Tăng phiên bản làm MỌI dòng thành cũ CÙNG LÚC, nên tới khi bộ lập lịch dựng lại xong (2.433 đơn,
 * trần 2.000 mỗi lượt ⇒ hai lượt ≈ 10 phút) thì mọi báo cáo chạy đường tính trực tiếp — đúng mức
 * 60 giây của trước P0.3, và rơi trúng lúc vừa deploy xong.
 *
 * Nên khi thêm cột mà LUẬT KHÔNG ĐỔI (P0.4 thêm `recognized_cogs`, `recognized_at`, `cogs_basis`):
 * giữ nguyên phiên bản và thêm một ĐIỀU KIỆN LÀM CŨ riêng cho cột mới trong `rematerializeStale()`.
 * Bỏ qua bước đó thì dòng cũ không bao giờ được điền, và cột mới im lặng vô tác dụng đúng với những
 * bản ghi cần nó nhất.
 */
/*
 * ─── v3 (13/09/2026): thêm kết quả `AWAITING_PICKUP` ───
 *
 * `ORDER_OUTCOME` ĐỔI NGHĨA, nên đây đúng là trường hợp bắt buộc tăng số — không phải ca "thêm cột
 * mà luật không đổi" nói ở trên. 106 đơn đang mang `IN_TRANSIT` trong bảng vật chất hoá sẽ được
 * dựng lại thành `AWAITING_PICKUP`; giữ nguyên phiên bản thì bảng âm thầm phục vụ kết luận cũ và cả
 * bản sửa này vô hình.
 *
 * Chi phí đã lường: mọi dòng thành cũ cùng lúc, bộ lập lịch dựng lại theo lô 2.000 (≈ hai lượt).
 * Trong lúc đó báo cáo chạy đường tính trực tiếp — chậm hơn nhưng ĐÚNG, vì `ORDER_OUTCOME_FAST` rơi
 * về chính công thức mới.
 */
export const CANONICAL_OUTCOME_VERSION = 3;
