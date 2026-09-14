# Biên bản 14/09/2026 (c) — Lương nói đúng số, và đơn đã huỷ thôi làm cầu nối

Nhánh: `claude/trusting-noether-fh23sk` · Đã phát hành: #286 `8076fd1` · #288 `77b262a` ·
#289 `f41a87a` · #290 `0bf4a08`.

**CHÍN LỖI ĐÃ TÁI HIỆN ĐƯỢC** trên đường tính lương và đường quy kết fanpage, cộng phần tài liệu
lỗi thời. **Không đổi một ngưỡng nghiệp vụ nào** (cửa sổ trùng đơn 24 giờ, ngưỡng 4 điểm, mọi mức
lương và tỷ lệ thưởng giữ nguyên). Một migration DUY NHẤT (`0088`) và nó CHỈ THÊM BẢNG.

## 0. ĐỌC NHANH — chín lỗi, và cái nào đang làm sai số ngay hôm nay

| # | Lỗi | Hôm nay đang sai không? |
|---|---|---|
| 1.1 | Đơn ĐÃ HUỶ làm cầu nối, biến hai lần bán thật thành một đơn trùng | Chưa — nhưng **6 cụm / 14 đơn còn sống** đang nằm đúng hình dạng ấy |
| 1.2 | Lương cứng chép nguyên lương THÁNG vào mọi kỳ | **CÓ** — xem 7 ngày đòi gấp >4 lần; xem một quý trả thiếu hai tháng |
| 1.3 | Hai nhân sự trùng tên đọc được lương của nhau | **CÓ** (mọi nhân sự cùng tên/tên ngắn) |
| 1.4 | Kỳ lỗ hiện "0 ₫ LN cá nhân" cho mọi marketer | **CÓ** ở cơ sở dòng tiền, mọi kỳ có LN1 ≤ 0 |
| 1.5 | Đổi người phụ trách fanpage viết lại bảng lương tháng trước | **CÓ** — và bảng gán phẳng đang RỖNG nên 972/1.243 đơn đi bằng nhánh lấp chỗ |
| 1.6 | Không có "đã trả" · cảnh báo chi phí bị bỏ lại · khoá mồ côi đội lốt "chưa gán" | **CÓ** (thiếu thông tin, không sai số) |
| 1.7 | Trang Lương không xuất được | **CÓ** (thiếu chức năng) |
| 1.8 | Ba trong bốn cơ sở lương không được phép chốt lương mà ô chọn giống hệt nhau | Rủi ro bấm nhầm |
| 1.9 | Bảng lương không có danh tính kỳ ⇒ kỳ đã trả tiền tự viết lại chính nó | **CÓ** |

---

## 1. Chín lỗi thật, và nguyên nhân gốc của từng cái

### 1.1 Đơn ĐÃ HUỶ làm CẦU NỐI biến hai lần bán thật thành một đơn trùng

`lib/constants/fanpage-attribution.ts::resolveDuplicates`

Ca tái hiện (đã thành kiểm thử, mục 7c):

| đơn | tình trạng | mốc  | giá trị   |
|-----|------------|------|-----------|
| A   | đã huỷ     | 09:00| 499.000đ  |
| B   | còn sống   | 09:05| 499.000đ  |
| C   | còn sống   | 10:00| 499.000đ  |

Không hội thoại chung, không bài viết chung, không định danh khách, Pancake không đánh dấu trùng.

```
TRƯỚC:  C → trùng của B, điểm 1, căn cứ "cùng giá trị đơn"   (ngưỡng là 4)
SAU:    C → KHÔNG trùng.  A vẫn nhường quy kết cho B, điểm 6.
```

**Nguyên nhân gốc.** Cụm nhận thành viên bằng cách chấm chứng cứ với đơn **SỚM NHẤT**, nhưng đơn
**GIỮ QUY KẾT** lại là đơn còn **SỐNG** sớm nhất. Hai đơn ấy khác nhau đúng lúc cụm mở bằng một đơn
đã huỷ — ca "huỷ rồi tạo lại", phổ biến nhất ở shop này. Khi đó `CANCELLED_SIBLING` (4 điểm, tự đủ
ngưỡng) bật với MỌI đơn còn sống trong cửa sổ, vì nó chỉ hỏi "một đơn huỷ, đơn kia còn sống". A kéo
B vào cụm, rồi A kéo tiếp C vào cùng cụm — trong khi B và C chỉ dính nhau đúng một điểm cùng giá
trị. Dòng ghi ra khẳng định "C trùng của B" nhưng chứng cứ dùng để kết luận lại là của cặp A–C.

**Sửa.** Chứng cứ nhận vào cụm chấm với chính đơn giữ quy kết (`holder`), không phải đơn sớm nhất.
Cửa sổ 24 giờ vẫn đo từ đơn sớm nhất (chống cụm trượt dài — khoá ở mục 7d). Thêm lưới an toàn cuối:
chứng cứ với đơn thắng dưới ngưỡng thì không kết luận trùng, tính cả hai đơn.

Người giữ quy kết đổi **nhiều nhất một lần** (đơn huỷ mở cụm → đơn sống đầu tiên) vì các đơn vào
cụm theo thứ tự thời gian tăng dần, nên thuật toán vẫn tất định và idempotent.

**Không đổi ngưỡng nào**: cửa sổ 24 giờ, ngưỡng 4 điểm, trọng số `DUPLICATE_SIGNALS` giữ nguyên.

### 1.2 Lương cứng trên bảng lương không nhìn tới kỳ đang xem

`lib/queries/payroll.ts::getPayrollReport`

`PayrollLine.fixed` chép thẳng `employee.fixed` — con số khai theo **THÁNG** — vào bất kỳ kỳ nào
người dùng chọn. Cùng lúc `lib/queries/payroll-cost.ts` (cửa duy nhất Profit Engine hỏi chi phí
nhân sự) đã chia theo ngày bằng `prorateMonthlyAmount`. **Hai nơi, hai con số, và nơi sai là nơi
chủ shop mở ra để trả tiền.**

Với 9.000.000đ/tháng, tháng 30 ngày:

| kỳ đang xem | cột "Lương cứng" TRƯỚC | máy chi phí trừ vào LN | SAU            |
|-------------|------------------------|------------------------|----------------|
| 7 ngày      | 9.000.000đ             | 2.100.000đ             | 2.100.000đ     |
| trọn tháng  | 9.000.000đ             | 9.000.000đ             | 9.000.000đ     |
| một quý     | 9.000.000đ             | 27.000.000đ            | 27.000.000đ    |
| "Toàn bộ"   | 9.000.000đ             | (không chia được)      | — (chưa biết)  |

Kèm theo: cả hai tệp nay đếm ngày bằng `inclusiveDays` (lịch Việt Nam). Phép cũ chia mili giây rồi
làm tròn ra **8 ngày cho một tuần**, vì mốc cuối kỳ là 23:59:59 — và con số ấy hiện thẳng ra màn
hình ở `recognitionPeriod.days`.

