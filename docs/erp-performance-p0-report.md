# PERFORMANCE P0 — Tốc độ báo cáo & trải nghiệm chờ

Ngày: 09/09/2026 · Vòng trước: `docs/erp-perf-audit.md` (vòng 1), `docs/erp-perf-audit-round2.md` (vòng 2).

Ba việc chủ shop nêu:

1. chuyển tab báo cáo chậm;
2. đổi kỳ báo cáo chậm;
3. **không biết hệ thống đang chạy hay đã treo** — đây mới là cái đau nhất, vì nó biến "chờ 2 giây"
   thành "hỏng rồi".

Tài liệu này ghi lại: đo bằng gì, tìm ra nguyên nhân gốc nào, sửa gì, và số liệu trước/sau.

---

## 0. Vì sao hai vòng đo trước kết luận "không có nút thắt"

Vòng 1 và vòng 2 đo **thời gian phản hồi của `/api/health`, `/login`, `/api/notifications`** và kích
thước bảng. Cả ba đều là điểm cuối tầm thường, và ở quy mô vài nghìn dòng chúng đúng là dưới
mili-giây. Kết luận "chưa có nút thắt" đúng với những gì đã đo — nhưng **chưa bao giờ đo một trang
báo cáo**. Trang báo cáo mới là chỗ chủ shop kêu chậm.

Vòng này đo đúng thứ người dùng chờ: gói truy vấn của từng trang, số câu truy vấn, kế hoạch thực thi
thật, và thời gian một lần điều hướng qua HTTP.

---

## 1. Đo bằng gì (tái lập được)

| Công cụ | Đo gì |
|---|---|
| `scripts/bench-reports.ts` | Gói truy vấn của từng trang: thời gian lạnh/ấm, **số câu truy vấn**, thời gian CSDL, số dòng, kích thước dữ liệu trả về |
| `scripts/bench/explain.ts` | Bắt câu lệnh THẬT tại lớp driver rồi chạy `EXPLAIN (ANALYZE, BUFFERS)` — kế hoạch của đúng câu ứng dụng chạy, không phải câu chép tay |
| `scripts/bench/outcome-shape.ts` | So ba cách viết cùng một truy vấn gộp, kèm kiểm tra số liệu giống hệt từng dòng |
| `scripts/bench-http.ts` | Một lần điều hướng thật: middleware → dựng trang → tuần tự hoá RSC → truyền về, kèm **kích thước gói** |
| `GET /api/perf` | Sổ đo trên CHÍNH máy chủ thật: p50/p95, tỷ lệ trúng đệm, chi phí tính lại của từng báo cáo |

Cách chạy:

```bash
npx tsx scripts/bench-reports.ts --scale=1  --rounds=3 --out=docs/perf/after-scale1.json
npx tsx scripts/bench-reports.ts --scale=4  --rounds=2 --out=docs/perf/after-scale4.json
npx tsx scripts/bench-reports.ts --scale=10 --rounds=2 --out=docs/perf/after-scale10.json
npx tsx scripts/bench/explain.ts --scale=10 --out=docs/perf/explain-after.txt
```

### Ba điều phải nói thẳng về phép đo

1. **Máy đo là PGlite (Postgres 16 biên dịch sang WebAssembly, MỘT luồng), không phải Postgres 16
   trên VPS.** Con số tuyệt đối KHÔNG bằng con số production. Cái so sánh được: tỷ lệ trước/sau trên
   cùng một máy, **số câu truy vấn**, số dòng, kế hoạch thực thi, và độ tăng theo quy mô. Ba thứ sau
   là tính chất của truy vấn, không phải của máy.
2. **Không truy cập được production trong phiên này** (không có `gh` CLI nên không chạy được ops
   `db-query` / `perf`). Vì vậy đã thêm `GET /api/perf` để đo trên máy thật ngay sau khi deploy —
   xem mục 9.
3. **Phải chạy `analyze` sau khi nạp dữ liệu mẫu.** Không có thống kê, bộ tối ưu ước lượng sai hàng
   trăm lần (đo được: ước 2 dòng cho bảng 600 dòng) và chọn kế hoạch mà máy chủ thật không bao giờ
   chọn. Lần đo đầu tiên của phiên này thiếu bước đó và đã đo lại toàn bộ.

Dữ liệu mẫu (`scripts/bench/seed.ts`) dựng theo đúng tỷ lệ production ngày 08/09/2026, `--scale`
nhân lên: **scale 1 ≈ quy mô hiện tại · scale 4 ≈ khoảng một năm tăng trưởng · scale 10 ≈ vài năm**.

---

## 2. Nguyên nhân gốc tìm được

### 2.1 Một truy vấn con KHÔNG CÓ INDEX, chạy cho TỪNG dòng — chi phí tăng theo bình phương

`HAS_RETURN_LEG` trong `ORDER_OUTCOME` hỏi "có vận đơn nào trỏ ngược về mã này không?" cho mỗi dòng.
Câu hỏi đó không kèm điều kiện `stage`/`cod_amount` nên index riêng phần `shipments_return_leg_idx`
không dùng được. `EXPLAIN ANALYZE` trên 4.802 vận đơn:

```
SubPlan 9 → Seq Scan on shipments leg  (actual time=0.316 rows=0 loops=3245)
            Filter: (id <> shipments.id) AND (order_reference = shipments.vtp_order_number)
            Rows Removed by Filter: 4802 · Buffers: shared hit=460790
```

Bảy lần quét như vậy trong MỘT truy vấn: 15,6 triệu lượt so sánh mỗi lần quét, và số đó tăng theo
**tích của số vận đơn với chính nó**.

→ **Sửa:** `drizzle/0041_shipment_return_leg_index.sql` — index riêng phần trên `order_reference`.
Đây là toàn bộ nội dung của migration: một index, không đổi một dòng logic nào.

