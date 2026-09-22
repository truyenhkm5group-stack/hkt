# TECH-4: Chốt kịch bản đo chuẩn trang vận đơn

**Phạm vi**: Định nghĩa 8 kịch bản đo lặp lại được cho trang `/shipments` của ERP VNXcommerce, cùng chỉ số, công thức tính, và hướng dẫn chạy đo.

**Trạng thái**: ✅ Chốt kịch bản (TECH-4-mucrcyev)  
**Cập nhật**: 2025-07-XX

---

## Tài liệu gốc

Việc này bao gồm **4 tệp markdown** chính:

1. **`TECH-4-benchmark-scenarios.md`** — Định nghĩa 8 kịch bản cụ thể
   - Route: `/shipments`
   - Mục đích, dữ liệu đầu vào, URL, điểm đo
   - Kỳ vọng hiệu năng

2. **`TECH-4-metrics-definition.md`** — Định nghĩa chỉ số & công thức tính
   - TTFB (Time To First Byte)
   - Server Action Time
   - SQL Execution Time
   - DataTable Render Time
   - Cách đo từng chỉ số (curl, DevTools, EXPLAIN ANALYZE)
   - Công thức so sánh & validation

3. **`TECH-4-measurement-runbook.md`** — Hướng dẫn chạy đo chi tiết
   - Chuẩn bị môi trường (cài đặt, seed dữ liệu)
   - Quy trình đo từng kịch bản (3 lần lặp lại)
   - Tổng hợp kết quả
   - Troubleshooting

4. **`TECH-4-measurement-template.md`** — Biểu mẫu ghi kết quả
   - Template sẵn sàng để điền số liệu
   - Bảng so sánh 8 kịch bản
   - Phân tích & khuyến nghị
   - Ký duyệt

---

## 8 Kịch bản đo

| # | Kịch bản | Route | Mục đích | Dòng khớp |
|---|---|---|---|---|
| 1 | Tải lần đầu | `/shipments` | Baseline, mặc định mọi tham số | 1.595 |
| 2 | Đổi bộ lọc | `?stage=DELIVERED&stage=RETURNING` | Tác động WHERE clause 2 giá trị | 900–1000 |
| 3 | Khoảng ngày rộng | `?period=2024-01-01&period=2024-12-31` | Tác động khoảng ngày lớn (365 ngày) | ~3000 |
| 4 | Khoảng ngày hẹp | `?period=2024-12-28&period=2024-12-30` | Tối ưu — khoảng ngày hẹp (3 ngày) | 50–100 |
| 5 | Phân trang sâu | `?page=25&pageSize=20` | Tác động OFFSET lớn (OFFSET 480) | 20 |
| 6 | Tìm kiếm mã VTP | `?q=PKE1508909064` | Tìm kiếm (9 OR clauses + JOINs) | 1–5 |
| 7 | Sắp xếp COD | `?sort=codAmount&dir=desc` | Sắp xếp cột không có index | 1.595 |
| 8 | Bộ lọc tổng hợp | `?stage=DELIVERED&stage=IN_TRANSIT&cod=PENDING&final=active&product=Q002&care=NEW` | Worst-case (6+ WHERE + JOINs) | 50–200 |

---

## Chỉ số đo

Mỗi kịch bản đo **4 chỉ số chính**:

| Chỉ số | Cách đo | Dạng | Kỳ vọng |
|---|---|---|---|
| **TTFB** | curl `-w '%{time_starttransfer}'` | ms | < 600ms |
| **Server Action** | `performance.now()` log | ms | < 500ms |
| **SQL Time** | `EXPLAIN ANALYZE` | ms | < 100ms (danh sách) + 150ms (facets) |
| **Render Bảng** | React Profiler / performance API | ms | < 60ms |

**E2E Time** = TTFB + Render (tổng server + client)  
**Kỳ vọng**: < 700ms trung bình, < 1500ms worst-case

---

## Dữ liệu test (cố định)

- **Tổng vận đơn**: 1.595 (1.495 Pancake + 100 ngoài)
- **Đơn gốc**: 859 (giao TC: 642, hoàn: 217)
- **Vận đơn chiều về**: 100
- **Mã hàng**: 6 (Q001–Q006)
- **Khoảng ngày**: 90 ngày gần nhất
- **Người xử lý**: 3–5 (30% kiện gán)

**Seed lại trước mỗi lần đo**: `npm run demo:clear && npm run seed:demo`

---

## Quy trình chạy đo (tóm tắt)

### 1. Chuẩn bị (một lần)
```bash
npm install
npm run db:migrate
npm run demo:clear
npm run seed:demo
npm run dev  # Terminal 1: khởi động server
```

### 2. Đo mỗi kịch bản (3 lần lặp lại)
```bash
# Terminal 2: Chạy curl
curl -w "TTFB: %{time_starttransfer}s\n" -o /dev/null -s \
  http://localhost:3000/shipments[?params]

# Terminal 3: EXPLAIN ANALYZE (nếu có PostgreSQL)
psql postgresql://... -c "EXPLAIN (ANALYZE, TIMING ON) SELECT ..."
```

### 3. Ghi kết quả
- Điền số liệu vào template `TECH-4-measurement-template.md`
- Tính trung bình 3 lần
- Lưu tệp: `docs/TECH-4-measurements/YYYY-MM-DD.md`

---

## Định nghĩa công thức

### TTFB
```
TTFB = T_response_start - T_request_sent
```
**Đo bằng**: curl (chính xác) hoặc DevTools (bao gồm overhead)

