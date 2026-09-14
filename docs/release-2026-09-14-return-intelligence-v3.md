# Biên bản bản phát hành — BÁO CÁO HOÀN V3: ĐỌC THEO THỨ TỰ RA QUYẾT ĐỊNH

Ngày 14/09/2026 · nhánh `claude/return-intelligence-v3` · trang `/reports/returns`

Tệp này ghi lại **nguyên nhân gốc**, **số đo production** và **thứ đã CỐ Ý không làm**. Hợp đồng
đầy đủ nằm ở mã nguồn: `lib/constants/projected-delivery.ts` · `lib/constants/marketer-attribution.ts` ·
`lib/constants/return-intelligence.ts`.

---

## 1. Vì sao phải sửa

Trang `/reports/returns` trước bản này **đúng về số nhưng sai về thứ tự đọc**:

1. Khối "GTC theo nguồn đơn" đứng **trước** "GTC theo mã hàng" — bắt người đọc quyết định về KÊNH
   trước khi biết SẢN PHẨM nào đang hỏng. Mọi hành động thật (đổi lô vải, sửa bảng size, dừng bán
   một mã) đều bắt đầu từ mã hàng.
2. Cột **GTC ước tính** đã bị gỡ khỏi bảng ngày 13/09, và lý do gỡ hoàn toàn đúng: công thức cũ áp
   MỘT tỷ lệ của cả shop cho TỪNG mã rồi in cạnh một con số đo thật, cùng cỡ chữ cùng màu. Người
   đọc không có cách nào biết cột nào là ước tính. Nhưng gỡ đi thì chủ shop mất luôn câu trả lời cho
   câu hỏi đắt nhất: *"lô hàng này rốt cuộc sẽ giao được bao nhiêu phần trăm?"*
3. Báo cáo dừng ở "bao nhiêu" và "vì sao", **không đi tới "ai sửa"**. Một con số "hoàn 55,4%" không
   tự đi tới phòng ban nào cả.

---

## 2. Số đo production TRƯỚC bản này (14/09/2026, ops `db-query`, chỉ đọc)

### 2.1 Kết quả theo mã hàng — 90 ngày, lọc theo mốc ĐVVC tiếp nhận

| mã | đã gửi | GTC | hoàn | chưa kết thúc | huỷ | **GTC thực tế** |
|---|---:|---:|---:|---:|---:|---:|
| Q001 | 71 | 33 | 38 | 0 | 0 | **46,5 %** |
| Q002 | 1.089 | 270 | 755 | 64 | 1 | **26,3 %** |
| Q003 | 467 | 188 | 220 | 59 | 0 | **46,1 %** |
| Q004 | 65 | 12 | 5 | 48 | 0 | **70,6 %** |
| X001 | 33 | 13 | 20 | 0 | 0 | **39,4 %** |

Đối chiếu bất biến: `đã gửi = GTC + hoàn + chưa kết thúc` đúng cho cả năm mã (huỷ nằm NGOÀI cohort).

Q004 có 48/65 kiện **chưa kết thúc** — nên "70,6 %" của nó đứng trên đúng 17 quan sát. Đó chính là
lý do bảng phải có cột "Chưa kết thúc" đứng cạnh, và vì sao nhãn "mẫu quá nhỏ" phải hiện thành lời.

### 2.2 171 đơn đang chạy, tách theo trạng thái Viettel Post

| mã VTP | trạng thái | kiện |
|---|---|---:|
| 300 | Đóng bảng kê đi | 50 |
| — | **Chờ xử lý** | **34** |
| 500 | Giao bưu tá đi phát | 21 |
| — | **Chờ phát lại** | **18** |
| 506 | Tồn – Khách hàng nghỉ, không có nhà | 17 |
| — | Đang giao hàng | 14 |
| 400 | Nhận bảng kê đến | 10 |
| — | Đang vận chuyển | 4 |
| 507 | Tồn – Khách hàng đến bưu cục nhận | 2 |
| 500 | Giao cho bưu cục | 1 |

Tuổi kiện tính từ mốc bàn giao: **62 kiện < 24 h · 13 kiện 48–72 h · 96 kiện > 72 h.**
Hơn một nửa số kiện đang chạy đã quá 72 giờ — đó là lý do **tuổi kiện phải là một chiều điều kiện
hoá riêng**, không gộp vào một xác suất chung với kiện mới rời kho.

