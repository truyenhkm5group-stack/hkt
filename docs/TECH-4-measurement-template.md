# TECH-4: Biểu mẫu ghi kết quả đo chuẩn

**Ngày đo**: [YYYY-MM-DD]  
**Người đo**: [Tên]  
**Phiên bản code**: [commit hash]  
**Số lượt chạy mỗi kịch bản**: 3 (ghi tất cả, tính trung bình ở hàng cuối)

---

## Dữ liệu test

| Thông tin | Giá trị |
|---|---|
| Tổng vận đơn | 1.595 |
| Vận đơn Pancake | 1.495 |
| Vận đơn ngoài Pancake | 100 |
| Khoảng ngày (mặc định) | 90 ngày gần nhất |
| Mã hàng | 6 (Q001–Q006) |
| Người xử lý | 3–5 |
| Trạng thái vận đơn | Đa dạng (PENDING, DELIVERED, RETURNING, ...) |
| Database | [PostgreSQL 14 / PGlite] |
| Server | localhost:3000 |
| Browser | [Chrome version] |
| OS | [Linux/macOS/Windows] |

---

## Kịch bản 1: Tải lần đầu (mặc định)

**URL**: `/shipments`  
**Bộ lọc**: Không  
**Sắp xếp**: `createdAt DESC` (mặc định)  
**Trang**: 1, pageSize: 20  

### Kết quả

| Chỉ số | Lần 1 | Lần 2 | Lần 3 | Trung bình | Ghi chú |
|---|---|---|---|---|---|
| TTFB (curl, ms) | _____ | _____ | _____ | **_____** | Clear cache lần đầu |
| Server Action (ms) | _____ | _____ | _____ | **_____** | listShipments + facets |
|   - listShipments | _____ | _____ | _____ | **_____** | Nếu có log |
|   - shipmentFacets | _____ | _____ | _____ | **_____** | Nếu có log |
| SQL Total (ms) | _____ | _____ | _____ | **_____** | Từ EXPLAIN ANALYZE |
|   - Planning | _____ | _____ | _____ | **_____** | Thường < 1ms |
|   - Execution | _____ | _____ | _____ | **_____** | Quá trình tính |
| DataTable Render (ms) | _____ | _____ | _____ | **_____** | React Profiler |
| **E2E Total (ms)** | _____ | _____ | _____ | **_____** | TTFB + Render |

### EXPLAIN ANALYZE
```sql
-- Dán output của: EXPLAIN (ANALYZE, TIMING ON, BUFFERS)
-- SELECT ... FROM shipments ... LIMIT 20;

[EXPLAIN output here]
```

### Ghi chú
- [Nhận xét gì đó nếu cần]
- [Kết quả có bất thường không]
- [So sánh với kỳ vọng]

---

## Kịch bản 2: Đổi bộ lọc trạng thái

**URL**: `/shipments?stage=DELIVERED&stage=RETURNING`  
**Bộ lọc**: `stage IN ('DELIVERED', 'RETURNING')`  
**Dòng khớp**: ~900–1000  

| Chỉ số | Lần 1 | Lần 2 | Lần 3 | Trung bình | So với Kịch bản 1 |
|---|---|---|---|---|---|
| TTFB (curl, ms) | _____ | _____ | _____ | **_____** | +_____ms |
| Server Action (ms) | _____ | _____ | _____ | **_____** | +_____ms |
| SQL Total (ms) | _____ | _____ | _____ | **_____** | +_____ms |
| DataTable Render (ms) | _____ | _____ | _____ | **_____** | ±_____ms |
| **E2E Total (ms)** | _____ | _____ | _____ | **_____** | +_____ms |

### EXPLAIN ANALYZE
```sql
[EXPLAIN output here]
```

### Ghi chú
- Số dòng khớp: _____
- Hiệu quả bộ lọc: [Tốt / Bình thường / Kém]
- Cần index?: [Có / Không]

---

## Kịch bản 3: Khoảng ngày rộng (365 ngày)

**URL**: `/shipments?period_from=2024-01-01&period_to=2024-12-31`  
**Khoảng ngày**: 365 ngày  
**Dòng khớp**: ~3000 (gấp đôi)  

| Chỉ số | Lần 1 | Lần 2 | Lần 3 | Trung bình | So với Kịch bản 1 |
|---|---|---|---|---|---|
| TTFB (curl, ms) | _____ | _____ | _____ | **_____** | +_____ms |
| Server Action (ms) | _____ | _____ | _____ | **_____** | +_____ms |
| SQL Total (ms) | _____ | _____ | _____ | **_____** | +_____ms |
| shipmentFacets (ms) | _____ | _____ | _____ | **_____** | +_____ms |
| DataTable Render (ms) | _____ | _____ | _____ | **_____** | ±_____ms |
| **E2E Total (ms)** | _____ | _____ | _____ | **_____** | +_____ms |

### EXPLAIN ANALYZE
```sql
[EXPLAIN output here — chú ý "Rows" và plan]
```

### Ghi chú
- Tác động lớn vì facets phải quét 3000 dòng
- Có thể cache facets không?

