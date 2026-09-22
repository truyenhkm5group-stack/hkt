# TECH-4: Hướng dẫn chạy đo chuẩn chi tiết

**Mục đích**: Hướng dẫn từng bước cách chạy 8 kịch bản đo chuẩn trang vận đơn một cách nhất quán.

---

## 1. Chuẩn bị môi trường

### 1.1 Yêu cầu phần cứng & phần mềm

| Yêu cầu | Chi tiết |
|---|---|
| CPU | 4+ core (tránh máy quá tải) |
| RAM | 8GB+ (DB + Node + Browsers) |
| Kết nối mạng | Cách trục Internet ≥50Mbps (để bỏ qua biến số mạng) |
| Chrome/Chromium | Phiên bản mới nhất (DevTools chính xác) |
| PostgreSQL | 14+ hoặc PGlite (phụ thuộc `DATABASE_URL` trong `.env`) |
| Node.js | 22+ (quy định trong kho) |

### 1.2 Chuẩn bị máy

```bash
# 1. Clone repo (nếu chưa)
git clone <repo-url>
cd <repo>
git checkout ai/architect/TECH-4-mucrcyev

# 2. Cài đặt dependencies
npm install

# 3. Chuẩn bị .env
cp .env.example .env
# Sửa DATABASE_URL nếu cần (để PGlite hoặc Postgres local)

# 4. Reset DB
npm run db:migrate              # Áp dụng migration (hoặc tự động khi server start)

# 5. Seed dữ liệu baseline
npm run demo:clear              # Xoá dữ liệu cũ (nếu có)
npm run seed:demo               # Nạp ~1.595 vận đơn

# 6. Kiểm tra dữ liệu
npm run sync -- all --dryRun    # Hoặc query DB trực tiếp
```

### 1.3 Dọn dẹp trước khi đo

```bash
# Tắt tất cả service nền đang chạy
pkill -f "npm run dev"
pkill -f "npm run scheduler"

# Xóa cache Node
rm -rf .next/
npm cache clean --force

# Xóa cache trình duyệt (sẽ làm ở DevTools)

# Nếu dùng PostgreSQL, tính lại stats (để planner tối ưu)
psql <database-url> -c "ANALYZE;"

# Nếu dùng PGlite, không cần (single-process)
```

---

## 2. Quy trình đo từng kịch bản

### 2.0 Chuẩn bị (chung cho tất cả)

```bash
# Terminal A: Khởi động server dev (chỉ một lần)
npm run dev
# Đợi log "ready - started server on 0.0.0.0:3000"

# Terminal B: Để sẵn cho curl / scripts
# (dùng cho các bước 2.1–2.8 dưới)
```

---

### 2.1 Kịch bản 1: Tải lần đầu (mặc định)

#### 2.1.1 Chuẩn bị (chỉ một lần)

```bash
# Terminal B: Xóa cache trình duyệt
# Chrome DevTools → Application → Clear storage → Clear all

# Hoặc dùng curl (không cache)
curl -i -H "Cache-Control: no-cache" http://localhost:3000/shipments > /dev/null 2>&1 &
sleep 1
```

#### 2.1.2 Chạy đo (3 lần, lấy giá trị trung bình)

**Lần 1**:
```bash
# Terminal B:
curl -w "\nTTFB: %{time_starttransfer}s\n" -o /dev/null -s http://localhost:3000/shipments

# Terminal A (server log):
# Tìm dòng: "shipments GET ... <time>ms" (nếu có log)
```

**Lần 2 & 3**: Lặp lại lần 1

#### 2.1.3 Đo chi tiết (TTFB + SQL)

```bash
# Terminal B:
# 1. Bật Network tab trong Chrome DevTools (F12)
# 2. Clear cache (Ctrl+Shift+Delete)
# 3. Reload (Ctrl+R hoặc Cmd+R)
# 4. Xem Network → shipments (request) → Timing tab:
#    - Queuing
#    - DNS Lookup
#    - Initial connection
#    - TLS handshake
#    - Request sent
#    - TTFB  ← **ĐÂY là cái cần**
#    - Content Download
# 5. Ghi lại giá trị TTFB (ms)

# Ngoài lề: Nếu máy làm chạy DB riêng
npm run bench -- shipments:list 2>&1 | tee /tmp/bench-s1.log
# (nếu script này tồn tại)
```

#### 2.1.4 Đo thời gian server action (optional, cần sửa code)

