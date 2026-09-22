# TECH-5: Hướng Dẫn Phân Tích Số Đo Phía Máy Chủ

**Mục đích:** Hiểu và phân tích các số liệu về hiệu năng truy vấn, server action, và tải phía máy chủ.

---

## 1. Các Số Đo Chính

### 1.1 Thời Gian Phản Hồi (Response Time)

**Định nghĩa:**
- **coldMs (lạnh):** Thời gian từ lúc request đến lúc nhận được response, khi **đệm cache trống** (lần đầu tiên load trang)
- **warmMs (ấm):** Thời gian khi **cache có dữ liệu** (lần 2+ cùng trang, trong 60–120 giây)
- **p50Ms:** Trung vị (median) từ 3 vòng lạnh
- **p95Ms:** Phân vị 95% từ 3 vòng lạnh (nếu vòng nào chậm bất thường)

**Mục tiêu:**
| Loại trang | Cold (ms) | Warm (ms) |
|---|---|---|
| Dashboard / KPI nhanh | < 300 | < 100 |
| Danh sách (50 dòng) | < 500 | < 150 |
| Báo cáo nặng | < 1000 | < 200 |

**Ví dụ:** Tổng quan dashboard 145ms lạnh → ✅ tốt

---

### 1.2 Truy Vấn SQL (Queries)

**Định nghĩa:**
- **queries:** Số câu SQL chạy để render trang (đếm từ database driver, không bỏ sót)
- **dbMs:** Tổng thời gian dành ở CSDL (không tính network, parsing JSON kết quả)
- **rows:** Tổng số dòng trả về từ CSDL (nếu quá lớn → cần phân trang hoặc filter)

**Mục tiêu:**
- Câu chạy: < 50/trang (dấu hiệu N+1 nếu > 100)
- Thời gian DB: < 80% của tổng thời gian response
- Dòng trả về: Hợp lý với số dòng hiển thị (nếu hiện 50 dòng nhưng lấy 10.000 → tối ưu)

**Ví dụ:**
- Báo cáo lợi nhuận: 38 câu, 801ms ở DB
  - ✅ 38 câu là hợp lý (< 50)
  - ⚠️ 801ms là 93.6% của 856ms tổng → chậm ở DB, không ở network
  - → Cần kiểm tra query chậm nhất (mục `slowest`)

---

### 1.3 Dữ Liệu Trả Về (Payload)

**Định nghĩa:**
- **payloadKb:** Kích thước dữ liệu JSON gửi từ server tới browser (serialized)

**Mục tiêu:**
- Dashboard: < 100 KB
- Danh sách: < 500 KB
- Báo cáo: < 1000 KB
- Nếu vượt → có thể tối ưu bằng lazy load, phân trang, hoặc bỏ cột không cần

**Ví dụ:**
- Báo cáo lợi nhuận: 245.6 KB → ✅ ổn (< 1000 KB)
- Quảng cáo: 789.3 KB → ✅ ổn nhưng gần trần

---

### 1.4 Truy Vấn Chậm Nhất (Slowest Queries)

**Cấu trúc:**
```json
"slowest": [
  {
    "sql": "SELECT ... FROM shipments s LEFT JOIN orders o ...",
    "count": 1,
    "ms": 523,
    "rows": 1147
  }
]
```

**Giải thích:**
- **sql:** Câu SQL (được rút gọn để dễ đọc)
- **count:** Chạy bao nhiêu lần
- **ms:** Tổng thời gian (mili giây)
- **rows:** Số dòng trả về

**Phân tích:**
- Nếu `count > 1` → dấu hiệu chạy lặp (N+1) → cần batch query
- Nếu `ms` chiếm > 50% thời gian response → cần index hoặc refactor
- Nếu `rows` lớn hơn nhiều dòng hiển thị → cần thêm LIMIT/phân trang

---

## 2. Ví Dụ: Phân Tích Từng Trang

### 2.1 Tổng Quan (Dashboard) — Nhanh nhất ✅

```json
{
  "page": "Tổng quan (Dashboard)",
  "coldMs": 145.3,
  "warmMs": 48.2,
  "queries": 18,
  "dbMs": 132,
  "rows": 247,
  "payloadKb": 45.2
}
```

**Kết luận:**
- ✅ 145ms lạnh → rất tốt (< 300ms)
- ✅ 48ms ấm → cache hiệu quả
- ✅ 18 câu → ít (< 50)
- ✅ 45KB → gọn nhẹ
- **Đánh giá:** Excellent

---

### 2.2 Báo Cáo Lợi Nhuận — Nặng ⚠️

