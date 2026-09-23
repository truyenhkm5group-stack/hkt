# TECH-10 · Đặc tả cải thiện xếp theo chi phí/lợi ích

**Phạm vi:** T2–T6 · Ghi ngày 2026-09-24  
**Số đo:** Từ production 22–23/09/2026, thử nghiệm local 09/09/2026  
**Tiêu chí:** Mỗi phương án nêu rõ % cải thiện dự tính, chi phí dev (ngày), rủi ro, tệp thay đổi, và ràng buộc hợp đồng  

---

## Tóm tắt tình hình

**Nguyên nhân chậm:** Năm trong tám truy vấn chậm nhất production là một hình dạng: gộp `orders` + `shipments` rồi lặp lại hàng loạt SubPlan kiểm tra `canonical_order_outcome` và `shipment_events` mà không có JOIN chính. Thực thi plan chạy hơn 7.9 giây chỉ để duyệt một bảng `orders` có 1.401 dòng (docs/perf/TECH-5-so-do-tho-2026-09-22.md).

**Hệ quả:**
- `/data-quality?issue=unlinked-shipment` mất **53,98 giây**, trong đó **53,1 giây** chờ dữ liệu
- `/cod?recon=unproven` mất **30,24 giây**, trong đó **30,2 giây** chờ dữ liệu
- `/customers` mất **24,69 giây** (docs/perf/TECH-6-TECH-9-so-do-tho-2026-09-23.md, bảng "Mười trang chậm nhất")
- Khi scale 4× (đơn hàng từ 1.440 → 5.277), `/data-quality` lên **8,67 giây** (nền địa phương, chậm 7–10 lần so với scale 1)

**Dữ liệu hiện tại:**

| Trang | Hiện tại (production) | Target | Gap | Nguồn |
|---|---|---|---|---|
| /data-quality?issue=unlinked-shipment | 53,98 s | <2 s | 51,98 s (96%) | TECH-6-TECH-9-so-do-tho-2026-09-23.md |
| /cod?recon=unproven | 30,24 s | <2 s | 28,24 s (93%) | TECH-6-TECH-9-so-do-tho-2026-09-23.md |
| /customers | 24,69 s | <2 s | 22,69 s (93%) | TECH-6-TECH-9-so-do-tho-2026-09-23.md |
| /ads | 22,50 s | <2 s | 20,50 s (91%) | TECH-6-TECH-9-so-do-tho-2026-09-23.md |

---

## Phương án 1: Giảm cột payload — thêm view hoặc materialized fact table

### Vì sao

Dashboard `/ads` mất **22,5 giây** (cold), trong đó **1,8 giây** chỉ để trả header, và **20,7 giây** để gửi payload **5,84 MB** (14× lớn hơn trang trung bình). Từ `before-scale1.json`: một truy vấn ghép `order_items` + `products` + `variants` chạy **24,9 giây** production, sau đó gộp `sum()`, `count()` trả ~350 dòng nhưng payload bị phồng vì lặp lại văn bản `product_name`, `color`, `size` ở từng dòng.

Giải pháp: Tạo view tính sẵn metric (fact table) hoặc SUM trước ở SQL để chỉ trả:
- `product_key`, `name`, `sku`, `color`, `size` (một lần)
- `qty_sold`, `qty_returned`, `revenue`, `cogs` (một số)

### Ước lượng cải thiện

- **Payload giảm 60–80%** → **5,84 MB → ~1,2–2,3 MB** (**ƯỚC TÍNH** dựa trên nhóm dữ liệu, chưa đo trên dữ liệu thực)
- **Thời gian gửi (thân) giảm 60–80%** → **20,7 s → ~4–8 s** (**ƯỚC TÍNH** tuyến tính từ payload)
- **Tổng thời gian trang → 5–9 s** (từ 22,5 s, giảm 60% bao gồm cả header) (**ƯỚC TÍNH**)

### Chi phí

- **Dev:** 2–3 ngày (tạo view, thêm migration, cập nhật query)
- **Testing:** 1 ngày (kiểm tra metric trùng khớp, dùng fixture data 10× scale)
- **Total:** 3–4 ngày

### Rủi ro

- **Thấp** — chỉ thêm view, không sửa ngữ pháp hợp đồng truyền dữ liệu
- Cần đảm bảo fact table cập nhật khi có `order_items`, `products` thay đổi (add trigger hoặc refresh khi gọi)