```bash
# Tạm thêm log vào app/(dashboard)/shipments/page.tsx:
# const t0 = performance.now();
# const data = await listShipments(params);
# const t1 = performance.now();
# console.log(`[BENCH] listShipments: ${(t1-t0).toFixed(2)}ms`);

# Sau đó kiểm tra Terminal A log
```

#### 2.1.5 EXPLAIN ANALYZE (SQL baseline)

```bash
# Terminal B:
# Kết nối tới DB (nếu PGlite, có thể không làm được; nếu Postgres cục bộ)

psql postgresql://localhost/erp

-- Trong psql:
-- Kịch bản 1: 20 dòng đầu tiên (trang 1)
-- Lấy chính xác SELECT từ lib/queries/shipments.ts::listShipments()

EXPLAIN (ANALYZE, BUFFERS, TIMING ON) 
SELECT DISTINCT s.id, s.created_at, s.stage, s.vtp_status_name, ... 
FROM shipments s 
LEFT JOIN orders o ON o.id = s.order_id 
WHERE s.created_at >= NOW() - INTERVAL '90 days'
ORDER BY s.created_at DESC 
LIMIT 20;

-- Ghi lại:
-- - Execution Time (actual): ...ms
-- - Planning Time: ...ms  
-- - Rows: 20
-- - Buffers: ... (nếu có)
```

#### 2.1.6 Ghi lại kết quả

```markdown
## Kịch bản 1: Tải lần đầu (mặc định)

**Ngày/Giờ**: [YYYY-MM-DD HH:MM UTC]  
**Lần chạy**: 1/3

| Chỉ số | Lần 1 | Lần 2 | Lần 3 | Trung bình |
|---|---|---|---|---|
| TTFB (curl) | XXXms | XXXms | XXXms | **XXXms** |
| SQL Plan time | XXms | | | **XXms** |
| SQL Exec time | XXXms | | | **XXXms** |
| Dòng trả về | 20 | 20 | 20 | 20 |

**Lệnh**:
```bash
curl -w "TTFB: %{time_starttransfer}s" http://localhost:3000/shipments
EXPLAIN (ANALYZE, TIMING) SELECT ... LIMIT 20;
```

**Ghi chú**: [Lưu ý gì đó nếu có]
```

---

### 2.2 Kịch bản 2: Đổi bộ lọc trạng thái

#### 2.2.1 Chạy

```bash
# URL với bộ lọc stage=DELIVERED&stage=RETURNING
curl -w "\nTTFB: %{time_starttransfer}s\n" -o /dev/null -s \
  "http://localhost:3000/shipments?stage=DELIVERED&stage=RETURNING"

# Hoặc trong trình duyệt:
# Bấm vào filter, chọn "DELIVERED" + "RETURNING", ghi TTFB từ DevTools
```

#### 2.2.2 EXPLAIN ANALYZE

```sql
EXPLAIN (ANALYZE, TIMING ON) 
SELECT DISTINCT s.id, ... 
FROM shipments s 
LEFT JOIN orders o ON o.id = s.order_id 
WHERE (s.stage = 'DELIVERED' OR s.stage = 'RETURNING') 
  AND s.created_at >= NOW() - INTERVAL '90 days'
ORDER BY s.created_at DESC 
LIMIT 20;
```

---

### 2.3–2.8 Các kịch bản còn lại

**Thực hiện cùng cách như 2.1 & 2.2**, thay URL tương ứng:

#### 2.3 Khoảng ngày rộng (365 ngày)
```bash
# URL:
http://localhost:3000/shipments?period_from=2024-01-01&period_to=2024-12-31

# SQL WHERE:
WHERE s.created_at BETWEEN '2024-01-01' AND '2024-12-31' + interval '1 day'
```

#### 2.4 Khoảng ngày hẹp (3 ngày)
```bash
# URL:
http://localhost:3000/shipments?period_from=2024-12-28&period_to=2024-12-30

# SQL WHERE:
WHERE s.created_at BETWEEN '2024-12-28' AND '2024-12-30' + interval '1 day'
```

#### 2.5 Phân trang sâu (trang 25)
```bash
# URL:
http://localhost:3000/shipments?page=25&pageSize=20

# SQL:
LIMIT 20 OFFSET 480;

# So sánh EXPLAIN ANALYZE với trang 1 (OFFSET 0)
```

