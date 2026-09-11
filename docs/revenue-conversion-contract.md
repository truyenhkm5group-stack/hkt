# Hợp đồng lớp Chuyển đổi doanh thu (Revenue Conversion Intelligence)

Kèm `docs/business-rules/ORDER_OUTCOME.md` (kết quả đơn — nguồn duy nhất), `docs/sales-funnel-contract.md`
(phễu bán hàng đã có) và `docs/metrics-contract.md`.

Lớp này trả lời bốn câu, và **không** thêm một dashboard nào:

1. khách nào đang có khả năng mua nhưng sắp bị bỏ quên;
2. đơn nào có rủi ro hoàn **trước khi giao**;
3. nhân viên / kênh / mẫu mã đang rò tiền ở **bước nào**;
4. việc nào làm ngay thì tăng được số đơn giao thành công.

---

## 0. Kết luận trước, giải thích sau

**Một câu trong kho mã này đã sai, và commit này sửa nó.**

`docs/sales-funnel-contract.md` viết: *"ERP **không đồng bộ hội thoại Pancake**"*, rồi kết luận hai bước
"đã liên hệ" và "đủ điều kiện" là không đo được. `lib/constants/operating-funnel.ts` nói ở khâu `LEAD`:
*"Không có mốc phản hồi đầu tiên cho từng lead, nên tỷ lệ và thời gian phản hồi CHƯA đo được."*

Sự thật: job `cs-chat` **ĐỌC** hội thoại Pancake và tới 50 tin nhắn mỗi hội thoại, **15 phút một lần,
96 lượt mỗi ngày** — rồi **ném đi tất cả** trừ những ca sinh ra case CSKH. Nó thậm chí đã tính sẵn lúc
khách cho SĐT và lúc khách cho địa chỉ (`findCustomerOrderInfo`).

Hệ quả đo được trên chính lượt quét ngày 11/09/2026: **157 khách đủ thông tin, 136 đã có đơn** nên không
sinh case ⇒ **87% bằng chứng mất ngay tại chỗ**, và **mẫu số của mọi tỷ lệ chuyển đổi mất theo**. Đó là
lý do `getOrderIntakeMetrics` phải tự cảnh báo rằng con số của nó *"KHÔNG phải tỷ lệ chuyển của cả khâu"*.

Nên việc ở đây **không phải bịa thêm bước phễu**, mà là **giữ lại bằng chứng đang bị ném đi**:
bảng `conversation_funnel` (migration `0065`).

---

## 1. Hai phễu, KHÔNG nối thành một

| | Phễu trước đơn (hội thoại) | Phễu đơn hàng |
|---|---|---|
| Nguồn | `conversation_funnel` | `orders` + `shipments` + `ORDER_OUTCOME_FAST` |
| Mẫu số | hội thoại **quét được** | mọi đơn trong kỳ |
| Độ tin | lệch và bị cắt (xem §3) | đầy đủ |
| Hàm | `getPreOrderFunnel()` | `getConversionFunnel()` |

**Cấm nối hai phễu thành một chuỗi.** Mẫu số khác nhau về bản chất: hội thoại quét được (cửa sổ 48 giờ,
chỉ page có đơn trong 90 ngày, tối đa 200 hội thoại mỗi page mỗi lượt) **≠** toàn bộ hội thoại. Nối hai
mẫu số khác nhau lại là dựng ra một tỷ lệ không mô tả cái gì.

### 1.1 Phễu trước đơn — bốn mốc

| # | Mốc | Cột | Bậc bằng chứng | Điều phải nói thẳng |
|---|---|---|---|---|
| 1 | Khách nhắn tin | `first_customer_message_at` | Chứng từ | chỉ gồm hội thoại quét được |
| 2 | **Đã được trả lời** | `first_shop_reply_at` | Chứng từ | tin của shop gửi **SAU** tin đầu của khách |
| 3 | Đã có SĐT | `phone_at` | Máy suy đoán | **đếm THIẾU**: biểu thức `SDT` đòi số bắt đầu bằng `0`, khách gõ `+84…` là vô hình |
| 4 | Đã có địa chỉ | `address_at` | Máy suy đoán | **đếm THIẾU có chủ ý**: luật nhận địa chỉ cố ý bảo thủ |

Mốc 2 là thứ mà `operating-funnel.ts` nói là không có. Nó **chỉ** đúng khi lấy tin của shop gửi **sau**
tin đầu của khách: không có điều kiện "sau" thì một tin chào mời tự động sẽ được tính là đã phản hồi
trong 0 giây, và thời gian phản hồi trung vị của cả shop tụt xuống gần 0 — một con số đẹp mô tả sai hoàn
toàn việc đang xảy ra.