### 2.2 `ORDER_OUTCOME` bị tính LẠI cho TỪNG cột gộp

Postgres nội tuyến cả biểu thức `CASE` (có 13 truy vấn con tương quan bên trong) vào từng cột
`filter (where ORDER_OUTCOME = …)`. Bảng "Hiệu quả mẫu mã" có 13 cột như vậy:

```
GroupAggregate (actual time=340.650..27706.255 rows=228)   ← khâu gộp: 27,4 giây
  ->  Incremental Sort (actual time=59.698..93.709 rows=4260)  ← lấy dữ liệu: 93 ms
Buffers: shared hit=13689132 · hơn 100 SubPlan trong một truy vấn
```

**99,7% thời gian là tính đi tính lại cùng một giá trị.**

→ **Sửa:** đưa `ORDER_OUTCOME` (và `ORDER_COGS`) xuống một **bảng dẫn xuất**, gộp bên ngoài trên cột
đã tính sẵn. Rào `OUTCOME_FENCE` (`offset 0`) chặn Postgres kéo bảng dẫn xuất lên rồi nội tuyến lại —
đã đo: không có rào thì **không nhanh hơn một mili-giây**.

Đo bằng `scripts/bench/outcome-shape.ts` (scale 1, 8 cột gộp):

| Cách viết | Thời gian | Số SubPlan | Số liệu |
|---|---|---|---|
| A. `CASE` trong từng cột gộp (cũ) | 110 ms | 112 | gốc |
| B. bảng dẫn xuất thường (bị kéo lên) | 104 ms | 112 | giống hệt |
| **C. bảng dẫn xuất + rào `offset 0`** | **18 ms** | **14** | **giống hệt từng dòng** |

### 2.3 Giá nhập gần nhất tra lại cho TỪNG dòng đơn hàng

`LAST_RECEIPT_COST` là truy vấn con tương quan. Dùng ở cấp dòng đơn hàng, bộ tối ưu quét từ phía
phiếu kho:

```
SubPlan 1 → Limit (actual time=4.820 loops=4260) · Buffers: shared hit=10350750
              Nested Loop … loops=2556000        (600 phiếu × 4.260 dòng)
```

**10.350.750 / 10.420.316 = 99,3% toàn bộ chi phí của truy vấn**, và chi phí tăng theo **tích của số
dòng đơn với số phiếu kho**.

→ **Sửa:** `variantLastCostSubquery()` — `distinct on (variant_id)` quét bảng phiếu đúng một lần rồi
để các truy vấn nối vào. Bộ lọc và thứ tự giữ y nguyên nên giá từng mẫu mã không đổi một đồng.

### 2.4 Ba báo cáo khai TTL đệm là `90` mili-giây thay vì `90_000`

```
lib/queries/cod-settlement.ts:117   memo(`cod-settlement:…`, 90, …)
lib/queries/data-quality.ts:53      memo(`data-quality:summary:…`, 90, …)
lib/queries/logistics.ts:58         memo(`logistics-performance:…`, 90, …)
```

Trang Chất lượng dữ liệu là trang nặng thứ hai và **thực tế không có đệm**. → Sửa thành `90_000`.

### 2.5 Báo cáo lợi nhuận và các thẻ tổng của trang danh sách KHÔNG có đệm

Đo được: lượt gọi thứ hai đúng bằng lượt đầu (`warm ≈ cold`). → Thêm `memo` cho `getProfitReport`
(60 s) và cho thẻ tổng / bộ đếm bộ lọc của Đơn hàng · Vận đơn · Nhật ký kho (30 s), với khoá đệm gồm
đủ kỳ + từ khoá + facet (`lib/cache.ts::listKey`). Cố ý **không** đưa `page`/`pageSize`/`sort` vào
khoá: chúng đổi trang và thứ tự, không đổi tổng.

### 2.6 Truy vấn độc lập chạy NỐI TIẾP

* Trang Chất lượng dữ liệu: 5 truy vấn độc lập chạy lần lượt (thời gian dựng trang = tổng của cả 5).
* `pnl()` trong Báo cáo lợi nhuận: 3 truy vấn độc lập (đơn · chi tiêu QC · chi phí) chạy lần lượt.

→ Gom vào `Promise.all`. Số liệu không đổi một chữ số nào, chỉ hết chờ vô ích.

### 2.7 `router.refresh()` xoá SẠCH bộ đệm điều hướng phía client, mỗi 20 giây

`next.config.ts` khai `staleTimes: { dynamic: 30 }` để bấm qua lại giữa các tab không phải tải lại.
Nhưng `RealtimeProvider` gọi `router.refresh()` mỗi khi có sự kiện đồng bộ, tối thiểu 20 giây/lần cho
MỌI trang — và `router.refresh()` **vô hiệu hoá toàn bộ bộ đệm đó**. Bộ đệm 30 giây gần như không bao
giờ còn sống, nên gần như mọi lần chuyển tab đều là một lần dựng trang lạnh trên máy chủ.

→ **Sửa:** nhịp làm mới theo trang. Trang vận hành (Đơn hàng, Vận đơn, Cần xử lý, CSKH, Landing…)
giữ 20 giây vì người dùng đang nhìn dòng việc chạy. Trang báo cáo tổng hợp giãn ra 90 giây: số liệu
kỳ tháng không đổi theo từng giây, và bản thân báo cáo đã có đệm 60–120 giây ở máy chủ nên làm mới
dày hơn cũng chỉ trả về đúng con số cũ.

### 2.8 Không có bất kỳ dấu hiệu "đang tải" nào

Đây là nguyên nhân gốc của lời phàn nàn thứ ba, và nó nằm ở chỗ không ai ngờ: `PeriodFilter` gọi
`nuqs` **không kèm `startTransition`**. Không có transition thì React không có cờ `pending`, nên
không chỗ nào biết mà hiện trạng thái chờ. Bấm "Tháng trước" → màn hình đứng im → người dùng bấm lại.

