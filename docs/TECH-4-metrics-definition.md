# TECH-4: Định nghĩa chỉ số và công thức tính

**Mục đích**: Xác định chính xác từng chỉ số sẽ đo, công thức tính, và cách ghi kết quả để những lần đo sau so sánh được.

---

## 1. Các chỉ số chính

### 1.1 TTFB (Time To First Byte)

#### Định nghĩa nghiệp vụ
Khoảng thời gian từ khi trình duyệt gửi HTTP request **hoàn toàn** tới máy chủ, đến khi máy chủ **bắt đầu gửi byte đầu tiên** của HTTP response (header hay body, tuỳ thuộc cách tính).

#### Công thức
```
TTFB = T_response_start - T_request_sent
```

Trong đó:
- `T_request_sent`: Thời điểm trình duyệt gửi xong toàn bộ HTTP request (bao gồm headers + body)
- `T_response_start`: Thời điểm máy chủ gửi byte đầu tiên của HTTP response

#### Cách đo

**Cách 1: curl (chính xác nhất)**
```bash
curl -w "TTFB: %{time_starttransfer}s\n" -o /dev/null -s \
  http://localhost:3000/shipments
```
- `time_starttransfer`: Khoảng từ khi request đầu tiên đến khi dòng đầu của response được nhận
- **Không bao gồm**: Network latency, DNS, TLS handshake
- **Bao gồm**: Server processing time

**Cách 2: Chrome DevTools (bao gồm overheads)**
- F12 → Network tab
- Load trang (Ctrl+Shift+Delete cache trước)
- Bấm request → Timing sub-tab
- Xem cột TTFB
- **Ghi chú**: Giá trị này >= curl vì DevTools thêm overhead

**Cách 3: Lighthouse (tự động tính Core Web Vitals)**
```bash
npm install -g lighthouse
lighthouse http://localhost:3000/shipments --output-path=/tmp/lh.html
```
- Cho giá trị First Contentful Paint (FCP) và Largest Contentful Paint (LCP)
- Khác TTFB nhưng có liên quan

#### Ghi chép
```
TTFB: 425ms
```
hoặc chi tiết hơn:
```
TTFB: 425ms (curl, clear cache)
DevTools TTFB: 480ms (bao gồm overhead)
Difference: +55ms (11.5%)
```

#### Kỳ vọng
- Good: < 600ms (bao gồm network)
- Acceptable: 600ms – 1000ms
- Poor: > 1000ms

---

### 1.2 Thời gian Server Action

#### Định nghĩa nghiệp vụ
Tổng thời gian chạy code trên server từ khi nhận request tới khi server component hoàn thành tính toán và sẵn sàng trả về data cho client để render.

#### Công thức
```
Server Action Time = T_listShipments_end + T_shipmentFacets_end - T_handler_start
```

Hoặc chi tiết hơn:
```
Server Action Time = T_listShipments + T_shipmentFacets + T_overhead
  where:
    T_listShipments = thời gian hàm listShipments() (bao gồm SQL)
    T_shipmentFacets = thời gian hàm shipmentFacets() (bao gồm SQL)
    T_overhead = thời gian React + Drizzle + JSON serialization
```

#### Cách đo

**Cách 1: Thêm log vào code (chính xác)**

Sửa `app/(dashboard)/shipments/page.tsx`:
```typescript
export default async function ShipmentsPage(props: ShipmentsPageProps) {
  const t0 = performance.now();
  
  const [data, facets] = await Promise.all([
    listShipments(params),
    shipmentFacets(params),
  ]);
  
  const t1 = performance.now();
  const serverTime = t1 - t0;
  
  console.log(`[BENCH] Server action time: ${serverTime.toFixed(2)}ms`);
  
  return <ShipmentsPageView data={data} facets={facets} />;
}
```

Chạy:
```bash
npm run dev 2>&1 | tee /tmp/server.log
# Load trang
# Grep log: grep "BENCH" /tmp/server.log
```

**Cách 2: Measure từ HTTP response headers (nếu có)**

Sửa `app/(dashboard)/shipments/page.tsx` thêm header:
```typescript
headers().set('X-Server-Time', serverTime.toFixed(2));
```

Sau đó kiểm tra:
```bash
curl -i http://localhost:3000/shipments | grep "X-Server-Time"
```

**Cách 3: OpenTelemetry (nếu áp dụng trong tương lai)**

