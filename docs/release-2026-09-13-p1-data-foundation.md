# P1 — NỀN DỮ LIỆU (13/09/2026)

Nhánh `claude/erp-p1-data-foundation`, dựng từ `origin/main` = `77b46e5` (đã chứa bản audit Fable).
**Chưa gộp, chưa deploy.** Sáu commit độc lập, xếp theo thứ tự gộp an toàn ở mục cuối.

Mọi con số trong tài liệu này đo trên **production ngày 13/09/2026** bằng ops `db-query` (chỉ đọc,
phiên đặt `default_transaction_read_only=on`).

---

## 1 · Mốc ĐVVC tiếp nhận kiện (`carrier_handoff_at`)

### Lỗi đã sửa

Luật cũ nhận **mọi** sự kiện `normalized_stage is not null` làm bậc dự phòng. `PENDING` và
`CANCELLED` không phải `NULL`, nên những mã này lọt vào làm mốc bàn giao:

| mã | nghĩa | chặng |
|----|-------|-------|
| 100 | Tiếp nhận đơn hàng | PENDING |
| **102** | **Lấy hàng thất bại** | PENDING |
| 103 / 104 | Điều phối bưu cục / bưu tá đi lấy | PENDING |
| 106 | Đối tác yêu cầu lấy lại hàng | PENDING |
| **101 / 107 / 201** | **VTP huỷ lấy · đối tác huỷ qua API · VTP huỷ đơn** | CANCELLED |

Một kiện bưu tá tới lấy **không thành công**, hoặc shop đã **huỷ lấy**, vẫn được đóng dấu "đã bàn
giao" và đi thẳng vào lô hàng "Đã gửi" của tuần đó.

### Đo trước khi sửa

```
2.108 vận đơn
  2.083 có mốc theo luật cũ
  1.963 có mốc theo luật này
    120 MẤT mốc · 0 được thêm

120 kiện đó đang ở chặng nào:  119 PENDING · 1 CANCELLED
```

Không một kiện nào trong 120 đã rời kho. Không có dương tính giả.

### Giả thuyết ban đầu sai — và số đo đã sửa nó

`shipments.picked_up_at` có hai người ghi, và `pancake/sync.ts` đặt giá trị Pancake **đứng trước**
giá trị đang lưu (`pickedUpAt: s.pickedUpAt ?? existing?.pickedUpAt`). Hướng sửa hiển nhiên là xếp
sự kiện ĐVVC lên trên cột này. Đo thử trước khi làm:

```
1.101 vận đơn có hai giá trị lệch nhau
  1.040 `picked_up_at` SỚM HƠN — và 1.039 trong số đó sớm hơn MỌI sự kiện ĐVVC của
        chính vận đơn. Cả 1.040 đều dựng từ tệp nhập; 956 chưa từng có gói tin webhook.
     61 muộn hơn.
  Độ lệch: trung vị 88,9 giờ · p90 209,9 giờ · lớn nhất 401,3 giờ.
```

Với vận đơn dựng lại từ tệp nhập, lịch sử sự kiện **bắt đầu sau** khi hàng đã được lấy — tệp nhập
là ảnh chụp trạng thái, không phải toàn bộ hành trình. Xếp sự kiện lên trên sẽ đẩy mốc của 1.040
kiện **muộn đi gần bốn ngày**. Đó là một bước lùi, và nó sẽ được đẩy đi dưới cái tên "bản sửa".

Và `picked_up_at` không gắn bừa: **cả 120 kiện chưa có chứng cứ bàn giao đều KHÔNG có cột này.**

### Hợp đồng đang chạy

`lib/constants/carrier-handoff.ts` — **sớm nhất trong các chứng cứ CÓ THẬT**, bằng `least()` chứ
không phải `coalesce()` theo thứ tự bậc:

| nguồn | là gì |
|-------|-------|
| `CARRIER_DOCUMENT` | sự kiện đến thẳng hệ thống VTP: webhook · tệp nhập · tra API |
| `MANUAL_DOCUMENT` | người của shop mở trang VTP, đọc rồi chép lại |
| `PICKUP_SNAPSHOT` | cột `picked_up_at` — mốc lấy hàng của ĐVVC chuyển tiếp qua khâu đồng bộ |

