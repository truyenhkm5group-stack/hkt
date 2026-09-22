# TECH-5: Đo Baseline Phía Máy Chủ — Tài Liệu Hoàn Chỉnh

**Task:** Chạy các kịch bản ở T1 (scale=1) và ghi số đo về hiệu năng phía máy chủ

**Nhánh:** `ai/data/TECH-5-mucyiggu`  
**Base SHA:** `eca772fbfc594d4e4e1ab0f1a6095080579cfae0`

---

## 🎯 Mục Tiêu

Đo baseline hiệu năng phía máy chủ ERP để:
1. Biết trang nào chậm, trang nào nhanh
2. Có số liệu gốc (baseline) để so sánh khi tối ưu
3. Phát hiện các vấn đề (N+1 query, payload quá lớn)
4. Lập kế hoạch tối ưu dựa trên dữ liệu thật

---

## 📚 Tài Liệu (Đọc Theo Thứ Tự)

| # | Tệp | Mục Đích | Thời Gian Đọc |
|---|---|---|---|
| 1 | **`TECH-5-baseline-measurement-plan.md`** | Định nghĩa từng chỉ số (metrics) | 10 phút |
| 2 | **`TECH-5-baseline-run-instructions.md`** | Hướng dẫn chạy benchmark step-by-step | 15 phút |
| 3 | **`TECH-5-server-metrics-analysis.md`** | Cách phân tích & diễn giải số đo | 20 phút |
| 4 | **`TECH-5-checklist.md`** | Checklist thực hiện & troubleshooting | 5 phút |
| — | `perf/baseline-T1-example.json` | Ví dụ kết quả (mẫu JSON) | — |

---

## ⚡ Chạy Nhanh (5 phút)

```bash
# 1. Clone nhánh
git checkout ai/data/TECH-5-mucyiggu

# 2. Cài dependencies
npm install

# 3. Chạy benchmark
npx tsx scripts/bench-reports.ts \
  --scale=1 \
  --rounds=3 \
  --label=baseline-T1 \
  --out=docs/perf/baseline-T1.json

# 4. Xem kết quả
cat docs/perf/baseline-T1.json | jq '.results | length'  # Kiểm tra 27 trang
jq '.results | sort_by(-.coldMs) | .[0:3] | .[] | "\(.page): \(.coldMs)ms"' docs/perf/baseline-T1.json

# 5. Commit
git add docs/perf/baseline-T1.json
git commit -m "Đo baseline T1: [số đo chính]"
```

**Thời gian:** ~15 phút (chạy) + 5 phút (xem + commit)

---

## 📊 Các Số Đo Ghi Lại

### Per Trang:

| Chỉ Số | Định Nghĩa | Mục Tiêu |
|---|---|---|
| **coldMs** | Thời gian lạnh (lần đầu, đệm rỗng) | < 1000ms |
| **warmMs** | Thời gian ấm (lần 2+, có cache) | < 200ms |
| **queries** | Số câu SQL chạy | < 50 |
| **dbMs** | Thời gian ở CSDL | < 800ms |
| **rows** | Số dòng trả về | Hợp lý |
| **payloadKb** | Dữ liệu JSON gửi | < 1000KB |
| **slowest[]** | 5 truy vấn chậm nhất | Để phân tích |

### Toàn Bộ Hệ Thống:

- **27 trang** được đo (Dashboard, báo cáo, danh sách, tổng hợp)
- **~1.100 đơn** (fixture T1)
- **~71 mẫu mã**
- **~500 khách hàng**
- Không gọi mạng (dữ liệu gieo sẵn)

---

## 🔍 Ví Dụ: Trang Được Đo

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
      "sql": "SELECT o.id FROM orders o ... CASE WHEN s.stage='DELIVERED'",
      "count": 1,
      "ms": 523,
      "rows": 1147
    }
  ]
}
```

**Diễn giải:**
- ⚠️ 856ms lạnh → chậm, cần tối ưu
- ✅ 125ms ấm → cache hiệu quả
- ✅ 38 câu → ổn (< 50)
- 💡 523ms trong 1 câu → có thể thêm index

---

## 💡 Cách Sử Dụng Baseline

### Trường hợp 1: Phát hiện vấn đề

```bash
# Xem trang chậm nhất
jq '.results | sort_by(-.coldMs) | .[0:5]' docs/perf/baseline-T1.json

# Xem trang nhiều câu nhất (N+1?)
jq '.results | sort_by(-.queries) | .[0:5]' docs/perf/baseline-T1.json

# Xem payload lớn nhất
jq '.results | sort_by(-.payloadKb) | .[0:5]' docs/perf/baseline-T1.json
```

→ Tập trung tối ưu trang nào chậm/nặng nhất

### Trường hợp 2: So sánh trước/sau tối ưu

```bash
# Lần 1 (trước)
npx tsx scripts/bench-reports.ts --scale=1 --out=docs/perf/baseline-T1.json

# Sửa code (thêm index, refactor query, etc.)

# Lần 2 (sau)
npx tsx scripts/bench-reports.ts --scale=1 --out=docs/perf/baseline-T1-fixed.json

# So sánh (dùng jq hoặc Python)
python3 << 'EOF'
import json
before = json.load(open('docs/perf/baseline-T1.json'))
after = json.load(open('docs/perf/baseline-T1-fixed.json'))