#### 2.6 Tìm kiếm theo mã VTP
```bash
# URL (ví dụ):
http://localhost:3000/shipments?q=PKE1508909064

# SQL WHERE:
WHERE (s.tracking_code ILIKE '%PKE1508909064%' 
   OR s.vtp_order_number ILIKE '%PKE1508909064%'
   OR ... 9 điều kiện khác ...)

# Ghi chú: 9 điều kiện OR có thể chậm
```

#### 2.7 Sắp xếp theo cột COD
```bash
# URL:
http://localhost:3000/shipments?sort=codAmount&dir=desc

# SQL ORDER BY:
ORDER BY s.cod_amount DESC NULLS LAST, s.id DESC

# Lưu ý: cod_amount có NULL nhiều, có index không?
```

#### 2.8 Bộ lọc tổng hợp (nặng nhất)
```bash
# URL:
http://localhost:3000/shipments?\
  stage=DELIVERED&stage=IN_TRANSIT&\
  cod=PENDING&\
  final=active&\
  product=Q002&\
  care=NEW

# SQL WHERE:
WHERE (s.stage IN ('DELIVERED', 'IN_TRANSIT'))
  AND s.cod_status = 'PENDING'
  AND s.is_final = false
  AND EXISTS (
    SELECT 1 FROM shipment_care sc 
    WHERE sc.shipment_id = s.id AND sc.active AND sc.care_status = 'NEW'
  )
  AND EXISTS (
    SELECT 1 FROM order_items oi 
    WHERE oi.order_id = s.order_id AND oi.sku ILIKE '%Q002%'
  )
```

---

## 3. Tổng hợp kết quả

### 3.1 Tạo bảng tổng hợp

```markdown
# Kết quả đo TECH-4 — Ngày [YYYY-MM-DD]

**Phiên bản**: commit [abc1234]  
**Số lượt chạy**: 3 (lấy trung bình)  
**Dữ liệu**: 1.595 vận đơn, 859 đơn Pancake  

## Bảng tổng hợp

| Kịch bản | TTFB | Server Action | SQL Total | Render | Tổng Server | Tổng E2E |
|---|---|---|---|---|---|---|
| 1. Tải lần đầu | XXXms | XXXms | XXXms | XXms | **XXXms** | **XXXms** |
| 2. Đổi bộ lọc | XXXms | XXXms | XXXms | XXms | **XXXms** | **XXXms** |
| 3. Khoảng ngày rộng | XXXms | XXXms | XXXms | XXms | **XXXms** | **XXXms** |
| 4. Khoảng ngày hẹp | XXXms | XXXms | XXXms | XXms | **XXXms** | **XXXms** |
| 5. Phân trang sâu | XXXms | XXXms | XXXms | XXms | **XXXms** | **XXXms** |
| 6. Tìm kiếm mã VTP | XXXms | XXXms | XXXms | XXms | **XXXms** | **XXXms** |
| 7. Sắp xếp COD | XXXms | XXXms | XXXms | XXms | **XXXms** | **XXXms** |
| 8. Bộ lọc tổng hợp | XXXms | XXXms | XXXms | XXms | **XXXms** | **XXXms** |
| **Trung bình** | | | | | **XXXms** | **XXXms** |
| **Max** | | | | | **XXXms** | **XXXms** |

## Quan sát

- Kịch bản [X] chậm nhất vì: ...
- Kịch bản [Y] nhanh nhất vì: ...
- Index cần tối ưu: ...
- Truy vấn cần rewrite: ...

## Tiếp theo

- [ ] Thêm index trên: ...
- [ ] Tối ưu query: ...
- [ ] Cache bộ lọc: ...
```

### 3.2 Lưu tệp đo

```bash
# Tạo thư mục (nếu chưa có)
mkdir -p docs/TECH-4-measurements

# Lưu tệp markdown kết quả
cp /tmp/measurement-YYYY-MM-DD.md docs/TECH-4-measurements/

# Lưu tệp log chi tiết (nếu có)
cp /tmp/bench-*.log docs/TECH-4-measurements/
```

---

## 4. So sánh nhiều lần đo

### 4.1 Format so sánh

Sau khi đo lần thứ 2 (sau tối ưu), tạo bảng so sánh:

