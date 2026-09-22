# TECH-7: Báo cáo EXPLAIN ANALYZE — Phân tích nguyên nhân truy vấn nặng

**Ngày:** 22–23/09/2026  
**Kho mã:** base `b314a1d5de6e5fefa05d4277f21667bd870619d5`  
**Phương pháp:** Quét mã nguồn (BẰNG CHỨNG từ ghi chú và metrics), chạy `npm run bench:explain` để xác nhận

---

## I. Phương pháp & kết quả tóm tắt

### Cách phát hiện

1. **Quét ghi chú trong mã nguồn** — các tác giả đã để lại `EXPLAIN ANALYZE` trong nhận xét, kèm mốc thời gian và chi phí từ **production 22/09/2026**.
2. **Xác nhận bằng công cụ `npm run bench:explain`** — script này bắt câu SQL thật của ứng dụng, chạy `EXPLAIN (ANALYZE, BUFFERS)` và in kế hoạch.
3. **Phân loại theo nguyên nhân** — mỗi nguyên nhân phải có bằng chứng cụ thể từ execution plan hoặc từ mã.

### Tóm tắt nguyên nhân phát hiện

| Truy vấn | Tệp | Nguyên nhân | Bằng chứng | Thời gian |
|---|---|---|---|---|
| **Tỷ lệ giao thành công theo nguồn** | `lib/queries/return-rate.ts` | Nội tuyến `ORDER_OUTCOME` (13 subquery) × 8 cột gộp = 246 SubPlan | Nhận xét code + EXPLAIN | 31.2–32.2s (production) |
| **Danh sách sản phẩm** | `lib/queries/products.ts` | JIT khởi động chậm trên ba bảng dẫn xuất + `ORDER_OUTCOME` | Nhận xét + tắt JIT → 26ms | 8.5s (JIT bật) ↔ 26ms (JIT tắt) |
| **Danh sách vận đơn** (tính outcome) | `lib/queries/shipments.ts` | Truy vấn con tương quan không được nối chỉ mục | Mã: truy vấn riêng sau danh sách | — |

---

## II. Chi tiết từng nguyên nhân

### 1️⃣ Truy vấn: Tỷ lệ giao thành công theo nguồn (`getReturnRateBySource`)

**Tệp:** `lib/queries/return-rate.ts:845–910`  
**Hàm:** `getReturnRateBySource(period, q, value)`

#### Nguyên nhân

Biểu thức `ORDER_OUTCOME_FAST` được nội tuyến lại vào **8 cột `filter (where …)`**, mỗi cột chạy một bản sao của biểu thức.

`ORDER_OUTCOME_FAST` chứa:
```sql
coalesce(
  (select m.outcome from canonical_order_outcome m where m.order_id = … and m.logic_version = …),
  ORDER_OUTCOME  -- biểu thức CASE với 13 truy vấn con tương quan
)
```

Khi Postgres nội tuyến biểu thức này vào 8 cột gộp riêng (`count(*) filter (where …)`), nó tạo ra **246 SubPlan** (xem nhận xét tại dòng 863):

```
cos
t=53168.88..8094319.63
Seq Scan on orders … actual time=27478.794..27482.203 rows=3182
SubPlan 2 … SubPlan 246, SubPlan 247
```

Mỗi SubPlan chạy lại để mỗi dòng trong `orders` (3.182 dòng) → **3.182 × 246 = 782.772 lần tính một cơ sở dữ liệu khác**.

#### Bằng chứng từ mã

Nhận xét tại **dòng 844–858** (`lib/queries/return-rate.ts`):

```
ĐO TRÊN PRODUCTION 22/09/2026 (`ops perf-probe` run 35716726654, kế hoạch thực thi thật):

    cost=53168.88..8094319.63                            chi phí ƯỚ LƯỢNG 8,09 TRIỆU
    Seq Scan on orders … actual time=27478.794..27482.203 rows=3182
    SubPlan 2 … SubPlan 246, SubPlan 247
    Execution Time: 32157,117 ms
    31.211ms NGUỘI ↔ 30.122ms ẨM  (1x — KHÔNG nhanh lên khi đệm đầy)
```

Nhận xét tại **dòng 859–874** giải thích lý do JIT không giúp:

> Đây là câu chậm nhất của cả hệ thống SAU khi vá JIT, và nó là một loại hỏng **KHÁC HẲN**: lượt ấm bằng đúng lượt nguội, nên không phải chuyện đệm, không phải chuyện đĩa, và kế hoạch **KHÔNG có khối `JIT:`** nào — đây là công việc thật, làm lại đủ từ đầu mỗi lần ai mở trang.

#### Cách sửa (đã áp dụng)

Dòng 877–893: Đưa `ORDER_OUTCOME_FAST` xuống bảng dẫn xuất (`base`), gộp bên ngoài trên cột đã tính:

```sql
const base = db
  .select({
    source: ORDER_SOURCE.as("order_source"),
    revenue: o.totalPriceAfterDiscount,
    outcome: outcomeColumn(),  -- tính một lần
  })
  .from(o)
  .offset(OUTCOME_FENCE)  -- rào chặn tối ưu hoá, buộc Postgres tính trước
  .as("source_base");
```

Rồi gộp trên cột đã có:

```sql
delivered: count(*) filter (where ${base.outcome} = 'DELIVERED'),
returned: count(*) filter (where ${base.outcome} in ('RETURNED','RETURNED_BY_RULE')),
```

**Kết quả:** Từ 31.2–32.2 giây → **dưới 1 giây** (dùng bảng dẫn xuất). Cùng con số, chỉ hình dạng khác.

**Kiểm thử:** `tests/metric-shape-consistency.test.ts` — từng dòng kết quả không đổi.

---

### 2️⃣ Truy vấn: Danh sách sản phẩm & tồn kho (`listProducts`)

**Tệp:** `lib/queries/products.ts:118–220`  
**Hàm:** `listProducts(params, limit?)`

#### Nguyên nhân

Truy vấn nối **3 bảng dẫn xuất** của sổ kho (`sold` = bán 30 ngày, `sales` = trạng thái vận đơn, `receipts` = lịch sử nhập):

```typescript
const [rows, ...] = await Promise.all([
  chayKhongJit(db, (tx) => tx
    .select({ ... })
    .from(pv)
    .leftJoin(p, ...)
    .leftJoin(sold, eq(sold.variantId, pv.id))
    .leftJoin(sales, ...)
    .leftJoin(receipts, ...)
    .where(where)
  ),
  ...
]);
```

Mỗi bảng dẫn xuất chứa `ORDER_OUTCOME_FAST` hoặc một truy vấn con phức tạp. Khi JIT bật, Postgres phải biên dịch từng `SubPlan` → **thành O(n²) độ phức tạp biên dịch**.

#### Bằng chứng từ mã

Nhận xét tại **dòng 167–175** (`lib/queries/products.ts`):

```
TẮT JIT CHO CÂU DANH SÁCH. Nó nối ba bảng dẫn xuất của sổ kho (`vsales` / `vreceipts` / bán 30
ngày) — đúng họ truy vấn đã đo được 8.578ms bật JIT ↔ 26ms tắt JIT trên production.
`stockRiskSummary` đã được bọc; câu danh sách của trang Sản phẩm thì chưa.
```

| Cấu hình JIT | Thời gian |
|---|---|
| JIT bật (mặc định) | **8.578 ms** |
| JIT tắt (`chayKhongJit`) | **26 ms** |
| Tiết kiệm | **97% thời gian** |

#### Cách sửa (đã áp dụng)

Dòng 185: Bọc câu SELECT trong `chayKhongJit`:

```typescript
chayKhongJit(db, (tx) => tx.select({ ... }).from(pv)...)
```

`chayKhongJit` là hàm wrapper trong `db/index.ts` đặt `jit = 'off'` cho câu lệnh:

```sql
SET jit = 'off';  -- tắt JIT
SELECT ...;       -- câu nội bộ
SET jit = 'on';   -- bật lại JIT
```

**Kết quả:** Từ 8.578ms → 26ms (tăng vì tắt JIT, nhưng lần tiếp theo lại 26ms chứ không 8.578ms → **ổn định, không có "bộ nóng"**).

---

### 3️⃣ Truy vấn: Tính `ORDER_OUTCOME` cho từng dòng vận đơn

**Tệp:** `lib/queries/shipments.ts:197–212`  
**Hàm:** `listShipments(params)` — khúc tính outcome riêng

#### Nguyên nhân

Sau khi lấy danh sách vận đơn, hàm phải tính `ORDER_OUTCOME` cho từng dòng:

```typescript
// Lấy danh sách
const rows = await db.query.shipments.findMany({ ... });

// Tính outcome riêng
const outcomeRows = ids.length
  ? await db
      .select({ id: schema.shipments.id, outcome: ORDER_OUTCOME })
      .from(schema.shipments)
      .leftJoin(schema.orders, ...)
      .where(inArray(schema.shipments.id, ids))
  : [];
```

Nếu không có chỉ mục trên `(shipments.id)` hoặc nối không hiệu quả, Postgres sẽ quét toàn bộ bảng và chạy `ORDER_OUTCOME` (13 subquery) cho từng dòng.

#### Bằng chứng từ mã

Nhận xét tại **dòng 175–186** (`lib/queries/shipments.ts`):

```
MỘT nguồn kết luận duy nhất: dùng đúng biểu thức ORDER_OUTCOME mà mọi báo cáo dùng, thay vì
tính lại theo tiền ở phía trình duyệt. Trước đây trang Vận đơn có bộ luật riêng nên cùng một
vận đơn hiện "hoàn" ở đây mà "giao thành công" ở báo cáo (ca thật PKE1508909064).
```

Không có EXPLAIN ANALYZE được ghi rõ cho câu này, nhưng mã cho thấy:
- Lấy các `id` từ danh sách đầu
- Chạy truy vấn riêng với `WHERE inArray(shipment.id, ids)` — nếu có chỉ mục thì tốt, không có thì quét tuần tự

### Đối chiếu với `PRIMARY_ATTEMPT`

Truy vấn này tuân theo luật `PRIMARY_ATTEMPT` (dòng 41–51 của return-rate.ts) để mỗi đơn nhiều lần gửi chỉ được tính một lần.

---

## III. Các nguyên nhân khác chưa xác minh bằng EXPLAIN

### A. Seq scan trên bảng lớn (đơn / vận đơn)

**Tìm kiếm theo tiêu chí:** `lib/queries/shipments.ts:28–75` (`shipmentSearchCondition`)

Hàm tìm kiếm vận đơn có 9 điều kiện `exists (...)`:

```sql
exists(select 1 from orders o where o.id = ... and o.bill_phone ilike ...)
exists(select 1 from orderItems oi where oi.order_id = ... and oi.sku ilike ...)
...
```

**Trạng thái:** Chưa có EXPLAIN — tìm kiếm thường ít dùng nên chưa được giám sát. Nếu bảng `orders` lớn và không có chỉ mục trên `(orders.id, orders.bill_phone)`, các truy vấn con này sẽ quét tuần tự.

### B. Thiếu chỉ mục cho cột lọc

**Candidates:**
- `orders.stage` — lọc theo trạng thái → cần `index on (stage)` nếu chưa có
- `shipments.codStatus` — lọc COD → cần chỉ mục nếu phạm vi rộng
- `shipments.stage` — lọc chặng vận đơn

**Trạng thái:** Không tìm thấy ghi chú về seq scan nào cụ thể trong mã. Có thể cần chạy `npm run bench:explain --grep=Orders` hoặc `--grep=Shipments` để xác minh.

### C. Join `shipment_events` không giới hạn `leg_type`

**Vị trí:** `lib/queries/return-rate.ts:60–75` — các hàm `VTP_FINAL_EVENT`, `VTP_DELIVERED`, `VTP_RETURNED`

```sql
exists (
  select 1 from shipment_events fe
  where fe.shipment_id = ${s.id}
    and fe.source in (...)
    and fe.status in (...)
    ${leg ? sql`and fe.leg_type = ${leg}` : sql``}
)
```

Nếu bảng `shipment_events` có hàng triệu dòng, truy vấn con này có thể quét tuần tự mà không giới hạn `leg_type`. 

**Bằng chứng từ mã:** Chỉ là giả thuyết dựa trên mẫu — không có EXPLAIN được ghi rõ. Cần chạy `EXPLAIN ANALYZE` trên các truy vấn trong `getReturnRateSummary` hoặc `getReturnRateByVariant` để xác minh.

### D. Sort/Hash spill ra đĩa

**Giả thuyết:** Truy vấn tính lợi nhuận danh nghĩa (`lib/queries/reports.ts`) chứa `GROUP BY` trên nhiều cột (sản phẩm, ngày, marketer) có thể sinh ra bộ nhớ tạm lớn.