### 1.2 Phễu đơn hàng — năm bước, CỘNG DỒN

| # | Bước | Nguồn sự thật |
|---|---|---|
| 1 | Đơn được tạo | `orders.inserted_at` |
| 2 | Đã rời trạng thái chờ | `stage ∉ (NEW, WAITING)` — **dùng lại đúng định nghĩa của `getSalesFunnel`** |
| 3 | Đã tạo vận đơn | có dòng `shipments` qua `PRIMARY_ATTEMPT` |
| 4 | Hàng đã rời kho | `SHIPMENT_LEFT_WAREHOUSE` (sự kiện Viettel Post) |
| 5 | Giao thành công | `ORDER_OUTCOME_FAST = 'DELIVERED'` |

**Bước 3 là bước mới, và nó là lý do chính file này tồn tại.** Phễu cũ nhảy thẳng từ xác nhận sang rời
kho, nên khoảng trống lớn nhất của kho — **mã đã in mà bưu tá chưa lấy** — không hiện ra ở đâu.

**PHỄU KHÔNG PHÌNH THEO ĐỊNH NGHĨA.** Mỗi đơn được gán một **mức đi được** (1..5); bước *n* = số đơn có
mức ≥ *n*. Không kẹp số, không clamp.

Vì sao phải thế: một đơn huỷ sau khi đã gửi vẫn **ĐÃ TỪNG** rời kho, và một đơn `ORDER_OUTCOME =
DELIVERED` **có thể không có dòng vận đơn nào** (luật kết quả đơn có nhánh dựa trên trạng thái Pancake).
Đếm từng bước rời rạc thì "đã rời kho" có thể lớn hơn "đã xác nhận".

Bước 5 dùng **đúng** `ORDER_OUTCOME_FAST = 'DELIVERED'`, **không** phải "rời kho VÀ giao thành công":
thêm điều kiện "và" là tạo ra định nghĩa giao thành công **thứ hai** trong ERP. Đơn giao thành công mà
thiếu chứng từ vận đơn được xếp mức 5 và **đếm riêng** ở `evidenceGaps.deliveredWithoutShipment`.

### 1.3 "Đã xác nhận" — hai định nghĩa cùng tồn tại, và đây là lựa chọn

| Nơi | Định nghĩa |
|---|---|
| `getSalesFunnel` | `stage not in ('NEW','WAITING')` — **LỎNG**, gồm cả đơn sau đó huỷ |
| `CONFIRMED_ORDER` (tầng chỉ số) | `stage in CONFIRMED_STAGES` — **LOẠI** đơn huỷ |

**Chọn bản LỎNG**, cố ý, vì đơn huỷ sau khi đã gửi vẫn đã từng được xác nhận và đã từng rời kho; dùng
bản chặt sẽ làm "đã rời kho" > "đã xác nhận" ⇒ phễu phình. Số đơn huỷ sau xác nhận hiện ở dòng riêng
(`cancelledAfterConfirm`). **Hợp nhất hai định nghĩa là một thay đổi chỉ số phải có chủ shop đồng ý kèm
số trước/sau** — không phải hệ quả phụ của một màn hình mới.

---

## 2. Bước KHÔNG ĐO ĐƯỢC — khai ra, không bịa

Kế hoạch ban đầu có bước **"đủ điều kiện / có ý định mua"** giữa "khách nhắn tin" và "đã có SĐT".

**ERP không có nguồn nào cho nó.** Mọi căn cứ nghĩ ra được đều rơi vào một trong hai bẫy:

1. **Đổi tên một sự thật đã đếm.** Căn cứ mạnh nhất nghĩ ra được là "khách đã cho SĐT hoặc địa chỉ" —
   nhưng đó **đúng là hai mốc kế tiếp**. Đếm nó thành một bước riêng là nhân đôi cùng một sự thật rồi
   gọi là hai bước, và phễu sẽ có một bước luôn xấp xỉ bước sau nó.
2. **Tìm từ khoá trong câu chữ.** Đúng loại suy diễn đã dựng ra **181 case sai** "đã chốt đơn" mà phần
   lớn khách còn chưa cho số điện thoại (xem `lib/cs/chat-detect.ts`).

Nên nó được **khai** ở `UNMEASURABLE_STAGES` (`lib/constants/conversion.ts`) kèm lý do, và hiện thành một
dòng **"KHÔNG ĐO ĐƯỢC"** trên màn hình. `tests/conversion-funnel.test.ts` khẳng định nó **không** có mặt
trong danh sách bước phễu.