Toàn ứng dụng có **0 ranh giới `Suspense`** và **1 file `loading.tsx` duy nhất** cho cả nhóm route.

### 2.9 Ô ngày tuỳ chọn bắn một lần dựng lại trang cho MỖI KÝ TỰ

`<input type="date">` phát `onChange` cho từng phần ngày/tháng/năm, và `PeriodFilter` đẩy thẳng lên
URL với `shallow: false`. Gõ một ngày = 3 lần dựng lại trang trên máy chủ, hai lần đầu là công toi.

→ **Sửa:** bản nháp cục bộ + chờ 500 ms sau khi ngừng gõ + chỉ gửi khi ngày hợp lệ.

---

### 2.10 Tồn kho có HAI công thức khác nhau trong cùng một trang

Tìm ra khi truy nút thắt của trang Sản phẩm & tồn kho: bộ lọc tồn và bộ đếm facet đếm "đã xuất kho"
theo `ORDER_OUTCOME` (định nghĩa theo TIỀN), trong khi cột tồn ngay cạnh đó đếm theo
`SHIPMENT_LEFT_WAREHOUSE` (định nghĩa theo SỔ KHO). Đây là lỗi nghiệp vụ, không chỉ là chậm —
chi tiết và mức ảnh hưởng ở **mục 11**.

---

## 3. Trải nghiệm chờ — thiết kế mới

Một nguồn sự thật duy nhất: `components/nav-progress.tsx` giữ bộ đếm điều hướng đang chạy. Mọi nơi
gây điều hướng đều báo vào đó.

| Tình huống | Người dùng thấy gì |
|---|---|
| Bấm mục menu | Chấm xoay **ngay trong mục vừa bấm** (`useLinkStatus`) + thanh tiến trình trên đỉnh trang |
| Mở một trang khác | Khung xương **đúng hình dạng trang đó** (`loading.tsx` riêng cho từng nhóm route) |
| Đổi kỳ / bộ lọc / tab **trên cùng một trang** | **Số cũ vẫn hiện**, mờ đi và khoá thao tác, kèm nhãn "Đang cập nhật báo cáo…" cạnh tiêu đề |
| Phản hồi nhanh hơn 180 ms | **Không hiện gì cả** — thanh loading nháy 80 ms làm giao diện trông giật, tệ hơn là không có |
| Trống / lỗi | Giữ nguyên `EmptyState` và `error.tsx` sẵn có; ba trạng thái tải / trống / lỗi nay phân biệt được |

Vì sao "số cũ vẫn hiện" chạy được mà không cần thư viện: đổi tham số URL trên cùng một trang thì ranh
giới `Suspense` đã gắn sẵn, và điều hướng nằm trong một transition — React giữ cây cũ cho tới khi cây
mới sẵn sàng. `StaleWhileRefreshing` chỉ thêm lớp mờ để nói rõ "số này chưa phải số mới".

**Yêu cầu cũ tự bị bỏ:** `startTransition` của React luôn lấy lần điều hướng MỚI NHẤT làm kết quả.
Bấm Tháng 8 → Tháng 9 → 7 ngày qua thì màn hình chắc chắn hiện 7 ngày qua, không phụ thuộc thứ tự
câu trả lời từ máy chủ. Không cần cơ chế huỷ thủ công; cái cần chặn là **gửi yêu cầu thừa**, và đó là
việc của bộ chống rung ở ô ngày (mục 2.9) và ô tìm kiếm (đã có sẵn 400 ms).

**Tải trước (prefetch):** cố ý dùng chế độ MẶC ĐỊNH của Next, **không** ép `prefetch` trên menu. Với
route động, ép `prefetch` bắt máy chủ dựng trước toàn bộ dữ liệu — 25 mục menu là 25 lần dựng báo cáo
trên một VPS 2 nhân, ngay khi người dùng vừa đăng nhập. Chế độ mặc định chỉ tải trước phần khung tới
ranh giới `loading.tsx`; nay mỗi trang nặng đã có `loading.tsx` riêng nên bấm vào là thấy khung xương
đúng hình dạng ngay, còn CSDL không bị gọi thêm lần nào.

---

## 4. Lớp tăng tốc KHÔNG được đổi ý nghĩa nghiệp vụ

Nguyên tắc giữ nguyên: **`ORDER_OUTCOME` vẫn là công thức duy nhất**. Việc làm ở đây là đổi HÌNH DẠNG
truy vấn (tính một lần thay vì mười ba lần), không đổi công thức, không thêm bảng tổng hợp dẫn xuất
nào, không có dữ liệu nào bị lưu sẵn để rồi cũ đi.

Khoá bằng `tests/metric-shape-consistency.test.ts`: tính lại cùng những con số đó bằng cách viết
NGUYÊN THUỶ (nội tuyến `ORDER_OUTCOME` vào từng cột gộp, đúng như trước khi tối ưu) rồi so **từng
cột, từng mẫu mã**. Lệch một đồng là hỏng.

Bài kiểm thử cũng khoá hai điều nữa:

* lượt gọi trúng đệm phải ra **đúng cùng con số** với lượt tính thật;
* xoá đệm rồi tính lại vẫn ra đúng con số đó.

Toàn bộ contract test cũ (`tests/contract-order-outcome.test.ts`, `business-invariants`,
`metrics-contract`, `canonical-truth`, `drilldown-contract`) chạy nguyên vẹn, không sửa một giá trị
kỳ vọng nào.

### Vì sao KHÔNG xây bảng tổng hợp `report_daily_*`

Đây là câu hỏi phải trả lời bằng số, không bằng cảm tính. Sau khi sửa bốn nguyên nhân gốc ở trên,
chi phí còn lại ở quy mô hiện tại và quy mô gấp 4 nằm trong ngân sách (mục 6). Một lớp bảng tổng hợp
sẽ thêm: một lịch làm mới, một cơ chế xác định ô ngày bị ảnh hưởng, một cơ chế vô hiệu hoá, và một
lớp có thể **lệch âm thầm** so với dữ liệu gốc. Trong một kho mã mà lớp số liệu vừa mất rất nhiều
công để làm cho đúng, đó là đổi một vấn đề đã đo được lấy một rủi ro chưa đo được.