### 2.3 Xác suất giao được, theo trạng thái (mẫu = vận đơn đã có kết cục)

| trạng thái | mẫu | giao được | P |
|---|---:|---:|---:|
| Đang vận chuyển | 230 | 93 | 40,4 % |
| Đang đi giao | 223 | 92 | 41,3 % |
| **Chờ xử lý** | **188** | **50** | **26,6 %** |
| Đã lấy hàng | 143 | 71 | 49,7 % |
| Tồn / giao gặp sự cố | 130 | 39 | 30,0 % |
| **Chờ phát lại** | **66** | **14** | **21,2 %** |

Hai nhóm chủ shop hỏi tên cụ thể — *Chờ xử lý* và *Chờ phát lại* — là hai nhóm **tệ nhất**, và
chúng cũng là hai nhóm duy nhất người trực can thiệp được. Vì vậy bảng gọi tên chúng ngay trên cột
"Chưa kết thúc" (⏳ và ↻) thay vì giấu trong tooltip.

### 2.4 Độ phủ quy kết marketer (90 ngày, 2.580 đơn đã xác nhận)

| tình trạng | đơn |
|---|---:|
| Quy kết được đúng một marketer | **1.321 (51,2 %)** |
| Không nối được về chiến dịch nào | 1.258 |
| Chiến dịch chưa khai người phụ trách | 1 |
| Chiến dịch nhiều người — nhập nhằng | 0 |

51,2 % là **dưới ngưỡng cảnh báo 70 %**, nên bảng theo marketer luôn kèm một dòng nói rõ: con số
đúng cho phần quy kết được, nhưng phần ấy có thể không đại diện cho toàn shop.

Kết quả theo marketer (GTC = giao ÷ đã kết thúc): `b6373e43…` 38,7 % (511 ca) · `590efdb6…` 40,6 %
(101 ca) · nhóm **Chưa xác định** 29,0 % (908 ca). Chênh lệch có thật và đủ lớn để đáng nhìn.

### 2.5 Chỗ trống lớn nhất của cả báo cáo

* `shipment_return_reasons` — **RỖNG**. Chưa một ca hoàn nào được người của shop xác nhận lý do.
* `shipments.vtp_reason_code` — **NULL trên cả 2.108 vận đơn**. ĐVVC chưa từng gửi mã lý do.

Nghĩa là **100 % lý do hoàn hiện nay suy từ CHỮ trong sự kiện Viettel Post**. Câu đó phải đứng
TRƯỚC bảng lý do chứ không phải ở chân trang — người đọc cần biết mình đang đọc một bản suy luận
trên phần dữ liệu đã thu, không phải một bản kiểm kê.

Chữ có thật trên sự kiện của đơn hoàn: *Tồn – Thông báo chuyển hoàn bưu cục gốc* 239 · *Tồn – Khách
hàng nghỉ, không có nhà* 89 · *Phát thất bại nhiều lần – Không liên lạc được* 78 · *Khách từ chối
nhận – Sai thông tin đơn hàng* ~150 · *Khách từ chối nhận – Không hài lòng về sản phẩm* ~24.

### 2.6 Chăm sóc kiện (250 ca)

`RESOLVED + RESCUED_DIRECT` 9 · `RESOLVED + RESCUE_FAILED` 8 ⇒ tỷ lệ cứu **9/17 = 52,9 %** trên mẫu
17 ca đã ngã ngũ. 49 ca `ASSIGNED/PENDING`, 112 ca `CANCELLED`. Mẫu còn quá nhỏ để chấm người, và
màn hình nói đúng như vậy thay vì in một con số.

---

## 3. Đã làm

### 3.1 Thứ tự khối đi theo đường một quyết định hình thành

```
KPI tổng quan → độ phủ dữ liệu → GTC THEO MÃ HÀNG → rủi ro theo mã hàng
→ GTC theo nguồn đơn → chất lượng đầu vào theo marketer → hiệu suất giao vận
→ xu hướng & so kỳ trước → phân tích lý do hoàn → chăm sóc & cứu đơn → cần chú ý
```

**sản phẩm → kênh → người mang đơn về → giao vận → nguyên nhân → người xử lý → việc.**

### 3.2 Bảng theo mã hàng