```typescript
import { trace } from '@opentelemetry/api';

const span = trace.getActiveSpan();
span?.setAttribute('shipments.list.time', t_listShipments);
span?.setAttribute('shipments.facets.time', t_shipmentFacets);
```

#### Ghi chép
```
Server Action Time: 385ms
  - listShipments(): 280ms
  - shipmentFacets(): 100ms
  - Overhead: 5ms
```

#### Kỳ vọng
- Good: < 300ms
- Acceptable: 300ms – 600ms
- Poor: > 600ms

---

### 1.3 Thời gian Truy vấn SQL

#### Định nghĩa nghiệp vụ
Thời gian Postgres chạy lệnh SQL từ khi nhận query tới khi trả về kết quả hoàn toàn. **Không bao gồm** network I/O giữa Node và Postgres, chỉ bao gồm quá trình tính toán trong DB.

#### Công thức (từ EXPLAIN ANALYZE)
```
Total SQL Time = Planning Time + Execution Time

Execution Time = thời gian thực thi (không bao gồm plan)
Planning Time = thời gian tạo query plan (thường < 10ms)
```

#### Cách đo

**Cách 1: EXPLAIN ANALYZE (chính xác)**

```bash
psql postgresql://localhost/erp
```

Trong psql:
```sql
EXPLAIN (ANALYZE, TIMING ON, BUFFERS)
SELECT s.id, s.created_at, s.stage, s.vtp_status_name, s.cod_amount, s.cod_status, s.shipping_fee, s.receiver_name, s.receiver_phone, s.receiver_address, s.vtp_status_date, s.delivered_at, s.tracking_code, s.vtp_order_number, s.order_reference, s.attempt_no, s.direction, s.vtp_location, s.cod_collected, s.cod_statement_ref, s.picked_up_at, s.returned_at, s.is_final, s.last_vtp_sync_at, s.vtp_sync_source, s.vtp_raw_status_name, s.vtp_raw_status_at, s.vtp_raw_mapped, s.vtp_next_sync_at, 
  (CASE 
    WHEN s.stage IN ('RETURNING', 'RETURNED') THEN 'RETURNED'::text 
    WHEN s.cod_collected > 100000 OR (o.prepaid IS NOT NULL AND o.prepaid > 100000) THEN 'DELIVERED'::text
    WHEN o.prepaid < 50000 AND coalesce(s.cod_collected, s.cod_amount, 0) < 50000 THEN 'RETURNED'::text
    ELSE 'DELIVERED'::text
  END) as outcome
FROM shipments s 
LEFT JOIN orders o ON o.id = s.order_id 
WHERE s.created_at >= NOW() - INTERVAL '90 days'
ORDER BY s.created_at DESC 
LIMIT 20;
```

Kết quả:
```
Planning Time: 0.234 ms
Execution Time: 45.123 ms
```

**Cách 2: SQL query execution time (chỉ Node)**

Thêm log vào `lib/queries/shipments.ts`:
```typescript
async function listShipments(params: ListParams) {
  const db = await getDb();
  
  const t0 = performance.now();
  
  const rows = await db.query.shipments.findMany({
    // ... query options
  });
  
  const t1 = performance.now();
  console.log(`[BENCH] listShipments SQL: ${(t1-t0).toFixed(2)}ms`);
  
  return { rows, /* ... */ };
}
```

**Cách 3: PostgreSQL log extension (production)**

```sql
-- Bật slow query log (nếu có quyền admin)
SET log_min_duration_statement = 10; -- log query > 10ms
-- Sau đó kiểm tra log file
```

#### Ghi chép

**Kiểu tóm tắt**:
```
SQL (listShipments): 45ms
  - Planning: 0.2ms
  - Execution: 44.8ms
  - Rows: 20
```

**Kiểu chi tiết (nếu đo từng truy vấn)**:
```
Query 1 (list): 45ms (20 rows, seq scan)
Query 2 (count): 5ms (1 row, count aggregate)
Query 3 (facets - stage): 8ms (5 groups)
Query 4 (facets - carrier): 12ms (7 groups)
Query 5 (facets - cod): 6ms (5 groups)
...
Total SQL: 76ms (6 truy vấn)
```

#### Kỳ vọng
- Good: < 50ms (với < 1000 dòng)
- Acceptable: 50ms – 150ms
- Poor: > 150ms (cần tối ưu index)

---

### 1.4 Thời gian Render Bảng (DataTable)

