# Hiệu năng P0.5 — bốn lần chẩn đoán sai, và thứ đã sửa được chúng

Ngày 10/09/2026. Mọi con số đo **trên production**, hệ thống rảnh, không phải lúc deploy.

---

## 1. Triệu chứng

```
[smoke] làm nóng /  → 76.292ms
[smoke] /           → QUÁ HẠN 60 giây
        → nuốt trọn ngân sách 300s, 8 màn hình còn lại KHÔNG kịp kiểm
```

Mọi trang khác: **49–320ms**. Chỉ trang chủ chậm.

## 2. Bốn lần chẩn đoán sai — và tất cả đều do THƯỚC ĐO, không do suy luận

| # | Giả thuyết | Đã làm gì | Kết quả |
| --- | --- | --- | --- |
| 1 | `getControlTower` (tôi vừa sửa hai luật ở đó) | đọc lại mã | **sai** — đo ra 300ms |
| 2 | Lớp tăng tốc P0.3 chỉ nối vào 2/25 tệp | chuyển 21 tệp sang bản nhanh | **không đổi** |
| 3 | `PRIMARY_ATTEMPT` nằm trong điều kiện nối | thêm đường tắt cho đơn một lần gửi | **không đổi** |
| 4 | `RETURN_PENDING_WAREHOUSE` dùng biểu thức sống | chuyển 11 vị trí sang bản nhanh | **không đổi** |

Bốn lần đều sửa **NỘI DUNG** biểu thức. Vấn đề nằm ở **HÌNH DẠNG**.

### Vì sao mất bốn vòng

Thước đo thiếu ba thứ, và mỗi thứ thiếu đều dẫn tới một kết luận sai:

1. **Không đo `getBusinessBrief`** — nó là thành phần ĐẮT NHẤT (46s) mà trang chủ cũng phải chờ.
   Nằm trong Suspense nên HTML đầu ra sớm, nhưng phản hồi HTTP chỉ kết thúc khi nó xong.
2. **Không in phần tách CSDL / ứng dụng** dù đã thu sẵn. Biết "40 giây" mà không biết nó nằm ở
   Postgres hay Node thì chỉ còn cách đoán.
3. **Không in câu lệnh SQL chậm nhất.** "46 giây trong 105 lượt gọi" chưa sửa được gì — phải biết
   lượt NÀO.

Vá cả ba, chạy MỘT lần, và nó chỉ thẳng thủ phạm:

```
39.960ms  select product_variants … received, out_shipped, sold_delivered …
39.284ms  (câu y hệt, chạy LẦN HAI trong cùng một lần mở trang chủ)
          toàn bộ trong Postgres · ứng dụng 0ms · ít lượt gọi
```

> **Bài học ghi lại:** một thước đo bỏ sót thì mọi kết luận rút ra từ nó đều thiếu — và nó thiếu một
> cách tự tin, vì phần bị bỏ sót không hiện ra ở đâu cả. Đầu tư vào thước đo trả lời được câu hỏi
> mình đặt ra rẻ hơn nhiều so với bốn vòng sửa mò.

## 3. Nguyên nhân gốc: bảng dẫn xuất sinh ra để NỐI, không phải để tra từng dòng

`EXPLAIN ANALYZE` (thao tác ops `explain-stock`) trả lời được câu mà bốn vòng trước phải đoán:

```
Seq Scan on orders  (actual time=9053.519..9055.475 rows=2443)
                    Buffers: shared hit=350
```

**350 buffer cho 2.443 dòng** — không phải đọc đĩa. Chín giây đó là biểu thức chạy trên từng dòng.

`ORDER_OUTCOME_FAST` là truy vấn con **tương quan**. Đọc bảng dẫn xuất bằng nó thì Postgres gắn cả
chuỗi dự phòng vào phép quét `orders`, và mỗi dòng phải đi qua chuỗi đó.

Bản thân việc tra bảng thì **rẻ**: `SubPlan 1` chạy 2.380 lượt, mỗi lượt **0,003ms**. Cái đắt là bị
gắn vào từng dòng của một câu gộp trên 2.495 dòng hàng.

### Bản vá

`variantSalesSubquery` nối thẳng `canonical_order_outcome` bằng `LEFT JOIN` — một phép nối băm, tính
một lần cho tất cả. Điều kiện tươi mới (phiên bản luật, `computed_at` so với `updated_at` của đơn và
vận đơn) đặt **ngay trong phép nối**, nên dòng cũ không khớp và `coalesce` rơi về biểu thức chuẩn.