`MÃ HÀNG · ĐÃ GỬI · GTC · KHÔNG THÀNH CÔNG · CHƯA KẾT THÚC · GTC THỰC TẾ · GTC ƯỚC TÍNH · DOANH THU THẤT BẠI`

Hai cột tỷ lệ đứng **cạnh nhau** là chủ ý: số đã đo và số dự báo phải so được bằng mắt. Cột dự báo
mang nhãn "ước tính", không dùng thang màu đạt/không đạt của cột thực tế, và hover ra **đúng phép
tính**:

```
Đã gửi: 93 đơn.
Đã GTC 52 · đã hoàn 39 · chưa kết thúc 2.
Phần chưa kết thúc, tách theo trạng thái Viettel Post:
  · Đã lấy hàng: 1 đơn — chưa đủ mẫu, NGOÀI phần ước tính
  · Tồn / giao gặp sự cố: 1 đơn — chưa đủ mẫu, NGOÀI phần ước tính
Giao được dự kiến thêm: 0.0 đơn.
Tổng giao được dự kiến: 52 + 0.0 = 52.0 đơn.
GTC ước tính = 52.0 ÷ 91 = chưa đo được.
2 đơn ở trạng thái chưa đủ mẫu bị LOẠI khỏi cả tử số lẫn mẫu số …
Đây là DỰ BÁO, không phải kết quả thực tế.
```

### 3.3 Mô hình xác suất: học đúng câu hỏi nó sẽ bị hỏi

V3 bản đầu học từ *"kiện TỪNG đi qua trạng thái s"* nhưng được DÙNG để trả lời *"kiện đang ở s lúc
này"* — và bài thử ngược vốn đã chấm bằng **ảnh chụp**. Học một câu, chấm một câu khác.

Nay huấn luyện dùng chính cấu trúc ảnh chụp của bài thử ngược (mốc 12 h · 36 h · 60 h · 96 h ·
144 h · 240 h sau khi ĐVVC nhận), và điều kiện hoá **bốn bậc**:

```
mã hàng + trạng thái + tuổi  →  mã hàng + trạng thái  →  trạng thái + tuổi  →  trạng thái  →  CHƯA ĐO ĐƯỢC
```

Ô dưới **10 quan sát** không được dùng, kể cả khi nó có một tỷ lệ trông rất hợp lý. Hết bậc thì
`null` — KHÔNG có bậc nào trả về một con số mặc định. Một kiện góp **đúng một quan sát cho mỗi ô**
(webhook VTP thử lại tới 5 lần).

Rổ tuổi `< 24 h · 24–48 h · 48–72 h · > 72 h` lấy theo nhịp giao hàng đo được: giao được p95 5,7
ngày, hoàn p95 13,1 ngày — qua 72 giờ mà chưa tới tay khách thì kiện đã rời khỏi vùng bình thường.

### 3.4 Quy kết marketer đi bằng KHOÁ

```
orders.ad_id  → fb_ads.campaign_id                     (bằng chứng trực tiếp nhất)
orders.post_id → fb_ads.post_id → campaign_id          (chỉ khi bài thuộc ĐÚNG 1 chiến dịch)
campaign_id   → ad_spends.marketer_id                  (chỉ khi chiến dịch có ĐÚNG 1 người)
```

**Tuyệt đối không dò chữ trong tên chiến dịch** — `tests/return-intelligence.test.ts` quét mã nguồn
để chặn `ilike` và `Employee.aliases` ở tệp quy kết. Quy kết sai ở đây ghi tỷ lệ hoàn của người này
lên thẻ điểm người kia.

Nhóm **"Chưa xác định"** luôn có mặt, nên cộng mọi dòng bằng đúng tổng khi không chia — bật chiều
marketer KHÔNG làm đổi tổng.

### 3.5 Bảng lý do hoàn: hai mẫu số, không được trộn

| cột | mẫu số | trả lời câu |
|---|---|---|
| Tỷ trọng trên hoàn | ca hoàn ĐÃ BIẾT lý do | "trong số ca đã hiểu, lý do này chiếm bao nhiêu" |
| **Tỷ lệ trên đã gửi** | **cả lô hàng đã bàn giao ĐVVC** | **"cứ 100 kiện gửi đi thì bao nhiêu hỏng vì lý do này"** |