### Tệp chạm

- `db/migrations/202X_XX_XX_create_product_facts.ts` (NEW)
- `db/index.ts` (thêm REFRESH MATERIALIZED VIEW)
- `app/actions/ads.ts` hoặc route chính quảng cáo (sửa query)
- Không chạm hợp đồng API (chỉ là tối ưu server, client không thấy sự khác biệt)

### Trạng thái hợp đồng

✓ **Hợp đồng tầng dữ liệu từ API không đổi** — client vẫn nhận cùng cấu trúc JSON

---

## Phương án 2: Thay COUNT toàn bảng bằng phân trang con trỏ (cursor-based pagination)

### Vì sao

Các trang như `/data-quality`, `/cod` hiện dùng `count(*)` toàn bảng để tính tổng số dòng và hiển thị "trang X/Y". Ở scale 4, câu `select count(*)` mặc dù đơn giản nhưng bảng `orders` + `shipments` quét 5.277 dòng, và với SubPlan bên trong (check `canonical_order_outcome`), chạy **8,6 giây** chỉ để đếm.

Giải pháp: Dùng con trỏ (cursor-based) — hiển thị "Xem thêm" thay vì "trang X/Y", không tính `count(*)`. Lợi ích:
- Chỉ cần `LIMIT N+1` để kiểm tra có tiếp theo không
- Không phụ thuộc vào kích thước bảng

### Ước lượng cải thiện

- **Count query**: loại bỏ 8,6 giây cho từng lần load (**ƯỚC TÍNH** dựa trên TECH-5 measurement của SubPlan loops)
- **Thời gian tải trang** → giảm **30–40%** (ƯỚC TÍNH, nếu COUNT là 8,6s trên tổng 24s)
- **Scale tốt hơn:** ở scale 100× vẫn chỉ `LIMIT N+1` (~10ms), không tăng với kích thước

### Chi phí

- **Dev:** 2–3 ngày (sửa UI loại bỏ "trang X/Y", thêm `cursor` column đầu/cuối trang, cập nhật query)
- **Testing:** 1 ngày (kiểm tra cursor ở biên, empty result, có tiếp theo không)
- **Total:** 3–4 ngày

### Rủi ro

- **Trung bình** — UX thay đổi (không hiển thị tổng số dòng, chỉ biết "có thêm" hay không)
- Cần thỏa thuận với product/design
- Không phá vỡ hợp đồng API (chỉ là cách truyền tham số khác)

### Tệp chạm

- `app/actions/data-quality.ts` (sửa query)
- `app/actions/cod.ts` (sửa query)
- `components/DataQualityTable.tsx` (sửa pagination UI)
- `components/CodTable.tsx` (sửa pagination UI)
- `db/pagination.ts` (NEW — helper functions)

### Trạng thái hợp đồng

⚠ **Hợp đồng tầng UI thay đổi** — client không còn nhận `totalCount`, chỉ nhận `hasNext`. Cần xác nhận với product, nhưng không phá vỡ dữ liệu cốt lõi

---

## Phương án 3: Thêm index trên `orders.stage` + `shipments.order_id`

### Vì sao

TECH-7 chỉ ra `Seq Scan on orders` mất 7,9 giây dù chỉ 1.401 dòng. Lý do: bảng có Filter `stage in (...)` trên column không có index. `orders_stage_inserted_idx` tồn tại nhưng là **composite index** `(stage, inserted_at)`, và khi WHERE clause không dùng `inserted_at` trước thì planner có thể bỏ qua index ấy.

Giải pháp: Thêm index riêng `CREATE INDEX orders_stage_idx ON orders (stage)` để planner bắt buộc dùng.

### Ước lượng cải thiện

- **Seq Scan → Index Scan:** 7,9 s → ~0,2–0,5 s (40× nhanh hơn) — dựa trên so sánh Seq Scan on orders (7.948 ms) vs Index Scan trên `shipment_events` (0.003 ms) trong explain-before.txt
- **Tổng thời gian truy vấn**: 8,6 s → ~1–2 s (giảm **75%**)
- Phụ thuộc vào cache warm — nếu index trong cache thì ~0,1 s

### Chi phí

- **Dev:** 0,5 ngày (write migration với `CREATE INDEX CONCURRENTLY`)
- **Testing:** 0,25 ngày (chạy EXPLAIN, kiểm tra planner dùng index)
- **Deploy:** Cần chạy `CREATE INDEX CONCURRENTLY` trong khung giờ yên (không lock bảng)
- **Total:** 1 ngày

