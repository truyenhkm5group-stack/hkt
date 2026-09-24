# TECH-4: Kịch bản đo chuẩn trang vận đơn

**Mục đích**: Xác định chính xác các kịch bản có thể lặp lại được khi đo hiệu năng trang vận đơn (`/shipments`), để các bước sau so sánh với nhau được.

**Ngày chốt**: 2026-09-22 (bản đầu ghi nhầm "2025-07-XX") · **Phiên bản base**: a6a219c (TECH-4-mucrcyev)

---

## 1. Route & Scope

**Route chính**: `GET /shipments`  
**Loại dữ liệu**: Danh sách vận đơn với bộ lọc, sắp xếp, phân trang (Server Component → `listShipments()`)

**Phạm vi đo**:
- **TTFB (Time To First Byte)**: từ khi gửi request tới khi máy chủ bắt đầu streaming HTML
- **Thời gian server action**: thời gian `listShipments()` + `shipmentFacets()` trong server component (không bao gồm render React)
- **Thời gian truy vấn SQL**: từng câu lệnh SELECT riêng biệt (exclude network I/O tới DB)
- **Thời gian render bảng**: từ khi data tới client tới khi bảng ổn định (DataTable + dòng)

---

## 2. Dữ liệu đầu vào cố định

### 2.1 Dữ liệu test (seed sẵn)

**Qui chuẩn**: mỗi lần chạy đều reset về trạng thái này. Sử dụng fixture từ `tests/sync-fixtures.test.ts` hoặc tạo dữ liệu mới toàn bộ.

| Thực thể | Số lượng | Ghi chú |
|---|---|---|
| Vận đơn tổng | **1.595** | Gồm 1.495 có đơn Pancake + 100 vận đơn ngoài Pancake |
| Đơn gốc (Pancake) | **859** | Giao thành công: 642, hoàn/hủy: 217 |
| Vận đơn chiều về | **100** | Mã gốc + 1P1 (khai trong cột "Mã đơn hàng" của tệp VTP) |
| Trạng thái vận đơn | Đa dạng | PENDING, PICKED_UP, IN_TRANSIT, DELIVERED, RETURNING, RETURNED, CANCELLED |
| Mã hàng (SKU) | **6** | Q002, Q003, Q004, Q005, Q001, Q006 |
| Người xử lý chăm sóc | **3** | Gán ngẫu nhiên trên 30% kiện |
| Khoảng ngày | 90 ngày | Từ ngày T-90 đến hôm nay (sắp xếp `createdAt`) |

### 2.2 Tài khoản & quyền truy cập

- **User**: `test@shop.local` (vai trò Quản lý hoặc cao hơn, có quyền xem toàn bộ vận đơn)
- **Phạm vi dữ liệu**: `ALL` (không giới hạn theo phòng/nhân viên)

---

## 3. Kịch bản đo (scenarios)

Mỗi kịch bản là một URL request cụ thể, có thể lặp lại được bằng cách sao chép hoặc dùng script tự động.

### Kịch bản 1: Tải trang lần đầu (mặc định)
**Mục đích**: Đo hiệu năng tải lần đầu, không bộ nhớ đệm, trạng thái mặc định.

**URL**:
```
/shipments
```

**Tham số**:
- Kỳ: 90 ngày gần nhất (mặc định)
- Bộ lọc: không
- Sắp xếp: `createdAt` descending (mặc định)
- Trang: 1
- Kích thước trang: 20 (mặc định)

**Đầu vào**:
- Không cache (clear `lib/cache.ts` phiên trước)
- Không cookie session tồn tại (fresh login)

**Điểm đo**:
- TTFB
- Thời gian `listShipments()` (lấy 20 dòng + tính `ORDER_OUTCOME`)
- Thời gian `shipmentFacets()` (đếm bộ lọc)
- Thời gian render bảng 20 dòng
- SQL: 2–3 câu (danh sách + summary + facets)

**Kỳ vọng**: ~500–800ms (tùy DB)

---

### Kịch bản 2: Đổi bộ lọc trạng thái
**Mục đích**: Đo tác động của bộ lọc vào thời gian truy vấn (WHERE clause phức tạp).

**URL**:
```
/shipments?stage=DELIVERED&stage=RETURNING
```

**Tham số**:
- Bộ lọc: `stage IN ('DELIVERED', 'RETURNING')`
- Sắp xếp: `createdAt` desc
- Trang: 1
- Kích thước trang: 20

**Đầu vào**:
- Tái sử dụng session từ kịch bản 1 (cache có)
- Vận đơn khớp bộ lọc: ~900–1.000 dòng