Bất biến mới khoá ở `tests/cost-double-count.test.ts` mục 6: **Σ lương cứng trên bảng lương = lương
cứng máy chi phí ghi nhận, cùng kỳ**.

### 1.3 Hai nhân sự trùng tên đọc được bảng lương của nhau

`lib/queries/payroll.ts::employeeMatchesUser` — cổng duy nhất của quyền `payroll:view-own`.

Bản cũ nhận ba bằng chứng: email khai đích danh (thật), **tên đầy đủ đã bỏ dấu**, **tên ngắn đã bỏ
dấu**. Hai nhánh sau chạy khi email không khớp hoặc bỏ trống. Hậu quả: "Nguyễn Văn Nam" và "Nguyen
Van Nam", hay hai người cùng tên ngắn "Nam", đọc được lương của nhau — và đổi một ô chữ hiển thị
trở thành một lượt cấp quyền.

AGENTS.md mục 34 (quy kết đi bằng KHOÁ TÀI KHOẢN) · mục 31 (mọi nhánh lỗi rơi về phía HẸP HƠN).

**Sửa.** Chỉ còn liên kết tài khoản khai đích danh ở ô "Email đăng nhập ERP". Chưa khai ⇒ không
khớp ai (mất quyền XEM, không phải lộ dữ liệu), và màn hình đã sẵn câu chỉ đường.

**Việc chủ shop cần làm:** người chỉ có quyền "Lương: xem của mình" mà hồ sơ nhân sự chưa khai
email sẽ thấy bảng rỗng. Vào **Lương & hoa hồng → sửa nhân sự → Email đăng nhập ERP** là xong.
Người có quyền "Lương: xem" (toàn bộ) không bị ảnh hưởng.

### 1.4 Kỳ lỗ hiện "0 ₫ lợi nhuận cá nhân" cho mọi marketer

Cơ sở lương "Dòng tiền thực" quy đổi: `LN cá nhân = LN1 cá nhân × (LN dòng tiền ÷ LN1 toàn shop)`.
Mẫu số ≤ 0 thì phép chia không có nghĩa (0 là vô định; âm cho hệ số âm, nhân vào là LẬT DẤU lợi
nhuận từng người). Bản cũ trả hệ số **0**, nên mọi marketer hiện đúng "0 ₫" — đọc thành "người này
không tạo ra đồng lợi nhuận nào", trong khi sự thật là phép tính không chạy được. Ca ấy xảy ra ở
**mọi kỳ lỗ** và **mọi kỳ ngắn chưa kịp có đơn giao thành công** — đúng những kỳ người ta mở bảng
lương ra soi.

**Sửa.** `cashRatio: number | null` kèm `cashRatioReason`; LN cá nhân, thưởng theo LN cá nhân, tổng
lương thành `null` → màn hình in "—" và một dải cảnh báo nói rõ lý do, chỉ sang cơ sở LN1.
Cơ sở LN1 / LN2 / danh nghĩa không đi qua phép quy đổi nào nên **không đổi một số nào**.

### 1.5 Đổi người phụ trách fanpage hôm nay viết lại bảng lương THÁNG TRƯỚC

`lib/constants/payroll.ts::attributionShares` + `lib/queries/payroll.ts::salesByProductPage`

Bảng lương chia doanh thu cho marketer bằng `payroll.config.pageMarketers` — một ánh xạ
`page → người` **không có mốc hiệu lực**. Fanpage A giao cho An từ 01/09 rồi chuyển cho Bình từ
10/09: chủ shop sửa ô ấy hôm nay và bảng lương THÁNG TRƯỚC chuyển toàn bộ doanh thu của An sang
Bình. Một kỳ đã trả tiền tự viết lại chính nó.

ERP đã có đúng thứ để chống điều đó — `fanpage_marketer_assignments` (có khoảng hiệu lực) và
`order_attributions` (ảnh chụp người phụ trách **tại mốc đơn phát sinh**, một dòng mỗi đơn). Bảng
lương chỉ chưa bao giờ đọc tới chúng.

Lỗi thứ hai trong cùng thứ tự căn cứ: **`ad_id` đứng TRÊN fanpage**. Quảng cáo trả lời câu hỏi
khác ("tiền quảng cáo nào tạo ra đơn này") và câu ấy vẫn được trả lời ở báo cáo Hiệu quả quảng cáo.
Chủ shop chấm marketer theo FANPAGE họ phụ trách.

**Thứ tự căn cứ nay là:** ảnh chụp theo mốc đơn lên → bảng gán phẳng (lấp chỗ) → `ad_id` (lấp chỗ)
→ tỷ trọng tiền quảng cáo → chủ mã → không ai.

Đơn bị kết luận TRÙNG mang `marketer_id = NULL` nên rơi xuống bậc sau — **cố ý**, và có luật đỡ:
`AGENTS.md` mục 9 đòi *"tổng đơn/doanh số của các marketer + 'Chưa gán marketer' phải BẰNG số đơn
xác nhận Pancake trong kỳ"*. Bỏ đơn trùng khỏi phần chia là phá đúng đẳng thức ấy, và ở bảng lương
còn làm Σ các marketer không bằng tổng của shop trong khi tiền đã về thật. Loại trùng đơn là việc
của chỉ số MARKETING (`/marketing/fanpages`), đo ở mốc chốt đơn — nên hai màn hình lệch nhau đúng
bằng phần đơn trùng (30 ngày gần nhất: **13 đơn**), và đó là chênh lệch GIẢI THÍCH ĐƯỢC, không phải
sai số.

`/payroll` thêm khối **"Doanh thu chia cho marketer bằng căn cứ nào"**: bốn nhóm (ảnh chụp · bảng
phẳng · quảng cáo lấp chỗ · chưa có căn cứ) cộng lại đúng tổng đem chia, kèm đường dẫn sang
Marketing → Fanpage & quy kết để khai mốc hiệu lực cho phần còn đi bằng bảng phẳng.

### 1.6 Ba thứ bảng lương đáng lẽ phải nói mà không nói

Không phải lỗi tính sai, mà là **thiếu hẳn một chiều** — và cái thiếu đó buộc người đọc tự suy,
nửa số lần sẽ suy sai.

**(a) "Đã trả" không có ở đâu cả.** Bảng lương chỉ có "Tổng lương kỳ" = PHẢI TRẢ. Lương tháng 8
trả ngày 05/09 là TIỀN RA của tháng 9 nhưng là CHI PHÍ của tháng 8 (`AGENTS.md` mục 17) — một màn
hình chỉ có một con số buộc người đọc tự gán nó cho một trong hai chiều. Nay có thẻ **"Đã trả
trong kỳ"**: tổng khoản chi nhóm "Lương", đọc theo NGÀY PHÁT SINH THÔ, kèm số chứng từ và chênh
lệch với phải trả. Và nó mang cờ `perPerson: false` cùng câu `missingWhat` cụ thể: `expenses` không
có cột nào trỏ tới một tài khoản nhân sự, nên ERP **không tách được "đã trả cho ai"** — chia bừa
theo tỷ trọng rồi in một cột cạnh tên từng người là dựng ra con số không ai kiểm lại được.