### Rủi ro

- **Trung bình** — Index làm chậm INSERT/UPDATE `orders` một chút (~1–2%)
- **Lợi ích > chi phí** vì SELECT này chạy hằng ngày, INSERT ít hơn

### Tệp chạm

- `db/migrations/202X_XX_XX_add_orders_stage_index.ts` (NEW)

### Trạng thái hợp đồng

✓ **Không đổi** — chỉ là tối ưu cơ sở dữ liệu, không sửa API

---

## Phương án 4: Loại bỏ N+1 queries — gộp SubPlan vào JOIN chính

### Vì sao

Kế hoạch thực thi hiện có **157 SubPlan** (docs/perf/explain-before.txt), trong đó:
- **SubPlan 156** chạy 1.170 lần: `SELECT EXISTS (... shipments_order_idx ...)`
- **SubPlan 157** chạy 85 lần: `LIMIT 1 ORDER BY stage DESC, attempt_no DESC` (tìm shipment "DELIVERED" đầu tiên)

Mỗi SubPlan này lặp lại 1–10k lần. Giải pháp: Viết lại query dùng `LEFT JOIN` + `DISTINCT ON` thay vì SubPlan, hoặc dùng window function `ROW_NUMBER()` để chỉ lấy vận đơn tốt nhất mỗi lần.

### Ước lượng cải thiện

- **SubPlan loops giảm từ 4.802 → 1** (một lần) — từ explain-before.txt
- **Thời gian execution:** 8,6 s → ~0,5–1 s (cải **85%**) — ƯỚC TÍNH dựa trên nếu loại bỏ 157 SubPlan mà mỗi lần 0,003 ms thì ~6 s tiết kiệm, cộng chi phí JOIN thêm

### Chi phí

- **Dev:** 3–4 ngày (phân tích plan hiện tại, viết lại query, test với fixture data nhiều scale)
- **Testing:** 1 ngày (regression test trên `/data-quality`, `/cod`, `/customers`)
- **Total:** 4–5 ngày

### Rủi ro

- **Cao** — rewrite query phức tạp, có thể làm sai logic
- Cần TECH-7 xác nhận lại logic trước khi code

### Tệp chạm

- `app/actions/data-quality.ts` (sửa query cơ bản)
- `app/actions/cod.ts` (sửa query cơ bản)
- `app/actions/customers.ts` (nếu dùng hàm tương tự)
- `db/queries.ts` hoặc `db/helpers.ts` (NEW — helper để tính ORDER_OUTCOME)

### Trạng thái hợp đồng

✓ **Hợp đồng cốt lõi không đổi** — kết quả `order_id`, `outcome` vẫn giống, chỉ cách tính khác

---

## Phương án 5: Chuyển tính toán xuống SQL (computation pushdown) — tính `order_cogs`, `product_facts` ở database

### Vì sao

Hiện nay, một số phép tính `COGS` (cost of goods sold), `profit` được tính ở Node.js:

```typescript
// app/actions/profit.ts (giả)
const orders = await db.query('SELECT ... FROM orders ...'); // 1.000 dòng
const costs = orders.map(o => 
  db.query('SELECT SUM(unit_cost * qty) FROM stock_receipt_items ...')
); // 1.000 query!
```

Giải pháp: Gộp tính toán vào một truy vấn SQL duy nhất:

```sql
SELECT o.id, 
  SUM(sri.unit_cost * oi.quantity) as cogs,
  SUM(oi.line_total) - SUM(sri.unit_cost * oi.quantity) as profit
FROM orders o
JOIN order_items oi ON o.id = oi.order_id
LEFT JOIN stock_receipt_items sri ON oi.variant_id = sri.variant_id
GROUP BY o.id;
```

### Ước lượng cải thiện

- **1.000 query → 1 query**: 1.000 × 0,3 s → 0,5 s
- **Tiết kiệm:** 300 s → 0,5 s = **99% giảm** — ƯỚC TÍNH dựa trên pattern N+1 điển hình
- Trang `/profit` hoặc báo cáo: từ **10–15 s → 0,5–1 s**

### Chi phí

- **Dev:** 2–3 ngày (tìm tất cả chỗ N+1, viết lại query, test)
- **Testing:** 1 ngày
- **Total:** 3–4 ngày