Thứ đo được và có ích hơn: **"đã được trả lời"** (mốc 2) — một sự thật, là bước rơi lớn nhất của bán hàng
qua chat, và sinh ra được một việc làm ngay.

---

## 3. Độ phủ — cái gác cho toàn bộ bốn mốc trước đơn

Bảng rỗng ⇒ mọi con số trả **`null`, KHÔNG phải 0**, và `sourceStatus = 'DATA_UNAVAILABLE'`.

Job quét lùi 48 giờ. Hội thoại xảy ra **trước lần quét đầu tiên không tồn tại trong CSDL**. Chia đơn của
một kỳ cho số hội thoại của kỳ chưa được quét thì tỷ lệ chuyển vọt lên hàng trăm phần trăm — một con số
vô nghĩa trông như tin tốt.

Ba điều kiện phải đạt **cùng lúc** mới công bố tỷ lệ chuyển hội thoại → đơn:

1. `coverage.periodCovered` — đầu kỳ không sớm hơn hội thoại sớm nhất ghi được;
2. `conversations ≥ MIN_CONVERSATIONS_FOR_RATE` (20);
3. phép ghép đơn **chắc chắn** (`BY_CONVERSATION` hoặc `BY_PHONE_UNIQUE`).

`truncated` đếm số dòng thuộc page đã **chạm trần 200 hội thoại/lượt** — một con số bị cắt trông y hệt
một con số đầy đủ nếu không ghi cờ.

**`AMBIGUOUS` (một SĐT nhiều đơn) là một dòng RIÊNG nhìn thấy được**, không bao giờ gộp vào "chưa có đơn":
gộp vào là biến *"không biết"* thành *"biết là chưa"*.

---

## 4. Hàng đợi rò rỉ — chỉ ca còn cứu được

Năm nhóm (`lib/constants/leakage.ts`). **Bốn trong năm dùng lại loại việc đã có** của Hàng đợi việc:

| Nhóm | Nguồn | Loại việc có sẵn |
|---|---|---|
| `NO_REPLY` | `conversation_funnel` | *(mới — trước đây không có dữ liệu)* |
| `PHONE_NO_ORDER` | `conversation_funnel` | *(mới)* |
| `INFO_NO_ORDER` | `conversation_funnel` | *(mới; xem lý do bên dưới)* |
| `UNCONFIRMED` | `getActionQueue()` | `NEW_ORDER_UNPROCESSED`, `ORDER_INCOMPLETE`, `ORDER_ADDRESS_NOT_NORMALIZED` |
| `NO_SHIPMENT` | `getActionQueue()` | `ORDER_CONFIRMATION_STALE` |

Hai nhóm cuối **đọc lại** Hàng đợi việc chứ không tự truy vấn `orders`: cùng bản ghi, cùng người nhận,
cùng hạn, cùng trạng thái tiếp nhận. Nếu tự truy vấn lại thì ai đó tiếp nhận một việc trên trang *Cần xử
lý* sẽ thấy nó vẫn "chưa ai nhận" ở trang này, và niềm tin vào cả hai màn hình mất trong một buổi.

`INFO_NO_ORDER` đọc `conversation_funnel` chứ **không** đọc case CSKH `ORDER_NOT_CREATED`, dù hai thứ nói
cùng chuyện: `cs_cases` chỉ giữ ca **chưa** có đơn nên không có mẫu số, và nó gom theo tuần/tháng bằng
`dedupeKey` nên một ca có thể biến mất khỏi danh sách dù vẫn chưa xử lý.

### 4.1 Hai cái chặn spam, và chúng là tính năng

1. **Tuổi tối đa** (`LEAKAGE_MAX_AGE_HOURS`). Khách nhắn 10 ngày trước mà chưa ai trả lời thì gọi lại bây
   giờ **không phải thu hồi doanh thu — đó là làm khách khó chịu**. Ca quá tuổi vẫn được **đếm** trong
   báo cáo phễu (nó là sự thật đã xảy ra) nhưng **không** vào hàng đợi việc.
2. **Ngưỡng tin cậy** (`MIN_CONFIDENCE = MEDIUM`, thang dùng lại `RECOMMENDATION_CONFIDENCE`).

**Mọi lần loại bỏ đều phải đếm được và nêu lý do** (`suppressed`). Một hàng đợi lặng lẽ bỏ 200 ca là một
hàng đợi không ai kiểm chứng được — và đúng thứ đó đã xảy ra ở kho mã này với 181 case sai.

Thêm một cái chặn thứ ba: hội thoại đã có **case CSKH đang mở** thì không báo lần hai
(`ALREADY_A_CASE`).