**Điểm đo**:
- TTFB (so với mặc định)
- Thời gian `listShipments()` với WHERE bổ sung
- Thời gian `shipmentFacets()` (lọc cơ sở)
- SQL: EXPLAIN ANALYZE cho WHERE clause

**Kỳ vọng**: +50–200ms so với kịch bản 1 (vì số dòng lớn hơn)

---

### Kịch bản 3: Khoảng ngày rộng (365 ngày)
**Mục đích**: Đo tác động của khoảng ngày lớn vào số dòng kết quả.

**URL**:
```
/shipments?period=2024-01-01&period=2024-12-31
```

**Tham số**:
- Kỳ: 365 ngày (toàn năm 2024)
- Bộ lọc: không
- Sắp xếp: `createdAt` desc
- Trang: 1
- Kích thước trang: 20

**Đầu vào**:
- Vận đơn khớp: ~3.000 (gấp đôi dữ liệu test chuẩn — cần seed thêm)
- Bộ nhớ đệm: có (nếu đã tải kịch bản 1)

**Điểm đo**:
- Thời gian `shipmentFacets()` (đếm trên 3.000 dòng)
- Thời gian tính `ORDER_OUTCOME` cho 20 dòng (giới hạn LIMIT/OFFSET không ảnh hưởng)
- Index efficiency: EXPLAIN cho `shipments.createdAt`

**Kỳ vọng**: +100–300ms (facets chậm hơn)

---

### Kịch bản 4: Khoảng ngày hẹp (3 ngày)
**Mục đích**: Đo tác động ngược — khoảng ngày hẹp dẫn tới facets nhanh hơn.

**URL**:
```
/shipments?period=2024-12-28&period=2024-12-30
```

**Tham số**:
- Kỳ: 3 ngày
- Bộ lọc: không
- Sắp xếp: `createdAt` desc
- Trang: 1
- Kích thước trang: 20

**Đầu vào**:
- Vận đơn khớp: ~50–100
- Facets sẽ trống hoặc rất ít giá trị

**Điểm đo**:
- Thời gian `shipmentFacets()` (tối ưu)
- Tổng TTFB (nhanh nhất trong kịch bản 1–4)

**Kỳ vọng**: ~300–500ms

---

### Kịch bản 5: Phân trang sâu (trang 25)
**Mục đích**: Đo tác động OFFSET lớn (trang 25 = 480 dòng bỏ qua).

**URL**:
```
/shipments?page=25&pageSize=20
```

**Tham số**:
- Kỳ: 90 ngày
- Bộ lọc: không
- Trang: 25
- Kích thước trang: 20
- OFFSET: 480

**Đầu vào**:
- OFFSET càng lớn, Postgres càng lâu quét
- Query plan: Sequential scan hay Index scan?

**Điểm đo**:
- Thời gian `listShipments()` với OFFSET 480
- SQL: EXPLAIN ANALYZE so với trang 1
- Server time (có chậm hơn trang 1 không)

**Kỳ vọng**: +50–150ms so với trang 1 (phụ thuộc index)

---

### Kịch bản 6: Tìm kiếm theo mã vận đơn
**Mục đích**: Đo hiệu năng tìm kiếm (ILIKE + OR + JOIN).

**URL**:
```
/shipments?q=PKE1508909064
```

**Tham số**:
- Kỳ: 90 ngày
- Tìm kiếm: mã vận đơn (VTP order number) hoặc mã tracking
- Kết quả kỳ vọng: 1–5 dòng

**Đầu vào**:
- `shipmentSearchCondition()` chạy 9 điều kiện OR (tracking code, order ref, phone, name, order.id, order.phone, order items…)
- Một số JOIN nested
- Kỳ vọng chỉ 1–2 dòng ra (hiệu quả cao)

**Điểm đo**:
- Thời gian WHERE clause với 9 OR
- Số dòng quét (sequential vs index)
- TTFB (nhanh vì kết quả ít)

**Kỳ vọng**: ~100–300ms

---

### Kịch bản 7: Đổi sắp xếp theo cột COD
**Mục đích**: Đo tác động sắp xếp cột số (khác `createdAt`).

**URL**:
```
/shipments?sort=codAmount&dir=desc
```

**Tham số**:
- Kỳ: 90 ngày
- Sắp xếp: `shipments.codAmount DESC NULLS LAST`
- Trang: 1

**Đầu vào**:
- Cột có NULL nhiều (nhiều vận đơn COD = 0 hoặc empty)
- NULLS LAST buộc sắp xếp đặc biệt

**Điểm đo**:
- Thời gian ORDER BY với NULL handling
- So sánh với ORDER BY `createdAt` (index có sẵn)

**Kỳ vọng**: +100–200ms (không có sẵn index, phải scan)

---

