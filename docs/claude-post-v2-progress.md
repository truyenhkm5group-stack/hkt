# Tiến độ roadmap sau V2

Cập nhật 08/09/2026. **Chưa deploy** — gom theo lô, chỉ phát hành khi cổng ra của lô đó đạt.

Production đang chạy `b067913` (bản V2). Nhánh `main` đi trước.

| Lô | Task | Trạng thái | Commit |
|---|---|---|---|
| **A** | A1 · Hàng đợi việc hợp nhất | **XONG** | `f039539` |
| **A** | A2 · Công thức ưu tiên | **XONG** | `a1b5b12` |
| **A** | A3 · Hạn xử lý & tuổi việc | **XONG** | `d21bcf9` |
| **A** | A4 · Quyền sở hữu việc | **XONG** | `0805463` |
| **A** | A5 · Giao diện hàng đợi | **XONG** | `5c0e57f` |
| B | B1–B4 · CS / Sales intelligence | chưa | |
| C | C1–C4 · Quảng cáo → giao thành công → lợi nhuận | chưa | |
| D | D1–D3 · Mẫu mã × màu × size | chưa | |
| E | E1–E5 · Tồn kho & dự báo sản xuất | chưa | |
| F | F1–F3 · Bảng điều khiển quản trị | chưa | |
| G | G1–G3 · Nền tảng trợ lý (chỉ đọc) | chưa | |
| H | H1–H2 · Tìm kiếm & dòng thời gian | chưa | |
| I | I1–I3 · Hiệu năng & độ tin cậy vòng 2 | chưa | |
| J | J · Nhất quán giao diện | chưa | |

## Lô A — đã làm gì

**Hai loại việc có thật trước đây không ai nhìn thấy:**
- *Đã chốt nhưng chưa gửi hàng* — tách khỏi "đơn chờ xử lý". Hai việc của hai người: đơn chưa chốt
  là việc CSKH gọi khách, đơn đã chốt mà chưa có vận đơn là việc kho đóng gói. Gộp lại thì cả hai
  cùng trôi vì không ai nhận là việc của mình.
- *Hàng hoàn về mà kho chưa tái nhập* — mỗi lô nằm đây là hàng có thật trong kho mà ERP không đếm,
  và kế hoạch sản xuất đặt thừa đúng bằng lượng đó.

**Năm trạng thái thay vì ba.** Thêm "đang làm" (giơ tay không phải là đang chạy) và "bỏ qua có lý
do". Thiếu cái sau thì người vận hành buộc phải bấm "đã xong" cho việc mình cố ý không làm — con số
"đã xong" mất hết ý nghĩa. Lý do là **bắt buộc**, khoá bằng ràng buộc CHECK ở CSDL.

**Công thức ưu tiên thêm hai yếu tố và giải thích được.** Sáu phần cộng đúng 100: nghiêm trọng 30 +
tuổi 20 + tiền 20 + khả năng cứu 15 + **có khách đang chờ 10** + **sắp cháy hàng 5**. Giao diện hiện
"Ưu tiên vì: …" — điểm mà người đọc không kiểm chứng được thì không khác gì cảm tính.

**Hạn xử lý theo loại việc**, một chỗ duy nhất. Ba nhóm cố ý KHÔNG đặt hạn: đang chuyển hoàn (chưa
làm được gì), vận đơn chưa ghép đơn và chưa rõ thuộc đơn nào (đặt hạn tạo áp lực ép ghép bừa).

**Bộ lọc không đổi số tổng hợp.** Tổng việc / tổng tiền treo / số trễ hạn luôn nói về toàn bộ hàng
đợi. Nếu tổng cũng bị lọc thì chọn một bộ lọc là thấy "hết việc rồi".

## Hiệu chuẩn có đổi hành vi

Trần mức nghiêm trọng hạ 40 → 30, nên việc "nghiêm trọng nhưng không ai chờ, không dính tiền" không
còn tự động là GẤP. Chủ ý: mức GẤP nay đòi đúng hồ sơ của việc gấp thật — nghiêm trọng + có khách
chờ + còn cứu được. Trên dữ liệu kiểm thử, số việc GẤP giảm 1 → 0.

## Schema

Migration **`0037`** — 5 cột hàng đợi việc + 2 khoá ngoại + 1 CHECK (bỏ qua phải có lý do) + 1 index.
Idempotent, CHECK để `NOT VALID` nên không quét lại lịch sử.

## Không làm, đúng lệnh

`PENDING_DIRECT_VTP_FULFILLMENT` · WRITE BACKFILL toàn cục · xoay secret · tự động đổi ngân sách
quảng cáo / tạo đơn sản xuất / đổi COD / đổi trạng thái vận đơn.