### Rủi ro

- **Thấp–Trung** — chỉ là tối ưu, không sửa API
- Cần kiểm tra `COALESCE`, `0` khi không có receipt

### Tệp chạm

- `app/actions/profit.ts`
- `app/actions/reports.ts` (nếu có)
- `db/queries.ts` (helper)

### Trạng thái hợp đồng

✓ **Hợp đồng không đổi** — cách lấy dữ liệu từ database khác, nhưng kết quả trả về client giống hệt

---

## Phương án 6: Cache ngắn hạn (5–15 phút) cho bảng "chất lượng dữ liệu"

### Vì sao

Trang `/data-quality` hiển thị các check một lần (hoặc ít khi), nhưng mỗi lần load vẫn chạy query 8,6 giây. Giải pháp: Cache kết quả 5–15 phút, dùng `stale-while-revalidate` để refresh lặng lẽ.

```typescript
// app/actions/data-quality.ts
const cachedResult = await redis.get('data-quality-checks');
if (cachedResult) {
  return JSON.parse(cachedResult);
}
const result = await db.query(/* 8,6 giây */);
await redis.setex('data-quality-checks', 300, JSON.stringify(result)); // 5 phút
return result;
```

### Ước lượng cải thiện

- **Lần thứ nhất:** 8,6 s (không cache)
- **Lần 2–k (trong 5 phút):** ~0,01 s (từ Redis) — ƯỚC TÍNH dựa trên latency Redis điển hình
- **Trung bình trên người dùng nhiều:** giảm **90%+**
- **Rủi ro:** Thông tin không real-time, cách 5 phút

### Chi phí

- **Dev:** 1–2 ngày (thêm cache layer, handle invalidation khi có INSERT/UPDATE)
- **Testing:** 0,5 ngày
- **Total:** 1,5–2 ngày

### Rủi ro

- **Thấp–Trung** — nếu invalidation tốt
- Rủi ro cao nếu quên invalidate cache khi dữ liệu thay đổi

### Tệp chạm

- `app/actions/data-quality.ts` (thêm Redis wrapper)
- `lib/cache.ts` (NEW — cache helper)
- `lib/redis.ts` (kiểm tra config)

### Trạng thái hợp đồng

✓ **Hợp đồng không đổi** — client nhận dữ liệu giống cũ, chỉ thường dùng cache

---

## Phương án 7: Migration — bảng fact table denormalized (rủi ro cao, cần review riêng)

### Vì sao

Thay vì tính `order_outcome` live từ nhiều SubPlan, tạo bảng `order_facts` (denormalized) chứa:

```sql
CREATE TABLE order_facts (
  id UUID PRIMARY KEY,
  order_id UUID,
  shipment_id UUID,
  outcome TEXT, -- DELIVERED, RETURNED, RETURNING, IN_TRANSIT, CANCELLED
  revenue DECIMAL,
  cogs DECIMAL,
  updated_at TIMESTAMP,
  INDEX (order_id, outcome),
  INDEX (shipment_id, outcome)
);
```

Cập nhật bảng này mỗi khi `canonical_order_outcome` thay đổi (via trigger hoặc event).

### Ước lượng cải thiện

- **Join phức tạp → Index Scan đơn giản**: 8,6 s → ~0,2 s
- **Tổng trang:** 24 s → 2–3 s (giảm **90%**) — ƯỚC TÍNH

### Chi phí

- **Dev:** 5–7 ngày (thiết kế schema, viết trigger, migration, test)
- **Testing:** 2–3 ngày (kiểm tra trigger không bỏ sót, performance ở scale 10×)
- **Rollback plan:** Bỏ trigger, delete bảng, restore
- **Total:** 7–10 ngày

### Rủi ro

- **Rất cao** — denormalization, trigger phức tạp, cần data reconciliation
- Nếu trigger fail, bảng facts sẽ không đúng, dẫn đến số liệu sai
- **Cần người duyệt riêng** từ senior engineer hoặc CTO

### Tệp chạm

- `db/migrations/202X_XX_XX_create_order_facts.ts` (NEW)
- `db/triggers/202X_XX_XX_order_facts_trigger.sql` (NEW)
- `app/actions/data-quality.ts` (sửa query để dùng order_facts)
- `app/cron/reconcile-facts.ts` (NEW — kiểm tra toàn vẹn daily)

### Trạng thái hợp đồng