Vẫn đúng luật **"chậm chứ không sai"** — chỉ khác là phần chậm nay chỉ trả cho những dòng thật sự
cũ, thay vì cho cả 2.443 dòng.

## 4. Việc đi kèm, có giá trị riêng

Bốn bản vá "không ăn thua" ở mục 2 **không phải công cốc** — chúng sửa những lỗi thật, chỉ là không
phải lỗi đang gây ra 40 giây:

- **Lớp tăng tốc chỉ nối vào 2/25 tệp.** 21 tệp còn lại vẫn tính lại kết quả đơn mỗi lần. Nay đã nối
  hết, và `tests/fast-path-wiring.test.ts` canh đường tiền nóng.
- **`PRIMARY_ATTEMPT` trong điều kiện nối** vẫn là hình dạng xấu; đường tắt cho đơn một lần gửi giữ
  nguyên tính đúng và bỏ được phần sắp xếp lại cho từng cặp dòng.
- **Miễn trừ quá rộng.** Lá chắn miễn cả tệp `return-rate.ts` vì "đây là nơi định nghĩa" — đúng, nhưng
  cùng tệp còn chứa các vị ngữ dẫn xuất dùng khắp nơi. Đây là lần thứ hai trong hai ngày một danh
  sách miễn trừ che mất lỗi thật; lá chắn nay kiểm riêng từng vị ngữ.

## 5. KẾT QUẢ — và mắt xích thật sự cuối cùng

```
[smoke] 19/25 đạt · 0 lỗi ứng dụng · 0 sai quyền · 1 chậm · 0 QUÁ HẠN
  ✓ /                    99ms      (trước: QUÁ HẠN 60 giây)
  ✓ /orders              97ms
  ✓ /inventory/planning  52ms
  ✓ /ads                 59ms
  ⚠ /customers/retention 2.368ms   ← còn lại, không chặn deploy
```

Sau khi vá xong hình dạng phép nối và bật giữ ấm, trang chủ VẪN quá hạn. Nhật ký cho thấy job giữ
ấm chạy đúng lịch. Mắt xích cuối nằm ở chỗ không ai ngờ:

```
lib/audit.ts   clearMemo()   ← xoá SẠCH đệm sau MỌI thao tác ghi, kể cả ĐĂNG NHẬP
```

Smoke đăng nhập lại trước mỗi màn hình (thêm vào từ trước để tránh hết hạn JWT), nên nó **xoá đệm 25
lần trong một lượt chạy**. Trang chủ luôn rơi vào lượt tính nguội.

Và đó không chỉ là chuyện của smoke: mỗi lần bất kỳ ai đăng nhập, toàn bộ đệm báo cáo của cả hệ
thống bị san phẳng. Đăng nhập không đổi doanh thu, không đổi tồn kho, không đổi lợi nhuận.

### Ba tầng cùng lúc mới đủ

| Tầng | Việc nó làm |
| --- | --- |
| **Đăng nhập thôi xoá đệm** | bỏ LOGIN/LOGOUT khỏi đường làm mới đệm — danh sách cố ý HẸP |
| **Job nền đánh dấu cũ, không xoá hẳn** | `staleMemo()` thay `clearMemo()` khi `runJob` đang chạy; người đọc nhận ngay số lượt trước |
| **Trả số cũ ngay, làm mới phía sau** | `memo()` phục vụ stale-while-revalidate, trần 15 phút |

Cộng thêm `dashboard-warm` mỗi 4 phút để cả lượt nguội đầu tiên cũng do bộ lập lịch trả giá.

**Điểm quan trọng: không tầng nào giấu chi phí thật.** `perf-probe` xoá đệm trước mỗi phép đo nên nó
vẫn báo đúng 33–40 giây cho `getDashboardData`. Cái đổi là AI trả giá đó.

## 6. Còn lại

Cùng hình dạng xấu còn ở các hàm khác, xếp theo chi phí đo được:

| Hàm | Đo được |
| --- | ---: |
| `getFinancialTruth` | 9.926ms |
| `getReturnRateByVariant` | 7.926ms |
| `getReturnRateSummary` | 6.921ms |
| `adsRoas` (30 ngày) | 4.487ms |
| `getOperatingCost` | 3.679ms |

Sửa theo đúng cách của mục 3: nối bảng dẫn xuất thay vì tra từng dòng. **Không** đụng tới định nghĩa
kết quả đơn — chỉ đổi *lúc nào* và *bằng hình dạng nào* nó được đọc.

---

# Phụ lục — sự cố 10/09/2026: sổ kho kéo sập trang chủ

## Diễn biến đo được