---

## Kịch bản 4: Khoảng ngày hẹp (3 ngày)

**URL**: `/shipments?period_from=2024-12-28&period_to=2024-12-30`  
**Khoảng ngày**: 3 ngày  
**Dòng khớp**: ~50–100  

| Chỉ số | Lần 1 | Lần 2 | Lần 3 | Trung bình | So với Kịch bản 1 |
|---|---|---|---|---|---|
| TTFB (curl, ms) | _____ | _____ | _____ | **_____** | -_____ms |
| Server Action (ms) | _____ | _____ | _____ | **_____** | -_____ms |
| SQL Total (ms) | _____ | _____ | _____ | **_____** | -_____ms |
| DataTable Render (ms) | _____ | _____ | _____ | **_____** | ±_____ms |
| **E2E Total (ms)** | _____ | _____ | _____ | **_____** | -_____ms |

### EXPLAIN ANALYZE
```sql
[EXPLAIN output here]
```

### Ghi chú
- Nhanh nhất vì ít dòng
- Facets trống hoặc rất ít giá trị

---

## Kịch bản 5: Phân trang sâu (trang 25)

**URL**: `/shipments?page=25&pageSize=20`  
**OFFSET**: 480  
**Dòng khớp**: 20 (LIMIT)  

| Chỉ số | Lần 1 | Lần 2 | Lần 3 | Trung bình | So với Kịch bản 1 |
|---|---|---|---|---|---|
| TTFB (curl, ms) | _____ | _____ | _____ | **_____** | +_____ms |
| Server Action (ms) | _____ | _____ | _____ | **_____** | +_____ms |
| SQL Total (ms) | _____ | _____ | _____ | **_____** | +_____ms |
| DataTable Render (ms) | _____ | _____ | _____ | **_____** | ±_____ms |
| **E2E Total (ms)** | _____ | _____ | _____ | **_____** | +_____ms |

### EXPLAIN ANALYZE
```sql
-- So sánh OFFSET 480 vs OFFSET 0
[EXPLAIN output here]
```

### Ghi chú
- OFFSET tác động bao nhiêu?
- Index `createdAt` có giúp không?
- Có cần tối ưu pagination?

---

## Kịch bản 6: Tìm kiếm theo mã VTP

**URL**: `/shipments?q=PKE1508909064` (ví dụ)  
**Kết quả**: 1–5 dòng  
**WHERE**: 9 điều kiện OR (tracking, order ref, phone, name, SKU, ...)  

| Chỉ số | Lần 1 | Lần 2 | Lần 3 | Trung bình | So với Kịch bản 1 |
|---|---|---|---|---|---|
| TTFB (curl, ms) | _____ | _____ | _____ | **_____** | -_____ms |
| Server Action (ms) | _____ | _____ | _____ | **_____** | -_____ms |
| SQL Total (ms) | _____ | _____ | _____ | **_____** | -_____ms |
| DataTable Render (ms) | _____ | _____ | _____ | **_____** | ±_____ms |
| **E2E Total (ms)** | _____ | _____ | _____ | **_____** | -_____ms |

### EXPLAIN ANALYZE
```sql
-- Mã tìm kiếm: _______________
[EXPLAIN output here — chú ý JOIN và OR]
```

### Ghi chú
- Tìm kiếm nhanh vì kết quả ít
- Có cần index ILIKE?
- OR clauses có hiệu quả?

---

## Kịch bản 7: Sắp xếp theo cột COD

**URL**: `/shipments?sort=codAmount&dir=desc`  
**Sắp xếp**: `cod_amount DESC NULLS LAST`  
**Dòng khớp**: 1.595 (all)  

| Chỉ số | Lần 1 | Lần 2 | Lần 3 | Trung bình | So với Kịch bản 1 |
|---|---|---|---|---|---|
| TTFB (curl, ms) | _____ | _____ | _____ | **_____** | +_____ms |
| Server Action (ms) | _____ | _____ | _____ | **_____** | +_____ms |
| SQL Total (ms) | _____ | _____ | _____ | **_____** | +_____ms |
| DataTable Render (ms) | _____ | _____ | _____ | **_____** | ±_____ms |
| **E2E Total (ms)** | _____ | _____ | _____ | **_____** | +_____ms |

### EXPLAIN ANALYZE
```sql
-- So sánh ORDER BY cod_amount vs createdAt
[EXPLAIN output here — chú ý Seq Scan vs Index Scan]
```

### Ghi chú
- Có index trên `cod_amount`?
- NULLS LAST tốn kém bao nhiêu?
- Cần tối ưu sắp xếp?

---

## Kịch bản 8: Bộ lọc tổng hợp (nặng nhất)

**URL**: `/shipments?stage=DELIVERED&stage=IN_TRANSIT&cod=PENDING&final=active&product=Q002&care=NEW`  
**Điều kiện**: 6+ WHERE clauses + JOINs  
**Dòng khớp**: 50–200  