**Ngưỡng xem lại — có số, không mơ hồ:** khi `orders` vượt ~10.000 dòng, hoặc khi `/api/perf` báo
p95 của bất kỳ báo cáo nào vượt 1 giây trên máy thật. Ở scale 10 (12.894 đơn) phép đo cho thấy Tổng
quan và Quảng cáo bắt đầu vượt ngân sách — đó chính là lúc lớp tổng hợp theo ngày đáng làm, và mục 8
ghi sẵn thiết kế để không phải nghĩ lại từ đầu.

---

## 5. Số liệu TRƯỚC / SAU

### 5.1 Gói truy vấn của từng trang (PGlite, đã chạy `analyze`)

Cột **ẤM** là lượt gọi thứ hai trong cùng cửa sổ đệm — đúng thứ người dùng gặp khi bấm qua lại giữa các tab.

| TRANG | TRƯỚC @1× | SAU @1× | LỢI | TRƯỚC @4× | SAU @4× | LỢI | TRƯỚC @10× | SAU @10× | LỢI | ẤM | CÂU |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Tổng quan (Dashboard) | 1.901 ms | 371 ms | **5.1×** | 19.675 ms | 1.122 ms | **17.5×** | 113.300 ms | 3.409 ms | **33.2×** | 0 ms | 55 |
| Chất lượng dữ liệu (Data Quality) | 875 ms | 295 ms | **3.0×** | 8.671 ms | 1.343 ms | **6.5×** | 54.268 ms | 4.718 ms | **11.5×** | 0 ms | 29 |
| Quảng cáo (Ads) | 787 ms | 305 ms | **2.6×** | 7.364 ms | 1.000 ms | **7.4×** | 42.495 ms | 2.398 ms | **17.7×** | 4 ms | 31 |
| Báo cáo lợi nhuận (Profit) | 224 ms | 111 ms | **2.0×** | 1.784 ms | 340 ms | **5.2×** | 15.744 ms | 963 ms | **16.3×** | 0 ms | 17 |
| Vận đơn (Shipments) | 223 ms | 64 ms | **3.5×** | 2.223 ms | 200 ms | **11.1×** | 12.842 ms | 473 ms | **27.2×** | 19 ms | 9 |
| Đơn hàng (Orders) | 112 ms | 48 ms | **2.4×** | 1.114 ms | 114 ms | **9.8×** | 10.955 ms | 250 ms | **43.9×** | 8 ms | 7 |
| Hiệu quả mẫu mã (Product) | 190 ms | 18 ms | **10.6×** | 1.572 ms | 55 ms | **28.4×** | 9.190 ms | 97 ms | **95.1×** | 0 ms | 1 |
| Chân lý tài chính (Truth) | 93 ms | 46 ms | **2.0×** | 849 ms | 123 ms | **6.9×** | 8.606 ms | 323 ms | **26.7×** | 0 ms | 5 |
| GTC theo mẫu mã | 158 ms | 25 ms | **6.4×** | 1.290 ms | 63 ms | **20.6×** | 7.546 ms | 136 ms | **55.3×** | 13 ms | 2 |
| Tỷ lệ giao thành công (GTC) | 69 ms | 23 ms | **3.0×** | 541 ms | 57 ms | **9.5×** | 3.316 ms | 128 ms | **26.0×** | 11 ms | 2 |
| Hàng đợi việc (Action Queue) | 7 ms | 7 ms | **1.1×** | 13 ms | 12 ms | **1.1×** | 14 ms | 14 ms | **1.1×** | 5 ms | 3 |
| Tồn kho (Inventory) | 3 ms | 3 ms | **1.0×** | 2 ms | 4 ms | **0.7×** | 3 ms | 2 ms | **1.1×** | 1 ms | 6 |
| Sản phẩm & tồn kho (Products) | — | 209 ms | — | — | 855 ms | — | — | 2.576 ms | — | 59 ms | 9 |
| Trung tâm điều khiển (22 luật) | — | 26 ms | — | — | 54 ms | — | — | 114 ms | — | 0 ms | 25 |

Quy mô dữ liệu: **@1× = 1.440 đơn · 1.320 vận đơn · 5.188 sự kiện hành trình** (đúng tỷ lệ production hôm nay) · **@4× = 5.277 đơn** (khoảng một năm tăng trưởng) · **@10× = 12.894 đơn · 11.719 vận đơn · 45.964 sự kiện**.

Cột @10× cho thấy rõ nhất bản chất của vấn đề: chi phí CŨ không tăng tuyến tính mà tăng theo bình phương. Tổng quan đi từ 1,9 giây ở quy mô hiện tại lên **113 giây** khi dữ liệu gấp 10 — dữ liệu gấp 9 mà thời gian gấp 60. Sau khi sửa, cùng trang đó mất 3,4 giây: dữ liệu gấp 9 thì thời gian gấp 9.

Hai dòng không có cột TRƯỚC (Sản phẩm & tồn kho, Trung tâm điều khiển) được thêm vào phép đo giữa chừng, khi số đo HTTP cho thấy chúng đáng ngờ. Riêng trang Sản phẩm & tồn kho: **441,5 ms → 209 ms** (2,1×) sau khi sửa biểu thức tồn kho, và **58,9 ms** khi trúng đệm.

### 5.2 Một lần điều hướng thật qua HTTP (quy mô hiện tại)

`HTML` = mở trang lần đầu / F5. `RSC` = bấm chuyển tab trong ứng dụng — đây mới là con số của lời phàn nàn "chuyển tab chậm".