| Lúc | `/` | Trang khác |
| --- | --- | --- |
| deploy #196 | 126ms | 19/25 đạt, 0 quá hạn |
| deploy #197–#198 | **QUÁ HẠN 60s** | tập trang hỏng ĐỔI giữa các lượt |
| deploy #199 (sau khi sửa) | **196ms** | 14/25 đạt, còn đúng `/inventory/planning` |

## Nguyên nhân

Một câu lệnh: **sổ kho**. Đo bằng `perf-probe` trên máy RẢNH (RAM 531/1963MB, `erp-app` 0% CPU):

```
                     một giờ trước   →   lúc sự cố
câu lệnh sổ kho          32,5s              61,4s
getDashboardData         43,0s              71,8s
getBusinessBrief         41,4s              65,3s
```

Chi phí này **có sẵn từ lâu** và đang tăng; nó vừa vượt ngưỡng 60 giây. Trang chủ gọi
`stockRiskSummary()` trong cùng `Promise.all` với doanh thu, đơn mới, COD và cảnh báo — nên toàn bộ
trang chờ nó. Các trang khác hỏng theo kiểu ngẫu nhiên vì tranh CPU với chính truy vấn đó.

## Cách xác định (và ba lần chẩn đoán SAI trên đường đi)

Ghi lại để lần sau không đi lại:

1. **"Hỏng ở cổng bí mật"** — sai. Cổng đó xanh; đọc nhầm dòng script được echo ra thành dòng lỗi.
   Đọc `steps[].conclusion` từ API job thay vì grep log là ra ngay.
2. **"Bảng kết quả đơn vật chất hoá bị rỗng nên rơi về đường chậm"** — sai. Bảng khoẻ: 2.629 dòng,
   một phiên bản luật, vừa tính lúc 09:01.
3. **"CSDL rảnh trong lúc trang treo"** — KHÔNG CÓ CĂN CỨ. Mẫu `pg_stat_activity` lấy GIỮA hai lượt
   smoke chứ không phải trong lúc treo. Suýt dẫn tới một bản sửa nhắm sai chỗ.

Thứ thật sự chỉ đúng chỗ là `perf-probe`: nó xoá đệm, đo từng báo cáo, và in nguyên văn tám câu lệnh
chậm nhất. Cùng một câu lệnh xuất hiện ba lần ở đầu bảng với 61s/51s/41s.

Phép kiểm cuối cùng chứng minh chẩn đoán: sau khi trang chủ thôi chờ sổ kho, **mọi** trang về
100–400ms và chỉ còn `/inventory/planning` quá hạn — đúng trang mà toàn bộ nội dung LÀ sổ kho, không
có chỗ nào để né.

## Đã sửa

Trang chủ đặt hạn 3 giây cho riêng mục sổ kho; quá hạn thì con số đó là **CHƯA TÍNH ĐƯỢC**, hiện
"đang tính". Cố ý không trả 0 — 0 đọc thành "không mẫu nào cần sản xuất gấp".

Kèm hai lỗi khác lộ ra trong lúc điều tra:

- `memo` gộp lời gọi trùng khoá **không có trần thời gian**: một lượt tính bị bỏ rơi (job giữ ấm gọi
  qua `?wait=0`) làm mọi người đọc sau đó chờ một lời hứa đã chết cho tới khi khởi động lại ứng dụng.
  Nay quá 20 giây thì tính lại. `tests/memo-inflight.test.ts`.
- Bảng độ phủ lợi nhuận ném lỗi im lặng: điều kiện kỳ viết bằng cột Drizzle sinh ra
  `"orders"."inserted_at"` trong câu lệnh đặt bí danh `orders o`. Hỏng cả doanh thu lẫn quy kết
  quảng cáo, nhưng nằm sau `Suspense` nên trang vẫn mở. Sau khi sửa: 413 đơn giao / 397 có chứng
  từ tiền.

## CÒN NỢ — sổ kho vẫn 61 giây

Bản sửa trên **không chạm vào truy vấn**. Nó chỉ chặn việc một mục nặng giữ cả trang làm con tin.

`/inventory/planning` vẫn quá hạn, và đây là việc thật còn lại. Manh mối đã có từ `explain-stock`:

```
vsales (đơn → mẫu mã)     9.862ms   cost=2.195.549   JIT: bật
vreceipts (phiếu → mẫu)       0,3ms
```

Chi phí kế hoạch 2,2 triệu trên máy 2 nhân làm PostgreSQL bật JIT — với dạng truy vấn nhiều truy vấn
con tương quan, thời gian biên dịch JIT thường lớn hơn thời gian chạy. Hai hướng đáng đo TRƯỚC KHI
sửa mã:

1. Đo lại `vsales` với `jit = off` — một tham số, đảo ngược được, không đụng dữ liệu.
2. Vật chất hoá phần bán ra theo mẫu mã, đúng cách đã dùng cho `canonical_order_outcome`.

Không làm hướng nào trong phiên này: sổ kho bị khoá bởi luật nghiệp vụ (AGENTS mục 3.10), và sửa vội
một truy vấn quyết định số tồn là cách nhanh nhất để có số tồn sai mà không ai phát hiện.

---

# Phụ lục 2 — JIT của PostgreSQL là nguyên nhân, và nó đã được đo

## Phép đo quyết định

Trên **đúng câu `/inventory/planning` chạy**, cùng dữ liệu, cùng kế hoạch thực thi:

| | JIT ON | JIT OFF |
| --- | --- | --- |
| TOTAL_TIME | 26.078 ms | **134 ms** |
| PLANNING_TIME | 84,45 ms | 33,24 ms |
| EXECUTION_TIME | 25.942,61 ms | **76,86 ms** |
| ROWS | 41 | 41 |
| BUFFERS | hit 443.673 · read 0 | hit 443.658 · read 0 |
| JIT_TIME | **51.518,04 ms · 1.432 hàm** | không bật |

Và trên truy vấn con nặng nhất (`vsales`): 8.578,82 ms → **26,02 ms**, JIT 17.036,85 ms · 465 hàm.

**Cùng khối đệm, cùng số dòng, cùng kế hoạch.** Toàn bộ chênh lệch là thời gian BIÊN DỊCH. PostgreSQL
bật JIT khi chi phí ước lượng vượt `jit_above_cost` (mặc định 100.000); báo cáo tồn kho có chi phí
hàng triệu vì nối sáu bảng dẫn xuất. Trên máy 2 nhân, biên dịch 1.432 hàm tốn gấp 337 lần phép tính.

## Cách sửa

`chayKhongJit()` trong `db/index.ts` đặt `set local jit = off` TRONG ĐÚNG giao dịch của báo cáo.
**Không** tắt JIT toàn máy chủ: `set local` hết hiệu lực khi giao dịch kết thúc, không rò sang phiên
khác, không đụng `postgresql.conf`. Truy vấn ngoài các báo cáo này vẫn dùng JIT như cũ.

Áp cho các chỗ ĐÃ ĐO: truy vấn dòng kế hoạch · truy vấn hàng hụt · hai truy vấn của báo cáo lương.

**Hai luật rút ra khi làm việc này** (cả hai đều do tự gây ra rồi tự phát hiện):

1. **Giao dịch chỉ được ôm câu lệnh chạy trên CHÍNH NÓ.** Bọc cả một `Promise.all` có
   `getOperatingCost()` bên trong là khoá chết: giao dịch giữ kết nối, hàm kia chờ kết nối.
2. **PGlite không có JIT và không được mở giao dịch ở đây.** Nó là PostgreSQL biên dịch sang WASM,
   không có LLVM. Mở giao dịch thì treo — và treo IM LẶNG.

## Kết quả

Smoke deploy #203: **27/27 đạt · 0 quá hạn · 0 chậm**, toàn bộ 56–155ms.

```
/                   107ms     /operations          102ms     /inventory/planning   63ms
/orders              77ms     /shipments            94ms     /payroll             155ms
/reports            119ms     /reports/returns     153ms     /returns              65ms
/alerts              81ms     /customers/retention 117ms     /ads                  59ms
```

`/inventory/planning`: **61 giây → 63ms**. `getDashboardActionQueue` (đo bằng perf-probe):
**28.655ms → 16ms**.

Tồn kho không đổi một số nào: `ON_HAND / RESERVED / AVAILABLE / INBOUND / UNSELLABLE` giữ nguyên,
`tests/consistency` khoá việc tồn khớp giữa Sản phẩm và Kế hoạch SX.

## Còn nợ — điểm nóng đã đo, chưa áp

perf-probe sau khi sửa (thời gian CSDL cộng dồn, đệm đã xoá trước mỗi phép đo):

```
getBusinessBrief          18.757ms      getReturnRateByVariant     7.582ms
getDashboardData          15.063ms      getReturnRateSummary       6.830ms
getFinancialTruth         10.262ms      adsRoas (mỗi kỳ)      ~4.700ms
```

Các trang chứa chúng hiện 59–155ms **nhờ bộ đệm và job giữ ấm** — chi phí thật chỉ phải trả trên
đường nguội. Đó chính là dạng hỏng đã làm `/` và `/payroll` quá hạn: lúc nhanh lúc chết tuỳ đệm.