| Chỉ số | Lần 1 | Lần 2 | Lần 3 | Trung bình | So với Kịch bản 1 |
|---|---|---|---|---|---|
| TTFB (curl, ms) | _____ | _____ | _____ | **_____** | +_____ms |
| Server Action (ms) | _____ | _____ | _____ | **_____** | +_____ms |
| SQL Total (ms) | _____ | _____ | _____ | **_____** | +_____ms |
| DataTable Render (ms) | _____ | _____ | _____ | **_____** | ±_____ms |
| **E2E Total (ms)** | _____ | _____ | _____ | **_____** | +_____ms |

### EXPLAIN ANALYZE
```sql
[EXPLAIN output here — chú ý Nested Loop, Seq Scan, số dòng quét]
```

### Ghi chú
- Worst-case: _____ms (tính từ E2E)
- Vấn đề chính: [Seq Scan / Nested Loop / No Index]
- Giải pháp đề xuất: [Thêm index / Rewrite query / Cache]

---

## Tóm tắt kết quả

### Bảng so sánh toàn bộ

| # | Kịch bản | TTFB (ms) | Server Action (ms) | SQL (ms) | Render (ms) | E2E (ms) | Trạng thái |
|---|---|---|---|---|---|---|---|
| 1 | Tải lần đầu | _____ | _____ | _____ | _____ | **_____** | ✓ / ⚠ / ✗ |
| 2 | Đổi bộ lọc | _____ | _____ | _____ | _____ | **_____** | ✓ / ⚠ / ✗ |
| 3 | Khoảng rộng | _____ | _____ | _____ | _____ | **_____** | ✓ / ⚠ / ✗ |
| 4 | Khoảng hẹp | _____ | _____ | _____ | _____ | **_____** | ✓ / ⚠ / ✗ |
| 5 | Phân trang s.25 | _____ | _____ | _____ | _____ | **_____** | ✓ / ⚠ / ✗ |
| 6 | Tìm kiếm mã | _____ | _____ | _____ | _____ | **_____** | ✓ / ⚠ / ✗ |
| 7 | Sắp xếp COD | _____ | _____ | _____ | _____ | **_____** | ✓ / ⚠ / ✗ |
| 8 | Bộ lọc nặng | _____ | _____ | _____ | _____ | **_____** | ✓ / ⚠ / ✗ |
| | **Trung bình** | | | | | **_____** | |
| | **Nhanh nhất** | | | | | **_____** | Kịch bản # |
| | **Chậm nhất** | | | | | **_____** | Kịch bản # |

### So sánh với kỳ vọng

| Chỉ số | Kỳ vọng | Kết quả | % | Kết luận |
|---|---|---|---|---|
| E2E trung bình | < 700ms | _____ms | ____% | ✓ PASS / ⚠ CAUTION / ✗ FAIL |
| E2E worst-case | < 1500ms | _____ms | ____% | ✓ PASS / ⚠ CAUTION / ✗ FAIL |
| SQL trung bình | < 100ms | _____ms | ____% | ✓ PASS / ⚠ CAUTION / ✗ FAIL |
| Render trung bình | < 60ms | _____ms | ____% | ✓ PASS / ⚠ CAUTION / ✗ FAIL |

---

## Phân tích & Khuyến nghị

### Điểm nền (Insights)

1. **Kịch bản nhanh nhất**: Kịch bản _____ (_____ms)
   - Lý do: [Ít dòng / Có index / ...]

2. **Kịch bản chậm nhất**: Kịch bản _____ (_____ms)
   - Lý do: [Seq Scan / Nested Loop / ...]

3. **Vấn đề chính**: 
   - [ ] Thiếu index trên: _________
   - [ ] SQL quá phức tạp (JOIN nhiều)
   - [ ] Facets chậm (quét nhiều dòng)
   - [ ] Render DataTable chậm (kiểm tra React)

4. **Cách tối ưu ưu tiên**: (sắp xếp từ 1 tới N)
   1. [Thêm index ...] → Dự kiến cải thiện: ____ms
   2. [Cache facets] → Dự kiến cải thiện: ____ms
   3. [Rewrite query ...] → Dự kiến cải thiện: ____ms

### Kế tiếp

- [ ] Thực hiện tối ưu #1
- [ ] Đo lại 8 kịch bản sau tối ưu
- [ ] Tính % cải thiện
- [ ] Commit kết quả

---

## Chứng chỉ & Ký duyệt

- [ ] Đã chạy đầy đủ 8 kịch bản
- [ ] Đã lặp lại 3 lần mỗi kịch bản
- [ ] Đã ghi rõ EXPLAIN ANALYZE
- [ ] Đã kiểm tra sanity (TTFB > Server Time, v.v.)
- [ ] Không có giá trị âm hoặc sai lệch

**Tester**: _________________ (tên)  
**Ngày hoàn thành**: [YYYY-MM-DD]  
**Xác nhận**: _________________ (lead/chủ shop)

---

## Lưu ý

- Giữ template này để dùng lại cho các lần đo tiếp theo
- Thay thế `_____` bằng giá trị thực tế
- Ghi chú bất kỳ điều bất thường
- Upload tệp này lên repo trong `docs/TECH-4-measurements/YYYY-MM-DD.md`