```markdown
# So sánh Before/After — TECH-4

## Baseline (2025-07-20)

[Bảng kết quả từ ngày 2025-07-20]

## After Index (2025-07-22)

[Bảng kết quả từ ngày 2025-07-22]

## Cải thiện

| Kịch bản | Before | After | % Cải thiện | Ghi chú |
|---|---|---|---|---|
| 1 | XXXms | XXXms | +YY% | Thêm index trên `created_at` |
| ... | ... | ... | ... | ... |
| **Trung bình** | **XXXms** | **XXXms** | **+YY%** | |

## Kết luận

- Hiệu quả: Tăng tốc độ **YY%** trên kịch bản trung bình
- Worst-case: Kịch bản [X] vẫn chậm [nguyên nhân]
- Tiếp theo: [Công việc tiếp]
```

---

## 5. Tự động hoá (optional)

### 5.1 Script bench đơn giản

```bash
#!/bin/bash
# scripts/bench-shipments.sh

SCENARIOS=(
  "http://localhost:3000/shipments"
  "http://localhost:3000/shipments?stage=DELIVERED&stage=RETURNING"
  "http://localhost:3000/shipments?page=25&pageSize=20"
  # ... thêm các URL khác
)

for url in "${SCENARIOS[@]}"; do
  echo "=== Testing: $url ==="
  for i in {1..3}; do
    echo "  Lần $i:"
    curl -w "    TTFB: %{time_starttransfer}s\n" -o /dev/null -s "$url"
  done
done
```

### 5.2 Script EXPLAIN tự động

```sql
-- scripts/bench-shipments.sql
-- Chạy bằng: psql -f scripts/bench-shipments.sql

\set ON_ERROR_STOP on
\timing on

-- Kịch bản 1
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT s.id, s.created_at, ... FROM shipments s ... LIMIT 20;

-- Kịch bản 2
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT s.id, ... FROM shipments s WHERE s.stage IN ('DELIVERED', 'RETURNING') ... LIMIT 20;

-- ... thêm các kịch bản khác
```

---

## 6. Troubleshooting

| Vấn đề | Giải pháp |
|---|---|
| TTFB luôn > 1000ms | DB chậm hoặc chưa có index. Chạy EXPLAIN ANALYZE để xác định. |
| SQL không trả về 20 dòng | Bộ lọc quá chặt hoặc dữ liệu chưa seed. Kiểm tra SELECT count(*) FROM shipments WHERE ... |
| EXPLAIN ANALYZE bị timeout | Truy vấn quá nặng, không có index. Hãy thêm index trước. |
| Kết quả không ổn định (lên xuống) | Bộ nhớ đệm OS / GC chạy. Chạy `sync; echo 3 > /proc/sys/vm/drop_caches` (Linux) hoặc chạy 10 lần lấy giá trị cuối. |
| "psql: command not found" | PostgreSQL chưa cài. Nếu dùng PGlite, bỏ qua EXPLAIN (PGlite không hỗ trợ EXPLAIN text). |

---

## 7. Checklist trước khi báo "xong"

- [ ] Đã seed dữ liệu baseline (1.595 vận đơn)
- [ ] Đã chạy 8 kịch bản (mỗi kịch bản 3 lần)
- [ ] Đã ghi lại giá trị TTFB từ curl hoặc DevTools
- [ ] Đã chạy EXPLAIN ANALYZE cho mỗi kịch bản
- [ ] Đã tổng hợp kết quả vào bảng
- [ ] Đã lưu tệp markdown vào `docs/TECH-4-measurements/`
- [ ] Đã commit & push tệp kịch bản
- [ ] Không có số liệu bị mất hoặc chưa rõ (ghi "?" nếu không đo được)

---

## 8. Kỳ vọng hiệu năng (từ HANDOFF.md)

Dựa vào production hiện tại (13/09/2026):

| Kỳ vọng | Giá trị |
|---|---|
| TTFB trung bình | 300–600ms |
| SQL list (<100 dòng) | 50–150ms |
| SQL facets | 80–200ms |
| Render bảng 20 dòng | 30–80ms |
| **Tổng E2E** | **400–800ms** |
| Worst-case (kịch bản 8) | <1500ms |

Nếu chỉ số vượt quá, cần tối ưu (index, cache, rewrite query).

---

## Tài liệu tham khảo

- `docs/TECH-4-benchmark-scenarios.md` — Định nghĩa 8 kịch bản
- `lib/queries/shipments.ts` — Hàm truy vấn
- `AGENTS.md` mục 6.2, 6.3 — Business rules vận đơn
- PostgreSQL EXPLAIN: https://www.postgresql.org/docs/current/sql-explain.html