### 4.2 Tiền — ba căn cứ, TUYỆT ĐỐI không cộng vào nhau

`lib/queries/order-intake.ts` đã từ chối ước tính tiền cho khách chưa có đơn, với lý do đúng: *"nhân số
khách chờ với giá trị đơn trung bình sẽ ra một con số nghe rất cụ thể mà không có gì đứng sau"*. Luật đó
**giữ nguyên**; ở đây chỉ nói rõ hơn bằng cách gắn căn cứ vào từng con số:

| `valueBasis` | Nghĩa | Vào tổng nào |
|---|---|---|
| `ACTUAL_ORDER` | đơn có thật, tiền của đơn | `actualValueAtRisk` — **SỰ THẬT** |
| `PAGE_MEDIAN` | trung vị đơn giao thành công của **đúng page đó**, mẫu ≥ 20 đơn/90 ngày | `estimatedValueAtRisk` — **ƯỚC TÍNH, tổng riêng, có nhãn** |
| `UNKNOWN` | không có căn cứ nào | `null`, **không phải 0**; đếm riêng ở `unknownValueCases` |

`PAGE_MEDIAN` nghĩa là *"một đơn của page này thường đáng bao nhiêu"*, **không** phải *"ta sẽ thu được
bấy nhiêu"*. Hàng đợi **xếp thứ tự theo tiền thật trước**, không theo ước tính: nếu ước tính được xếp
ngang tiền thật thì thứ tự việc của cả hàng đợi do một con số suy ra quyết định, và không ai phát hiện được.

---

## 5. Điểm rủi ro trước khi giao

`lib/constants/preship-risk.ts` (trọng số) + `lib/queries/preship-risk.ts` (tính) — **11 tín hiệu**, tổng
điểm dương **đúng 100**.

Bốn điều phải nói thẳng:

1. **Trọng số là GIẢ THIẾT, không phải kết quả học máy.** Việc chứng minh chúng có tác dụng là của kiểm
   định (§6). Kiểm định nói KHÔNG thì báo cáo phải nói KHÔNG — **tuyệt đối không sửa trọng số cho tới khi
   số liệu đẹp rồi mới công bố**.
2. **Điểm KHÔNG phải xác suất hoàn.** Nó là chỉ số tương đối 0–100 để xếp thứ tự việc cần soát.
3. **Không tín hiệu nào là căn cứ kết luận kết quả đơn.** Kết quả đơn chỉ có `ORDER_OUTCOME`. Điểm rủi ro
   không bao giờ được ghi vào chỗ mà báo cáo doanh thu / lương / tồn kho đọc.
4. **Điểm cao KHÔNG tự huỷ đơn.** Chỉ sinh một việc: xin cọc, gọi xác nhận.
   `tests/preship-risk.test.ts` khoá điều này ở **mức mã nguồn** (quét tìm `update(orders)` và
   `stage: 'CANCELLED'` trong ba file của lớp này).

### 5.1 KHÔNG có tín hiệu "COD cao"

Số tiền phải trả tại cửa là **độ lớn thiệt hại**, không phải **xác suất** xảy ra. Trộn hai thứ vào một
điểm sẽ làm đơn 2 triệu của khách ruột bị soát **trước** đơn 300K của khách đã hoàn bốn lần — sai người,
sai việc. COD đi vào `expectedLossVnd`, hiện ở một dòng riêng. Bài kiểm khẳng định: **đổi giá trị đơn
không đổi điểm, nhưng đổi thiệt hại dự kiến.**

### 5.2 Thiếu dữ liệu KHÔNG phải an toàn

Tín hiệu không tra được thì **không cộng 0 điểm** mà vào `unmeasurable`. Cộng 0 sẽ làm một đơn không biết
gì về khách trông y hệt một đơn của khách tốt.

Thiếu quá `MAX_UNMEASURABLE_FOR_HIGH` (4) tín hiệu ⇒ mức bị **hạ** khỏi "cao", `confidence = LOW`, và
`bandCapped = true` (nói ra, không hạ âm thầm). Đây là luật *"thiếu chiều nào thì KHÔNG phán"* đã có ở
`classifyProduct`.

**Một tính chất phát hiện được khi viết bài kiểm:** với bảng trọng số hiện tại, ca thiếu dữ liệu **không
thể** đạt mức CAO, vì đúng những tín hiệu nặng nhất (lịch sử khách 30đ, Pancake chặn 18đ) lại chính là
những tín hiệu bị thiếu; phần còn lại cộng hết chỉ tới 29đ < 40đ. Bài kiểm khoá luôn tính chất đó.

