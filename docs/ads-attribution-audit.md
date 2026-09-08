# Rà soát độ phủ quy kết quảng cáo

Kèm `docs/business-rules/ORDER_OUTCOME.md`. Mọi chỉ số ROAS ở đây dùng lại công thức kết quả đơn,
không tự tính.

## Câu hỏi duy nhất

**Bao nhiêu phần trăm tiền quảng cáo và bao nhiêu phần trăm đơn hàng thật sự nối được với nhau?**

Vì sao phải trả lời câu này trước khi tin bất kỳ con số ROAS nào: nếu chỉ 30% đơn có `ad_id` thì
"ROAS 4,2" là ROAS của 30% đó. Con số vẫn đúng, nhưng đọc nó như thể nó nói về toàn shop là tự lừa
mình. Trang Quảng cáo hiện độ phủ ngay cạnh chỉ số, không giấu ở đâu.

## Dữ liệu ERP thật sự có

| Cấp | Tiền chi | Đơn hàng | Kết luận |
|---|---|---|---|
| Tài khoản | ✔ `ad_spends.account_id` | gián tiếp qua mẩu QC | phân tích được |
| **Chiến dịch** | ✔ `ad_spends.campaign_id` | ✔ `fb_ads.campaign_id` | **cấp sâu nhất có CẢ HAI** |
| Nhóm quảng cáo | ✖ | có mã, không có tên | **không tính được ROAS** |
| Mẩu quảng cáo | ✖ | ✔ `orders.ad_id` | chỉ có đơn, tiền lấy theo chiến dịch mẹ |
| Nội dung (creative) | ✖ | ✖ | **không tồn tại trong ERP** |
| Mã hàng | ✔ ghép từ tên chiến dịch | ✔ | phân tích được, kèm độ phủ |
| Người phụ trách | ✔ `ad_spends.marketer_id` | — | phân tích được, kèm nhóm "Chưa gán" |

## Ba cấp KHÔNG làm được, và vì sao

Kế hoạch đề nghị drill-down **Chiến dịch → Nhóm → Mẩu → Nội dung**. ERP đi được **hai** cấp.

1. **Nội dung quảng cáo (creative)** — không có bảng nào lưu. Đồng bộ Facebook hiện chỉ lấy tới cấp
   mẩu quảng cáo. Muốn có thì phải mở rộng đồng bộ trước; đó là việc riêng.
2. **Chi tiêu theo nhóm quảng cáo** — Facebook Insights được đồng bộ ở cấp **chiến dịch/ngày**.
   Không có tiền ở cấp nhóm thì không có ROAS ở cấp nhóm. `fb_ads.adset_id` có mã nhưng không có
   tên và không có chi tiêu — đủ để nhóm các mẩu quảng cáo lại, không đủ để tính hiệu quả.
3. **Chi tiêu theo từng mẩu quảng cáo** — cùng lý do. Bảng ROAS theo mẩu quảng cáo có ĐƠN thật,
   phần tiền lấy theo chiến dịch mẹ; điều này **phải nói ra trên giao diện**, vì nếu không người đọc
   sẽ tưởng đang so tiền của chính mẩu quảng cáo đó.

Ba cấp này được liệt kê tường minh trong dữ liệu trả về (`unavailableLevels`) chứ không im lặng bỏ
qua — im lặng thì người sau sẽ đi tìm, không thấy, rồi tự dựng một con số thay thế.

## Ba loại "không nối được", đếm riêng từng loại

| Loại | Nghĩa | Hệ quả |
|---|---|---|
| **Đơn không có mã quảng cáo** | Không biết đến từ quảng cáo nào | Là TRẦN của mọi ROAS |
| **Mã quảng cáo tra không ra** | Biết đơn từ quảng cáo, không biết chiến dịch nào | Rơi khỏi bảng theo chiến dịch |
| **Tiền không có đơn nào** | Chiến dịch đã tiêu tiền, không đơn nào gắn vào | **Tiền đã mất** — phải hiện ra |

Loại thứ ba dễ bị bỏ sót nhất và đau nhất: nó không làm ROAS xấu đi (vì không có mẫu số nào chứa
nó), nó chỉ đơn giản biến mất. ERP hiện nó thành dòng riêng với ROAS lợi nhuận góp bằng −1.

## Cấm

1. **Không chia đều** tiền quảng cáo cho các chiến dịch/đơn để bảng trông đầy đủ. Chia đều làm tổng
   khớp trong khi từng dòng đều sai.
2. **Không suy** `ad_id` từ trang, từ thời điểm, hay từ tên chiến dịch giống nhau.
3. **Không xoá** `fb_ads` đã đánh dấu `missing` — quảng cáo bị Facebook xoá vẫn là bằng chứng của
   các đơn đã phát sinh.
4. **Không hiện ROAS mà không hiện độ phủ** khi độ phủ dưới ngưỡng.
5. **Không dùng doanh thu lên đơn** làm mẫu số mặc định của ROAS cho shop bán COD — xem bốn mức
   ROAS trong `lib/queries/ads-roas.ts`.
