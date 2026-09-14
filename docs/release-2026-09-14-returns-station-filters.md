# 14/09/2026 — Trạm đếm hàng hoàn: lọc theo mã hàng, cột thời gian, và "nhận đủ" cho kiện nhiều mẫu mã

## 0. Vì sao có bản này

Lượt đối soát sổ hàng hoàn viết tay (bản 13/09) đẩy **300 kiện** vào hàng đợi đếm. Rồi hàng đợi
đứng yên, và lý do không phải thiếu tính năng ghi nhận — nó đã có từ lâu:

1. **Hàng trong kho nằm theo SỌT MẪU MÃ, hàng đợi nằm theo mã vận đơn.** Người kho kéo sọt Q002 ra,
   rồi cuộn 300 dòng tìm kiện nào có Q002. Xong sọt đó thì cuộn lại từ đầu cho sọt tiếp theo.
2. **Đường đếm nhanh chặn kiện nhiều mẫu mã.** Phần lớn 300 kiện là kiện HAI mẫu mã, nên "Nhận đủ"
   báo lỗi và bắt mở ngăn kéo đếm từng món — ba trăm lần, cho một kết luận luôn giống nhau.
3. **Không có mốc thời gian trên dòng.** Chỉ có "chờ N ngày", mà cả 300 kiện vào cùng một lượt nên
   con số đó bằng nhau hết.

## 1. Ranh giới đúng của "nhận đủ" không nằm ở SỐ MẪU MÃ

Đây là phần đáng đọc kỹ nhất của bản này, vì nó là một luật nghiệp vụ chứ không phải một nút bấm.

Đường đếm nhanh cũ (`recordInspection`) nhận **một con số tổng**. Kiện 2 đỏ + 1 đen mà nhận số 2 thì
không ai biết đó là "2 đỏ" hay "1 đỏ 1 đen" — ghi bừa làm sai tồn của HAI mẫu mã theo hai chiều
ngược nhau, và sai lặng lẽ cho tới kỳ kiểm kê. **Chặn là đúng, và vẫn chặn.**

Nhưng "nhận đủ" không phải một con số tổng: nó là lời khẳng định **TỪNG DÒNG** — mỗi mẫu mã về đúng
số kỳ vọng của nó. Phân bổ hoàn toàn xác định, không còn gì để đoán. Nên ranh giới thật là:

| đầu vào | kiện 1 mẫu mã | kiện nhiều mẫu mã |
|---|---|---|
| một số tổng BẰNG kỳ vọng | vào tồn | **vào tồn** (mới) — mỗi dòng đúng số của nó |
| một số tổng KHÁC kỳ vọng | vào tồn theo số đếm | **vẫn chặn** — mở "Kiểm từng món" |
| từng món có kết luận riêng | vào tồn | vào tồn |

`recordFullReturnInspection` (`lib/returns/inspection.ts`) là đường mới, và nó **không phải một
đường ghi thứ hai**: nó dựng danh sách "thực nhận = kỳ vọng" rồi gọi thẳng `recordItemInspection`,
nên thừa hưởng nguyên giao dịch, khoá dòng, một-dòng-phiếu-cho-một-mẫu-mã, chống đếm hai lần và
việc đóng vận đơn chiều hoàn. Không có luật nào được viết lại lần thứ hai.

### Lời khai đối chiếu: siết, không nới

Hệ quả kèm theo, và nó siết chứ không nới: `recordInspectionBulk` với kết luận `RESTOCKABLE` nay
cũng đi qua đường ấy, nên nó **thừa hưởng lá chắn `ORDER_ONLY`**.

Đường đếm MỘT kiện có ô số: người kho gõ số họ đếm được, và một kiện hoàn một phần tự lộ ra ở con số
đó. Đường HÀNG LOẠT không có ô số nào — bấm một cái là khẳng định "cả lô này về đủ theo đơn". Với
kiện chưa có phiếu trả từng món (`ORDER_ONLY`), đó là khẳng định thay cho một thứ ERP không biết.
Trước bản này đường hàng loạt không hỏi gì; nó chỉ chạy được cho kiện MỘT mẫu mã nên phạm vi hẹp hơn
và cái lỗ ít lộ ra. Nay phạm vi rộng ra, nên lỗ phải bịt.