Cùng một họ truy vấn, nên gần như chắc chắn cùng một nguyên nhân. **Nhưng chưa đo từng cái**, và
mục 9 của chủ shop nói rõ: trang đang nhanh thì đóng băng, không tối ưu theo cảm tính. Việc đúng
tiếp theo là chạy `explain-stock` mở rộng cho sáu hàm này, rồi mới áp — mỗi chỗ một con số.

---

# Phụ lục 3 — nghiệm thu đường NGUỘI, và bottleneck còn lại

## Đo trước, sửa sau — công cụ đo được mở rộng trước

`perf-probe` nay in thêm ba thứ mà trước đây phải đoán:

- **NGUỘI ↔ ẤM**: mỗi hàm chạy hai lượt, đệm rỗng rồi đệm còn nguyên.
- **CHẠY LẠI CÙNG MỘT CÂU**: gom câu lệnh theo HÌNH DẠNG (bỏ tham số) rồi đếm — chỗ tìm nguyên nhân
  chung giữa các báo cáo.
- **Số dòng** trả về mỗi hàm: phân biệt chậm-vì-nhiều-dữ-liệu với chậm-vì-lặp.

## Giả thuyết bị số liệu bác bỏ

Nghi ngờ ban đầu: *nhiều báo cáo dựng lại cùng một tập nền*. Số liệu nói không:

```
getBusinessBrief   104 lượt truy vấn · 92 câu KHÁC NHAU
getDashboardData    75 lượt truy vấn · 70 câu KHÁC NHAU
```

Không phải lặp. Vấn đề là **từng câu đơn lẻ tốn 13–17 giây**, và tất cả cùng một họ — gộp nhiều cột
trên bảng dẫn xuất kết quả đơn, đúng họ đã tách bạch được JIT (8.578ms ↔ 26ms, cùng khối đệm).

## Kết quả (đường NGUỘI, đệm rỗng)

| Hàm | Ban đầu | Lượt 1 | Lượt 2 | Ấm | Mục tiêu | Đạt |
| --- | --- | --- | --- | --- | --- | --- |
| getDashboardData | 15.182ms | 10.719ms | **3.536ms** | 0ms | <1,5s | chưa |
| getBusinessBrief | 17.611ms | 10.617ms | **3.307ms** | 0ms | <1,5–2s | chưa |
| getFinancialTruth | 19.162ms | 6.285ms | **2.899ms** | 0ms | <1,5s | chưa |
| getReturnRateByVariant | 7.066ms | 2.953ms | **3.309ms** | 54ms | <800ms | chưa |
| getReturnRateSummary | 6.465ms | 3.241ms | **3.223ms** | 29ms | <800ms | chưa |
| adsRoas 30 ngày | 5.083ms | 849ms | **829ms** | 0ms | <1,5–2s | **✓** |
| adsRoas toàn kỳ | 4.458ms | 876ms | **879ms** | 0ms | <1,5–2s | **✓** |
| getOperatingCost | 3.356ms | 4.208ms | **57ms** | 0ms | — | **✓** |

Mục "CHẠY LẠI CÙNG MỘT CÂU" nay **trống hoàn toàn**: không hàm nào còn chạy lại cùng một câu lệnh.

Smoke deploy #206: **27/27 đạt · 0 quá hạn · 0 chậm**.

## Bottleneck còn lại — biết chính xác, chưa sửa

Ba câu chậm nhất còn lại đều ~3,2 giây và đều mang cùng một hình dạng:

```
coalesce(
  (select m.outcome from canonical_order_outcome m
    where m.order_id = orders.id
      and coalesce(m.shipment_id,'') = coalesce(shipments.id,'')
      and m.logic_version = $1),
  <biểu thức ORDER_OUTCOME tính trực tiếp>
)
```

Đây **không còn là JIT** — nó là công việc thật: một truy vấn con TƯƠNG QUAN chạy cho từng dòng trên
~2.500 đơn, cộng phép nối `PRIMARY_ATTEMPT` sang vận đơn.

Hướng sửa đúng (chưa làm, cần đo trước): thay tra cứu tương quan bằng một phép NỐI với bảng đã tính
sẵn, giữ nguyên nhánh dự phòng cho dòng thiếu. Đây là đổi HÌNH DẠNG truy vấn chứ không đổi công
thức, nên `tests/metric-shape-consistency.test.ts` là chỗ chứng minh con số không đổi.

**Không tăng TTL để giấu.** Mục tiêu <1,5s cold vẫn còn nợ ba hàm, và nợ đó được ghi ở đây kèm đúng
câu lệnh phải sửa.