```json
{
  "page": "Báo cáo lợi nhuận (Profit)",
  "coldMs": 856.3,
  "warmMs": 125.4,
  "queries": 38,
  "dbMs": 801,
  "rows": 1523,
  "payloadKb": 245.6,
  "slowest": [
    {
      "sql": "SELECT o.id, o.items FROM orders o ... CASE WHEN s.stage='DELIVERED' THEN ... ",
      "count": 1,
      "ms": 523,
      "rows": 1147
    },
    {
      "sql": "SELECT product_id, SUM(qty) FROM order_items ... GROUP BY product_id",
      "count": 1,
      "ms": 187,
      "rows": 71
    }
  ]
}
```

**Kết luận:**
- ⚠️ 856ms lạnh → chậm (≥ target 1000ms nhưng gần ranh giới)
- ✅ 125ms ấm → cache có tác dụng (↓ 87% so với lạnh)
- ✅ 38 câu → chấp nhận (< 50)
- ⚠️ 801ms ở DB = 93.6% tổng thời gian → lỗi ở DB, không ở network
- ✅ 245KB → ổn
- **Câu chậm nhất:** ORDER_OUTCOME logic (523ms) — có thể tối ưu bằng **index** trên `shipments.stage` + `orders.id`

**Đề xuất tối ưu:**
```sql
-- Trong db/schema.ts, thêm index
export const shipmentOutcomeIdx = index('idx_shipment_outcome')
  .on(shipments.stage, shipments.codAmount, shipments.codCollected, orders.id);
```

---

### 2.3 Danh Sách Đơn — Bình thường ✅

```json
{
  "page": "Đơn hàng (Orders)",
  "coldMs": 312.5,
  "warmMs": 89.3,
  "queries": 26,
  "dbMs": 285,
  "rows": 1147,
  "payloadKb": 512.4
}
```

**Kết luận:**
- ✅ 312ms lạnh → ổn (< 500ms)
- ✅ 89ms ấm → tốt
- ✅ 26 câu → bình thường
- ⚠️ 512KB payload → gần trần (1147 dòng lấy hết) → có thể giảm bằng phân trang

---

## 3. Kiểm Tra Nhanh: Dấu Hiệu Cảnh Báo

| Dấu Hiệu | Nguyên Nhân | Cách Sửa |
|---|---|---|
| coldMs > 1000ms | Query chậm hoặc quá nhiều câu | Thêm index, refactor query, phân trang |
| warmMs > 300ms | Cache không hiệu quả | Tăng TTL memo, giảm complexity query |
| queries > 50 | N+1 problem (vòng lặp) | Batch query, JOIN thay vì loop |
| dbMs > 90% của coldMs | Lỗi ở CSDL, không ở network | Thêm index, query optimization |
| payloadKb > 1000 | Dữ liệu quá lớn | Lazy load, phân trang, bỏ cột |
| rows >> số dòng hiển thị | Lấy dữ liệu thừa | Thêm LIMIT, phân trang |
| slowest[0].count > 1 | Câu chạy lặp lại | Batch lại query |

---

## 4. So Sánh Hai Lần Chạy (Trước/Sau)

### Kịch bản: Tối ưu Báo cáo lợi nhuận

**Lần 1 (Trước):**
```json
{"page": "Báo cáo lợi nhuận", "coldMs": 856.3, "queries": 38, "dbMs": 801}
```

**Sửa:** Thêm index + refactor ORDER_OUTCOME

**Lần 2 (Sau):**
```json
{"page": "Báo cáo lợi nhuận", "coldMs": 612.4, "queries": 35, "dbMs": 560}
```

**Kết quả:**
- ✅ Thời gian giảm: 856ms → 612ms = **-28.5%** 🎉
- ✅ Câu giảm: 38 → 35
- ✅ Thời gian DB: 801ms → 560ms = **-30.1%**

**Commit message:**
```
Tối ưu báo cáo lợi nhuận: giảm 28% thời gian phản hồi

Vấn đề: Báo cáo lợi nhuận chạy 856ms, 801ms ở DB.
Nguyên nhân: ORDER_OUTCOME CASE logic không có index, query chạy sequential.

Sửa:
- Thêm index trên shipments(stage, cod_amount, cod_collected)
- Refactor CASE để tránh full scan orders
- Batch product_id lookup thay vì JOIN riêng

Kết quả (scale 1):
- Thời gian: 856ms → 612ms (-28.5%)
- DB time: 801ms → 560ms (-30.1%)
- Câu: 38 → 35

Số đo: baseline-T1 vs baseline-T1-after-opt
```

---

## 5. Kiểm Tra Query Chậm (Phân Tích Sâu)