#### Định nghĩa nghiệp vụ
Thời gian từ khi JavaScript trên client nhận dữ liệu JSON và bắt đầu render component DataTable, đến khi tất cả dòng (rows) được vẽ trên DOM và ổn định (không có layout shift).

#### Công thức
```
Render Time = T_render_end - T_data_received
  where:
    T_data_received = khi useEffect nhận props data từ parent
    T_render_end = khi tất cả Row component mounted + DOM stable
```

#### Cách đo

**Cách 1: React Profiler (DevTools)**

- F12 → Profiler tab (nếu không có, cài React DevTools extension)
- Load trang
- Bấm "Record" (hình tròn)
- Cuộn bảng hoặc kích hoạt re-render
- Dừng "Record"
- Xem flamegraph, tìm `DataTable` component
- Ghi lại thời gian render

**Cách 2: performance.measure() (code)**

Sửa `components/data-table/data-table.tsx`:
```typescript
export function DataTable<TData, TValue>({
  columns,
  data,
  // ...
}: DataTableProps<TData, TValue>) {
  const t0 = useRef(performance.now());
  
  useEffect(() => {
    const t1 = performance.now();
    console.log(`[BENCH] DataTable render: ${(t1 - t0.current).toFixed(2)}ms for ${data.length} rows`);
  }, [data]);
  
  return (
    <div className="border rounded-md">
      <Table>
        {/* rows */}
      </Table>
    </div>
  );
}
```

Chạy:
```bash
npm run dev 2>&1 | grep "BENCH.*DataTable"
```

**Cách 3: Lighthouse (tổng hợp)**

```bash
lighthouse http://localhost:3000/shipments --only-audits=first-contentful-paint,largest-contentful-paint
```

#### Ghi chép
```
DataTable render: 52ms (20 rows)
  - Row component: 45ms
  - Column header: 5ms
  - Pagination: 2ms
```

#### Kỳ vọng
- Good: < 50ms (20 dòng)
- Acceptable: 50ms – 100ms
- Poor: > 100ms

---

## 2. Chỉ số tổng hợp

### 2.1 Thời gian Server (Server-side)
```
Server Time = TTFB (curl) 
           ≈ Server Action Time + Network I/O (Node ↔ DB)
```

**Ghi chú**: TTFB từ curl **không bao gồm network lưới internet**, chỉ bao gồm:
- Server processing
- Network I/O DB (cục bộ, ~1-5ms)

### 2.2 Thời gian Client (Client-side)
```
Client Time = Time to render DataTable + Hydrate React
```

### 2.3 Thời gian End-to-End (E2E)
```
E2E Time = TTFB (curl) + Thời gian render
```

hoặc chi tiết:
```
E2E Time = Server Action + SQL + Render
```

---

## 3. Cách ghi kết quả chuẩn

> **Mọi con số và kế hoạch thực thi trong mục 3 là MẪU MINH HOẠ ĐỊNH DẠNG, không phải số đo** — ngày
> "2025-07-xx" và số dòng trong mẫu là bịa để chỉ cách ghi. Trong kho chưa có kết quả đo chuẩn nào
> của TECH-4 (không có `docs/TECH-4-measurements/`); số đo production thật nằm ở `docs/perf/`
> (tổng hợp: `docs/perf/TRANG-THAI.md`).

### 3.1 Bảng đơn (cho 1 kịch bản)

```markdown
## Kịch bản 1: Tải lần đầu

**Ngày**: 2025-07-20  
**Số lần chạy**: 3 (lấy trung bình)  
**Dữ liệu**: 1.595 vận đơn, khoảng 90 ngày

| Chỉ số | Lần 1 | Lần 2 | Lần 3 | Trung bình | Ghi chú |
|---|---|---|---|---|---|
| TTFB (curl) | 420ms | 435ms | 425ms | **427ms** | Clear cache |
| Server Action | 380ms | 390ms | 385ms | **385ms** | listShipments + facets |
| SQL Plan | 0.2ms | 0.2ms | 0.2ms | **0.2ms** | Stable |
| SQL Exec | 44ms | 48ms | 46ms | **46ms** | 20 rows + facets |
| DataTable Render | 48ms | 52ms | 50ms | **50ms** | React Profiler |
| **Tổng Server** | **427ms** | **437ms** | **432ms** | **432ms** | TTFB estimate |
| **Tổng E2E** | **475ms** | **489ms** | **482ms** | **482ms** | TTFB + render |
```

