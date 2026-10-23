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
/*
 * ─── G-ORDER (29/09/2026): nhánh "đơn tay + phiếu giao có ký nhận ⇒ DELIVERED" — CỐ Ý KHÔNG tăng số ───
 *
 * Nhánh mới chỉ khớp đơn `erp-` CÓ phiếu còn hiệu lực, và bảng `order_delivery_notes` sinh ra RỖNG (0178): lúc deploy
 * không dòng vật chất hoá nào đổi kết luận. Mỗi lượt ghi / huỷ phiếu đều đặt `orders.updated_at` ⇒ dòng của ĐÚNG đơn
 * đó thành cũ theo điều kiện tươi mới và `ORDER_OUTCOME_FAST` tự tính lại. Tăng số ở đây chỉ làm mọi dòng của nhà
 * thành cũ cùng lúc mà không một con số nào đổi.
 */
/*
 * ─── 04/10/2026: mã cuối GHN / GHTK (mục 4.1) + «huỷ vận đơn ≠ huỷ đơn» của đơn ERP (mục 11.5) — CỐ Ý KHÔNG tăng số ───
 *
 * Cùng lý do với G-ORDER: lúc deploy production CHƯA có sự kiện `GHN_WEBHOOK` / `GHTK_WEBHOOK` nào và chưa có đơn `erp-` nào
 * mang vận đơn ERP tạo (POS tự chủ vừa lên) ⇒ không dòng vật chất hoá nào đổi kết luận. Sự kiện hãng mới về làm vận đơn và
 * đơn của ĐÚNG kiện đó thành cũ theo điều kiện tươi mới. Tăng số chỉ làm mọi dòng của nhà thành cũ cùng lúc vô ích.
 */
/*
 * ─── 5 (vtp-reship-outcome + bản sửa review #981, P0 22/10/2026 — ORDER_OUTCOME.md mục 12): TĂNG SỐ, có chủ ý ───
 *
 * Nhảy thẳng 3 → 5: số 4 chỉ từng tồn tại trên nhánh #981 TRƯỚC bản sửa review (RESHIP_ALIVE cho cả ORDER_OUTCOME_VERIFIED),
 * chưa lên production. Script vá vtp-reship-backfill chặn `--apply` khi phiên bản < 5 — dấu duy nhất rằng luật đã gồm bản sửa.
 *
 * Khác hai lần trên: kết luận của dòng ĐÃ CÓ đổi. (a) Lần gửi chính chọn lần CÒN SỐNG (có chứng từ bàn giao ∧ chưa huỷ) trước
 * `attempt_no`; (b) đơn Pancake «Đã hủy» mà lần gửi thay thế (`attempt_no > 1`) đang đi / chờ lấy thôi rơi về `CANCELLED`. Không
 * tăng số thì bảng vật chất hoá phục vụ kết luận cũ cho những đơn đó tới khi đầu vào của chúng tình cờ đổi. Giá: mọi dòng thành
 * cũ cùng lúc ⇒ báo cáo tính trực tiếp tới khi job `outcome-materialize` (5 phút, ≤ 2.000 dòng / lượt) dựng xong — đo 23/10:
 * 5.688 dòng ⇒ 3 lượt ≈ 15 phút.
 */
export const CANONICAL_OUTCOME_VERSION = 5;