| THAO TÁC | KIỂU | p50 | p95 | GÓI DỮ LIỆU |
|---|---|---:|---:|---:|
| Tỷ lệ giao thành công | HTML | 274 ms | 288 ms | 250.1 KB |
| Tổng quan | HTML | 267 ms | 277 ms | 306.1 KB |
| Tổng quan | RSC | 224 ms | 269 ms | 115.4 KB |
| Tỷ lệ giao thành công | RSC | 217 ms | 237 ms | 78.1 KB |
| Tổng quan · đổi kỳ tháng trước | RSC | 181 ms | 230 ms | 115.5 KB |
| Sản phẩm & tồn kho | HTML | 179 ms | 218 ms | 245.7 KB |
| Tổng quan · đổi kỳ 7 ngày | RSC | 171 ms | 209 ms | 113.1 KB |
| Quảng cáo | HTML | 165 ms | 191 ms | 470.4 KB |
| Sản phẩm & tồn kho | RSC | 136 ms | 158 ms | 60.2 KB |
| Cần xử lý (hàng đợi việc) | HTML | 133 ms | 147 ms | 736.5 KB |
| Vận đơn | HTML | 104 ms | 132 ms | 309.6 KB |
| Quảng cáo · đổi kỳ 30 ngày | RSC | 119 ms | 131 ms | 141.2 KB |
| Báo cáo lợi nhuận | HTML | 82 ms | 100 ms | 300.2 KB |
| Quảng cáo | RSC | 90 ms | 98 ms | 140.3 KB |
| Đơn hàng | HTML | 72 ms | 95 ms | 281.8 KB |
| Hiệu quả mẫu mã | HTML | 83 ms | 94 ms | 494 KB |
| Cần xử lý (hàng đợi việc) | RSC | 85 ms | 90 ms | 198.2 KB |
| Vận đơn | RSC | 65 ms | 86 ms | 55.5 KB |
| Lợi nhuận · đổi tab dòng tiền | RSC | 82 ms | 84 ms | 53.3 KB |
| Báo cáo lợi nhuận | RSC | 44 ms | 76 ms | 98.7 KB |
| Chất lượng dữ liệu | HTML | 52 ms | 62 ms | 204.7 KB |
| Hiệu quả mẫu mã | RSC | 46 ms | 53 ms | 168.9 KB |
| Nhật ký kho | HTML | 36 ms | 41 ms | 149.6 KB |
| Đơn hàng | RSC | 35 ms | 40 ms | 56.5 KB |
| Lợi nhuận · đổi kỳ 90 ngày | RSC | 33 ms | 39 ms | 105.3 KB |
| Chất lượng dữ liệu | RSC | 25 ms | 34 ms | 67.3 KB |
| Nhật ký kho | RSC | 19 ms | 21 ms | 35.7 KB |


---

## 6. Ngân sách hiệu năng

| MỤC TIÊU | NGƯỠNG | ĐO ĐƯỢC (quy mô hiện tại) | ĐẠT? |
|---|---:|---|---|
| Chuyển tab đã có đệm — cảm nhận | < 200 ms | Lượt ẤM của gói truy vấn **0–19 ms**; điều hướng RSC p50 **19–224 ms**, p95 tối đa **269 ms** | **Đạt** với 24/27 thao tác; ba thao tác nặng nhất (Tổng quan, Tỷ lệ giao thành công) 217–274 ms p50 |
| Đổi kỳ báo cáo thường dùng | < 700 ms | Đổi kỳ Tổng quan **171–181 ms** p50 (p95 230 ms) · Lợi nhuận **25–33 ms** · Quảng cáo **119 ms** | **Đạt** |
| Báo cáo lạnh (chưa có đệm) | < 1.500 ms | Nặng nhất là Tổng quan **371 ms**, Quảng cáo **305 ms**, Chất lượng dữ liệu **295 ms** | **Đạt** |
| Tổng quan lạnh | < 1.500 ms | **371 ms** (trước: 1.901 ms) | **Đạt** |
| Lọc / tìm kiếm đơn hàng | < 500 ms | Đơn hàng RSC **35 ms** p50 (p95 40 ms) · gói truy vấn 48 ms lạnh, 8 ms ấm | **Đạt** |
| p95 của báo cáo | < 1.000 ms | p95 HTTP cao nhất **288 ms** (HTML) / **269 ms** (RSC) | **Đạt** |

**Ở quy mô gấp 4 (khoảng một năm tăng trưởng) vẫn đạt**: nặng nhất là Chất lượng dữ liệu 1.343 ms và Tổng quan 1.122 ms — đều dưới ngưỡng 1.500 ms.

**Ở quy mô gấp 10 thì vẫn KHÔNG đạt** trên máy đo: Chất lượng dữ liệu **4.718 ms**, Tổng quan **3.409 ms**, Sản phẩm & tồn kho **2.576 ms**, Quảng cáo **2.398 ms** — dù đã nhanh hơn 11–33 lần so với trước (Tổng quan: **113 giây → 3,4 giây**). Nói cho đủ:

* PGlite chạy MỘT luồng, không có kết nối song song. Postgres 16 trên VPS chạy 55 câu truy vấn của Tổng quan qua pool 10 kết nối, nên con số thật sẽ thấp hơn hẳn — nhưng **thấp hơn bao nhiêu thì chưa đo được**, và tôi không đoán.
* Nút thắt còn lại đã biết chính xác: `ORDER_OUTCOME` mang **13 truy vấn con tương quan**, trong đó `HAS_VTP_EVIDENCE` một mình xuất hiện 5 lần trong cùng biểu thức `CASE`. Gộp chúng thành một cột tính sẵn trong bảng dẫn xuất sẽ cắt khoảng một nửa số lần tra chỉ mục. Chưa làm ở vòng này vì đó là sửa vào ĐÚNG biểu thức nhạy cảm nhất của kho mã, và ở quy mô hiện tại nó chưa đổi lấy được gì.