Ô tick "Tôi xác nhận đã MỞ KIỆN đối chiếu thực tế" nằm **ngay trên ô lý do**, không nằm trong thanh
hàng loạt: nó chi phối cả hai đường, và để nó trong thanh hàng loạt thì người đếm từng kiện gặp nút
báo lỗi mà không có ô nào để tick — một ngõ cụt. Mặc định TẮT và không nhớ qua lần tải trang; chỉ
hiện khi trong phần đang xem thực sự CÓ kiện như vậy.

## 2. Lọc và sắp xếp

`lib/returns/inspection-filter.ts` — **hàm thuần, không đọc CSDL**, dùng chung giữa máy chủ và trình
duyệt, kiểm thử được không cần dựng cơ sở dữ liệu (`tests/inspection-filter.test.ts`).

- **Ô gõ tự do**: mã vận đơn · mã đơn · khách · SĐT · mã hàng · tên hàng · màu · size. Hai đống chữ
  riêng — chuẩn hoá kiểu MÃ (viết hoa, bỏ ký tự phân cách) và kiểu CHỮ (thường hoá, bỏ dấu) — nên
  `v15 0123` ra `V150123`, và `dao` ra `Đào`. Nhiều từ ghép bằng **VÀ**: gõ thêm phải THU HẸP.
- **Ô chọn Mã hàng / Màu / Size / Kho nhận bởi**, mỗi giá trị kèm **số kiện**, chỉ liệt kê giá trị
  THẬT SỰ có trong hàng đợi — người kho không thuộc mã hàng, và một ô gõ sai một ký tự trả về rỗng
  bị đọc thành "không có kiện nào".
- **Số mẫu mã** (1 / nhiều) · **Tuổi** · **Ghép đơn**. `AMBIGUOUS` đứng cùng phía "chưa ghép được":
  nó CÓ danh sách món, chỉ là có nhiều danh sách và ERP không chọn hộ.
- **Sắp xếp** 5 khoá × 2 chiều. `null` **luôn xếp cuối ở cả hai chiều**: "chưa có chứng từ ĐVVC" mà
  đứng ở chỗ "mới nhất" là một kết luận sai trên màn hình trông hoàn toàn bình thường.

Ba điều kiện mã/màu/size phải thoả trên **cùng MỘT dòng hàng**, không ghép chéo qua hai dòng — người
kho đi lấy sọt theo đúng nghĩa đen.

### Cột thời gian: hai mốc, không gộp

`ĐVVC trả về` (`shipments.returned_at`) là lúc kiện thật sự quay lại shop; `Kho ghi`
(`return_inspections.received_at`) là lúc ERP biết chuyện đó. Lượt đối soát sổ giấy ghi nhận cả trăm
kiện trong một giây, nên mốc thứ hai gần như bằng nhau hết — gộp hai mốc thành một cột "thời gian"
là in ra một dòng thời gian không có thật. Chưa có chứng từ ĐVVC thì in `—`, không lùi về mốc kho.

### Điều kiện để bộ lọc không nói dối

Lọc chạy ở trình duyệt vì danh sách món trong kiện **không nằm ở một cột nào** — nó do
`returnProductContext` dựng sau truy vấn (kiện chiều về mang `order_id` NULL nên phải lần ngược mã
gốc). Viết lại điều kiện đó thành SQL là dựng nguồn sự thật thứ hai cho câu hỏi "trong kiện có gì".

Điều đó chỉ trung thực khi cả hàng đợi đã nằm trong tay. Nên trang tải tới `PENDING_STATION_CAP`
(800, trước là 300) và truyền xuống **TỔNG THẬT**; chạm trần thì dải cảnh báo nói thẳng đang lọc
trong bao nhiêu trên tổng bao nhiêu, và ô bắn mã vẫn dò cả hàng đợi ở máy chủ. Đây chính là cái bẫy
đã sập một lần ở bàn nhận hàng: lọc trong một phần danh sách rồi hiện "0 kiện", và người đứng ở kho
đọc câu đó thành "kiện này không có trong hệ thống". Vẽ ra DOM thì theo cửa sổ 60 dòng — lọc thấy
hết, nhưng vẽ 800 thẻ thì trình duyệt đứng hình.

