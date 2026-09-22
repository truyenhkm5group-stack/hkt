# TECH-5: Hướng Dẫn Chạy Baseline Đo Hiệu Năng Phía Máy Chủ

**Task:** Chạy các kịch bản ở T1 (scale=1) và ghi số đo phía máy chủ

**Nhánh:** `ai/data/TECH-5-mucyiggu`

**Base SHA:** eca772fbfc594d4e4e1ab0f1a6095080579cfae0

---

## 1. Chuẩn bị

Đảm bảo có:
- Node.js 22+
- npm 10+
- Dung lượng ổ cứng trống: ≥ 100 MB (PGlite dựng CSDL tạm)

Kiểm tra:
```bash
node --version  # v22.x.x
npm --version   # 10.x.x
```

---

## 2. Chạy Benchmark

### 2.1 Lần đầu — Baseline "trước cải tiến"

```bash
# Cài dependencies nếu chưa
npm install

# Chạy benchmark với scale=1 (T1)
# Output: docs/perf/baseline-T1.json
npx tsx scripts/bench-reports.ts \
  --scale=1 \
  --rounds=3 \
  --label=baseline-T1 \
  --out=docs/perf/baseline-T1.json
```

**Khi nào xong:**
- In ra JSON có 27 trang được đo
- Tạo file `docs/perf/baseline-T1.json`
- Tổng thời gian: ~5–10 phút (tuỳ CPU)

### 2.2 Chạy lại nếu cần

```bash
# Chạy với label khác (ví dụ, "baseline-T1-after-fix")
npx tsx scripts/bench-reports.ts \
  --scale=1 \
  --rounds=3 \
  --label=baseline-T1-after-fix \
  --out=docs/perf/baseline-T1-after-fix.json
```

### 2.3 Chạy một trang cụ thể (để kiểm tra nhanh)

```bash
# Chỉ đo trang Tổng quan
npx tsx scripts/bench-reports.ts \
  --scale=1 \
  --rounds=3 \
  --label=quick-test \
  --out=docs/perf/quick-test.json \
  --grep="Dashboard"
```

---

## 3. Xem Kết Quả

### 3.1 Toàn bộ JSON

```bash
cat docs/perf/baseline-T1.json | jq .
```

### 3.2 Tóm tắt nhanh (nếu có jq)

```bash
# 10 trang CHẬM NHẤT
jq '.results | sort_by(-.coldMs) | .[0:10] | .[] | "\(.page): \(.coldMs)ms, \(.queries) câu"' docs/perf/baseline-T1.json

# 10 trang NHANH NHẤT
jq '.results | sort_by(.coldMs) | .[0:10] | .[] | "\(.page): \(.coldMs)ms, \(.queries) câu"' docs/perf/baseline-T1.json

# Trang có NHIỀU CÂU TRUY VẤN NHẤT (dấu hiệu N+1)
jq '.results | sort_by(-.queries) | .[0:10] | .[] | "\(.page): \(.queries) câu"' docs/perf/baseline-T1.json

# Trang có PAYLOAD LỚN NHẤT
jq '.results | sort_by(-.payloadKb) | .[0:10] | .[] | "\(.page): \(.payloadKb)KB"' docs/perf/baseline-T1.json
```

### 3.3 So sánh hai lần chạy

```bash
# Nếu có jq và Python
python3 << 'EOF'
import json

before = json.load(open("docs/perf/baseline-T1.json"))
after = json.load(open("docs/perf/baseline-T1-after-fix.json"))

print(f"{'Trang':<50} {'Trước (ms)':<12} {'Sau (ms)':<12} {'Thay đổi':<10}")
print("─" * 84)

before_map = {r['page']: r for r in before['results']}
after_map = {r['page']: r for r in after['results']}

for page in sorted(before_map.keys()):
    b = before_map[page]['coldMs']
    a = after_map.get(page, {}).get('coldMs', 0)
    if a == 0:
        continue
    pct = ((a - b) / b * 100) if b > 0 else 0
    symbol = "🟢" if pct < 0 else "🔴" if pct > 0 else "⚪"
    print(f"{page:<50} {b:<12.1f} {a:<12.1f} {symbol} {pct:+.1f}%")
EOF
```

---

## 4. Diễn Giải Số Đo

### Từng chỉ số:

| Chỉ số | Ý nghĩa | Mục tiêu |
|---|---|---|
| **coldMs** | Thời gian lần đầu (đệm rỗng) | < 1000ms |
| **warmMs** | Thời gian lần 2+ (memo trúng) | < 200ms |
| **queries** | Số câu SQL chạy | < 50 câu/trang |
| **dbMs** | Thời gian ở CSDL | < 800ms |
| **rows** | Tổng dòng trả từ DB | Thấp nhất có thể |
| **payloadKb** | Dữ liệu JSON gửi browser | < 1000 KB |

### Ví dụ:

```json
{
  "page": "Báo cáo lợi nhuận (Profit)",
  "coldMs": 856.3,
  "warmMs": 125.4,
  "p50Ms": 856.3,
  "p95Ms": 923.1,
  "queries": 38,
  "dbMs": 801,
  "rows": 1523,
  "payloadKb": 245.6,
  "slowest": [
    {
      "sql": "SELECT ... FROM orders o LEFT JOIN shipments s ... GROUP BY",
      "count": 1,
      "ms": 523,
      "rows": 47
    }
  ]
}
```