**(b) Lời khai của máy chi phí bị bỏ lại giữa đường.** `getOperatingCost` trả về con số LẪN cảnh
báo ("N khoản cước gõ tay bị loại vì trùng vận đơn", "khoản lương ở bảng Chi phí đang bị BỎ QUA,
kể cả phần hoa hồng nằm lẫn trong đó"). `productEconomics` chỉ lấy `.amount`. Nên `/expenses` biết
chi phí đang thiếu gì còn `/payroll` thì không — dù /payroll mới là nơi con số ấy thành tiền trả
cho người thật. Nay có khối **"Lợi nhuận này đã trừ đủ chi phí chưa?"** ngay trên bảng lương.

**(c) Khoá quy kết mồ côi đội lốt "Chưa gán marketer".** `order_attributions.marketer_id` không có
khoá ngoại sang sổ nhân sự (sổ ấy nằm trong `settings`). Một dòng phân công trỏ tới người đã gỡ
khỏi sổ lương sẽ hiện tên "Chưa gán marketer" — trùng đúng tên mà `id = null` đang dùng, nên hai id
lạ khác nhau thành hai dòng cùng tên và phần doanh thu ấy trông như chưa thuộc về ai. Ba trạng thái
nay ba tên: tên người · `Nhân sự đã gỡ khỏi sổ lương (<id>)` · `Chưa gán marketer`.

### 1.7 Trang Lương là trang tài chính duy nhất không xuất được

Mọi đối chiếu ngoài ERP đều phải chép tay từ màn hình. Thêm `/api/export/payroll`, gọi ĐÚNG
`getPayrollReport(period, basis)` mà trang gọi với y nguyên tham số URL của trang — một tệp xuất tự
cộng lại theo cách riêng là cách chắc chắn để hai con số của cùng một khoản lương đi hai ngả.

Cổng hẹp **đúng bằng** cổng màn hình: `payroll:view` thấy tất, `payroll:view-own` chỉ thấy dòng của
chính mình (lọc bằng chính `employeeMatchesUser`), còn lại 403. Ô CHƯA BIẾT để **trống** kèm cột
"Ghi chú" — ghi 0 vào đó là để một bảng tính sau này cộng nó vào tổng tiền phải trả. Hai dòng cuối
tệp ghi kỳ, cơ sở lợi nhuận, số ngày đã dùng để chia lương cứng và phạm vi xem.

### 1.8 Ba trong bốn cơ sở lương không được phép chốt lương, mà ô chọn thì giống hệt nhau

Luật chủ shop: lợi nhuận tính lương = doanh thu thực − **TOÀN BỘ** chi phí thuộc phạm vi ghi nhận,
và *"tiền mua hàng chưa bán … không tự trở thành chi phí của lợi nhuận tính lương"*. Bốn cơ sở của
ERP không tương đương nhau trước luật ấy, mỗi cái sai một kiểu:

| cơ sở | chốt lương được? | vì sao |
|---|---|---|
| **LN1 · giá vốn hàng giao TC** | ✓ **mặc định** | Doanh thu giao thành công − QC − giá vốn CỦA CHÍNH HÀNG ĐÃ GIAO − vận chuyển − chi phí vận hành đã ghi nhận |
| LN2 · giá vốn hàng nhập | ✗ | Trừ TOÀN BỘ giá vốn hàng NHẬP trong kỳ, kể cả hàng chưa bán. Nhập một lô lớn ⇒ kỳ ấy âm, kỳ sau đẹp giả |
| Dòng tiền thực | ✗ | Là DÒNG TIỀN: trừ cả tiền nhập hàng chưa bán, không trừ chi phí đã phát sinh mà chưa trả; LN cá nhân chỉ là quy đổi theo tỷ trọng |
| Danh nghĩa | ✗ | Số DỰ PHÓNG — đơn lên × tỷ lệ giao thành công ƯỚC TÍNH, chưa chứng từ nào nói tiền đã về |

Ô chọn cho cả bốn trông giống hệt nhau, nên một lần bấm nhầm là cả kỳ lương tính trên cơ sở sai mà
**không có gì báo** — và ba trong bốn con số ấy đều trông hợp lý. `PAYROLL_BASIS_ELIGIBILITY` nay
khai rõ cái nào đủ điều kiện kèm lý do; chọn một cơ sở không đủ thì màn hình hiện dải đỏ nói đúng
chỗ sai và một đường dẫn sang LN1 giữ nguyên kỳ đang xem.

**Không gỡ cơ sở nào** — LN2 cho thấy áp lực tiền hàng, dòng tiền thực cho thấy tiền thật. Chúng
chỉ không được ÂM THẦM trở thành căn cứ trả tiền cho người. Mặc định vẫn là LN1 như trước, không
đổi một con số nào.

### 1.9 Bảng lương không có danh tính kỳ, nên mọi thứ sau con số đều trôi

`/payroll` tính lại từ đầu mỗi lần mở. Hệ quả: đổi một tỷ lệ thưởng, đổi người phụ trách một
fanpage, nhập thêm một phiếu kho — và bảng lương **THÁNG TRƯỚC** đổi theo, **sau khi tiền đã trả**.
Không chỗ nào ghi shop đã trả bao nhiêu, theo cơ sở nào, với tỷ lệ nào. Con số vẫn ra, vẫn trông
hợp lý, và không ai thấy.

**`payroll_periods`** (migration `0088`, CHỈ THÊM BẢNG) — cùng hình dạng và cùng bộ ràng buộc với
`review_cycles` (`AGENTS.md` mục 21): `DRAFT` tính sống · `FINAL` đọc `snapshot`, KHÔNG truy vấn lại.

Ảnh chụp giữ đủ để **dựng lại câu trả lời**, không chỉ đủ để in một con số: cơ sở lợi nhuận đã dùng,
**tỷ lệ của từng người TẠI LÚC CHỐT**, lương cứng khai và phần thuộc kỳ, độ phủ nguồn quy kết, và
nguyên văn cảnh báo của máy chi phí. `calc_version` tách khỏi nội dung — hai kỳ mang hai số thì màn
hình in "đổi công thức giữa hai kỳ" thay vì vẽ một mũi tên xu hướng.

**Kỳ đã chốt không được viết lại, nhưng cũng không được nói dối.** Chứng từ vẫn về sau ngày chốt.
Tính lại đè lên ảnh chụp là viết lại một kỳ đã trả tiền, im lặng; giấu hẳn phần chênh là để chủ shop
không bao giờ biết có gì đã đổi. Nên phần tính lại hôm nay đứng **cạnh** bảng đã chốt như một **đề
xuất điều chỉnh** — và im lặng khi không có gì đổi. Cố ý **không** có đường "mở lại".

Bốn cửa trước khi chốt: quyền `payroll:manage` · kỳ phải có mốc đầu/cuối · cơ sở phải **đủ điều
kiện** · **không con số nào được CHƯA BIẾT** (chốt lúc đó là đóng băng một chỗ trống rồi gọi nó là
kết quả). Nút "Chốt kỳ" chỉ hiện khi cả bốn cửa đã qua.

> **Chưa kỳ nào được chốt.** Bảng rỗng sau khi triển khai và mọi màn hình chạy y như trước, cho tới
> khi chủ shop tự bấm — đúng yêu cầu "không tự chốt bảng lương".

---

## 2. Công thức đang áp dụng (không đổi trong bản này)

```
Lương phải trả (một người, một kỳ)
  = lương cứng THUỘC KỲ                     ← khai theo tháng, chia theo số ngày chồng lấn
  + %LN tổng    × max(LN tổng kỳ, 0)        ← LN theo cơ sở đang chọn
  + %LN cá nhân × max(LN cá nhân, 0)        ← "—" khi cơ sở dòng tiền không quy đổi được
  + %DT cá nhân × max(DT quy kết, 0)
```

Ba chỉ tiêu vẫn tách bạch, đúng như chủ shop chốt:

| | nguồn | mốc đo | dùng để |
|---|---|---|---|
| **A · Doanh thu thành tích MKTer** | `orders.total_price_after_discount`, đơn `stage ∈ CONFIRMED_STAGES`, quy kết theo **fanpage** | mốc CHỐT ĐƠN | chấm việc marketing |
| **B · Doanh thu thực** | `ORDER_OUTCOME` (`lib/queries/return-rate.ts`) | mốc kết quả vận đơn | lợi nhuận |
| **C · Tiền thực nhận** | COD về theo bảng kê + trả trước | mốc tiền về | dòng tiền, đối soát |

A **không** đổi sang COD trong bản này. B và C **không** bị đồng nhất.

---

## 2b. Kiểm kê chi phí — mỗi khoản một nguồn, một cách phân bổ

Sổ đăng ký thật nằm ở `lib/constants/cost-authority.ts` và mọi báo cáo đọc qua
`lib/queries/cost-engine.ts::getRecognizedCosts()`. Bảng dưới là bản đọc của nó, để chủ shop đối
chiếu mà không phải mở mã nguồn.

| khoản | nguồn có thẩm quyền | ghi nhận theo | chống trùng |
|---|---|---|---|
| Giá vốn hàng bán | Phiếu kho (`stock_receipt_items`) | theo ĐƠN giao thành công, giá vốn CHỐT tại thời điểm giao | khoản "Nhập hàng" gõ tay bị loại |
| Quảng cáo | Tài khoản QC (`ad_spends`) | theo NGÀY CHI THẬT | khoản "Quảng cáo" gõ tay bị loại |
| Cước chiều đi | Vận đơn / bảng kê ĐVVC | theo từng VẬN ĐƠN | khoản gõ tay bị loại, trừ khi khai `MANUAL_ADJUSTMENT` kèm lý do |
| Phí hoàn | Vận đơn / bảng kê ĐVVC | theo từng VẬN ĐƠN | như trên |
| **Lương cố định** | bảng Lương *(khi bật)* → **mặc định: bảng Chi phí** | **chia theo SỐ NGÀY chồng lấn** | bật bảng Lương thì khoản "Lương" gõ tay bị loại — **xem cảnh báo mục 5.1** |
| **Hoa hồng** | *(chưa chốt được cơ sở)* → bảng Chi phí | chưa xác định | `COMMISSION_BASIS_NEEDS_REVIEW` |
| Mặt bằng · điện nước | bảng Chi phí | chia theo SỐ NGÀY chồng lấn | — |
| Phần mềm · dịch vụ | bảng Chi phí | chia theo SỐ NGÀY chồng lấn | — |
| Dự phòng rủi ro tồn kho | Giả định (`profit.assumptions`) | % × **giá vốn hàng BÁN RA**, không phải hàng nhập | phần hàng chưa bán hiện riêng ở dòng "còn treo" |
| Vận hành khác | bảng Chi phí | theo NGÀY PHÁT SINH | — |

Ba điều bảng này KHÔNG nói, và phải nói ra:

1. **Sao kê ngân hàng không tạo chi phí.** Nó quyết định LOẠI DÒNG TIỀN; nối tiền với chứng từ là
   ĐỐI CHIẾU, không phải ghi nhận (`AGENTS.md` mục 17). Tiền mua hàng chưa bán, trả nợ gốc, chuyển
   nội bộ, góp/rút vốn **không** trở thành chi phí của lợi nhuận tính lương.
2. **Phí đã bị ĐVVC khấu trừ trong COD ròng không trừ thêm lần nữa** — `lib/queries/profit-cash.ts`
   chuyển sang chế độ `statement` khi kỳ có bảng kê và bỏ hẳn ước tính cước.
3. **Đóng gói và nhân sự vận đơn** tính theo SỐ ĐƠN GỬI của từng mã (`opsCosts`), không phải theo
   doanh thu — nên một mã nhiều đơn nhỏ vẫn gánh đúng phần của nó.

---

## 3. Đo trên production (ops `db-query`, chỉ đọc, 14/09/2026)

**Trùng đơn — hiện trạng và mức phơi nhiễm**

```
order_attributions:            2.833 dòng
  status = DUPLICATE:             83
  trong đó điểm < ngưỡng 4:        0      ← hôm nay CHƯA có dòng sai
  trong đó căn cứ rỗng:            0
  điểm thấp nhất:                  4

nhóm cùng khoá trùng đơn, > 1 đơn:            91
  có ≥1 đơn huỷ VÀ ≥2 đơn còn sống:            7   ← đúng hình dạng sinh ra lỗi
  trong đó trải dài ≤ 24 giờ:                  6
  số đơn CÒN SỐNG nằm trong 7 nhóm ấy:        14
```

Nói thẳng: **bản vá này không sửa một dòng dữ liệu nào hôm nay** — 83 dòng trùng đơn hiện có đều
đạt ngưỡng. Nó chặn một lớp lỗi đang có 6 cụm / 14 đơn còn sống nằm đúng hình dạng, và chỉ cần một
đơn nữa rơi vào cửa sổ là mất doanh thu của một người bán thật.

Chiều ngược lại cũng cần nói: với luật mới, một đơn ĐÃ HUỶ đến sau nay được chấm với đơn giữ quy
kết (còn sống) nên `CANCELLED_SIBLING` bật, và nó có thể được xếp là trùng đơn ở chỗ trước đây thì
không. Đơn đã huỷ đóng góp **0đ** doanh thu xác nhận nên **không đồng doanh thu nào đổi chỗ**; chỉ
nhãn tình trạng của đơn huỷ đổi. Xác minh lại sau khi triển khai bằng đúng câu truy vấn trên.

**Quy kết marketer — mức phơi nhiễm của bảng gán phẳng** (30 ngày gần nhất, đơn chưa huỷ):

```
đơn trong kỳ                                          1.243
  có ẢNH CHỤP người phụ trách tại mốc đơn lên           972   (78%)
  chưa có ảnh chụp (bảng gán phẳng cũng trống)          271   (22%)
  bảng gán phẳng và ảnh chụp nói HAI người khác nhau      0
  chỉ bảng gán phẳng có tên, ảnh chụp không                0
  đơn bị kết luận trùng                                   13
```

Đọc ra: `payroll.config.pageMarketers` thực tế **RỖNG** với mọi fanpage đang có đơn, trong khi
`order_attributions` đã quy kết được 972/1.243 đơn. Bảng lương trước bản này **không dùng tới nguồn
quy kết ấy một chút nào** — doanh thu của 972 đơn đi bằng các nhánh lấp chỗ (quảng cáo · chia theo
tỷ trọng tiền quảng cáo · về chủ mã). Sau bản này chúng về đúng người phụ trách fanpage tại lúc đơn
lên. Vì bảng phẳng rỗng, **không có ca nào hai nguồn nói hai người khác nhau**, nên không ai bị
"mất" đơn sang tay người khác — chỉ có phần trước đây chia nhầm bằng tỷ trọng nay được gọi đúng tên.

271 đơn còn lại (fanpage chưa khai mốc hiệu lực, hoặc đơn không có fanpage) hiện ra ở nhóm "chưa có
căn cứ" trên màn hình, kèm lối ra — không bị giấu đi.

---

**Hiện trạng khai báo trên production** (cùng lượt đo):

```
payroll.recognition                (chưa khai)  ⇒ chạy mặc định LEGACY_EXPENSES
nhân sự khai trong sổ lương                  4
  … có khai "Email đăng nhập ERP"            0   ← xem 3b mục 2, việc phải làm NGAY
bảng gán phẳng pageMarketers (số page)       0   ← rỗng, đúng như mục 1.5
dòng gán fanpage CÓ MỐC HIỆU LỰC             8   ← nguồn có thẩm quyền đang chạy
khoản chi nhóm "Lương" ở bảng Chi phí        0
dòng hàng TẶNG (is_bonus)                    0   ·  giá vốn hàng tặng: 0 ₫
```

Bốn điều đọc ra, và cả bốn đều đổi mức khẩn của một mục dưới đây:

1. **`payroll.recognition` chưa khai** ⇒ chi phí nhân sự vẫn đi đường bảng Chi phí. Rủi ro "chuyển
   nguồn mới phủ được một phần" (mục 5.1) là **tiềm ẩn, chưa xảy ra**. Đừng bật cho tới khi chốt
   được cơ sở hoa hồng.
2. **0/4 nhân sự có email đăng nhập** ⇒ hiện KHÔNG ai khớp được bằng khoá tài khoản. Trước bản này
   nhánh so TÊN có thể là thứ duy nhất làm quyền "xem của mình" chạy được — nay nó đã bị bỏ, nên
   người chỉ có quyền ấy sẽ thấy bảng rỗng kèm câu chỉ đường. Đây là hướng AN TOÀN (mất quyền xem,
   không lộ dữ liệu) nhưng phải khai email thì họ mới xem lại được.
3. **0 khoản chi nhóm "Lương"** ⇒ ERP hiện **không có chứng từ nào nói lương đã từng được trả**.
   Thẻ "Đã trả trong kỳ" sẽ hiện `0 ₫ · 0 khoản chi` — đúng với chứng từ đang có, và chính con số
   ấy nói rằng chưa đối chiếu được "còn phải trả" với thực tế.
4. **0 dòng hàng tặng, giá vốn hàng tặng 0 ₫** ⇒ lỗ hổng giá vốn quà tặng (mục 5.2) hôm nay
   **không làm sai một đồng nào**. Nó vẫn phải sửa trước khi shop bắt đầu tặng hàng, nhưng không
   phải việc gấp.

### Đối soát cùng phạm vi: POS xác nhận → đơn được tính → trùng → chưa gán

Đo 14/09 20:29 trên bản đã triển khai, 30 ngày gần nhất, đơn ở `CONFIRMED_STAGES` (mốc CHỐT ĐƠN):

| nhóm | đơn | doanh thu xác nhận |
|---|---:|---:|
| Marketer `b6373e43…` (đã quy kết) | 566 | 306.954.498 ₫ |
| Marketer `590efdb6…` (đã quy kết) | 263 | 134.505.000 ₫ |
| **Cộng hai marketer** | **829** | **441.459.498 ₫** |
| Đơn KHÔNG có fanpage (`NO_PAGE`) — landing / nhập tay / nguồn khác | 217 | 120.307.000 ₫ |
| Đơn TRÙNG bị loại (`DUPLICATE`) | 13 | 7.787.000 ₫ |
| Fanpage chưa gán marketer (`NO_ASSIGNMENT`) | 1 | 424.000 ₫ |
| **TỔNG đơn xác nhận trong kỳ** | **1.060** | **569.977.498 ₫** |

Bốn nhóm cộng lại bằng đúng số đơn xác nhận của kỳ — đó là `AGENTS.md` mục 9, và nó đúng ở đây.

Ba điều đọc ra:

1. **829/1.060 đơn (78%) nay mang đúng tên một người**, theo fanpage tại mốc đơn lên. Trước bản
   này phần ấy đi bằng nhánh lấp chỗ (quảng cáo · chia theo tỷ trọng tiền QC · về chủ mã).
2. **217 đơn không có fanpage nào** — đây KHÔNG phải lỗi: đơn landing và đơn nhập tay vốn không
   sinh ra từ một fanpage. Doanh thu của chúng thuộc kênh landing, không thuộc marketer nào
   (`ATTRIBUTION_STATUS_FIX.NO_PAGE` nói đúng điều này trên màn hình).
3. **Chỉ 1 đơn** thuộc một fanpage chưa gán marketer — tức sổ `fanpage_marketer_assignments` gần
   như đã phủ đủ. Khai nốt fanpage ấy là hết nhóm này.

## 3a. XÁC MINH SAU TRIỂN KHAI — đợt 1 (deploy #286, SHA `8076fd1`, 14/09 18:43)

Chạy `ops run-job "fanpage-attribution --dryRun=1"` trên **chính bản đã triển khai**:

```
Quy kết fanpage → marketer (fanpage-attribution) { dryRun: '1' }
  quét            2.835 đơn
  ATTRIBUTED      2.349      (83%)
  NO_PAGE           276
  NO_ASSIGNMENT     127
  DUPLICATE          83
  changed             0      ← BẢN VÁ KHÔNG ĐỔI MỘT DÒNG NÀO
  ruleVersion 1 · windowHours 24 · scoreThreshold 4
```

Ba điều đọc ra:

1. **`changed: 0`** — luật trùng đơn mới chạy trên toàn bộ 2.835 đơn của production và ra ĐÚNG kết
   luận cũ. Không một đồng doanh thu nào đổi chỗ, không một đơn nào đổi chủ. Đây là bằng chứng
   mạnh nhất có được rằng bản vá là PHÒNG, không phải sửa số.
2. **2.349 + 276 + 127 + 83 = 2.835** — bốn nhóm cộng lại đúng bằng số đơn quét, tức phép chiếu
   vẫn khép kín sau khi đổi thuật toán gom cụm.
3. **Ngưỡng không đổi**: cửa sổ vẫn 24 giờ, ngưỡng vẫn 4 điểm — máy chủ tự in ra để đối chiếu.

## 3b. Việc chủ shop nên làm ngay sau bản này

1. **Khai mốc hiệu lực cho fanpage còn thiếu** — Marketing → Fanpage & quy kết → gán marketer với
   khoảng hiệu lực TRÙM ngày đơn lên, rồi bấm "Đối soát lại". 271/1.243 đơn của 30 ngày gần nhất
   đang nằm ở nhóm "chưa có căn cứ"; mỗi fanpage khai xong là một phần doanh thu chuyển từ "chia
   theo tỷ trọng" sang "đúng tên người".
2. **Khai email đăng nhập ERP cho nhân sự** — Lương & hoa hồng → sửa nhân sự. Chỉ cần cho người có
   quyền "Lương: xem của mình"; thiếu thì họ thấy bảng rỗng kèm câu chỉ đường.
3. **Đọc khối cảnh báo chi phí trên /payroll** trước khi dùng con số lợi nhuận để trả lương.

## 4. Cổng đã chạy

`npm run typecheck` · `npm run lint` · `npm test` → **"TẤT CẢ KIỂM THỬ ĐẠT"** · `npm run build`.

Hai đợt phát hành:

| đợt | SHA | nội dung |
|---|---|---|
| #286 | `8076fd1` | bốn lỗi mục 1.1–1.4 · lỗi quy kết fanpage 1.5 · tài liệu migration |
| #288 | `77b262a` | mục 1.6 (đã trả · cảnh báo chi phí · khoá mồ côi) · 1.7 (xuất CSV) · ba đoạn mô tả lỗi thời · bất biến độ phủ |
| #289 | `f41a87a` | mục 1.8 (sổ đăng ký cơ sở lương + dải cảnh báo) · README/HANDOFF/chú giải quyền nói đúng luật đang chạy · nhắc khai email đăng nhập |
| #290 | `0bf4a08` | mục 1.9 (kỳ lương: migration `0088`, ảnh chụp bất biến, đề xuất điều chỉnh) |

Kiểm thử mới / mở rộng:
- `tests/fanpage-attribution.test.ts` mục **7c** (cầu nối đơn huỷ) và **7d** (cửa sổ không trượt
  theo người giữ quy kết) — cả hai ĐỎ trên mã cũ, xanh trên mã mới.
- `tests/cost-double-count.test.ts` mục **6** (bảng lương = máy chi phí) và **7** (mẫu số ≤ 0 ⇒
  chưa biết, không phải 0).
- `tests/cost-double-count.test.ts` mục **8** (cảnh báo nguồn chi phí đi tới tận bảng lương —
  `deepEqual` theo `rule`) và **9** (PHẢI TRẢ và ĐÃ TRẢ đứng riêng hai chiều; cờ `perPerson` không
  được lật thành true).
- `tests/sync-fixtures.test.ts` — ca `a4` đổi theo LUẬT MỚI (quảng cáo của B trên page của A nay về
  A, nêu lý do tại chỗ), hai ca mới cho ảnh chụp thắng bảng phẳng / thắng quảng cáo, và một BẤT
  BIẾN chạy trên cả bốn cơ sở lợi nhuận: bốn nhóm độ phủ là một PHÂN HOẠCH, cộng lại bằng tổng
  đem chia, không nhóm nào âm.
- `tests/scope-enforcement.test.ts::testPayrollOwnLineNeedsAccountKey` — sáu ca hành vi cộng ba lá
  chắn mã nguồn: thân `employeeMatchesUser` nhắc tới `e.name` / `e.shortName` / `user.name` là đỏ;
  khối chi tiết marketer phải tra trong danh sách ĐÃ LỌC (`?marketer=<id>` không mở được lương
  người khác); và `/api/export/payroll` phải hỏi đúng hai quyền rồi lọc bằng chính hàm ấy.

---

## 4b. HIỆU NĂNG — đo trên production, không đoán

**`ops smoke` sau bản #289** (mở thật 54 màn hình bằng phiên đăng nhập hợp lệ):

```
54/54 đạt · 0 lỗi ứng dụng · 0 sai quyền · 0 chưa kiểm · 0 hết phiên
/payroll                        281 kB   123 ms   ← có đủ khối mới, và vẫn nhanh
/marketing/fanpages             165 kB    79 ms
/marketing/fanpages?tab=orders  281 kB    47 ms
/marketing/fanpages?tab=assign  262 kB    68 ms
/reports                        300 kB   129 ms
/ads                          2.597 kB  6.374 ms  ← CHẬM
```

`/payroll` mang thêm bốn khối (độ phủ quy kết · cảnh báo chi phí · đã trả trong kỳ · nhắc khai
email) và vẫn ở **123 ms**. Phép nối `order_attributions` thêm vào `salesByProductPage` không tốn
gì đáng kể: bảng ấy có chỉ mục DUY NHẤT trên `order_id`, nên mỗi đơn là một lần tra chỉ mục.

**`/ads` 6,4 giây — KHÔNG phải do bản này.** `ops perf-probe` (xoá sạch đệm trước mỗi phép đo, tức
điều kiện xấu nhất tuyệt đối) cho tám câu SQL chậm nhất của production, và **không câu nào là
`salesByProductPage`**:

```
4.292 ms  ORDER_OUTCOME dựng trực tiếp  → Seq Scan on orders + SubPlan tương quan trên shipments
4.216 ms  cùng câu trên
4.001 ms  CTE cod_statement_lines + ORDER_OUTCOME
2.690 ms  ORDER_OUTCOME theo inserted_at
…
getReturnRateSummary   5.048 ms nguội → 145 ms ấm  (35×)
getReturnRateByVariant 4.566 ms nguội → 176 ms ấm  (26×)
adsRoas 30 ngày          268 ms
```

Đây là chi phí của nhánh dự phòng `ORDER_OUTCOME` khi bảng `canonical_order_outcome` chưa phủ —
một vấn đề đã có từ trước và đã được ghi trong `docs/erp-performance-p0-3-report.md`. Lượt smoke
lại chạy **ngay sau khi deploy xong**, đúng lúc bộ lập lịch vừa khởi động và đang đồng bộ lại —
chính `scripts/smoke.ts` cảnh báo về ca này.

**Chạy lại smoke trên hệ thống ĐÃ ỔN ĐỊNH — và nó xác nhận đúng điều đó:**

```
54/54 đạt · 0 lỗi ứng dụng · 0 sai quyền · 0 CHẬM · 0 chưa kiểm · 0 hết phiên
/payroll                         281 kB   91 ms
/ads                           2.592 kB   81 ms   ← 6.374 ms → 81 ms, không sửa một dòng mã nào
/marketing/fanpages              165 kB   53 ms
/marketing/fanpages?tab=orders   281 kB   49 ms
/marketing/fanpages?tab=assign   262 kB   50 ms
/reports                         300 kB  102 ms
```

`/ads` đi từ 6.374 ms xuống **81 ms** mà không ai sửa gì — đó là dấu vân tay của việc đo trúng lúc
máy chủ đang đồng bộ lại sau deploy, không phải của một hồi quy. **Không màn hình nào CHẬM.**

---

## 5. Còn tồn tại — cần chủ shop quyết, KHÔNG tự làm

### 5.1 Chuyển nguồn ghi nhận lương mới phủ được MỘT PHẦN

`payroll.recognition = PAYROLL` làm máy chi phí **loại toàn bộ** khoản chi nhóm "Lương" ở bảng Chi
phí và thay bằng **lương cứng** từ bảng Lương. Nhưng bảng Lương **chưa ghi nhận hoa hồng** (bốn cơ
sở hoa hồng hiện có đều là % của LỢI NHUẬN, nên hoa hồng không thể đồng thời là chi phí nằm trong
lợi nhuận — vòng tròn). Nếu khoản chi "Lương tháng 1" gõ tay có gộp cả hoa hồng thì phần hoa hồng
biến mất khỏi chi phí, và lợi nhuận — cơ sở trả lương — bị thổi lên.

Engine ĐÃ cảnh báo đúng chuyện này (`DUPLICATE_PAYROLL_EXPENSE_SOURCE`, mức cao, nói rõ "kể cả
phần hoa hồng nằm lẫn trong đó") nên nó không im lặng. Bản này **không đổi** hành vi ấy: sửa nó là
sửa một hợp đồng đã được thiết kế có chủ đích, và hướng đúng phụ thuộc vào quyết định chưa có.

**Hai phương án để chủ shop chọn:**

- **(a) Chốt một cơ sở hoa hồng KHÔNG dẫn xuất từ lợi nhuận** (ví dụ % doanh thu thuần). Khi đó
  hoa hồng tính được trước lợi nhuận, bảng Lương phủ đủ cả lương cứng lẫn hoa hồng, và việc chuyển
  nguồn là an toàn.
- **(b) Coi hoa hồng là PHÂN PHỐI LỢI NHUẬN** (chia sau khi đã có lợi nhuận), không phải chi phí.
  Khi đó lợi nhuận tính lương không trừ hoa hồng, và phải nói rõ điều đó trên màn hình.

Nếu chủ shop muốn thưởng L tính theo chính lợi nhuận SAU khi trừ L, phép giải nhất quán là
`P = (R − C_khác) / (1 + tỷ lệ)` — ví dụ `R − C_khác = 20tr`, `L = 10% × max(P,0)` ⇒ `P = 20/1,1 ≈
18,18tr`, `L ≈ 1,82tr`; **không phải** `P = 20tr` rồi bỏ L khỏi chi phí. Chỗ đặt phép giải là một
hàm THUẦN tách khỏi phần đọc dữ liệu, để `payroll` và `cost-engine` không gọi đệ quy vào nhau.

Chừng nào chưa có quyết định: giữ `payroll.recognition = LEGACY_EXPENSES` (mặc định) — lương và
hoa hồng cùng đi đường bảng Chi phí, không thiếu khoản nào.

### 5.2 Giá vốn HÀNG TẶNG không vào lợi nhuận theo mã / theo marketer

`ORDER_COGS` (máy chi phí, báo cáo lợi nhuận toàn shop) cộng **mọi** dòng `order_items`, kể cả
`is_bonus = true`. Nhưng các truy vấn theo mã hàng đều lọc `is_bonus = false` ở mệnh đề `WHERE` —
`lib/queries/payroll.ts` (2 chỗ), `profit-nominal.ts` (5), `return-rate.ts` (2), `planning.ts` (2),
`inventory-decision.ts`, `slow-moving.ts`, `product-intelligence.ts`, `data-quality.ts`. Lọc ấy
đúng cho **doanh thu** (hàng tặng không sinh doanh thu) nhưng cũng cắt luôn **giá vốn** — mà hàng
tặng vẫn tốn tiền thật và vẫn trừ tồn (AGENTS.md mục 10).

Hệ quả: một marketer tặng nhiều hàng có lợi nhuận cá nhân CAO HƠN thực tế ⇒ hoa hồng cao hơn.
**Đo 14/09: production có 0 dòng `is_bonus`, giá vốn hàng tặng 0 ₫** — nên hôm nay lỗ hổng này
không làm sai một đồng nào. Phải sửa TRƯỚC khi shop bắt đầu tặng hàng, không phải việc gấp.

Đây **không** phải lỗi riêng của bảng lương mà là một quy ước chạy suốt mười tệp truy vấn; sửa lệch
một chỗ sẽ làm bảng lương không còn khớp Báo cáo lợi nhuận. **Phương án đề nghị:** bỏ `is_bonus` ra
khỏi `WHERE`, chuyển thành `filter (where is_bonus = false)` trên riêng cột doanh thu và cột phân
bổ cước, để giá vốn đếm đủ cả hàng tặng — làm đồng loạt ở cả mười tệp, trong một bản riêng, kèm bảng
đối chiếu trước/sau. Mức ảnh hưởng đo bằng ops `db-query` trước khi sửa (xem mục 6).

### 5.2b Trả lương tháng trước vào tháng sau — cơ chế đã có, nhưng phải KHAI mới chạy

`AGENTS.md` mục 17: *"Tiền ra ngày trả khác chi phí của kỳ trả."* Một khoản chi "Lương tháng 8" ghi
ngày 05/09 mà để `allocation_method = EVENT_DATE` sẽ rơi trọn vào **chi phí tháng 9** — tức tháng 8
thiếu một tháng lương và tháng 9 gánh hai.

Cơ chế chống điều đó **đã có sẵn**: khai `allocation_method = 'PERIOD_PRORATA'` kèm
`period_start` / `period_end` thì khoản ấy chia theo số ngày chồng lấn, và `needsAllocationReview`
đánh dấu những khoản theo kỳ mà chưa khai kỳ (ràng buộc `expenses_period_check` chặn ở CSDL).

Hôm nay production có **0 khoản chi nhóm "Lương"** nên chưa có gì sai. Nhưng ngày shop bắt đầu ghi
lương vào bảng Chi phí, **mỗi khoản phải khai kỳ hiệu lực của nó**, không phải chỉ ngày trả. Thẻ
"Đã trả trong kỳ" mới thêm cố ý đọc theo NGÀY TRẢ THÔ, đứng riêng với chi phí của kỳ — hai chiều,
hai con số, để chênh lệch giữa chúng lộ ra thay vì bị gộp mất.

### 5.3 Cơ sở "Dòng tiền thực" vẫn là phép QUY ĐỔI THEO TỶ TRỌNG

Tiền COD về theo bảng kê không tách được theo mã hay theo người, nên LN cá nhân ở cơ sở này là ước
tính, không phải đo được. Bản này làm nó **nói thật** (hiện "—" khi không quy đổi được, và ghi
thẳng "đây là phép quy đổi theo tỷ trọng" lên nhãn) nhưng **không** biến nó thành số đo được — muốn
đo thật thì cần nối từng dòng bảng kê COD về từng vận đơn, việc riêng, chưa làm.

### 5.4 Nhánh `claude/ai-workforce-sales-v1` — TRÙNG SỐ MIGRATION (phiên khác đang làm)

Chỉ đọc, không đụng vào:

```
main                          0084_metric_target_product_scope
                              0085_return_reason_raw_text
                              0086_fanpage_marketer_attribution
                              0087_return_reason_observations

claude/ai-workforce-sales-v1  0084_ai_workforce_foundation     ← trùng số 0084
                              0085_sales_shadow_validation     ← trùng số 0085
                              0086_product_resolver_v2         ← idx trong sổ ghi 85, TRÙNG
                              0087_ad_media_url                ← trùng số 0087
```

Ngoài trùng số với `main`, sổ của nhánh ấy còn có **hai mục cùng `idx = 85`** — điều mà
`tests/migration-journal.test.ts` trên `main` chặn. Nhánh đó phải đánh số lại migration **của
mình** (chưa áp ở đâu) cho nối tiếp vào cuối sổ `main`, không đụng tới bốn migration đã vào `main`.
Không nhánh nào được triển khai đè lên nhánh kia. Việc này thuộc phiên đang giữ nhánh ấy.

**Cập nhật 14/09 20:40** — `main` nay đã có thêm `0088_payroll_periods` (bản này), nên khoảng cần
đánh số lại của nhánh AI là **0089 trở đi**, không phải 0088. Kiểm tra lại
`drizzle/meta/_journal.json` của `main` ngay trước khi đánh số, vì con số này còn tiếp tục nhích:

```
main  (14/09 20:40)   … 0086_fanpage_marketer_attribution
                        0087_return_reason_observations
                        0088_payroll_periods              ← mới, bản này
ai-workforce-sales-v1   0084_ai_workforce_foundation   (idx 84) ← trùng số với main
                        0085_sales_shadow_validation   (idx 85) ← trùng số với main
                        0086_product_resolver_v2       (idx 85) ← TRÙNG idx với dòng trên
                        0087_ad_media_url              (idx 86) ← trùng số với main
```

Tôi **không chạm** vào nhánh ấy: chỉ đọc sổ của nó để ghi lại đây. Phiên đang giữ nhánh quyết cách
đánh số lại, và phải chạy `tests/migration-upgrade-path.test.ts` sau khi đánh số để chứng minh
đường nâng cấp từ trạng thái production hôm nay vẫn chạy.

---

## 6. Chủ shop kiểm tra thế nào

| Kiểm cái gì | Mở ở đâu | Phải thấy |
|---|---|---|
| Lương cứng theo kỳ | https://erp.vnxcommerce.com/payroll — đổi kỳ 7 ngày ↔ tháng này | Cột "Lương cứng (thuộc kỳ)" ĐỔI theo kỳ, dưới mỗi số có dòng "x/tháng × N ngày" |
| Lương cứng khớp lợi nhuận | /payroll rồi /reports (cùng kỳ) | Lương cứng ở hai trang bằng nhau |
| Kỳ "Toàn bộ" | /payroll?period=all | Lương cứng và tổng lương hiện "—", không hiện 0 ₫ |
| Cơ sở dòng tiền khi lỗ | /payroll?basis=cash, chọn một kỳ ngắn | Dải cảnh báo vàng + cột LN cá nhân "—", không phải 0 ₫ |
| Quyền xem lương | Đăng nhập tài khoản chỉ có "Lương: xem của mình" | Chỉ thấy dòng của chính mình; chưa khai email thì thấy câu chỉ đường |
| Trùng đơn | /marketing/fanpages | Mỗi dòng trùng đơn đều có CĂN CỨ và điểm ≥ 4 |
| Kỳ lương | /payroll (kỳ có mốc đầu/cuối, cơ sở LN1) | Có nút "Chốt kỳ"; kỳ "Toàn bộ" hoặc cơ sở khác LN1 thì KHÔNG có nút |
| Kỳ đã chốt | /payroll sau khi chốt một kỳ | Dải xanh "đã CHỐT", bảng đọc ảnh chụp, và khối "Chênh lệch phát sinh SAU khi chốt" nếu dữ liệu đã đổi |
| Căn cứ quy kết | /payroll (quyền xem toàn bộ) | Khối "Doanh thu chia cho marketer bằng căn cứ nào" — bốn nhóm cộng lại bằng tổng; phần "bảng gán phẳng" càng nhỏ càng tốt |
| Đã trừ đủ chi phí chưa | /payroll | Khối "Lợi nhuận này đã trừ đủ chi phí chưa?" — cảnh báo của máy chi phí, kèm việc phải làm |
| Đã trả vs phải trả | /payroll | Thẻ "Đã trả trong kỳ" kèm số chứng từ và chênh lệch với phải trả · hôm nay là `0 ₫ · 0 khoản chi` |
| Xuất CSV | /payroll → **Xuất CSV** | Tệp mở ra khớp đúng bảng đang xem; hai dòng cuối ghi kỳ, cơ sở, số ngày chia lương và phạm vi |
| Nhắc khai email | /payroll (quyền khai báo) | Dải vàng liệt kê đích danh nhân sự chưa có "Email đăng nhập ERP" — hôm nay là 4/4 |

### Ba thao tác ngắn nhất để tin con số

1. `/payroll?period=7d` rồi `/payroll?period=month` — cột **Lương cứng (thuộc kỳ)** phải ĐỔI, và
   dòng nhỏ dưới nó nói đúng phép chia. Trước bản này cột ấy đứng im ở con số lương THÁNG.
2. `/payroll?basis=cash` — phải thấy **dải đỏ** "không dùng để chốt lương được" kèm lý do và đường
   dẫn sang LN1. Trước bản này bốn cơ sở trông giống hệt nhau.
3. `/marketing/fanpages` → mở một dòng **Trùng đơn** — phải có CĂN CỨ đọc được (tên dấu hiệu) và
   điểm ≥ 4. Không dòng nào được mang điểm 1.


Câu truy vấn xác minh sau triển khai (ops `db-query`, chỉ đọc) — chạy lại đối soát fanpage trước,
rồi so với bảng ở mục 3:

```sql
select count(*) filter (where status='DUPLICATE')                                  as tong_trung,
       count(*) filter (where status='DUPLICATE' and coalesce(duplicate_score,0)<4) as duoi_nguong,
       count(*) filter (where status='DUPLICATE' and coalesce(duplicate_reason,'')='') as khong_can_cu,
       min(duplicate_score) filter (where status='DUPLICATE')                      as diem_min
from order_attributions;
```

`duoi_nguong` và `khong_can_cu` phải là **0**. Nếu khác 0 thì bản vá chưa lên.