### 3.2 Bảng so sánh (8 kịch bản)

```markdown
## Tổng hợp 8 kịch bản — Ngày 2025-07-20

| # | Kịch bản | TTFB | Server Action | SQL | Render | E2E | Trạng thái |
|---|---|---|---|---|---|---|---|
| 1 | Tải lần đầu | 427ms | 385ms | 46ms | 50ms | 482ms | ✓ OK |
| 2 | Đổi bộ lọc | 480ms | 420ms | 80ms | 48ms | 535ms | ⚠ Chậm hơn |
| 3 | Khoảng rộng | 650ms | 580ms | 120ms | 55ms | 712ms | ⚠ Chậm nhất |
| 4 | Khoảng hẹp | 380ms | 340ms | 35ms | 45ms | 425ms | ✓ Nhanh |
| 5 | Phân trang s.25 | 455ms | 400ms | 65ms | 50ms | 510ms | ✓ OK |
| 6 | Tìm kiếm mã | 320ms | 280ms | 30ms | 42ms | 365ms | ✓ Nhanh |
| 7 | Sắp xếp COD | 520ms | 460ms | 95ms | 52ms | 575ms | ⚠ Cần index |
| 8 | Bộ lọc nặng | 1200ms | 1050ms | 200ms | 58ms | 1260ms | ✗ Quá chậm |
| | **Trung bình** | **565ms** | **489ms** | **84ms** | **50ms** | **619ms** | |
```

### 3.3 Thông tin chi tiết (khi cần troubleshoot)

```markdown
## Kịch bản 8 — Bộ lọc tổng hợp (Troubleshooting)

**Lệnh**: `curl 'http://localhost:3000/shipments?stage=DELIVERED&stage=IN_TRANSIT&cod=PENDING&final=active&product=Q002'`

**Kết quả đo**:

### SQL EXPLAIN ANALYZE
```
Limit  (cost=5234.50..5234.60 rows=20 width=456) (actual time=1050.234..1050.245 rows=20 loops=1)
  ->  Sort  (cost=5234.50..5240.00 rows=2200 width=456) (actual time=1050.200..1050.210 rows=20 loops=1)
    ->  Nested Loop Left Join  (cost=100.00..5000.00 rows=2200 width=456) (actual time=50.100..1000.150 rows=145 loops=1)
      ->  Seq Scan on shipments s  (cost=100.00..2000.00 rows=1100 width=256) (actual time=50.100..500.150 rows=145 loops=1)
        Filter: ((stage = ANY ('{DELIVERED,IN_TRANSIT}'::text[])) AND (cod_status = 'PENDING'::cod_status) AND (is_final = false))
        Rows Removed by Filter: 1450
      ->  Index Scan using orders_pkey on orders o  (cost=0.29..2.70 rows=1 width=200) (actual time=3.250..3.260 rows=1 loops=145)
        Index Cond: (id = s.order_id)

Planning Time: 0.543 ms
Execution Time: 1050.234 ms
```

**Vấn đề**: Sequential Scan trên shipments (1.595 dòng) dù có filter. Cần index.

**Giải pháp**: Thêm index tổng hợp:
```sql
CREATE INDEX shipments_composite_idx 
ON shipments (stage, cod_status, is_final, created_at DESC NULLS LAST);
```

**Sau tối ưu**: (ngày 2025-07-22)
```
Limit  (cost=50.00..50.10 rows=20 width=456) (actual time=95.234..95.245 rows=20 loops=1)
  ->  Sort  (cost=50.00..52.00 rows=145 width=456) (actual time=95.200..95.210 rows=20 loops=1)
    ->  Index Scan using shipments_composite_idx on shipments s  (cost=0.29..40.00 rows=145 width=256) (actual time=10.100..85.150 rows=145 loops=1)
      Index Cond: ((stage = ANY (...)) AND (cod_status = 'PENDING') AND (is_final = false))

Planning Time: 0.301 ms
Execution Time: 95.234 ms
```

**Cải thiện**: 1050ms → 95ms (**91% nhanh hơn**)
```

---

## 4. Công thức so sánh

### 4.1 Tính % cải thiện

```
% Cải thiện = ((Trước - Sau) / Trước) × 100%
```

Ví dụ:
```
Kịch bản 8: 1200ms → 120ms
% Cải thiện = ((1200 - 120) / 1200) × 100% = 90%
```