`basis` ghi lại nguồn nào **đạt** mốc sớm nhất, để màn hình nói được vì sao nó tin.

**Không có nguồn thứ tư.** `orders.inserted_at` · `shipments.created_at` · trạng thái Pancake ·
`cod_status` · mọi chứng từ tiền đều cố ý không được dùng.

**So với luật cũ: đổi mốc của 61 vận đơn, bỏ mốc của 120.** Không phải 1.101.

### Tính chất làm cho SQL đọc thẳng `normalized_stage` là đúng

Tập chặng **đóng** dưới phép quy đổi chiều hoàn: `DELIVERED → RETURNED` và
`PICKED_UP/IN_TRANSIT/OUT_FOR_DELIVERY/DELIVERY_FAILED → RETURNING` đều rơi lại vào trong tập. Nhờ
vậy SQL không cần đọc `leg_type` mà vẫn cho cùng câu trả lời với bản TypeScript. Kiểm thử khoá tính
chất này — mất nó thì hai bản lặng lẽ nói hai điều khác nhau.

### Ảnh hưởng cần biết trước khi gộp

`CARRIER_HANDOFF_AT_SQL` là hợp đồng dùng chung, nên bản này cũng đổi số của
`lib/queries/projected-delivery.ts` (**Dự báo GTC**) dù tệp đó **không bị sửa**. Đúng ý đồ — P1.1
yêu cầu áp mốc này cho cả age bucket của GTC — nhưng người gộp bản cần biết để đối chiếu.

**Chưa cần backfill.** Mốc được TÍNH LÚC ĐỌC từ `shipment_events` + `picked_up_at`, không có cột
nào lưu sẵn, nên không có dữ liệu lịch sử nào bị viết lại. Nếu sau này thêm cột vật chất hoá thì
mới cần chạy thử xác định trước.

---

## 2 · Đích chỉ số (`metric_targets`)

Kho mã có **hai** sổ chỉ số: `METRIC_CATALOG` (14 khoá, hiệu suất người/phòng) và `METRIC_BINDINGS`
(14 khoá, chỉ số kinh doanh mà KR và ô BSC nối vào). Bảng `metric_targets` chỉ nhận khoá của sổ thứ
nhất, nên **KR không có đường nào tới một đích có thẩm quyền** — `okr_key_results` tự giữ `target`,
`unit`, `direction` của riêng nó.

`lib/constants/metric-registry.ts` **dẫn xuất** một không gian khoá chung từ hai sổ (28 khoá, không
giao nhau — điều kiện này được kiểm thử, không phải được hy vọng). Không khai thêm chỉ số nào ở đó.

Migration **0077** thêm: `target_max` (dải) · `warning_at` · `critical_at` · `period_kind` ·
`effective_to` · `version` · `owner_department`; và nới `scope` để có `USER`.

* `period_kind = 'ANY'` nghĩa là **chưa khai**, không phải "mỗi tháng". Một đích 500 đơn mà máy tự
  gán cho một tháng sẽ chấm sai gấp bốn khi người ta xem theo tuần — màn hình trông bình thường.
* **Không có bộ ngưỡng mặc định**, và không được thêm (AGENTS.md mục 38).
* `PRODUCT` **cố ý không có**: chưa sổ nào khai một chỉ số đọc được ở mức mã hàng.
* Đích cho **một cá nhân** chỉ được khi chỉ số (1) đọc được ở mức người, (2) không mang cờ `shared`,
  (3) thật sự đo được. Chặn ở **cả** lược đồ đầu vào lẫn server action.

KR nay mang `authoritativeTarget` + `targetConflict`; màn hình hiện nhãn **"lệch sổ đích"**. **Không
tự ghi đè** — đích của một KR đang chạy là cam kết đã thống nhất trong kỳ.

---

## 3 · Thẻ điểm dùng chung

`lib/metrics/scorecard.ts::evaluateMetric()` là đường **duy nhất** biến (giá trị + đích + độ tin
cậy) thành một ô đọc được, trả lời chín câu: chỉ số gì · hiện bao nhiêu · đích bao nhiêu · đạt bao
nhiêu % · lên hay xuống · ai chịu trách nhiệm · kỳ nào · nguồn nào · có đáng tin không.