### Kịch bản 8: Bộ lọc tổng hợp (chạy nặng)
**Mục đích**: Đo hiệu năng worst-case — nhiều bộ lọc kết hợp.

**URL**:
```
/shipments?stage=DELIVERED&stage=IN_TRANSIT&cod=PENDING&final=active&product=Q002&care=NEW
```

**Tham số**:
- Trạng thái: 2 giá trị
- COD status: PENDING
- Trạng thái chăm sóc: NEW (chưa có ca nào)
- Sản phẩm: Q002
- Còn theo dõi: yes

**Đầu vào**:
- WHERE clause 6+ điều kiện
- Có JOIN với `orderItems`, `shipmentCare`
- Kỳ vọng: ~50–200 dòng

**Điểm đo**:
- Tổng thời gian `listShipments()` với 6+ WHERE
- Index efficiency (có bao nhiêu index được dùng)
- Thời gian JOIN so với WHERE đơn

**Kỳ vọng**: ~500–1.000ms (nặng nhất)

---

## 4. Chỉ số đo chi tiết

### 4.1 TTFB (Time To First Byte)
- **Định nghĩa**: Khoảng từ khi request gửi tới khi server bắt đầu ghi bytes HTTP response header
- **Công cụ**: Chrome DevTools → Network → Timing → TTFB hoặc `curl -w '%{time_starttransfer}'`
- **Ghi chú**: TTFB không bao gồm network latency, chỉ server processing time
- **Dạng ghi**: `<milliseconds>ms`

### 4.2 Thời gian Server Action (`listShipments()` + `shipmentFacets()`)
- **Định nghĩa**: Tổng thời gian chạy hàm truy vấn trong server component (không bao gồm render React)
- **Công cụ**: 
  - Thêm `console.time()` / `console.timeEnd()` ở `app/(dashboard)/shipments/page.tsx`
  - Hoặc thêm log timestamps vào `listShipments()` 
  - Hoặc dùng OpenTelemetry nếu có
- **Ghi chú**: Bao gồm network I/O tới DB + tính toán
- **Dạng ghi**: `<milliseconds>ms` (5–6 chữ số)

### 4.3 Thời gian Truy vấn SQL
- **Định nghĩa**: Thời gian từ khi Postgres bắt đầu quá trình tính cho tới khi trả kết quả
- **Công cụ**: `EXPLAIN (ANALYZE, TIMING) <query>`
- **Ghi chú**: Đo thực hiện, không chỉ plan
- **Câu lệnh cần đo**:
  1. `shipments.findMany()` (danh sách + LEFT JOIN orders + ORDER BY LIMIT OFFSET)
  2. `count()` từng shipments (summary)
  3. `shipmentFacets()` (6+ truy vấn GROUP BY riêng biệt)
- **Dạng ghi**: `<milliseconds>ms` và số dòng quét (rows returned, rows sequentially scanned)

### 4.4 Thời gian Render Bảng (DataTable)
- **Định nghĩa**: Từ khi data được pass vào component DataTable tới khi tất cả dòng được render trên DOM
- **Công cụ**: 
  - React Profiler (`<Profiler>` component)
  - Chrome DevTools → Performance → User Timing
  - Hoặc `performance.measure()` ở component
- **Ghi chú**: Chỉ include render, không include fetch data
- **Dạng ghi**: `<milliseconds>ms`

---

## 5. Dữ liệu baseline (chưa tối ưu)

| Kịch bản | TTFB | Server Action | SQL Total | Render Bảng | Tổng |
|---|---|---|---|---|---|
| 1. Tải lần đầu | ?ms | ?ms | ?ms | ?ms | ?ms |
| 2. Đổi bộ lọc | ?ms | ?ms | ?ms | ?ms | ?ms |
| 3. Khoảng ngày rộng | ?ms | ?ms | ?ms | ?ms | ?ms |
| 4. Khoảng ngày hẹp | ?ms | ?ms | ?ms | ?ms | ?ms |
| 5. Phân trang sâu | ?ms | ?ms | ?ms | ?ms | ?ms |
| 6. Tìm kiếm mã VTP | ?ms | ?ms | ?ms | ?ms | ?ms |
| 7. Sắp xếp COD | ?ms | ?ms | ?ms | ?ms | ?ms |
| 8. Bộ lọc tổng hợp | ?ms | ?ms | ?ms | ?ms | ?ms |

---

## 6. Hướng dẫn chạy đo

### 6.1 Chuẩn bị dữ liệu

```bash
# 1. Reset DB về trạng thái sạch
npm run demo:clear

# 2. Seed dữ liệu test chuẩn (1.595 vận đơn)
npm run seed:demo

# 3. Kiểm tra số dòng
npm run check:integrations  # (hoặc query SELECT count(*) FROM shipments)
```