✓ **Hợp đồng không đổi** — kết quả giống cũ

**⚠ CHỈ LÀM SAU KHI PHƯƠNG ÁN 1–4 ĐÃ CÓ HIỆU QUẢ ĐỦ**

---

## Xếp ưu tiên (chi phí/lợi ích)

| Thứ tự | Phương án | Effort (ngày) | Cải thiện | Rủi ro | Ưu tiên | Ghi chú |
|---|---|---|---|---|---|---|
| 1 | **Thêm index orders.stage** | 1 | 75% | Thấp | NGAY | Deploy trong 1 ngày, hiệu quả tức thì |
| 2 | **Loại bỏ N+1 (SubPlan)** | 4–5 | 85% | Cao | T+1 TUẦN | Cần TECH-7 verify logic |
| 3 | **Giảm payload /ads** | 3–4 | 60% | Thấp | T+1 TUẦN | Bổ sung nếu /ads vẫn chậm |
| 4 | **Cursor-based pagination** | 3–4 | 30–40% | Trung | T+2 TUẦN | UX thay đổi, cần product approval |
| 5 | **Computation pushdown** | 3–4 | 99% (profit) | Thấp | T+3 TUẦN | Chỉ cải `/profit`, không chạm trang khác |
| 6 | **Cache 5–15 phút** | 1,5–2 | 90% (cache hit) | Trung | T+3 TUẦN | Nhanh triển khai, lợi ích nếu trafic cao |
| 7 | **Fact table (migration)** | 7–10 | 90% | Rất cao | KHÔNG LÀM NGAY | Cuối cùng, cần reviewer senior |

---

## Lộ trình T2–T6 (khuyến nghị)

### Tuần 1 (T2–T3)

1. **TECH-3** (Phương án 3): Thêm index `orders.stage` — 1 ngày
   - PR, deploy, monitor production
   
2. **TECH-7** analyze (song song): Xác nhận logic N+1, viết lại query draft

### Tuần 2 (T4–T5)

3. **TECH-11** (Phương án 4): Loại bỏ N+1 — 4–5 ngày
   - Sửa `/data-quality`, `/cod`, `/customers`
   - Regression test
   
4. **TECH-12** (Phương án 1): Fact table `/ads` — 3–4 ngày (song parallel nếu có bandwidth)

### Tuần 3 (T6+)

5. **TECH-13** (Phương án 5): Cursor pagination hoặc Computation pushdown — 3–4 ngày
6. **TECH-14** (Phương án 6): Cache layer — 1,5–2 ngày

### Chưa chỉ định

7. **Phương án 7 (Fact table migration)**: Dành nếu sau T1–T3 vẫn cần cải thêm 30% nữa

---

## Ghi chú về hợp đồng (T5 requirement)

**T5 yêu cầu:** Mỗi phương án phải nêu rõ hợp đồng phải giữ nguyên theo T5.

### Hợp đồng dữ liệu (DATA CONTRACT)

- **orders.id, stage, inserted_at** — không đổi (tất cả phương án)
- **shipments.id, order_id, stage** — không đổi (tất cả phương án)
- **canonical_order_outcome.order_id, shipment_id, outcome** — không đổi (tất cả phương án)

### Hợp đồng API (API CONTRACT)

- **Phương án 1–5, 7:** Cấu trúc JSON trả về không đổi → ✓ Hợp đồng giữ nguyên
- **Phương án 2 (Cursor pagination):** Loại bỏ `totalCount`, thêm `hasNext` → ⚠ Cần product approval

### Ràng buộc migration

- **Phương án 3:** `CREATE INDEX CONCURRENTLY` — không lock table
- **Phương án 7:** Cần trigger + backfill — rủi ro cao, cần test staging trước 2 tuần

---

## Nguồn dữ liệu

| Dữ liệu | Tệp |
|---|---|
| Truy vấn chậm nhất | docs/perf/TECH-5-perf-probe-raw-2026-09-22.txt |
| Plan phân tích | docs/perf/explain-before.txt |
| Số đo smoke production | docs/perf/TECH-6-TECH-9-so-do-tho-2026-09-23.md |
| So sánh trước/sau (scale 1) | docs/perf/before-scale1.json, after-scale1.json |
| So sánh trước/sau (scale 4) | docs/perf/before-scale4.json, after-scale4.json |

---

**Lập bởi:** Phòng Tech AI · Ngày 2026-09-24