Nó **không tự đi đo** — công thức từng chỉ số vẫn ở đúng chỗ của nó trong `lib/queries/*`.

Hai cái bẫy được khoá bằng kiểm thử:

* **Phần trăm đạt đích** của chỉ số càng-thấp-càng-tốt phải là `target/value`. Chia `value/target`
  thì 10 lỗi trên đích 5 lỗi ra **200%** — trông như vượt đích gấp đôi trong khi đang tệ gấp đôi.
* **Xu hướng** phải quy theo chiều: tỷ lệ hoàn **tăng** là **xấu đi**.

`canConclude` là cờ một-lần-đọc: sai thì đừng tô màu, đừng xếp hạng, đừng gắn nhãn.

---

## 4 · Định dạng tiền / số / phần trăm

`formatVND(null)` in ra `0 ₫`. `formatNumber(null)` in ra `0`. `formatPercent(null)` in ra `0.0%`.

Tầng truy vấn giữ `NULL` rất kỹ rồi bị xoá sạch ở phân đoạn cuối cùng bởi `Number(value ?? 0)`.

| trạng thái | in ra |
|---|---|
| 0 **thật** (đã đo, kết quả bằng không) | `0 ₫` · `0` · `0.0%` |
| **chưa biết** | `—` |
| **không áp dụng** | `N/A` |

`NaN`, `Infinity` và chuỗi rỗng đi cùng nhánh *chưa biết*.

**Đo bán kính ảnh hưởng trước khi đổi:** 1.039 nơi gọi. Thay vì đọc tay, tạm thu hẹp kiểu tham số
về `number` rồi để `tsc` liệt kê — **đúng 8 nơi** truyền giá trị có thể null, và cả 8 đều mang nghĩa
*chưa biết*. Không nơi nào cần `?? 0`.

---

## 5 · Phân loại chỗ trống (UNKNOWN)

Không phải mọi `UNKNOWN` đều là lỗi. Gộp chúng rồi đi "giảm số UNKNOWN" là cách chắc chắn nhất để
ai đó lấp một chỗ trống bằng phép đoán.

| loại | nghĩa | sửa được? |
|---|---|---|
| `TRUE_UNKNOWN` | không chứng cứ nào tồn tại | **không** — giữ nguyên là câu trả lời đúng |
| `RESOLVABLE` | dữ liệu đã có, chưa ai nối | có (mã nguồn) |
| `STALE` | dữ liệu có, đường ống chưa chạy lại | có (chạy job) |
| `AMBIGUOUS` | nhiều ứng viên, không căn cứ nào chọn được | **không** — người quyết |

`fixable` **suy ra** từ loại, không khai tay.

### Đo production 13/09/2026

| lỗ hổng | trước | sau |
|---|---|---|
| vận đơn chưa có chứng cứ bàn giao | 25 | **142** |
| vận đơn hoàn lần ra nhiều đơn | 0 | 0 |
| dòng tiền chưa phân loại | 0 | 0 |
| dòng hàng chưa ghép mẫu mã | 5 | 5 |
| việc chưa nối tài khoản | 806 CSKH + 119 đợt chăm sóc | không đổi |
| chỉ số đã đặt đích | 0 / 26 | 0 / 26 |

**Con số đầu tiên TĂNG, và đó là đúng hướng.** Luật cũ không *biết* nhiều hơn — nó chỉ *khẳng định*
nhiều hơn. Bản này thôi khẳng định thứ không chứng minh được, nên phần chưa biết hiện ra đúng kích
thước thật. Đó cũng là lý do mục này khai `TRUE_UNKNOWN` chứ không phải `RESOLVABLE`.

Ba con số đáng chú ý cho chủ shop:

* **0/26 chỉ số có đích** ⇒ thẻ điểm và OKR đang hiện số mà *không kết luận được* đạt hay chưa.
  Đúng luật, nhưng cũng nghĩa là chưa chỉ số nào đang lái việc gì.
* **806 case CSKH chưa nối tài khoản** — đúng phần bản 13/09 đã nói: đường ống quy kết đã sẵn sàng,
  thứ còn thiếu là việc được làm trong ERP.
* **0 dòng tiền chưa phân loại** và **0 vận đơn mơ hồ**: hai mục này đang sạch, và mục đích của sổ
  là để biết khi nào chúng thôi sạch.