### 6.2 Chạy trang và đo TTFB

```bash
# Terminal 1: Khởi động dev server
npm run dev  # http://localhost:3000

# Terminal 2: Đo TTFB + server log
curl -w "@curl-format.txt" -o /dev/null -s http://localhost:3000/shipments

# Hoặc dùng DevTools:
# 1. Mở DevTools (F12)
# 2. Chuyển tới Network tab
# 3. Load page: Ctrl+Shift+Delete (clear cache trước), rồi F5
# 4. Xem mục "shipments" → Timing → TTFB
```

### 6.3 Chạy EXPLAIN ANALYZE

```bash
# Kết nối tới DB (qua ops hoặc local psql)
psql postgresql://...

-- Kịch bản 1: Tải lần đầu
EXPLAIN (ANALYZE, TIMING) SELECT ... FROM shipments LEFT JOIN orders ON ... ORDER BY created_at DESC LIMIT 20;

-- Kịch bản 5: Phân trang sâu (trang 25)
EXPLAIN (ANALYZE, TIMING) SELECT ... FROM shipments ... ORDER BY created_at DESC LIMIT 20 OFFSET 480;

-- Kịch bản 7: Sắp xếp COD
EXPLAIN (ANALYZE, TIMING) SELECT ... FROM shipments ... ORDER BY cod_amount DESC NULLS LAST LIMIT 20;
```

### 6.4 Đo render bảng (DevTools)

```javascript
// Paste vào console khi page đã load:
performance.mark('table-start');
// Kích hoạt render (bấm nút sắp xếp hoặc đổi trang)
// Khi dòng hiện xong:
performance.mark('table-end');
performance.measure('table-render', 'table-start', 'table-end');
console.log(performance.getEntriesByName('table-render')[0].duration);
```

---

## 7. Ghi chép kết quả

Mỗi lần đo, tạo một branch mới trong `docs/TECH-4-measurements/` để lưu raw data:

```
docs/TECH-4-measurements/
  ├── 2025-07-XX-baseline.md        (chạy trước)
  ├── 2025-07-XX-after-index.md     (sau khi thêm index)
  ├── 2025-07-XX-after-cache.md     (sau khi tối ưu cache)
  └── results-summary.md            (tổng hợp)
```

**Format ghi mỗi lần đo**:
```markdown
## Kịch bản N: [Tên]

**Thời gian**: 2025-07-XX 14:30 UTC  
**Phiên bản**: commit abc1234  
**Tester**: [Tên người]

| Chỉ số | Giá trị | Ghi chú |
|---|---|---|
| TTFB | 425ms | Network latency 20ms (estimate) |
| Server Action | 380ms | listShipments 280ms + facets 100ms |
| SQL List | 180ms | Tuần tự scan 1.595 dòng, 20 dòng return |
| SQL Facets | 95ms | 6 truy vấn GROUP BY riêng |
| Render | 45ms | DataTable + 20 Row component |
| **Tổng (Server)** | **380ms** | Không include network |
| **Tổng (Client to Server)** | **520ms** | TTFB + render |

**Lệnh chạy**:
\`\`\`bash
curl -w '@curl-format.txt' http://localhost:3000/shipments?...
EXPLAIN ANALYZE SELECT ... LIMIT 20;
\`\`\`

**Kết luận**: [Nhanh / Chậm / Bình thường] so với kỳ vọng.
```

---

## 8. Lưu ý quan trọng

1. **Reset dữ liệu trước mỗi phiên đo** để kết quả nhất quán.
2. **Chạy đo 2–3 lần liên tiếp** cho mỗi kịch bản, ghi giá trị trung bình (vì OS cache, GC…).
3. **Tắt plugins, extensions** trong trình duyệt (ảnh hưởng DevTools).
4. **Tách TTFB từ rendering** — nếu muốn đo server thực, dùng curl + EXPLAIN, không dùng DevTools (DevTools thêm overhead).
5. **Tại sao 8 kịch bản?** Để che phủ các tình huống chính:
   - Mặc định + nhất quán (1)
   - Sắc thái bộ lọc (2)
   - Kích thước kết quả (3, 4)
   - Offset lớn (5)
   - Search + JOIN (6)
   - Cột không có index (7)
   - Worst-case (8)

---

## 9. Tiếp theo

Sau khi chốt kịch bản này, bước TECH-4 kế tiếp sẽ:
1. Chạy đo baseline để có số liệu gốc
2. Cải tiến (thêm index, cache, query tối ưu)
3. Chạy lại 8 kịch bản để so sánh
4. Báo cáo %improvement cho chủ shop