### Server Action Time
```
Server Action = listShipments() + shipmentFacets() + overhead
```
**Đo bằng**: performance.now() log hoặc HTTP header

### SQL Time (từ EXPLAIN ANALYZE)
```
SQL Total = Planning Time + Execution Time
```
**Đo bằng**: `EXPLAIN (ANALYZE, TIMING ON)`

### E2E Time
```
E2E = TTFB + Render Time
```

---

## Validation & Sanity checks

Sau khi đo, kiểm tra:

- [ ] TTFB (curl) < TTFB (DevTools) — curl chính xác hơn
- [ ] Server Action > SQL — action bao gồm SQL
- [ ] Kịch bản 4 (hẹp) < Kịch bản 3 (rộng) — logic đúng
- [ ] Kịch bản 8 (nặng) là chậm nhất — WHERE phức tạp
- [ ] Số dòng hiển thị ≤ pageSize
- [ ] Không có giá trị âm hoặc > 10000ms (ngoài worst-case)

---

## Tiếp theo (Bước TECH-5 trở đi)

Sau khi chốt kịch bản này:

1. **TECH-5**: Chạy baseline đo — lần đo đầu tiên để có số gốc
2. **TECH-6**: Phân tích kết quả — xác định vấn đề (index, query, cache)
3. **TECH-7**: Tối ưu — thêm index / cache / rewrite query
4. **TECH-8**: Đo lại — so sánh sau tối ưu, tính % cải thiện
5. **TECH-9**: Báo cáo — ghi lại kết quả cuối cùng cho chủ shop

---

## Tệp liên quan

```
docs/
  ├── TECH-4-README.md (file này)
  ├── TECH-4-benchmark-scenarios.md ← 8 kịch bản cụ thể
  ├── TECH-4-metrics-definition.md ← Định nghĩa chỉ số & công thức
  ├── TECH-4-measurement-runbook.md ← Hướng dẫn chạy đo chi tiết
  ├── TECH-4-measurement-template.md ← Biểu mẫu ghi kết quả
  └── TECH-4-measurements/ (sau này)
      ├── 2025-07-20-baseline.md
      ├── 2025-07-22-after-index.md
      └── results-summary.md
```

---

## Cách dùng tài liệu

### Lần đầu chạy đo (Baseline)
1. Đọc: `TECH-4-benchmark-scenarios.md` (hiểu 8 kịch bản)
2. Đọc: `TECH-4-metrics-definition.md` (hiểu cách đo)
3. Chạy theo: `TECH-4-measurement-runbook.md` (chạy đo)
4. Ghi vào: `TECH-4-measurement-template.md` (lưu kết quả)

### Lần tối ưu & đo lại
1. Thực hiện tối ưu (thêm index, cache, v.v.)
2. Chạy lại theo runbook (cùng 8 kịch bản)
3. Ghi vào template mới (cùng dạng)
4. So sánh baseline vs after-fix

---

## Lưu ý quan trọng

1. **Dữ liệu phải giống nhau**: Reset trước mỗi lần đo (`npm run demo:clear && npm run seed:demo`)
2. **Chạy 3 lần mỗi kịch bản**: Vì OS cache, GC, quá trình khác chạy
3. **Ghi rõ context**: Phiên bản code, DB, OS, thời gian
4. **Không có "nhanh chắc chắn"**: Có sai số ±5–10%, nên ghi cả 3 lần
5. **So sánh apple-to-apple**: Cùng phiên bản code, cùng dữ liệu, cùng máy

---

## FAQ

**Q: Tại sao 8 kịch bản, không phải 5 hoặc 10?**  
A: 8 kịch bản đủ để che phủ: (1) baseline, (2) bộ lọc, (3-4) khoảng ngày, (5) phân trang, (6) tìm kiếm, (7) sắp xếp, (8) worst-case. Ít hơn sẽ bỏ lỡ vấn đề, nhiều hơn sẽ tốn thời gian không cần.

**Q: Tại sao 3 lần lặp lại?**  
A: Để bỏ qua sai số ngẫu nhiên (OS cache, GC, process khác). 3 lần là trung bình giữa độ tin cậy (>=5 tốt nhưng chậm) và tốc độ chạy.

**Q: Có thể dùng Apache Bench hoặc JMeter thay vì curl không?**  
A: Có thể, nhưng curl đơn giản hơn và đủ cho TTFB. JMeter/AB dùng khi cần load test (đo concurrent requests), không phải benchmark chuyên sâu.

**Q: Nếu không có PostgreSQL (chỉ PGlite)?**  
A: PGlite không hỗ trợ EXPLAIN ANALYZE text. Bỏ qua bước EXPLAIN, chỉ đo TTFB + Server Action + Render (vẫn đủ để so sánh).

**Q: Nếu dữ liệu seed không khớp dòng kỳ vọng?**  
A: Kiểm tra `SELECT count(*) FROM shipments` trong DB. Nếu sai, chạy lại `npm run seed:demo` hoặc ghi lại con số thực tế vào template (miễn sao lần sau tái lập được).

---

## Liên hệ & Hỗ trợ

- **Kịch bản không chạy**: Xem troubleshooting trong `TECH-4-measurement-runbook.md`
- **Giá trị đo bất thường**: Kiểm tra sanity checks trong `TECH-4-metrics-definition.md` mục 8
- **Không biết chạy bước nào**: Theo quy trình trong `TECH-4-measurement-runbook.md` bước 2.0 trở đi

---

**Người chốt**: [Tên agent]  
**Ngày chốt**: 2025-07-XX  
**Nhánh**: ai/architect/TECH-4-mucrcyev  
**Base commit**: a6a219c
