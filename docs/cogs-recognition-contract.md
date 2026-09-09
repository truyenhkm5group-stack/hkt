# Hợp đồng ghi nhận GIÁ VỐN (COGS)

Ngày 09/09/2026. Viết ra vì giá vốn vừa được đưa vào lớp tăng tốc — và **việc tăng tốc tuyệt đối
không được đổi cách xác định giá vốn**, chỉ đổi *lúc nào* nó được tính.

Nguồn sự thật: `ORDER_COGS` trong `lib/queries/cogs.ts`. Tài liệu này mô tả lại nó, không định nghĩa
thay.

---

## 1. Phương pháp tính đang dùng

Giá vốn một đơn = tổng trên từng dòng hàng của `số lượng × đơn giá vốn`, trong đó **đơn giá vốn** lấy
theo thứ tự ưu tiên, lấy được cái nào thì dừng:

| # | Nguồn | Điều kiện |
| --- | --- | --- |
| 1 | **Giá trên phiếu nhập GẦN NHẤT của mẫu mã** | `unit_cost > 0`, xếp theo `received_at desc`, rồi `created_at desc`, lấy 1 |
| 2 | Giá vốn Pancake ghi trên chính dòng hàng | `order_items.unit_cost <> 0` |
| 3 | Giá nhập gần nhất lưu ở mẫu mã | `product_variants.last_imported_price` |
| 4 | `0` | khi cả ba trên đều không có |

Nói gọn: **giá phiếu nhập gần nhất** (*latest applicable receipt*). Không phải bình quân gia quyền,
không phải theo lô, không phải FIFO.

## 2. Tính chất quan trọng nhất — và nó gây bất ngờ

> **"Gần nhất" tính theo THỜI ĐIỂM HIỆN TẠI, không phải theo ngày lên đơn.**

Hệ quả: nhập một phiếu mới hôm nay sẽ **đổi giá vốn của MỌI đơn lịch sử** có mẫu mã đó — kể cả đơn
của tháng trước đã chốt sổ.

Đây là hành vi **hiện hữu**, không phải lỗi mới sinh ra. Nhưng nó có hai hệ quả phải nói rõ:

1. **Lợi nhuận của kỳ đã qua có thể đổi** khi kho nhập hàng mới. Ai chốt số cuối tháng rồi in ra sẽ
   thấy con số khác nếu in lại sau một lần nhập hàng.
2. **Giá vốn đã vật chất hoá phải bị coi là cũ ngay khi có phiếu nhập mới** — nếu không, kết quả đơn
   đúng mà giá vốn cũ, và lợi nhuận sai một cách im lặng.

Điểm 2 đã được xử lý (mục 4). Điểm 1 là **quyết định nghiệp vụ đang bỏ ngỏ**: nếu chủ shop muốn giá
vốn của một đơn được *đóng băng* tại thời điểm giao hàng, đó là đổi phương pháp tính — phải quyết
riêng, và **không được lồng vào một lượt tăng tốc**.

## 3. Việc tăng tốc đổi gì và KHÔNG đổi gì

| | |
| --- | --- |
| **Đổi** | *lúc nào* giá vốn được tính: trước đây tính lại trong mọi báo cáo, mỗi lần mở trang; nay tính một lần và lưu vào `canonical_order_outcome.cogs`. |
| **KHÔNG đổi** | thứ tự bốn nguồn ở mục 1, cách chọn "phiếu gần nhất", cách nhân số lượng, cách cộng dòng hàng, cách xử lý `0`. |

Bằng chứng: bộ vật chất hoá **dùng lại chính biểu thức `ORDER_COGS`** đã import — không chép công
thức. Hai bên khớp theo cấu trúc, không nhờ ai nhớ đồng bộ.

Nhánh dự phòng: `ORDER_COGS_FAST` = `coalesce(bảng, tính trực tiếp)`. Bảng trống, thiếu dòng, hay
mang phiên bản luật cũ ⇒ tự tính lại. **Chậm chứ không sai.**

## 4. Khi nào giá vốn đã lưu bị coi là cũ

`rematerializeStale()` nhặt đơn ra khi:

| Đầu vào đổi | Vì sao ảnh hưởng giá vốn |
| --- | --- |
| **Phiếu nhập kho mới / sửa giá phiếu** (`stock_receipts.updated_at`) | đổi "phiếu gần nhất" của mẫu mã ⇒ đổi giá vốn của mọi đơn có mẫu mã đó |
| **Dòng hàng của đơn đổi** (`orders.updated_at`) | số lượng, mẫu mã, hay giá vốn Pancake đổi |
| Đơn / vận đơn / sự kiện ĐVVC / dòng bảng kê đổi | (thuộc phần kết quả đơn) |
| `logic_version` khác phiên bản hiện tại | luật đã đổi |

Điểm đáng chú ý: một phiếu nhập ảnh hưởng **nhiều đơn lịch sử**, nên chiến lược làm cũ ở đây đi theo
**mẫu mã**, không theo đơn lẻ — và vẫn xác định, chạy lại được, có trần mỗi lượt.

## 5. Kiểm chứng

- `tests/canonical-outcome.test.ts`: **0 dòng lệch giá vốn** giữa bảng và biểu thức chuẩn.
- `scripts/outcome-parity.ts`: đối chiếu **toàn bộ dân số production**, kiểm cả kết quả đơn lẫn giá
  vốn; lệch một dòng là thoát mã lỗi và in dòng lệch để tìm nguyên nhân — **không** sửa dữ liệu cho
  khớp.
- `tests/metric-shape-consistency.test.ts`: sáu con số tiền của `getFinancialTruth` tính lại theo
  cách nội tuyến cũ, khớp 6/6.

## 6. Việc còn bỏ ngỏ (cần chủ shop quyết, không phải việc kỹ thuật)

1. **Giá vốn có nên đóng băng tại thời điểm giao hàng không?** Hiện tại là không (mục 2). Đổi sang
   đóng băng sẽ làm lợi nhuận kỳ cũ ổn định, nhưng là **đổi phương pháp tính**.
2. **Đơn không tra được giá vốn đang tính 0.** `getFinancialTruth` đã đếm và nêu rõ số đơn này
   (`missingCogsOrders`) kèm câu "lợi nhuận của nhóm này đang CAO HƠN thực tế" — nhưng vẫn là 0 chứ
   chưa phải CHƯA BIẾT. Nếu muốn đúng luật "`NULL` là chưa biết, không phải 0", đây là chỗ phải sửa.