Tỷ lệ lịch sử (mẫu mã / khu vực / kênh / khách) **dưới `MIN_SAMPLE_FOR_RATE` (20) đơn đã kết thúc ⇒
`null`**, không phải 0: "mẫu mã hoàn 3/3" không phải "mẫu mã hoàn 100%".

---

## 6. Kiểm định — hàm này ĐƯỢC PHÉP nói "không có tác dụng"

`lib/queries/preship-risk-backtest.ts`.

**Chia theo thời gian, không chia ngẫu nhiên.** Bốn tín hiệu của điểm rủi ro đều là tỷ lệ hoàn lịch sử;
nếu tính trên toàn bộ dữ liệu thì nó **đã chứa** kết quả của chính đơn đang chấm, và điểm sẽ "dự báo"
xuất sắc một chuyện nó đã biết trước. Đó là tự chấm bài của mình.

- Tỷ lệ tham chiếu học từ nửa **cũ** (đơn lên trước `trainTo`, phân vị `BACKTEST_TRAIN_RATIO = 0,7`).
- Lịch sử khách còn chặt hơn: `oh.inserted_at < o.inserted_at` — lúc chuẩn bị gửi đơn này, ta **chưa thể**
  biết kết quả những đơn lên sau nó.
- Chấm bằng **đúng** `scorePreshipRisk()` mà giao diện dùng; kiểm định một hàm khác là kiểm định vô nghĩa.

`verdict` chỉ là **`PHÂN BIỆT ĐƯỢC`** khi **cả hai** điều kiện đạt:

1. `uplift ≥ MIN_LIFT_TO_CLAIM` (1,3× mặt bằng);
2. **biên dưới Wilson 95%** của `P(hoàn | rủi ro cao)` vẫn **cao hơn** mặt bằng.

Mọi trường hợp khác: `KHÔNG PHÂN BIỆT ĐƯỢC` hoặc `KHÔNG ĐỦ MẪU`, kèm lý do nêu **đúng điều kiện nào
thiếu**. Nhóm dưới 20 đơn ⇒ nhóm đó **không có tỷ lệ**.

`limitations` **luôn không rỗng**, và luôn gồm câu quan trọng nhất: nhãn "hoàn" một phần là **kết luận về
TIỀN** (theo `RETURN_RULE`, đơn ĐVVC báo giao thành công mà thực thu < 100.000đ vẫn là hoàn), nên điểm
đang dự báo lẫn cả việc **thu được tiền**, không chỉ vật lý giao hàng.

### 6.1 Chưa đo trên production

**Tại thời điểm commit này, kiểm định CHƯA chạy trên dữ liệu production.** Phiên làm việc không có `.env`
và không có `gh` CLI, nên không truy cập được CSDL thật. Cái đã được chứng minh là **tính chất của hàm**
(thứ tự điểm, kỷ luật `null`, và việc nó **từ chối** tuyên bố khi mẫu chưa đủ) trên dữ liệu dựng tay
trong `tests/preship-risk.test.ts`.

**Không được ghi một con số precision / uplift nào vào tài liệu này cho tới khi chủ shop chạy thật.**
Cách chạy: mở `/reports/funnel` (mục *Kiểm định điểm rủi ro*) — nó tính trực tiếp trên CSDL thật ở lần
mở đầu tiên sau khi deploy. Ghi số trả về vào commit message / bàn giao theo `AGENTS.md` mục 6.5.

---

## 7. Cấm

1. Không suy diễn "ý định mua" từ bất kỳ trường nào. Bước đó đã được khai là không đo được (§2).
2. Không nối phễu trước đơn vào phễu đơn thành một chuỗi (§1).
3. Không công bố tỷ lệ chuyển hội thoại khi chưa đạt cả ba điều kiện độ phủ (§3).
4. Không gộp `AMBIGUOUS` vào "chưa có đơn" (§3).
5. Không cộng tiền ước tính vào tiền thật (§4.2).
6. Không đưa COD / giá trị đơn vào điểm rủi ro (§5.1).
7. Không để điểm rủi ro huỷ, xoá, hay đổi trạng thái bất kỳ đơn nào (§5).
8. Không tuyên bố điểm rủi ro có tác dụng khi kiểm định chưa đạt hai điều kiện ở §6.
9. Không viết lại điều kiện `stage` cho bước "giao thành công" — dùng `ORDER_OUTCOME_FAST`.
10. Không bỏ `PRIMARY_ATTEMPT` khỏi bất kỳ phép nối `shipments` ở mức đơn.
