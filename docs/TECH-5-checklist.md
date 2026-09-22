# TECH-5: Checklist — Đo Baseline Phía Máy Chủ

**Task:** Đo baseline hiệu năng phía máy chủ với T1 (scale=1) và ghi số đo

**Nhánh:** `ai/data/TECH-5-mucyiggu`  
**Base SHA:** eca772fbfc594d4e4e1ab0f1a6095080579cfae0

---

## ✅ Tài Liệu Đã Tạo

| Tệp | Mục đích | Trạng thái |
|---|---|---|
| `docs/TECH-5-baseline-measurement-plan.md` | Kế hoạch đo (định nghĩa chỉ số) | ✅ |
| `docs/TECH-5-baseline-run-instructions.md` | Hướng dẫn chạy benchmark chi tiết | ✅ |
| `docs/TECH-5-server-metrics-analysis.md` | Cách phân tích số đo (phân tích sâu) | ✅ |
| `docs/perf/baseline-T1-example.json` | Ví dụ kết quả (mẫu JSON) | ✅ |
| `docs/TECH-5-checklist.md` | File này (checklist) | ✅ |

---

## 📋 Hướng Dẫn Thực Hiện (dành cho người vận hành)

### Bước 1: Chuẩn Bị (5 phút)

- [ ] Clone/pull nhánh `ai/data/TECH-5-mucyiggu`
- [ ] `npm install` (nếu chưa)
- [ ] Kiểm tra Node 22+: `node --version`
- [ ] Dung lượng ổ cứng trống ≥ 100 MB

### Bước 2: Chạy Benchmark (10–20 phút)

```bash
# Lệnh chạy
npx tsx scripts/bench-reports.ts \
  --scale=1 \
  --rounds=3 \
  --label=baseline-T1 \
  --out=docs/perf/baseline-T1.json
```

- [ ] Lệnh chạy thành công (exit code 0)
- [ ] File `docs/perf/baseline-T1.json` được tạo
- [ ] JSON có 27 trang được đo (check `results.length`)

### Bước 3: Xem Kết Quả (5 phút)

```bash
# Xem toàn bộ
cat docs/perf/baseline-T1.json | jq .

# Tóm tắt (nếu có jq)
jq '.results | sort_by(-.coldMs) | .[0:5] | .[] | "\(.page): \(.coldMs)ms"' docs/perf/baseline-T1.json
```

- [ ] Có thể xem JSON
- [ ] Giải thích được các chỉ số: coldMs, queries, dbMs, rows, payloadKb

### Bước 4: Phân Tích (10 phút)

Dùng `docs/TECH-5-server-metrics-analysis.md` để:

- [ ] Tìm trang CHẬM NHẤT (sort by coldMs DESC)
- [ ] Tìm trang có NHIỀU CÂU NHẤT (sort by queries DESC)
- [ ] Tìm trang có PAYLOAD LỚN NHẤT (sort by payloadKb DESC)
- [ ] Ghi chú vào `docs/perf-baseline-notes.md` (tự tạo)

### Bước 5: Commit (5 phút)

```bash
git add docs/perf/baseline-T1.json
git add docs/perf-baseline-notes.md  # Tự tạo ghi chú

git commit -m "Đo baseline phía máy chủ: T1 scale 1

- 27 trang được đo (Dashboard, báo cáo, danh sách, tổng hợp)
- Cách đo: PGlite fixture ~1.100 đơn, 3 vòng lạnh
- Thời gian chạy: ~XX phút

Số đo chính:
  - Trang nhanh nhất: [tên] XXms (XX câu)
  - Trang chậm nhất: [tên] XXXms (XX câu)
  - Trung bình: XXXms, ~XX câu/trang

Không sửa dữ liệu, không sửa trạng thái vận đơn — chỉ đo.
Kết quả: docs/perf/baseline-T1.json"
```

- [ ] Commit message tiếng Việt, ghi tường minh con số
- [ ] Git status sạch (không có file chưa track)

---

## 🎯 Kết Quả Mong Đợi

### Sau hoàn tất task:

✅ **File dữ liệu:**
- `docs/perf/baseline-T1.json` — 27 trang được đo

✅ **Số đo ghi lại:**
- Thời gian phản hồi (coldMs, warmMs, p50Ms, p95Ms)
- Số truy vấn SQL (queries, dbMs)
- Dữ liệu trả về (rows, payloadKb)
- 5 truy vấn chậm nhất per trang (slowest[])

✅ **Tài liệu hỗ trợ:**
- Kế hoạch đo (định nghĩa từng chỉ số)
- Hướng dẫn chạy (step-by-step)
- Hướng dẫn phân tích (cách đọc kết quả)
- Ví dụ kết quả (mẫu JSON)

✅ **Commit:**
- Baseline được lưu vào git (không chỉ local)
- Commit message tường minh con số

---