Nếu một câu trong `slowest` chạy 523ms:

### 5.1 Dùng EXPLAIN để xem kế hoạch

```sql
-- Đăng nhập VPS, chạy:
EXPLAIN ANALYZE
SELECT o.id, ... 
FROM orders o 
LEFT JOIN shipments s ON s.order_id = o.id 
WHERE CASE WHEN s.stage='DELIVERED' THEN ... 
GROUP BY o.id;
```

Xem:
- **Seq Scan** vs **Index Scan** → nếu Seq Scan = chưa có index
- **Planning time** vs **Execution time** → nếu lệch => re-plan quá lâu

### 5.2 Thêm Index

```typescript
// db/schema.ts
export const shipmentDeliveredIdx = index('idx_shipment_delivered')
  .on(shipments.stage, shipments.id)
  .where(eq(shipments.stage, 'DELIVERED'));
```

Run migration:
```bash
npm run db:generate
npm run db:migrate
```

Test lại:
```bash
npm run bench -- --scale=1 --grep="Profit" --out=docs/perf/baseline-T1-indexed.json
```

---

## 6. Thước Đo Hiệu Quả (ROI của Tối Ưu)

**Trước tối ưu:**
- Báo cáo lợi nhuận: 856ms
- Các query khác: ~300ms (trung bình)
- Tổng: ~1156ms

**Sau tối ưu:**
- Báo cáo lợi nhuận: 612ms (tiết kiệm 244ms)
- Các query khác: không đổi
- Tổng: ~912ms

**Hiệu quả:**
- ✅ Giảm **21% tổng thời gian** dashboard
- ✅ Người dùng cảm nhận rõ (862ms → 612ms = 244ms nhanh hơn)
- 💰 Tối ưu 1 trang có tác động vào toàn bộ hệ thống

---

## 7. Điều Kiện Dừng (Khi nào ngưng tối ưu)

| Thời gian | Trang | Hành động |
|---|---|---|
| < 300ms | Bất cứ | ✅ Rất tốt, không cần tối ưu |
| 300–500ms | Danh sách | ✅ Ổn, có thể tối ưu nếu còn thời gian |
| 500–1000ms | Báo cáo | ⚠️ Nên tối ưu nếu có thể |
| > 1000ms | Bất cứ | 🔴 Phải tối ưu ngay |

---

## 8. Lưu ý Kỹ Thuật

### PGlite vs PostgreSQL Thật

| Khía cạnh | PGlite | PostgreSQL 16 |
|---|---|---|
| Con số thời gian tuyệt đối | ❌ Cao hơn (WASM, 1 luồng) | ✅ Thực tế |
| Tỷ lệ giữa các trang | ✅ Chính xác | ✅ Chính xác |
| Tỷ lệ TRƯỚC/SAU tối ưu | ✅ Chính xác | ✅ Chính xác |
| Index effect | ✅ Có thể đo | ✅ Thực tế |

**Kết luận:** Dùng PGlite để đo **tương đối** (so sánh), không dùng để dự đoán **tuyệt đối** (VPS phải đo thật).

### Memo Cache

Sau lần đầu (lạnh), các lần tiếp (ấm) hit memo nên thời gian giảm mạnh:
- Query kéo về **cùng dữ liệu** → cache (TTL 60–120s)
- Query có **parameter khác** → cache misss

Ví dụ:
```typescript
// lib/queries/profit-nominal.ts
const getCachedProfit = memo(
  `profit:${period.from}:${period.to}`,  // Key
  () => calculateProfit(period),          // Async function
  120,                                     // TTL 120 giây
);
```

---

## 9. Workflow Tối Ưu Hoàn Chỉnh

1. **Chạy baseline:** `npm run bench -- --scale=1 --out=docs/perf/baseline-T1.json`
2. **Phân tích:** Tìm trang chậm nhất (sort by coldMs DESC)
3. **Chẩn đoán:** Xem `slowest` queries
4. **Sửa code:** Thêm index, refactor query, hoặc thêm memo
5. **Chạy lại:** `npm run bench -- --scale=1 --out=docs/perf/baseline-T1-fixed.json`
6. **So sánh:** `python3 compare.py baseline-T1.json baseline-T1-fixed.json`
7. **Commit:** Ghi tường minh số đo trước/sau

---

## 10. Tài Liệu Liên Quan

- `scripts/bench-reports.ts` — Script đo
- `lib/perf/probe.ts` — Lớp đếm truy vấn
- `lib/cache.ts` — Hệ thống memo cache
- `db/schema.ts` — Định nghĩa index
- `docs/CONVENTIONS.md` — Quy ước viết query

**Hết.**