Dùng nhầm cột đầu để nói về quy mô là phóng đại nhiều lần. Thêm cột **Doanh thu mất**, nút
**hiện/ẩn lý do 0 đơn** (gấp lại chứ không xoá — lý do `needsHuman` bằng 0 nghĩa là *chưa ai ghi*),
và **drilldown** xuống từng vận đơn giữ nguyên mọi bộ lọc.

Bộ lọc mới áp cho cả khối: **mã hàng · marketer · kỳ · mốc thời gian** (ba mốc: ngày gửi ĐVVC ·
ngày tạo đơn · ngày xử lý), tất cả lưu trên URL.

### 3.6 Tầng quyết định

* **Rủi ro theo mã hàng** chấm bằng **ĐÍCH trong `metric_targets`**, không bằng hằng số trong mã
  (AGENTS.md mục 38). Chưa đặt đích ⇒ `NO_TARGET`: hiện thực tế, KHÔNG kết luận. Chưa đủ mẫu ⇒
  `INSUFFICIENT` — một mức RIÊNG, không phải "xấu".
* **Lớp vấn đề suy từ LÝ DO**, không từ con số: `PRODUCT_QUALITY` · `SIZE_FIT` · `LOGISTICS` ·
  `SALES_CONSULTING` · `CUSTOMER_BEHAVIOR` · `DATA_GAP`, mỗi lớp một phòng ban sở hữu.
* **Hiệu quả chăm sóc** chỉ chấm trên ca ĐÃ NGÃ NGŨ; ca còn treo đếm riêng. Và vì ĐVVC đồng quyết
  định kết quả, đây là **kết quả chung**, đọc làm bối cảnh chứ không phải điểm cá nhân.
* **Khối "Cần chú ý"** chỉ nói khi đủ mẫu (mã hàng ≥ 20 đơn đã kết thúc, marketer ≥ 30), tối đa 8
  dòng, mỗi dòng mang con số + cỡ mẫu + phòng ban. Nút **Tạo công việc** giao cho **PHÒNG BAN**,
  KHÔNG gán cho một cá nhân (AGENTS.md mục 22 và 25).

---

## 4. Đã thử và đã BỊ CHẶN — ghi lại để không ai thử lại

Bản nháp thêm hai luật đọc chữ, đưa

* *"Khách từ chối nhận – Không hài lòng về sản phẩm"* (~24 kiện) → nhóm **Chất lượng**
* *"Khách từ chối nhận – Sai thông tin đơn hàng"* (~150 kiện) → nhóm **Chốt đơn sai**

`tests/kpi-clarity.test.ts` đỏ ngay, và **bài kiểm đúng**: hai lý do đó nằm trong nhóm CHỈ NGƯỜI MỚI
BIẾT. Một bưu tá gõ "không hài lòng" vào máy không phải là shop đã xác minh vải xấu — và một khi
con số ấy vào cột "Chất lượng kém", nó trông y hệt một ca đã có người gọi cho khách.

Cả hai vẫn là `CUSTOMER_REFUSED` (khách từ chối — một **quan sát**, không phải một **kết luận**), và
chuỗi gốc hiện nguyên văn ở cột "Căn cứ lý do" của bảng drilldown để người xử lý đọc rồi XÁC NHẬN.
Đường tăng độ phủ lý do đi qua `shipment_return_reasons` — bảng đó đang RỖNG, và đó mới là việc phải
làm.

---

## 5. Đo hiệu năng — trước / sau, cùng máy, cùng quy mô

`npm run bench -- --scale=4` (5.277 đơn · 4.802 vận đơn · 18.841 sự kiện — gấp ~2 lần production),
PGlite một luồng:

| gói truy vấn | cold TRƯỚC | cold SAU | warm TRƯỚC | warm SAU | câu truy vấn |
|---|---:|---:|---:|---:|---:|
| Tỷ lệ giao thành công (GTC) | 1.286 ms | 1.379 ms | 159 ms | 158 ms | 9 → 14 |
| GTC theo mẫu mã | 1.279 ms | 1.348 ms | 177 ms | 172 ms | 9 → 14 |
| Lý do hoàn (mới) | — | 225 ms | — | 218 ms | 5 |
| Tầng quyết định (mới) | — | 1.969 ms | — | 230 ms | 27 |