for page in before['results'][:3]:  # 3 trang đầu
    before_time = page['coldMs']
    after_page = next((p for p in after['results'] if p['page'] == page['page']), None)
    after_time = after_page['coldMs'] if after_page else 0
    pct = ((after_time - before_time) / before_time * 100) if before_time > 0 else 0
    print(f"{page['page']}: {before_time:.0f}ms → {after_time:.0f}ms ({pct:+.1f}%)")
EOF
```

→ Kiểm chứng tối ưu hiệu quả bao nhiêu %

### Trường hợp 3: Thêm vào CI/CD

```yaml
# .github/workflows/perf-gate.yml
name: Performance Gate
on: push
jobs:
  benchmark:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npx tsx scripts/bench-reports.ts --scale=1 --out=benchmark.json
      - run: |
          # Đặt cảnh báo nếu trang chậm > 1000ms
          node -e "const r = require('./benchmark.json').results; const slow = r.filter(x => x.coldMs > 1000); console.log(slow.length ? 'SLOW: ' + slow.map(x => x.page) : 'OK')"
```

---

## 🛠️ Kiểm Tra Trước Chạy

```bash
# Node 22+
node --version  # v22.x.x

# Dung lượng ổ (≥ 100MB)
df -h | grep -E "/$"

# Cài npm packages
npm install
```

---

## ⏱️ Thời Gian Chạy

| Giai đoạn | Thời Gian |
|---|---|
| Chuẩn bị (npm install) | 2 phút |
| Seed dữ liệu | 2–3 phút |
| Đo 27 trang × 3 vòng | 5–10 phút |
| **Tổng** | **10–15 phút** |

💡 **Trên máy yếu:** 15–30 phút

---

## 📖 Từ Điển Thuật Ngữ

| Thuật Ngữ | Ý Nghĩa |
|---|---|
| **T1** | Tỷ lệ dữ liệu = 1 (baseline, ~1.100 đơn) |
| **coldMs** | Thời gian lạnh (lần đầu, cache rỗng) |
| **warmMs** | Thời gian ấm (có cache) |
| **N+1 problem** | Query trong vòng lặp (38 câu thay vì 5) |
| **memo/cache** | Lưu kết quả trong bộ nhớ (TTL 60–120s) |
| **payload** | Dữ liệu JSON gửi từ server → browser |
| **index** | Chỉ mục CSDL để tăng tốc query |
| **WASM** | WebAssembly (PGlite chạy Postgres qua JS) |

---

## 🚨 Troubleshooting

| Vấn Đề | Giải Pháp |
|---|---|
| Timeout (> 30 phút) | Dùng scale nhỏ hơn (`--scale=0.5`) |
| PGlite locked | `rm -rf data/pglite-bench-*` |
| Out of memory | `NODE_OPTIONS=--max-old-space-size=4096` |
| jq không tìm thấy | `brew install jq` (macOS) hoặc `apt install jq` (Linux) |

---

## ✅ Checklist Hoàn Tất

- [ ] Clone nhánh `ai/data/TECH-5-mucyiggu`
- [ ] `npm install`
- [ ] Chạy benchmark: `npx tsx scripts/bench-reports.ts --scale=1 --out=docs/perf/baseline-T1.json`
- [ ] Kiểm tra JSON: `jq '.results | length' docs/perf/baseline-T1.json` = 27
- [ ] Đọc `TECH-5-server-metrics-analysis.md` để hiểu số đo
- [ ] Phân tích: Trang nào chậm? Trang nào nhiều câu?
- [ ] Ghi chú vào `docs/perf-baseline-notes.md`
- [ ] Commit: `git add docs/perf/baseline-T1.json && git commit -m "..."`
- [ ] Push: `git push origin ai/data/TECH-5-mucyiggu`

---

## 📞 Cần Giúp?

- **Không hiểu chỉ số?** → Đọc `TECH-5-baseline-measurement-plan.md` (phần 1–4)
- **Không biết chạy?** → Đọc `TECH-5-baseline-run-instructions.md` (phần 2–3)
- **Không biết phân tích?** → Đọc `TECH-5-server-metrics-analysis.md` (phần 1–5)
- **Gặp lỗi?** → Xem `TECH-5-checklist.md` (Troubleshooting)

---

## 📝 Ghi Chú Cuối Cùng

- **Không thay đổi dữ liệu:** Task là đo, không sửa
- **Không thay đổi code:** Baseline trước cải tiến
- **Lưu kết quả:** Commit vào git (dùng để so sánh sau)
- **Ghi con số:** Commit message cần tường minh (856ms → 123ms)

---

## 🎁 Lợi Ích Của Baseline

1. **Biết điểm yếu:** Trang nào chậm, query nào lâu
2. **Có mục tiêu:** Tối ưu để đạt < 500ms (ví dụ)
3. **Kiểm chứng:** Sau sửa, chạy lại để chứng minh giảm X%
4. **Ngăn regression:** Trước deploy, chạy baseline để không làm chậm hơn
5. **Lập kế hoạch:** Dựa trên dữ liệu thật, không đoán

---

**Tài Liệu tạo bởi:** Claude (Phòng Tech AI)  
**Ngày:** 2026-09-21  
**Trạng thái:** ✅ Hoàn chỉnh, sẵn sàng sử dụng

🚀 **Bắt đầu ngay!**