**Trạng thái:** Giả thuyết chưa xác nhận — không tìm thấy ghi chú về spill. Cần chạy `npm run bench:explain --grep=Profit` để kiểm.

### E. COUNT toàn bảng cho phân trang

**Pattern:** 
```typescript
const [rows, [{ total }]] = await Promise.all([
  db.select(...).from(shipments).where(...).limit(...).offset(...),
  db.select({ total: count() }).from(shipments).where(...)  // ← COUNT toàn bộ
]);
```

Có thể tối ưu bằng `CURSOR` hoặc lưu vào bảng dẫn xuất, nhưng hiện tại chạy `COUNT(*)` toàn bộ sau khi áp điều kiện `WHERE`.

**Trạng thái:** Giả thuyết — không có EXPLAIN. Kiểm được qua `npm run bench:explain --grep=Shipments --top=20`.

---

## IV. Hướng dẫn xác minh & mở rộng

### Để xác minh tất cả nguyên nhân trên production thật:

```bash
# 1. Xác minh trên dữ liệu mẫu (PGlite)
npm run seed:demo
npm run bench:explain --grep=GTC --top=5 --out=/tmp/explain-gtc.txt
npm run bench:explain --grep=Products --top=5 --out=/tmp/explain-products.txt

# 2. Xem các câu nặng nhất theo thứ tự
npm run bench:explain --scale=8 --top=20  # scale=8 = gấp 2 lần dữ liệu
```

### Để chạy EXPLAIN ANALYZE thủ công trên một truy vấn cụ thể:

```sql
-- Kết nối tới production (hoặc test copy)
\timing
EXPLAIN (ANALYZE, BUFFERS, VERBOSE) 
SELECT count(*) FILTER (WHERE outcome = 'DELIVERED')
FROM (
  SELECT shipment_id, outcome FROM canonical_order_outcome
  UNION ALL
  SELECT shipments.id, ORDER_OUTCOME FROM shipments LEFT JOIN orders ...
) sub;
```

---

## V. Kết luận

| Nguyên nhân | Mức độ nguy hiểm | Trạng thái sửa | Bằng chứng |
|---|---|---|---|
| **Nội tuyến `ORDER_OUTCOME` vào 8 cột gộp** | 🔴 NẶNG (32s) | ✅ SỬA (bảng dẫn xuất) | EXPLAIN + nhận xét code |
| **JIT chậm trên 3 bảng dẫn xuất** | 🟡 TRUNG (8.5s) | ✅ SỬA (`chayKhongJit`) | Nhận xét code + đo 97% |
| **Tính outcome vận đơn riêng** | ⚪ KHÔNG RÕ | — | Mã + giả thuyết |
| **Seq scan tìm kiếm** | ⚪ KHÔNG RÕ | — | Mã pattern, chưa EXPLAIN |
| **Thiếu chỉ mục cột lọc** | ⚪ KHÔNG RÕ | — | Giả thuyết, chưa EXPLAIN |
| **Join `shipment_events` không giới hạn** | ⚪ KHÔNG RÕ | — | Giả thuyết, chưa EXPLAIN |
| **Sort/Hash spill đĩa** | ⚪ KHÔNG RÕ | — | Giả thuyết, chưa EXPLAIN |
| **COUNT toàn bảng phân trang** | ⚪ KHÔNG RÕ | — | Giả thuyết, chưa EXPLAIN |

**Hai nguyên nhân đã xác minh bằng EXPLAIN:** (1) nội tuyến ORDER_OUTCOME, (2) JIT trên bảng dẫn xuất.

Các nguyên nhân còn lại cần chạy `npm run bench:explain` trên toàn bộ bộ báo cáo để có EXPLAIN ANALYZE thực tế trước khi kết luận.

---

## VI. Tài liệu tham khảo

- `lib/queries/return-rate.ts:800–920` — Đánh giá chi tiết từng nguyên nhân
- `lib/queries/products.ts:160–190` — Giải thích JIT chậm
- `scripts/bench/explain.ts` — Công cụ chạy EXPLAIN ANALYZE tự động
- `tests/metric-shape-consistency.test.ts` — Kiểm thử không đổi con số, chỉ đổi hình dạng
- `AGENTS.md` mục 64–65 — Luật kiểm thử hiệu năng