---

## 6 · Bàn nhận hàng hoàn

Trang gọi hàng đợi mà **không truyền ô tìm**, rồi trình duyệt lọc trên đúng 400 dòng đã tải — phần
lọc phía máy chủ có sẵn trong truy vấn nhưng chưa nơi nào gọi. Bộ đếm in `đang hiện / TỔNG TOÀN BỘ`,
nên tìm một mã cụ thể hiện **"0/612 kiện"**.

Người kho cầm kiện trên tay, gõ mã, đọc "0/612" thành *"kiện này không có trong hệ thống"* — rồi
chọn đại một dòng gần giống, hoặc lập phiếu mới cho một kiện đã có. Không lỗi, không cảnh báo.

Nay ô tìm đi lên máy chủ (nuqs, chờ 400 ms), lọc tại chỗ giữ đúng vai của nó (bắt mã hàng / tên sản
phẩm — hai thứ truy vấn không lọc được), bộ đếm nói đúng thứ nó đang đếm, và thêm cột **ĐVVC báo**
(trạng thái + ngày báo trả về).

---

## 7 · Ghi chú vận hành cho sản phẩm

Ô "Ghi chú" trên trang sản phẩm là cột `products.note` **đồng bộ từ Pancake**: hiện ra và không ai
trong shop viết vào được. Migration **0078** thêm bảng `product_notes` (chỉ thêm), nhóm đóng, quy
kết bằng khoá tài khoản, tên do **máy chủ** đọc từ `users`.

**Không con số nào của ERP đọc bảng này** — kiểm thử quét mã nguồn đã vào kho và chặn mọi nơi ngoài
vùng cho phép. Một ô chữ tự do mà ảnh hưởng tới tồn kho hay giá vốn là đường ngắn nhất để một câu
ghi vội thành một dòng trong báo cáo tài chính.

---

## 8 · Hiệu năng

`explain (analyze, buffers)` trên production, lọc cohort 30 ngày bằng mốc bàn giao mới:

```
Execution Time: 61.753 ms   (Planning 5.405 ms)
Buffers: shared hit=38810   — toàn bộ trúng đệm, 0 lượt đọc đĩa
SubPlan chạy 2.108 lượt, mỗi lượt 0,027 ms
  → Index Scan using shipment_events_uq  (KHÔNG có Seq Scan trên shipment_events)
```

Một truy vấn con tương quan cho mỗi dòng, **đã có chỉ mục phục vụ** — cùng hình dạng với luật cũ,
nên **không cần thêm chỉ mục nào**. Biểu thức cố ý gộp hai con số vào **một** lượt quét bằng
`min(...) filter (where ...)`; viết rời thành hai truy vấn con sẽ nhân đôi số lượt quét cho mỗi dòng
(kho mã này đã gặp đúng kiểu hỏng đó ngày 13/09 — một biểu thức tự nhân bản năm lượt, câu lệnh phình
lên 180 KB).

`getDataQualityIssues()`: mỗi lỗ hổng đúng một truy vấn tổng hợp, mẫu lấy kèm bằng một truy vấn giới
hạn 5 dòng, đệm 90 giây. `latestNotes()` dùng `distinct on` — một lượt quét cho cả trang.

---

## 9 · Thứ tự gộp

Sáu commit độc lập, có thể cherry-pick theo đúng thứ tự này:

| # | commit | phụ thuộc |
|---|--------|-----------|
| 1 | `28afd91` định dạng — chưa biết thôi hiện thành `0 ₫` | không |
| 2 | `50cd91c` mốc bàn giao | không |
| 3 | `f750aec` đích chỉ số + thẻ điểm dùng chung (migration 0077) | không |
| 4 | `db3f1b2` sổ lỗ hổng dữ liệu | **cần 2 và 3** |
| 5 | `135aa6d` bàn nhận hàng hoàn | không |
| 6 | `accc22e` ghi chú vận hành (migration 0078) | không |

Commit 4 đọc `CARRIER_HANDOFF_AT_SQL` (từ 2) và `TARGETABLE_METRICS` (từ 3). Năm commit còn lại độc
lập với nhau.