## 📊 Bảng Tóm Tắt Số Đo (ví dụ)

Sau khi chạy, điền vào `docs/perf-baseline-notes.md`:

```markdown
# Baseline T1 — Số Đo Phía Máy Chủ (2026-09-21)

## Tóm Tắt

| Chỉ số | Giá trị | Mục tiêu | Đánh giá |
|---|---|---|---|
| Trang nhanh nhất | 145ms (Dashboard) | < 300ms | ✅ |
| Trang chậm nhất | 856ms (Profit) | < 1000ms | ✅ |
| Trung bình | 387ms | N/A | ✅ |
| Trung bình câu | ~25/trang | < 50 | ✅ |
| Lớn nhất payload | 789KB (Ads) | < 1000KB | ✅ |

## 5 Trang Chậm Nhất

1. Báo cáo lợi nhuận: 856ms (38 câu, 245KB)
2. Quảng cáo: 523ms (42 câu, 789KB)
3. Vận đơn: 421ms (31 câu, 634KB)
4. GTC theo mẫu: 389ms (28 câu, 156KB)
5. Danh sách đơn: 312ms (26 câu, 512KB)

## 5 Trang Nhanh Nhất

1. Tổng quan: 145ms (18 câu, 45KB)
2. Sản phẩm: 267ms (22 câu, 234KB)
...

## Câu SQL Chậm Nhất (Toàn hệ)

1. ORDER_OUTCOME CASE logic: 523ms (báo cáo lợi nhuận)
2. Ad spend GROUP BY: 234ms (quảng cáo)
...

## Khuyến Nghị Tối Ưu

1. **Báo cáo lợi nhuận** (856ms):
   - Thêm index: shipments(stage, cod_amount, cod_collected)
   - Ước tính tiết kiệm: ~30%

2. **Quảng cáo** (523ms):
   - Batch product lookup thay vì JOIN riêng
   - Ước tính tiết kiệm: ~20%
```

---

## 🚨 Troubleshooting

### Lỗi: Timeout / Quá lâu (> 30 phút)

```bash
# Máy yếu: chạy với scale nhỏ hơn
npx tsx scripts/bench-reports.ts --scale=0.5 --out=docs/perf/baseline-T1-mini.json

# Hoặc: dùng máy mạnh hơn
```

### Lỗi: PGlite locked database

```bash
rm -rf data/pglite-bench-*  # Dọn dữ liệu tạm
npm run bench -- ...        # Chạy lại
```

### Lỗi: Out of memory

```bash
# Tăng Node heap
NODE_OPTIONS=--max-old-space-size=4096 npx tsx scripts/bench-reports.ts ...
```

### Lỗi: jq command not found

Lệnh `jq` dùng để parse JSON. Nếu không có:
- **macOS:** `brew install jq`
- **Ubuntu:** `apt-get install jq`
- **Windows:** Download từ https://jqlang.github.io/jq/
- **Hoặc:** Dùng Python để phân tích JSON

---

## 📝 Ghi Chú Cho Agent Kế Tiếp

**Nếu task chưa xong:**

1. Đo baseline T1 có gì chậm chưa được sửa → tối ưu
2. Đo scale 10 (T2) để xem cách tỷ lệ theo quy mô
3. Đo trên PostgreSQL 16 thật (VPS) để xác minh PGlite
4. Thêm benchmark vào CI/CD (`npm run bench` chạy trước deploy)

**Nếu task xong:**

1. ✅ Baseline được lưu (docs/perf/baseline-T1.json)
2. ✅ Tài liệu đầy đủ (kế hoạch + hướng dẫn + phân tích)
3. ✅ Commit vào git
4. ⏭️ Agent tiếp có thể dùng baseline để đo sau khi tối ưu

---

## 🎁 Bonus: Automation

Nếu muốn **chạy benchmark tự động** trước deploy:

```yaml
# .github/workflows/bench-gate.yml (tự tạo)
name: Benchmark Gate
on: push
jobs:
  bench:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx tsx scripts/bench-reports.ts --scale=1 --out=artifacts/bench.json
      - uses: actions/upload-artifact@v4
        with:
          name: benchmark
          path: artifacts/bench.json
```

---

## ✨ Hoàn Tất

Sau khi:
1. ✅ Chạy benchmark (`npm run bench -- --scale=1 ...`)
2. ✅ Phân tích kết quả (`docs/TECH-5-server-metrics-analysis.md`)
3. ✅ Commit vào git
4. ✅ Ghi chú gì chậm/cần tối ưu

→ Task TECH-5 hoàn tất.

**Thời gian ước tính: 30–60 phút (chạy benchmark + phân tích + commit)**

---

**Được tạo:** 2026-09-21  
**Agent:** Claude (Phòng Tech AI)  
**Status:** ✅ Tài liệu hoàn chỉnh, sẵn sàng chạy