Phần đang chọn **không** tự bỏ khi đổi bộ lọc (gom một mẻ từ nhiều sọt là việc có thật), nhưng số
kiện đang chọn mà bộ lọc đang giấu được nói thẳng kèm lối bỏ chúng ra. Bắn mã trúng kiện nằm ngoài
bộ lọc thì bộ lọc TỰ BỎ và nói vì sao.

## 3. Một bộ mốc tuổi, ba chỗ dùng

`INSPECT_AGE_DAYS` (`lib/constants/return-lifecycle.ts`) thay ba con số rời trong ba câu lệnh: dải
"tuổi kiện chờ đếm" đầu trang, thẻ `inspectionSummary.stale`, và bộ lọc tuổi ở trạm đếm. Trước đây
sửa một chỗ thì hai chỗ kia lặng lẽ nói số khác trên cùng một màn hình.

## 4. Kiểm thử

| tệp | khoá điều gì |
|---|---|
| `tests/inspection-filter.test.ts` (mới) | chạy KHÔNG cần CSDL — bằng chứng cho tính thuần. Ghép từ bằng VÀ · mã+màu+size trên cùng một dòng hàng · `null` luôn cuối cả hai chiều · `AMBIGUOUS` là "chưa ghép" · ô chọn đếm KIỆN không đếm DÒNG · sắp xếp ổn định |
| `tests/return-full-receive.test.ts` (mới) | "nhận đủ" kiện nhiều mẫu mã vào ĐÚNG từng mẫu mã (2+1, không phải 3 chia đôi) · đếm THIẾU vẫn bị chặn · `ORDER_ONLY` cần lời khai · không ghép đơn thì không có gì để "đủ" · hàng loạt: kiện trượt có TÊN và có LÝ DO · không đếm hai lần |
| `tests/return-inspection.test.ts` (sửa) | phần 9 và 10 viết lại để khoá luật MỚI: chưa khai đối chiếu ⇒ từ chối có lý do, không cộng một món nào; khai rồi ⇒ mỗi mẫu mã một dòng phiếu đúng số |

## 5. QA trình duyệt — lần này chạy TRƯỚC deploy

Bài học của bản 13/09 (hai lượt deploy vì chụp màn hình sau lượt đầu) được áp dụng: dựng bản
production tại chỗ, seed 140 kiện (5 mã hàng × 4 màu × 4 size, đa số hai mẫu mã, có kiện mồ côi và
kiện `ORDER_ONLY`), rồi chụp và bấm thật.

**Bắt được một lỗi bố cục thật, trước khi nó ra production:** hàng nút bên phải không co được nên nó
ép cột định danh xuống ~180px — mã vận đơn, mã đơn, tên khách mỗi thứ rơi một dòng, và khối mã hàng
(thứ người đếm cần nhìn nhất) bị nhét vào cuối một cột hẹp. Sửa: sàn 220px cho cột định danh, khối
mã hàng ra một dòng riêng chiếm cả bề ngang thẻ, ba kết luận phụ chỉ còn biểu tượng (nhãn đầy đủ ở
`title`/`aria-label`). Thẻ từ ~150px xuống ~110px.

Quét sáng/tối × 100% / 90% / 110% / 400px: **không lỗi console, không lỗi HTTP, không tràn ngang**.

Bấm thật qua giao diện, kết quả đọc lại từ CSDL:

| phép đo | kết quả |
|---|---|
| hàng loạt 102 kiện nhiều mẫu mã, CHƯA tick đối chiếu | 68 kiện chạy · **34 kiện từ chối kèm lý do gộp thành MỘT dòng**, không bỏ qua im lặng |
| tick rồi làm lại | 34 kiện còn lại chạy hết |
| dòng phiếu kho sinh ra | 225 dòng cho 330 món trên 105 kiện — kiện 3 mẫu mã ra ĐÚNG 3 dòng |
| hai dòng cùng một mẫu mã trong một kiện | **0** |
| tổng món vào tồn so với tổng món kỳ vọng | **330 = 330** — không hơn, không kém |

## 6. Cổng và deploy

Xem mục cuối tài liệu này sau khi chạy.