### 4.2 So sánh với kỳ vọng (KPI)

```markdown
| Kịch bản | Giá trị đo | Kỳ vọng | % so với KPI | Kết luận |
|---|---|---|---|---|
| 1 | 482ms | < 500ms | 96.4% | ✓ PASS |
| 2 | 535ms | < 600ms | 89.2% | ✓ PASS |
| 7 | 575ms | < 600ms | 95.8% | ✓ PASS |
| 8 | 1260ms | < 1500ms | 84% | ✓ PASS |
```

---

## 5. Công cụ & công thức đo tự động

### 5.1 curl wrapper

```bash
#!/bin/bash
# Đo TTFB + thời gian download

URLS=(
  "http://localhost:3000/shipments"
  "http://localhost:3000/shipments?stage=DELIVERED"
  # ...
)

for url in "${URLS[@]}"; do
  echo "Testing: $url"
  for i in {1..3}; do
    curl -w "TTFB:%{time_starttransfer}s Download:%{time_total}s\n" -o /dev/null -s "$url"
  done
done
```

### 5.2 psql batch EXPLAIN

```sql
-- Lưu vào file: explain-batch.sql
\set ON_ERROR_STOP on

-- Kịch bản 1
\echo '=== Scenario 1: Default ==='
EXPLAIN (ANALYZE, TIMING ON)
SELECT ... FROM shipments ... LIMIT 20;

-- Kịch bản 2
\echo '=== Scenario 2: Filter stage ==='
EXPLAIN (ANALYZE, TIMING ON)
SELECT ... FROM shipments WHERE stage IN ('DELIVERED', 'RETURNING') ... LIMIT 20;

-- ... thêm các kịch bản

-- Chạy: psql -f explain-batch.sql
```

---

## 6. Kỳ vọng tổng thể

Dựa vào production 13/09/2026:

| Thước đo | Kỳ vọng | Ghi chú |
|---|---|---|
| TTFB (curl, clear cache) | 300–600ms | Tính từ server start |
| TTFB (DevTools, warm) | 400–700ms | Bao gồm overhead |
| Server Action | 250–500ms | listShipments + facets |
| SQL (danh sách) | 30–80ms | < 100 dòng, có index |
| SQL (facets) | 50–150ms | 6 truy vấn GROUP BY |
| Render (20 dòng) | 30–60ms | DataTable + Row |
| **E2E** | **400–800ms** | Tổng server + render |
| **Worst-case** | < 1500ms | Kịch bản 8 (bộ lọc nặng) |

---

## 7. Validation & Sanity checks

Sau khi đo xong, chạy các kiểm tra:

```markdown
## Sanity checks

- [ ] TTFB (curl) < TTFB (DevTools) — DevTools phải chậm hơn vì overhead
- [ ] Server Action > SQL — Server action bao gồm SQL
- [ ] Render time ≤ 100ms — Render chỉ dùng React
- [ ] E2E ≈ TTFB (curl) + Render — Phép cộng cơ bản
- [ ] Scenario 4 (hẹp) nhanh hơn scenario 3 (rộng) — Logic đúng
- [ ] Scenario 8 (nặng) là chậm nhất — WHERE clause phức tạp
- [ ] Số dòng trong bảng ≤ pageSize — LIMIT đúng
- [ ] Tất cả giá trị > 0 — Không có -1 hay giá trị sai
```

---

## 8. Lưu trữ & traceability

Mỗi lần đo, lưu:

1. **Tệp markdown** (tóm tắt): `docs/TECH-4-measurements/YYYY-MM-DD-baseline.md`
2. **Tệp log raw** (chi tiết): `/tmp/bench-YYYY-MM-DD.log` (upload sau)
3. **Git commit**: Ghi commit message với kết quả chính

Ví dụ commit message:
```
TECH-4: Baseline đo trang vận đơn

Đo 8 kịch bản trên 1.595 vận đơn:
- E2E trung bình: 619ms (kỳ vọng 400-800ms)
- Nhanh nhất (Kịch bản 6 - tìm kiếm): 365ms
- Chậm nhất (Kịch bản 3 - khoảng rộng): 712ms
- Worst-case (Kịch bản 8 - bộ lọc nặng): 1.260ms ⚠

Phát hiện: Kịch bản 8 vượt quá, cần tối ưu index.

Chi tiết: docs/TECH-4-measurements/2025-07-20-baseline.md
```