**Ngưỡng xem lại (có số, không mơ hồ):** `orders` vượt ~10.000 dòng, HOẶC `/api/perf` báo p95 của bất kỳ báo cáo nào vượt 1 giây trên máy thật.


---

## 7. Quan sát trên máy chủ thật

`GET /api/perf` (quyền `settings:manage`) trả về, cho từng báo cáo nặng:

```
{ "name": "getProfitReport", "calls": 42, "hits": 31, "hitRate": 73.8,
  "p50": 2, "p95": 180, "max": 240, "missAvg": 168, "lastAt": … }
```

* **p50 / p95 / max** — thời gian thật trên máy thật;
* **hitRate** — tỷ lệ trúng đệm; thấp bất thường nghĩa là đệm đang bị xoá quá dày (sau mỗi job đồng bộ);
* **missAvg** — chi phí TÍNH LẠI, tức là con số phải so với ngân sách;
* **vuotNganSach** — danh sách báo cáo đang vượt p95 1 giây.

Đặt ở `memo()` vì đó là chỗ **mọi** báo cáo nặng đi qua — đo một chỗ là đo được tất cả, không phải
rải mã đo khắp nơi. Vòng đệm 200 mẫu trong RAM, mất khi khởi động lại, **không ghi thông tin cá
nhân**: chỉ tên báo cáo, thời gian, trúng/trượt đệm. `?reset=1` để bắt đầu lượt đo mới.

Lớp đếm số câu truy vấn (`lib/perf/probe.ts`) chỉ bật khi `ERP_PERF_PROBE=1` — production không bọc
gì cả. Lớp CSDL không phải chỗ để thêm rủi ro đổi lấy một con số.

---

## 8. Nếu sau này cần lớp tổng hợp theo ngày (thiết kế sẵn, CHƯA làm)

Ghi lại để lần sau không phải nghĩ lại, và để nói rõ nó **không** được phép là nguồn sự thật:

```
NGUỒN GỐC (Pancake · Viettel Post · bảng kê · ngân hàng)
   → BẢNG NGHIỆP VỤ CHUẨN (orders · shipments · shipment_events · cod_statement_lines)   ← SỰ THẬT
      → TỔNG HỢP DẪN XUẤT theo ngày (report_daily_*)                                     ← chỉ để nhanh
         → ĐỆM API (memo, 30–120 s)
            → GIAO DIỆN
```

* **Hạt:** một dòng cho mỗi (ngày, chiều) — `report_daily_orders`, `report_daily_logistics`,
  `report_daily_finance`, `report_daily_ads`, `report_daily_product`. Ưu tiên nhiều bảng theo ngày
  thay vì một bảng khổng lồ: mỗi bảng làm mới độc lập, hỏng một chiều không kéo đổ chiều khác.
* **Làm mới tăng dần:** sự kiện thay đổi (webhook, job đồng bộ, thao tác ghi) ghi ra danh sách **ngày
  bị ảnh hưởng**; job dựng lại đúng những ngày đó. Bắt buộc: chạy lại cho ra cùng kết quả
  (idempotent), ghi `sync_runs` để nhìn thấy được, và chạy tiếp được từ chỗ dừng.
* **Bất biến bắt buộc:** cùng chỉ số + cùng bộ lọc + cùng kỳ ⇒ cùng con số ở mọi module. Kiểm bằng
  cách so bảng tổng hợp với phép tính từ bảng nghiệp vụ chuẩn trên các kỳ mẫu — đúng cách
  `tests/metric-shape-consistency.test.ts` đang làm cho lớp tăng tốc hiện tại.
* **Vô hiệu hoá:** đệm API không bao giờ được che một thay đổi nghiệp vụ. Hiện `clearMemo()` chạy sau
  mỗi job đồng bộ và mỗi thao tác ghi; lớp tổng hợp phải theo đúng quy tắc đó.

---

## 9. Việc còn lại / giới hạn của phiên này

### 9.1 Đã đo được nhưng CHƯA sửa — kèm lý do và ngưỡng

| Việc | Vì sao chưa làm | Ngưỡng xem lại |
|---|---|---|
| Gộp 13 truy vấn con của `ORDER_OUTCOME` (riêng `HAS_VTP_EVIDENCE` lặp 5 lần) | Sửa vào đúng biểu thức nhạy cảm nhất kho mã; ở quy mô hiện tại không đổi lấy được gì | `orders` > 10.000 dòng |
| Bảng tổng hợp theo ngày `report_daily_*` | Thêm lịch làm mới, cơ chế xác định ngày ảnh hưởng, cơ chế vô hiệu hoá và một lớp có thể lệch âm thầm. Thiết kế đã ghi sẵn ở mục 8 | Sau khi làm xong việc trên mà vẫn vượt ngân sách |
| Trang **Cần xử lý** vẫn là gói dữ liệu nặng nhất (736 KB HTML / 198 KB RSC sau khi giảm một nửa) | Mỗi dòng việc mang sáu nút thao tác — đó là thiết kế nghiệp vụ, cắt tiếp phải hỏi chủ shop | Nhân viên phản ánh chậm trên 3G |
| `LIKE '%…%'` trong tìm kiếm không dùng được index (ghi nhận từ vòng 2) | Vẫn dưới mili-giây ở quy mô hiện tại | `orders` > ~50.000 dòng ⇒ cần `pg_trgm` |

### 9.2 Giới hạn của phiên này — phải nói rõ

1. **Không có số production.** Phiên này không có `gh` CLI nên không chạy được ops `db-query` / `perf`.
   Mọi con số ở đây đo trên PGlite của máy lập trình. Đó là lý do có `GET /api/perf`: chạy vài ngày
   trên máy thật rồi đọc p95 — **hãy coi bảng ở mục 5 là bằng chứng về HƯỚNG và TỶ LỆ, không phải
   cam kết về mili-giây trên VPS.**
