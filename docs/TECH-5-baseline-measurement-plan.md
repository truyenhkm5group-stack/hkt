# TECH-5: Đo Baseline Phía Máy Chủ

**Task:** Chạy các kịch bản ở T1 (scale=1) và ghi số đo về hiệu năng phía máy chủ.

**Ngày:** 2026 (trên nhánh `ai/data/TECH-5-mucyiggu`)

**Base SHA:** eca772fbfc594d4e4e1ab0f1a6095080579cfae0

---

## 1. Phương pháp đo

Dùng script `scripts/bench-reports.ts`:

```bash
npx tsx scripts/bench-reports.ts --scale=1 --out=docs/perf/baseline-T1.json
```

**Cách hoạt động:**
- Dựng CSDL PGlite TRỐNG riêng
- Gieo dữ liệu theo scale (T1 = scale 1, có ~1.100 đơn, 71 mẫu mã)
- Đo từng "gói truy vấn của một trang":
  - Lạnh (xoá đệm trước): lần đầu tiên load trang
  - Ấm (giữ đệm): lần thứ hai (có memo)
  - P50, P95 từ 3 vòng lạnh
  - Số câu truy vấn thật sự chạy
  - Tổng thời gian CSDL, số dòng trả về
  - Kích thước payload JSON gửi cho browser

---

## 2. Số đo cần ghi lại

Với mỗi trang (27 trang được đo):

| Trang | Thời gian lạnh (ms) | Thời gian ấm (ms) | P95 (ms) | Số câu truy vấn | Thời gian DB (ms) | Số hàng | Payload (KB) | Truy vấn chậm nhất |
|---|---|---|---|---|---|---|---|---|
| Tổng quan (Dashboard) | | | | | | | | |
| Báo cáo lợi nhuận | | | | | | | | |
| Đơn hàng | | | | | | | | |
| Vận đơn | | | | | | | | |
| ... (25 trang khác) | | | | | | | | |

---

## 3. Định nghĩa từng chỉ số

### Thời gian (millisecond)
- **Lạnh (cold):** Lần đầu tiên gọi (đệm rỗng), phản ánh hiệu năng trong trường hợp xấu nhất
- **Ấm (warm):** Lần tiếp theo (đệm có dữ liệu memo), phản ánh chi phí thực khi có cache
- **P50:** Trung vị từ 3 vòng lạnh
- **P95:** Phân vị 95% từ 3 vòng lạnh (nếu có vòng nào chậm bất thường)

### Truy vấn SQL
- **Số câu:** Đếm từ lớp driver (không bỏ sót, không tính mock)
- **Thời gian DB:** Tổng thời gian ở CSDL (không tính parsing kết quả)
- **Số dòng:** Mặc định là tổng dòng từ tất cả câu (nếu một trang lấy 10.000 dòng trong khi chỉ hiện 50 dòng là dấu hiệu có thể tối ưu)

### Payload
- **Kích thước KB:** Dữ liệu JSON gửi cho browser (bao gồm toàn bộ danh sách, facet, tổng hợp)
- **Lưu ý:** PGlite chạy MỘT LUỒ => không bằng Postgres thật, nhưng **tỷ lệ** giữa các trang là so sánh được

### Truy vấn chậm nhất
- Liệt kê 3–5 câu SQL chạy lâu nhất (đo từ `bench/seed.ts::probe()`)
- Kèm số lần chạy, tổng thời gian, số dòng trả về

---

## 4. Mục tiêu

- **Tìm các trang nặng (slow):** Tổng quan, báo cáo lợi nhuận, vận đơn nên < 1 giây
- **Đếm câu truy vấn:** Trang không được > 50 câu (dấu hiệu N+1)
- **Payload:** Nếu trang chỉ hiện 50 dòng nhưng payload > 1 MB, cần xem xét phân trang/lazy load

---

## 5. Cách chạy (dành cho người vận hành)

```bash
# Lần đầu — baseline "trước cải tiến"
npm install  # nếu chưa
npx tsx scripts/bench-reports.ts --scale=1 --out=docs/perf/baseline-T1.json

# Xem kết quả (đã prettify JSON)
cat docs/perf/baseline-T1.json

# So sánh với lần kế (sau cải tiến)
# Nếu cải tiến được, chạy lại và so sánh thời gian
```

---

## 6. Lưu ý kỹ thuật

- **Không phải số tuyệt đối trên production:** PGlite là Postgres biên dịch sang WebAssembly, chạy 1 luồng. Con số **tuyệt đối** khác Postgres 16 thật (VPS), nhưng:
  - **Tỷ lệ giữa các trang** là so sánh được
  - **Tỷ lệ TRƯỚC/SAU cải tiến** trên cùng máy, cùng bộ dữ liệu là **độ tin cậy cao**

- **Fixture dữ liệu:** Script seed tự dựng:
  - ~1.100 đơn
  - ~71 mẫu mã
  - ~500 khách
  - Vận đơn, COD, webhook lịch sử

- **Không gọi mạng:** Tất cả đơn/sản phẩm/kho được gieo từ CSV fixture (xem `tests/fixtures-pancake-*.json`)

---

## 7. Kết quả mong đợi (sau chạy)

Script sẽ in ra JSON như sau (ví dụ):

```json
{
  "label": "baseline-T1",
  "scale": 1,
  "rounds": 3,
  "seedMs": 2450,
  "measuredAt": "2026-09-21T...",
  "rows": {
    "orders": 1147,
    "shipments": 1302,
    "customers": 487,
    "variants": 71
  },
  "results": [
    {
      "page": "Tổng quan (Dashboard)",
      "coldMs": 145.3,
      "warmMs": 48.2,
      "p50Ms": 145.3,
      "p95Ms": 172.1,
      "queries": 18,
      "dbMs": 132,
      "rows": 247,
      "payloadKb": 45.2,
      "slowest": [
        {
          "sql": "SELECT ... FROM shipments s LEFT JOIN orders ...",
          "count": 1,
          "ms": 85,
          "rows": 47
        }
      ]
    },
    ...
  ]
}
```

---

## 8. Phân tích kết quả

**Sau khi có số đo, hãy:**

1. **Tìm trang chậm nhất:** Sort by `coldMs` giảm dần
2. **Đếm truy vấn:** Trang nào > 50 câu → có dấu hiệu N+1
3. **Kiểm tra payload:** Nếu > 1 MB nhưng chỉ hiện 50 dòng → có thể lazy load
4. **Tìm câu SQL chậm:** Mục `slowest` — có thể cần index hay refactor query

---

## 9. Ghi chú cho commit

Khi commit kết quả:

```
Đo baseline phía máy chủ: T1 scale 1

- 27 trang được đo (Dashboard, báo cáo, danh sách, tổng hợp)
- Cách đo: PGlite fixture ~1.100 đơn, 3 vòng lạnh, 1 vòng ấm
- Ghi vào: docs/perf/baseline-T1.json

Số đo chính:
  - Tổng quan: 145ms lạnh, 48ms ấm, 18 câu
  - Báo cáo lợi nhuận: XXXms, XX câu
  - ... (tóm tắt các trang nặng)

Không sửa dữ liệu, không sửa trạng thái vận đơn — chỉ đo.
```

---

## 10. File đầu ra

Lưu vào: **`docs/perf/baseline-T1.json`**

Cấu trúc đã có sẵn trong script, chỉ cần chạy và lưu.