Cold +5–7 %, **warm không đổi**. Năm câu thêm là phép tra mã hàng cho kho huấn luyện, chia lô 1.000
vận đơn (production 2.108 kiện ⇒ 3 lô) và nằm trong bộ đệm 10 phút của kho. Tầng quyết định cold cao
vì nó dùng CHUNG kho xác suất với bảng phía trên — trên trang thật, bảng chạy trước nên kho đã ấm.

Không có N+1: drilldown là **một** câu cho tối đa 300 đơn; bản đồ mã hàng là **một** câu cho mỗi lô
1.000 vận đơn. Không thêm chỉ mục nào — benchmark không chứng minh cần.

---

## 6. Kiểm thử

`tests/return-intelligence.test.ts` (mới, 8 nhóm) khoá những thứ CHỈ bản này mới có:

1. bậc điều kiện hoá và rổ tuổi phủ kín – không chồng – mỗi rổ có mốc học;
2. một kiện không được đếm hai lần trong cùng một ô;
3. quy kết marketer đi bằng khoá (0 phép dò chữ);
4. lớp vấn đề phủ kín 40/40 lý do, mọi lớp có phòng ban;
5. nhãn rủi ro đọc đích, 0 ngưỡng ghi cứng;
6. cổng cỡ mẫu của khối cảnh báo, và nút tạo việc không gán cá nhân;
7. hai mẫu số của bảng lý do + bốn bộ lọc + drilldown khớp từng lý do;
8. tầng quyết định chạy thật: chưa đặt đích ⇒ 0 kết luận đạt/không đạt.

Những gì đã có bài khác khoá thì KHÔNG lặp lại: "Đã gửi" · `AWAITING_PICKUP` · lấy hụt · shop huỷ
lấy · vận đơn 1P1 · nhiều lần gửi (`contract-order-outcome`, `multi-attempt-money`); ba mốc thời
gian (`kpi-clarity`); công thức ước tính · thử ngược · parity với trang lợi nhuận
(`projected-delivery`, `reporting-parity`).

## 7. Visual QA — trình duyệt thật

Chromium, ba mức phóng (90 % · 100 % · 110 %) × hai chủ đề (sáng · tối), trên bản dựng production
với dữ liệu demo: **52/52 đạt**. Kiểm được: không cuộn ngang toàn trang ở cả sáu tổ hợp · thứ tự
khối đúng hợp đồng · tám cột đúng thứ tự với "GTC ước tính" ngay sau "GTC thực tế" · tooltip ước
tính mang đủ phép tính và câu "đây là DỰ BÁO" · bốn bộ lọc có mặt · đổi cả ba mốc thời gian vẫn
200 · kỳ rỗng không làm sập trang.

Lượt QA đầu tiên "xanh" 22 khẳng định trong khi **không dòng dữ liệu nào được vẽ** — token tự ký
mang `sub` không có thật, máy chủ trả TRANG ĐĂNG NHẬP với mã 200. Nay kịch bản đăng nhập thật qua
form và có một lá chắn riêng: *"đã vào được trang thật, không phải màn đăng nhập"*.

Lượt QA cũng bắt được một lỗi thật: `ReasonGroupTable` là Client Component và bản nháp truyền một
**hàm** `drilldownHref` qua ranh giới — cả khối lý do hoàn biến mất sau một lớp bắt lỗi, trang vẫn
trả 200. Nay truyền một **bảng tra** dựng sẵn ở máy chủ.

---

## 8. Xác minh SAU khi triển khai (14/09/2026, 08:25–08:48)

Production đang chạy `bf48f8dc98c0` trên `main` — **đúng SHA đã qua cổng**, xác nhận bằng
`/api/health`.

### 8.1 Bất biến nghiệp vụ: đối soát toàn bộ đơn

`ops outcome-parity` (chỉ đo, không ghi):

```
TOTAL_ORDERS   2.810      MATCHED 2.810      MISMATCHED 0
MISSING_FACT   0          STALE_VERSION 0    FALLBACK_RATE 0 %
DELIVERED      505        COGS_FROZEN 505    COGS_NOT_FROZEN 0
```

**0 dòng lệch** giữa bảng kết quả đã tính sẵn và luật chuẩn. Bản phát hành này KHÔNG đụng tới
`ORDER_OUTCOME`, và con số chứng minh điều đó thay vì lời hứa.

### 8.2 Bảng chân lý theo mã hàng — và phép cộng phải khớp

