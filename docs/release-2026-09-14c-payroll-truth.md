# Biên bản 14/09/2026 (c) — Lương nói đúng số, và đơn đã huỷ thôi làm cầu nối

Nhánh: `claude/trusting-noether-fh23sk` · Nền: `main` sau `a142f6e` (đã gộp vào nhánh này)
Phạm vi: bốn lỗi ĐÃ TÁI HIỆN ĐƯỢC trên đường tính lương và đường quy kết fanpage, cộng hai mục
tài liệu đã lỗi thời. Không đổi một ngưỡng nghiệp vụ nào, không đổi lược đồ, không migration.

---

## 1. Bốn lỗi thật, và nguyên nhân gốc của từng cái

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

Kiểm thử mới / mở rộng:
- `tests/fanpage-attribution.test.ts` mục **7c** (cầu nối đơn huỷ) và **7d** (cửa sổ không trượt
  theo người giữ quy kết) — cả hai ĐỎ trên mã cũ, xanh trên mã mới.
- `tests/cost-double-count.test.ts` mục **6** (bảng lương = máy chi phí) và **7** (mẫu số ≤ 0 ⇒
  chưa biết, không phải 0).
- `tests/scope-enforcement.test.ts::testPayrollOwnLineNeedsAccountKey` — sáu ca hành vi cộng một lá
  chắn mã nguồn: thân `employeeMatchesUser` nhắc tới `e.name` / `e.shortName` / `user.name` là đỏ.

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

Đây **không** phải lỗi riêng của bảng lương mà là một quy ước chạy suốt mười tệp truy vấn; sửa lệch
một chỗ sẽ làm bảng lương không còn khớp Báo cáo lợi nhuận. **Phương án đề nghị:** bỏ `is_bonus` ra
khỏi `WHERE`, chuyển thành `filter (where is_bonus = false)` trên riêng cột doanh thu và cột phân
bổ cước, để giá vốn đếm đủ cả hàng tặng — làm đồng loạt ở cả mười tệp, trong một bản riêng, kèm bảng
đối chiếu trước/sau. Mức ảnh hưởng đo bằng ops `db-query` trước khi sửa (xem mục 6).

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
| Căn cứ quy kết | /payroll (quyền xem toàn bộ) | Khối "Doanh thu chia cho marketer bằng căn cứ nào" — bốn nhóm cộng lại bằng tổng; phần "bảng gán phẳng" càng nhỏ càng tốt |
| Đã trừ đủ chi phí chưa | /payroll | Khối "Lợi nhuận này đã trừ đủ chi phí chưa?" — cảnh báo của máy chi phí, kèm việc phải làm |

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