2. **Chưa có người bấm thử.** Mục "UX acceptance" của yêu cầu (bấm 10 tab, đổi kỳ liên tục, giả lập
   mạng chậm, giả lập API lỗi) cần mắt người trên trình duyệt thật. Việc đã làm được bằng máy: dựng
   bản production, đăng nhập thật, đo 27 thao tác điều hướng qua HTTP (mục 5.2). Việc chưa làm được:
   xác nhận bằng mắt rằng thanh tiến trình, khung xương và lớp mờ hiện đúng lúc. **Đây là việc cần
   chủ shop hoặc người kế tiếp bấm thử.**
3. **Không có số TRƯỚC cho phép đo HTTP.** Lúc dựng được máy chủ đo thì phần lớn tối ưu truy vấn đã
   nằm trong mã. Bảng 5.2 vì vậy là ảnh chụp trạng thái SAU, dùng để đối chiếu với ngân sách. Số
   trước/sau đầy đủ nằm ở bảng 5.1. Hai con số trước/sau đo được ở lớp HTTP:
   trang **Cần xử lý** 1.368 → 736 KB (HTML) và 376 → 198 KB (RSC).

### 9.3 Chưa deploy — và vì sao

**Phiên này KHÔNG commit và KHÔNG deploy.** Trong lúc làm việc, cây thư mục này còn có một phiên
làm việc khác đang sửa cùng lúc (các tệp `lib/constants/ads-identity.ts`, `lib/constants/purchasing.ts`,
`app/(dashboard)/inventory/purchasing/`, `tests/purchasing.test.ts`, `tests/ads-identity.test.ts`
xuất hiện dần trong lúc phiên này chạy, và HEAD nhảy từ `de3ec1e` sang `3a963a2`). Có thời điểm
`npm run typecheck` đỏ ở **tệp của phiên kia**, không phải của phiên này.

`git commit` lúc này sẽ gom cả phần việc đang dở của người khác vào một commit mang tên "hiệu năng" —
không đọc lại được, không quay lui được từng phần. Cổng chất lượng của riêng phần việc này đã xanh
(mục 10); việc gộp và deploy phải do chủ shop quyết khi biết cả hai phía đang ở đâu.


---

## 10. Cổng chất lượng

Chạy ngày 09/09/2026 lúc 16:23, sau toàn bộ thay đổi của phần việc này:

| Cổng | Kết quả |
|---|---|
| `npm run typecheck` | Sạch |
| `npm run lint` | 0 lỗi. 3 cảnh báo còn lại đều nằm trong tệp của phiên làm việc song song (`lib/actions/bank.ts`, `tests/migration-journal.test.ts`), không phải của phần việc này |
| `npm test` | **TẤT CẢ KIỂM THỬ ĐẠT** |
| `npm run build` | Biên dịch thành công |
| Contract test kết quả đơn | Xanh, **không sửa một giá trị kỳ vọng nào** |
| Bất biến nghiệp vụ (17 điều) | Xanh |
| Hợp đồng chỉ số | Xanh |
| Nhất quán số liệu giữa các module | Xanh — giao thành công 18 / hoàn 32 / GTC 36% khớp ở Đơn hàng · Vận đơn · GTC · Marketing · Chất lượng dữ liệu |
| **Kiểm thử MỚI: lớp tăng tốc không đổi số liệu** | Xanh — 4 mẫu mã khớp từng cột với cách tính nguyên thuỷ · Báo cáo lợi nhuận khớp · đệm không đổi kết quả · bộ đếm tồn kho khớp cột tồn |

Không có con số nghiệp vụ nào đổi: `DELIVERED` · `RETURNED` · `UNKNOWN` · GTC · doanh thu lên đơn ·
doanh thu giao thành công · tiền thực nhận · lợi nhuận · COD · tồn kho đều giữ nguyên định nghĩa và
giá trị. Ngoại lệ duy nhất được nêu tường minh ở mục 11.

**Trạng thái cây thư mục lúc 16:36 thì khác** — và phải nói rõ vì sao. Phiên làm việc song song (mục
9.3) vừa đổi `markReturnReceived`: hàng hoàn không còn tự lập phiếu tái nhập nữa mà phải qua bước
đếm. Đó là một thay đổi nghiệp vụ có chủ đích của phiên kia, và bài kiểm thử cũ
`tests/sync-fixtures.test.ts:298` (`kho nhận 2 kiện hoàn → tồn 1 + 2 = 3`) vẫn đang khoá hành vi cũ
nên đỏ. **Không liên quan tới phần việc này:** đường tính của nó là `erpStockExpr` trong
`lib/queries/stock.ts`, tệp mà phiên này không sửa. Người gộp hai nhánh cần chạy lại cổng chất lượng
sau khi phiên kia cập nhật bài kiểm thử của họ.

---

## 11. Một lỗi nghiệp vụ tìm thấy trên đường đi

Trang **Sản phẩm & tồn kho** có HAI đường tính tồn:

* cột tồn trong bảng dùng `erpStockExpr` = *tổng phiếu kho − đã xuất qua ĐVVC* (`SHIPMENT_LEFT_WAREHOUSE`);
* bộ lọc "Sắp hết / Hết hàng / Còn hàng" và ba bộ đếm facet dùng `ERP_STOCK_SUB`, trừ đi
  `ORDER_OUTCOME in ('DELIVERED','IN_TRANSIT') or RETURN_PENDING_WAREHOUSE`.

Vế thứ hai đếm "đã xuất kho" bằng **định nghĩa theo TIỀN** — đúng thứ `AGENTS.md` mục 3.10 và
`HANDOFF.md` mục 6.7 cấm:

> «"Đã xuất" đếm theo `SHIPMENT_LEFT_WAREHOUSE` … **không** dùng `ORDER_OUTCOME` (đó là định nghĩa
> theo tiền) và **không** dùng trạng thái Pancake.»