| mã | GTC | hoàn | chưa kết thúc | **đã gửi** | GTC + hoàn + chưa kết thúc | GTC thực tế |
|---|---:|---:|---:|---:|---:|---:|
| Q001 | 33 | 38 | 0 | **71** | 71 ✓ | 46,5 % |
| Q002 | 270 | 760 | 59 | **1.089** | 1.089 ✓ | 26,2 % |
| Q003 | 190 | 222 | 55 | **467** | 467 ✓ | 46,1 % |
| Q004 | 12 | 6 | 47 | **65** | 65 ✓ | 66,7 % |
| X001 | 13 | 20 | 0 | **33** | 33 ✓ | 39,4 % |

`Đã gửi = GTC + hoàn + chưa kết thúc` đúng cho **cả năm mã**. Đơn huỷ (Q002: 1) nằm NGOÀI cohort —
không ở tử số, không ở mẫu số.

So với lượt đo lúc 05:59 cùng ngày: Q002 chưa kết thúc 64 → 59 và hoàn 755 → 760; Q003 giao 188 →
190, chưa kết thúc 59 → 55, hoàn 220 → 222; Q004 hoàn 5 → 6, chưa kết thúc 48 → 47. **Cột "đã gửi"
của cả năm mã KHÔNG đổi một đơn.** Đúng như thiết kế: đơn đi từ "chưa kết thúc" sang một kết cục,
cohort đứng yên. Đó chính là thứ mốc `carrier_handoff_at` tồn tại để bảo đảm.

### 8.3 Hai nhóm chăm sóc, theo mã hàng

| mã | chờ phát lại | chờ xử lý | active khác | tổng |
|---|---:|---:|---:|---:|
| Q002 | 9 | 16 | 34 | 59 |
| Q003 | 8 | 9 | 38 | 55 |
| Q004 | 1 | 5 | 41 | 47 |

Cộng lại 161 — khớp đúng ô `dang_giao` của ảnh chụp KPI. Đây là hai nhóm mà bảng gọi tên ngay trên
cột "Chưa kết thúc", và là hai nhóm duy nhất người trực can thiệp được.

### 8.4 Độ phủ dữ liệu trên production

* **Quy kết marketer**: 1.321 / 2.580 = **51,2 %** — *giống hệt* lượt đo trước deploy (1.258 không
  nối được chiến dịch · 1 chiến dịch chưa khai người · 0 nhập nhằng). Dưới ngưỡng 70 %, nên bảng
  marketer luôn kèm cảnh báo.
* **Lý do hoàn**: **727 / 1.026 = 70,9 %** ca hoàn có ít nhất một sự kiện ĐVVC mang chữ nêu lý do.
  Cao hơn nhiều con số "~22 %" ghi trong tài liệu cũ — vì bậc suy từ CHỮ đọc `shipment_events` chứ
  không chỉ đọc trạng thái cuối của vận đơn.
* **Mã hàng**: 6 mã có `custom_id`, mọi đơn trong bảng đều lần được về mã.

### 8.5 Chưa đặt đích — và màn hình nói đúng như vậy

```sql
select … from metric_targets where metric_key in ('delivery_success_rate','return_rate');
(0 rows)
```

**Chưa có đích nào cho chỉ số GTC.** Nên trên production, cột "Đánh giá" của bảng rủi ro hiện
**"Chưa đặt đích"** cho mọi mã, bảng in THỰC TẾ và KHÔNG kết luận mã nào đạt hay không đạt — đúng
AGENTS.md mục 38. Khối "Cần chú ý" có một dòng `INFO` nói thẳng việc còn thiếu và đường đi tới chỗ
đặt đích.

**Việc này cần chủ shop quyết**, không phải việc của máy: đặt bao nhiêu phần trăm là đạt, bao nhiêu
là nghiêm trọng. Đặt ở *Mục tiêu → Đích chỉ số*.

### 8.6 Mọi màn hình còn sống

`ops smoke` (mở thật bằng phiên đăng nhập hợp lệ): **51/51 đạt · 0 lỗi ứng dụng · 0 sai quyền ·
0 chậm**. `/reports/returns` 485 kB / 359 ms · `/reports` 295 kB / 102 ms · `/shipments` 1.266 kB /
69 ms · `/shipments?bucket=CARE_TODAY` 98 ms.