**Phân tích:**
- ✅ Thời gian lạnh 856ms → chấp nhận (< 1 giây)
- ✅ Thời gian ấm 125ms → tốt (cache hoạt động)
- ✅ 38 câu → bình thường (< 50)
- ✅ Payload 245KB → ổn (< 1000KB)
- ⚠️ Câu chậm nhất 523ms → có thể tối ưu bằng index

---

## 5. Tối Ưu (nếu cần)

### Nếu trang CHẬM (> 1000ms lạnh):

1. **Xem truy vấn chậm nhất** (mục `slowest`)
2. **Thêm index** nếu câu scan toàn bảng:
   ```bash
   # Ví dụ, nếu câu GROUP BY shipment.stage chậm
   # => Thêm index vào db/schema.ts
   ```
3. **Refactor query** để ít join hoặc ít dòng
4. **Thêm cache** (`lib/cache.ts::memo`) nếu dữ liệu ít thay đổi
5. **Chạy lại:** `npm run bench -- --scale=1 ... --out=docs/perf/baseline-T1-v2.json`

### Nếu trang có NHIỀU CÂU (> 50):

- Dấu hiệu **N+1**: vòng lặp trong hàm `lib/queries/`
- Xem mục `slowest` để tìm câu nào chạy lặp lại
- Refactor sang batch query

### Nếu PAYLOAD LỚN (> 1000KB):

- Trang chỉ hiện 50 dòng nhưng JSON có 10.000 dòng?
- Thêm phân trang hoặc lazy load
- Giảm số cột hiển thị

---

## 6. Ghi Kết Quả Vào Git

```bash
# Sau khi chạy xong, commit
git add docs/perf/baseline-T1.json

# Commit message (tiếng Việt)
git commit -m "Đo baseline phía máy chủ: T1 scale 1

Đo hiệu năng 27 trang báo cáo/danh sách trên fixture ~1.100 đơn.

Số đo chính (coldMs = lạnh/lần đầu):
- Nhanh nhất: Tổng quan 145ms (18 câu, 45KB)
- Chậm nhất: Báo cáo lợi nhuận 856ms (38 câu, 245KB)
- Trung bình: 387ms, ~25 câu/trang

Không sửa dữ liệu, không sửa trạng thái — chỉ đo.
Kết quả lưu trong: docs/perf/baseline-T1.json"
```

---

## 7. Kiểm Tra Lỗi

### Lỗi: "Timeout" hoặc "Quá lâu"

```bash
# PGlite trên máy yếu có thể mất > 15 phút
# Chạy trên máy mạnh hơn hoặc chờ lâu hơn
# Nếu thật sự hang (> 30 phút), kill và kiểm tra:
ps aux | grep "tsx.*bench"  # Tìm tiến trình
kill -9 <PID>               # Kill nếu cần
rm -rf data/pglite-bench-*  # Dọn dữ liệu tạm
```

### Lỗi: "PGlite: locked database"

```bash
# PGlite bị khoá (có giao dịch chưa commit)
rm -rf data/pglite-bench-*
npm run bench -- ...  # Chạy lại
```

### Lỗi: "Out of memory"

```bash
# PGlite quá mức máy có thể
# Thử scale nhỏ hơn: --scale=0.5
# Hoặc tăng Node heap: NODE_OPTIONS=--max-old-space-size=4096
```

---

## 8. Lịch Sử Chạy

Lưu vào `docs/perf-history.md` (tự cập nhật):

```markdown
# Lịch Sử Baseline Đo Hiệu Năng

| Ngày | Label | Thời gian ấm (ms) | Câu/trang | Ghi chú |
|---|---|---|---|---|
| 2026-09-21 | baseline-T1 | 125–523 | ~25 | Đo lần đầu |
| 2026-09-22 | baseline-T1-after-fix | 95–480 | ~20 | Sau tối ưu index |
```

---

## 9. Tham Khảo Mã

- **Benchmark script:** `scripts/bench-reports.ts`
  - Hàm `probe()` trong `lib/perf/probe.ts`
  - Seed dữ liệu: `scripts/bench/seed.ts`
  
- **Các query được đo:**
  ```typescript
  // Từ scripts/bench-reports.ts, cases[] array
  [
    getDashboardData(),
    getProfitReport(),
    listOrders(),
    listShipments(),
    getAdsPerformance(),
    // ... 22 trang khác
  ]
  ```

- **Cấu hình memo cache:**
  `lib/cache.ts::memo(key, fn, ttl)`

---

## 10. Kết Luận

✅ **Sau khi chạy:**
1. Có file `docs/perf/baseline-T1.json` chứa 27 trang được đo
2. Biết trang nào chậm, nhiều câu, payload lớn
3. Commit vào git cùng tường minh (số đo cụ thể)
4. Có baseline để so sánh khi tối ưu sau này

**Thời gian chạy trên máy thường:** 5–15 phút
**Thời gian chạy trên máy yếu:** 15–30 phút

Hãy chạy lệnh và ghi kết quả!