**Migration: 0077 rồi 0078, đúng thứ tự đó.** Cả hai chỉ cộng thêm, không backfill, không mặc định
nào là một phép đoán về dữ liệu cũ (`metric_targets` rỗng; `product_notes` mới tạo).

`tests/migration-upgrade-path.test.ts` đổi hằng số `MOI` từ một chuỗi thành **danh sách**: một bản
phát hành có thể mang nhiều migration, và ép về một chuỗi sẽ làm bài kiểm gieo dữ liệu thử *sau* khi
migration cần kiểm đã áp — phần backfill của nó không bao giờ được kiểm.

---

## 10 · Việc P1 còn để lại

* **`docs/` chưa có bản đo "sau khi deploy"** — không deploy được từ phiên này theo đúng yêu cầu.
  Sau khi gộp và deploy, chạy lại đúng các truy vấn ở mục 5 để đối chiếu.
* **`/work/performance` chưa chuyển sang `evaluateMetric()`.** Màn hình đó đang tự gọi
  `resolveTarget` + `verdict` + `delta` và tự quyết màu — logic hiện **đúng**, nhưng vẫn là đường
  tính thứ hai. Chuyển nó là một bản refactor giao diện riêng, không trộn vào bản nền dữ liệu này.
* **Chưa có chỉ số nào ở mức MÃ HÀNG**, nên phạm vi đích `PRODUCT` chưa mở. Mở cùng lúc với chỉ số
  đầu tiên đọc được ở mức đó.

---

## 11 · `TASK_9_BLOCKED_BY_SOURCE_ACCESS` — đối soát hàng hoàn từ Google Sheet

**Trạng thái: CHẶN VÌ KHÔNG TRUY CẬP ĐƯỢC NGUỒN. Không chặn bản phát hành này.**

Bằng chứng, đo trong chính phiên làm việc 13/09/2026:

```
curl https://docs.google.com/  →  curl: (56) CONNECT tunnel failed, response 403
```

Chính sách ra mạng của môi trường agent chặn `docs.google.com`. Không có cách nào đọc được bảng
tính, kể cả bản xuất CSV công khai.

**Vì sao dừng chứ không làm tiếp.** Việc này là một phép ÁNH XẠ CỘT: cột nào của bảng tính là mã vận
đơn, cột nào là số lượng thực nhận, cột nào là lý do hoàn, ngày ghi theo múi giờ nào. Không nhìn
thấy bảng thì mọi ánh xạ đều là phỏng đoán — và phỏng đoán ở đây đi thẳng vào TỒN KHO qua phiếu
`RETURN` (luật 10: hàng hoàn chỉ quay lại tồn khi kho lập phiếu với số đếm thực tế). Một cột đọc
nhầm là một lô hàng vào kho bằng số không ai đếm. Viết sẵn một importer "chắc là đúng" rồi để chủ
shop bấm nút là cách hỏng tệ nhất: nó trông như đã xong.

**Cần gì để mở khoá** — một trong hai, không cần cả hai:

1. Chủ shop dán **20 dòng đầu của bảng tính** (kể cả dòng tiêu đề) vào phiên làm việc. Đủ để chốt
   ánh xạ cột và viết bài kiểm bằng dữ liệu thật.
2. Hoặc mở `docs.google.com` cho môi trường agent, rồi đưa **đường dẫn xuất CSV công khai**
   (`.../export?format=csv&gid=...`).

**Hình dạng công việc khi mở khoá** (đã khảo sát, chưa viết mã):

* Kho mã đã có sẵn đường đọc Google Sheet bằng CSV công khai — `lib/constants/landing.ts` dùng đúng
  cách đó, và AGENTS.md §5 chốt "chỉ CSV export công khai, không thêm Google API key". Dùng lại,
  không dựng đường thứ hai.
* Điểm vào là **bàn nhận hàng hoàn** đã có trong bản này (`135aa6d`), không phải một trang mới:
  bảng tính chỉ là một NGUỒN GỢI Ý cho phiếu kiểm, người kho vẫn đếm và vẫn bấm. Nhập thẳng thành
  phiếu `RETURN` là đi vòng qua đúng cái luật 10 dựng ra để chặn.
* Khoá tự nhiên để không nhân đôi khi nhập lại: mã vận đơn + ngày dòng, cùng kiểu `landing_orders.row_key`.