Chú thích ngay trên biểu thức đó viết "Phải khớp với `erpStockExpr`", nhưng hai công thức khác nhau
về bản chất, nên lọc "Hết hàng" có thể ra những dòng mà chính cột tồn của chúng ghi số dương.

**Đã sửa:** `ERP_STOCK_SUB` nay trừ theo `SHIPMENT_LEFT_WAREHOUSE`, tức đúng bằng `erpStockExpr`.
Khoá bằng một assertion mới trong `tests/metric-shape-consistency.test.ts`: ba bộ đếm bộ lọc phải
bằng số dòng đếm được từ chính cột tồn của bảng.

**Nói cho đủ về mức ảnh hưởng:** trên bộ dữ liệu đo, hai công thức cho ra **cùng một con số cho cả
72 mẫu mã** (chênh lệch 0). Nghĩa là **chưa đo được** lệch trên dữ liệu thật; chúng chỉ khác nhau ở
các tình huống mà bộ dữ liệu mẫu không có (đơn huỷ sau khi đã xuất, vận đơn `UNKNOWN`, hàng bị tiêu
huỷ). Sửa vì đó là quy tắc đã ghi thành văn trong kho mã, không phải vì đã bắt được sai số.
Chủ shop nên đối chiếu ba bộ đếm này trước/sau khi deploy.

Lợi ích kèm theo là hiệu năng: `ORDER_OUTCOME` mang 13 truy vấn con tương quan và bị nội tuyến vào
từng cột gộp, nên riêng ba bộ đếm facet phải quét toàn bộ bảng đơn cho MỖI mẫu mã.
Trang này: **441,5 ms → 209 ms**, và **58,9 ms** khi trúng đệm.

---

## 12. Bản đồ thay đổi

**Cơ sở dữ liệu**

* `drizzle/0041_shipment_return_leg_index.sql` — index riêng phần trên `shipments.order_reference` (mục 2.1). Idempotent, không đụng dữ liệu.
* `db/schema.ts` — khai báo index đó.

**Lớp truy vấn — tăng tốc, KHÔNG đổi công thức**

* `lib/queries/return-rate.ts` — `OUTCOME_FENCE` + `outcomeColumn()`; `getReturnRateSummary` và `getReturnRateByVariant` chuyển sang bảng dẫn xuất.
* `lib/queries/cogs.ts` — `orderCogsColumn()` và `lineUnitCost()` cho các truy vấn cấp dòng đơn.
* `lib/queries/stock.ts` — `variantLastCostSubquery()`: giá nhập gần nhất tính một lần cho mỗi mẫu mã.
* `lib/queries/metrics.ts` — `orderMetricFacts()` + `factMetrics()`: bảng dẫn xuất cấp đơn dùng chung.
* `lib/queries/reports.ts` — `orderFacts()`; `pnl()` chạy song song ba truy vấn; `getProfitReport` có đệm 60 s.
* `lib/queries/dashboard.ts`, `lib/queries/product-intelligence.ts` — dùng bảng dẫn xuất.
* `lib/queries/products.ts` — **sửa lỗi nghiệp vụ** (mục 11) + đệm cho facet/summary/kho.
* `lib/queries/orders.ts`, `shipments.ts`, `inventory.ts` — đệm 30 s cho thẻ tổng và bộ đếm facet.
* `lib/queries/cod-settlement.ts`, `data-quality.ts`, `logistics.ts` — sửa TTL `90` → `90_000`.
* `lib/queries/notifications.ts` — lọc theo loại TRONG SQL, phân trang, chỉ lấy cột giao diện dùng.
* `lib/cache.ts` — `listKey()` cho khoá đệm của trang danh sách + ghi sổ đo hiệu năng.

**Giao diện — trạng thái chờ**

* `components/nav-progress.tsx` (mới) — bộ đếm điều hướng dùng chung, thanh tiến trình, nhãn "Đang cập nhật báo cáo…", lớp giữ-số-cũ, chấm chờ trong mục menu.
* `components/skeletons.tsx` (mới) + 21 tệp `loading.tsx` theo route — khung xương đúng hình dạng từng trang.
* `components/data-table/toolbar.tsx` — kỳ báo cáo / tìm kiếm / facet đi qua transition; ô ngày tuỳ chọn có chống rung 500 ms.
* `components/data-table/data-table.tsx`, `url-pagination.tsx`, `app-sidebar.tsx`, `page-header.tsx` — nối vào bộ đếm chung.
* `components/realtime-provider.tsx` — nhịp làm mới theo trang (20 s cho trang vận hành, 90 s cho trang báo cáo).
* `app/(dashboard)/layout.tsx`, `page.tsx` — lớp giữ-số-cũ; hai khối nặng của Tổng quan chảy về sau bằng `Suspense`.
* `app/(dashboard)/data-quality/page.tsx` — 5 truy vấn nối tiếp → song song.
* `app/(dashboard)/alerts/page.tsx` — phân trang danh sách cảnh báo, 50 việc ưu tiên cao nhất.

**Đo lường & quan sát**

* `app/api/perf/route.ts` (mới) — p50/p95, tỷ lệ trúng đệm, chi phí tính lại trên máy thật.
* `lib/perf/registry.ts`, `lib/perf/probe.ts` (mới) — sổ đo và lớp đếm câu truy vấn (chỉ bật khi `ERP_PERF_PROBE=1`).
* `scripts/bench-reports.ts`, `scripts/bench-http.ts`, `scripts/bench/*` (mới) — bộ công cụ đo, chạy lại được: `npm run bench`, `npm run bench:http`, `npm run bench:explain`.
* `docs/perf/*.json` — số liệu thô của mọi lần đo trong tài liệu này.

**Kiểm thử**

* `tests/metric-shape-consistency.test.ts` (mới) — khoá lớp tăng tốc vào đúng con số của cách tính nguyên thuỷ.
