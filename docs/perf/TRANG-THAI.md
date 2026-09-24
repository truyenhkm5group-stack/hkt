# Trạng thái hiệu năng — tổng hợp theo trang (24/09/2026, `main` @ `1d5b4ec6`)

**Tệp này là BẢN TỔNG HỢP, không phải chứng từ số đo.** Nó không chứa phép đo mới nào. Mỗi con số
dưới đây được chép từ một tệp hoặc một commit ghi ngay cạnh nó — muốn trích một con số thì trích
**nguồn ấy**, không trích tệp này. Chỗ nào không có số trong kho thì ghi **CHƯA ĐO**.

Các tài liệu hiệu năng trước đây chồng lên nhau theo thời gian (08/09 → 24/09) và nhiều kết luận cũ
đã bị số đo sau thay thế. Tệp này nói: trang nào đã vá bằng gì, còn gì chưa, số đo nằm ở đâu.

---

## 1. Ba điều đã được đo, không còn là giả thuyết

1. **JIT của PostgreSQL biên dịch câu mang biểu thức kết quả đơn, và thời gian biên dịch lớn hơn
   thời gian chạy hàng trăm lần.**
   · `/inventory/planning` 10/09: 26.078 ms JIT bật ↔ 134 ms JIT tắt, 1.432 hàm được biên dịch —
     `docs/erp-performance-p0-5-report.md`, Phụ lục 2.
   · Câu `count(*) filter (where … canonical_order_outcome …)` 23/09: 8.425 ms ↔ 43 ms (99 %),
     trung vị 3 lượt xen kẽ — `docs/perf/JIT-bat-tat-2026-09-23.md`.
   · Cách vá DUY NHẤT đang dùng: `chayKhongJit()` trong `db/index.ts` — `set local jit = off` trong
     đúng giao dịch của câu đó. **Không** tắt JIT toàn máy chủ (cùng tệp, mục "không kết luận").
2. **Nội tuyến `ORDER_OUTCOME` vào nhiều cột gộp làm cùng một biểu thức chạy N lần mỗi đơn.**
   Cách vá: bảng dẫn xuất + `OUTCOME_FENCE` — `docs/erp-performance-p0-2-report.md` mục 3–4;
   `getReturnRateBySource` 246 SubPlan / 31.211 ms (commit `04fc955f`).
3. **Máy chủ 2 nhân, bão hoà lúc đo 23/09** (load 3,77 · `erp-db` 107,57 % CPU · RAM khả dụng
   390 MB) — nên mọi thời gian trang ngày 23/09 là **CẬN TRÊN**, không phải nền sạch.
   Bể kết nối 3/5 lúc yên, không đề xuất nâng: chỗ nghẽn là CPU —
   `docs/perf/TECH-6-TECH-9-so-do-tho-2026-09-23.md`.

**Một cái bẫy đo phải nhớ:** thời gian EXPLAIN của `perf-probe` trước 23/09 đo trên đường CÔNG CỤ
(JIT bật), không phải đường ỨNG DỤNG (JIT tắt trong `chayKhongJit`) — `docs/perf/TECH-5-so-do-tho-2026-09-22.md`,
mục "BỔ SUNG 23/09". Ưu tiên số 1 của `docs/TECH-10-improvement-spec.md` (chỉ mục `orders.stage`)
dựng trên con số ấy. Từ `39cad2a9` probe đo cả hai điều kiện JIT xen kẽ.

---

## 2. Theo trang

Cột "gần nhất" là số trang (smoke / verify) nếu có, không thì số hàm (perf-probe). Thời gian ngày
23/09 lấy từ `ops verify` run `35817182554` lúc máy bão hoà.

| Trang | Số đo gần nhất trong kho (nguồn) | Đã vá (commit) | Còn lại |
|---|---|---|---|
| `/` trang chủ | 201 ms, 23/09 (TECH-6-TECH-9) | P0.2/P0.3 bảng `canonical_order_outcome` (`e019cac`); đăng nhập thôi xoá đệm + `staleMemo` + job `dashboard-warm` (P0.5 mục 5); JIT tắt ở `dashboard.ts`, `cost-engine.ts` (`55cac21c`) | Đường NGUỘI: `getDashboardData` 3.536 ms, `getBusinessBrief` 3.307 ms, `getFinancialTruth` 2.899 ms — chưa đạt mục tiêu < 1,5 s; nguyên nhân là truy vấn con tương quan tra `canonical_order_outcome` từng dòng, KHÔNG phải JIT (P0.5 Phụ lục 3) |
| `/inventory/planning` | 2.013 ms, 23/09 (TECH-6-TECH-9) · 63 ms sau vá 10/09 (P0.5 Phụ lục 2) | JIT tắt ở `planning.ts`, `stock.ts` (`63f4df44`) — 61 s → 63 ms | — |
| `/payroll` | 622 ms, 23/09 | JIT tắt ở `payroll.ts` (`2ec5499e`) | — |
| `/orders` | 203 ms, 23/09 | — | Không có gì để vá |
| `/shipments` | 545 ms · 1.333 kB, 23/09 | — | Kịch bản đo chuẩn: `docs/TECH-4-*`. Truy vấn con tương quan tính kết quả từng dòng: giả thuyết của `docs/TECH-7-explain-analyze-findings.md` mục II.3, CHƯA ĐO |
| `/ads` | 22.501 ms · 5.840 kB (TECH-6-TECH-9) · 18,4 s · 6.768 kB smoke deploy 23/09 (`722821f0`) | Bảng quyết định chỉ gửi dòng cần đọc (`03e27cd0`); khối marketer nạp khi bấm mở (`8ff62785`); báo cáo marketer thôi đọc tồn kho (`149f39c3`, `8d6665a0`) | **Chưa có số smoke sau các bản vá trong kho.** `getAdsPerformance` còn 9,7 s nguội sau #199 — `a292d750` thêm phép đo, chưa sửa |
| `/ads/daily` | 2.122 ms (TECH-6-TECH-9) · 16,2 s smoke deploy 23/09 (`722821f0`) — hai lượt khác nhau | JIT tắt `marketing-daily.ts` (`4bb8f31d`: 3.739 ms, trong đó JIT 3.246 ms); một giao dịch cho cả bảng bóc tách (`e7b9fb23`); lợi nhuận danh nghĩa bên dưới (xem dòng dưới); thôi chờ AI viết diễn giải (`4c3b3fc0`, rồi gỡ hẳn `5bd93053`) | CHƯA ĐO sau vá |
| Báo cáo lợi nhuận danh nghĩa | `getNominalProfitReport` 30 ngày nguội 61,5 s, JIT 24,96 s (`7a204595`); đo riêng 8,7 s (23/09, nêu ở `8ff62785`) | JIT tắt `productReturnHistory` (`cd1c061d`: 5.876 ms, 98,1 % là biên dịch) và câu doanh số theo mã (`7a204595`); `projected-delivery.ts` (`cd1c061d`, `7a204595` — câu thứ hai suy từ hình dạng) | `stockByProduct` 5,1 s khi đọc tồn kho (`8d6665a0`) — mới tắt được ở đường marketer, đường mặc định vẫn đọc |
| `/reports/returns` | 9.425 ms, 23/09 (TECH-6-TECH-9) · 61,8 s → 16,9–24,6 s ngày 22/09 (`e8f91622`) | `getReturnRateBySource` bảng dẫn xuất (`04fc955f`); JIT tắt `baseRows` — 4.034 → 183 ms, 95 % (`20e4fbe4`) | `careRows`, `trendPoints` → nhánh chưa gộp (mục 3). Số sau `20e4fbe4`: CHƯA ĐO |
| `/customers` | 24.690 ms · 243 kB, 23/09 | JIT tắt `listCustomers` — 7.463 → 100 ms, 99 % (`20e4fbe4`) | `customerFacets`, `customerSummary` → nhánh chưa gộp |
| `/work/okr` | `getScorecard` 19.967 → 2.536 ms · `listObjectives` 11.428 → 3.575 ms (JIT-bat-tat, lượt 2) | JIT tắt `outcomeAggregate` trong `metric-resolver.ts` (`5d853725`) | ~2,5 s còn lại KHÔNG phải JIT, CHƯA ĐO là gì |
| `/reports/funnel` | 34,4 s máy rảnh (`docs/tech-ai-room-status.md`) · `getFunnelBySource` 40.266 ms, `getStaffPerformance` 31.124 ms, `getSalesFunnel` 26.822 ms ngày 22/09 (`98b32f1f`) | JIT tắt ba hàm trên (`98b32f1f`) | Đệm `memo` 120 s cho bốn hàm + `conversion-funnel` → nhánh chưa gộp |
| `/cod`, `?recon=unproven`, `?recon=stale` | 18.263 · 30.243 · 10.742 ms, 23/09 · `codSettlementSummary` 3.555 ms (JIT-bat-tat, "ứng viên chưa đo") | Chưa có bản vá JIT nào trên `main` (`cod-settlement.ts` không dùng `chayKhongJit`); ngày 09/09 trang đo 147 ms (P0.3) | 6 hàm của `cod-settlement.ts` → nhánh chưa gộp. EXPLAIN bật/tắt riêng: CHƯA ĐO |
| `/data-quality?issue=unlinked-shipment` | 53.979 ms · 610 kB, 23/09 | — | `dataQualitySummary` đổi hình dạng + JIT, `getDataQualityIssues`, khoá đệm `adsAttributionCoverage` → nhánh chưa gộp |
| `/reports/cashflow` | 9.448 ms, 23/09 | — | `buildCashflow`, `vonLuuDong`, `profit-cash-bridge` → nhánh chưa gộp |
| `/products` | 8.840 ms, 23/09 | JIT tắt câu danh sách (`13934810`, 11/09) | Câu đếm, câu tồn, tóm tắt → nhánh chưa gộp |
| `/landing` | 5.300 ms · 2.911 kB, 23/09 | — | `listLandingOrders`, `landingSummary` → nhánh chưa gộp |
| `/customers/retention` | 117 ms sau vá 10/09 (P0.5 Phụ lục 2) | — | `crm.ts` (`ORDER_FACTS`) → nhánh chưa gộp |

---

## 3. Nhánh CHƯA GỘP: `claude/trang-cham-jit` (`d5146ec2`, 24/09/2026)

Vá theo HÌNH DẠNG (cùng họ câu với chỗ đã đo, chưa EXPLAIN riêng từng câu): 27 hàm chạy trong
`chayKhongJit` ở `cod-settlement` · `data-quality` · `data-quality-issues` · `customers` ·
`products` · `cashflow` · `profit-cash-bridge` · `profit-cash` · `conversion-funnel` ·
`return-intelligence` · `crm` · `landing`; `dataQualitySummary` đổi hình dạng sang bảng dẫn xuất
có rào; `memo` 120 s cho `/reports/funnel`; khoá đệm `adsAttributionCoverage` tròn tới phút. Tức là
các trang **/cod, /data-quality, /customers, /products, /reports/cashflow, /reports/funnel** (và
phần còn lại của /reports/returns, /landing, /customers/retention).

**Chưa có số đo SAU vá** — commit ghi rõ máy vá không chạm production. Lệnh đo và bảng chờ điền nằm
ở `docs/perf/vong-va-2026-09-24.md` **trên nhánh ấy** (chưa có trên `main`). Khi gộp và đo xong,
sửa các dòng tương ứng ở bảng mục 2.

---

## 4. Còn nợ — đã biết, chưa làm

| Việc | Căn cứ |
|---|---|
| Đo lại mọi trang sau các bản vá 23–24/09 trên máy KHÔNG bão hoà | Số 23/09 là cận trên (mục 1.3) |
| Truy vấn con tương quan tra `canonical_order_outcome` từng dòng (~3,2 s nguội) → đổi sang phép NỐI, giữ nhánh dự phòng | P0.5 Phụ lục 3 — "biết chính xác, chưa sửa" |
| `stockByProduct` quét toàn bộ lịch sử dòng hàng (5,1 s) | `8d6665a0` |
| Bốn phép đo phía trình duyệt (số truy vấn / lượt, fetch khi đổi lọc, refetch thừa, ranh giới server/client) | `docs/TECH-6-SUMMARY.md` là cách đo và chỗ điền — không có số |
| Bể kết nối trong GIỜ CAO ĐIỂM · cold start từng tuyến · job đồng bộ trùng giờ cao điểm | `docs/TECH-9-infrastructure-health-check-2026-09-23.md`, TECH-6-TECH-9 mục "không kết luận" |
| Ngưỡng quy mô: `pg_trgm` cho tìm kiếm khi `orders` > ~50.000; xem lại RAM | `docs/erp-perf-audit-round2.md`, `docs/erp-perf-audit.md` |

---

## 5. Công cụ đo — cái nào trả lời câu hỏi nào

| Công cụ | Trả lời | Không trả lời |
|---|---|---|
| `ops smoke` / `ops verify` (`scripts/smoke.ts`) | Người dùng chờ bao lâu, đầu phản hồi ↔ thân, kB | Câu nào chậm |
| `ops perf-probe` (`scripts/perf-probe.ts`) | Thời gian từng hàm, nguội ↔ ấm, câu chậm bên trong hàm trọng điểm, JIT bật ↔ tắt | Thời gian dựng trang |
| `ops perf-audit` (`scripts/perf-audit.ts`) | Thời gian + dung lượng từng khối của một trang (vd. `/ads`) | — |
| `scripts/bench-reports.ts`, `scripts/bench/*` | Số câu truy vấn, tỷ lệ trước/sau trên PGlite | Mili giây production (PGlite một luồng, không JIT) |
| `GET /api/perf` | p50/p95 từng báo cáo trên máy thật | — |

---

## 6. Tài liệu nguồn, theo thời gian

| Tệp | Nội dung · còn dùng được đến đâu |
|---|---|
| `docs/erp-perf-audit.md` (08/09) | Vòng 1: "không có nút thắt" — chỉ đo điểm cuối tầm thường, **đã bị P0 bác** |
| `docs/erp-perf-audit-round2.md` | Vòng 2: không số production mới; ngưỡng quy mô vẫn dùng được |
| `docs/erp-performance-p0-report.md` (09/09) | Nguyên nhân gốc 2.1–2.10, đo trên PGlite — dùng cho HƯỚNG và TỶ LỆ |
| `docs/erp-performance-p0-2-report.md` | Production thật; bảng dẫn xuất + `OUTCOME_FENCE` |
| `docs/erp-performance-p0-3-report.md` | `canonical_order_outcome`; 25/25 màn đạt ngày 09/09 |
| `docs/erp-performance-p0-5-report.md` (10/09) | Đệm, `dashboard-warm`, **Phụ lục 2 = bằng chứng JIT đầu tiên** |
| `docs/TECH-4-*.md` (22/09) | Kịch bản đo chuẩn trang vận đơn — chưa có số |
| `docs/perf/TECH-5-so-do-tho-2026-09-22.md` | Số đo thô EXPLAIN — đọc kèm mục BỔ SUNG 23/09 |
| `docs/TECH-6-*.md` | Cách đo phía trình duyệt — không số |
| `docs/perf/TECH-6-TECH-9-so-do-tho-2026-09-23.md` + `TECH-6-smoke-tho-2026-09-23.txt` | Thời gian 59 tuyến, máy bão hoà; bể kết nối |
| `docs/TECH-7-explain-analyze-findings.md` | Suy luận từ chú thích trong mã, KHÔNG chạy đo |
| `docs/TECH-9-infrastructure-health-check-2026-09-23.md` | Tài nguyên máy chủ lúc bão hoà |
| `docs/TECH-10-improvement-spec.md` | Đặc tả phương án với % cải thiện ƯỚC TÍNH — không phải số đo |
| `docs/perf/JIT-bat-tat-2026-09-23.md` | Số đo JIT bật/tắt, hai lượt; sổ ứng viên chưa đo |
| `docs/perf/*.json`, `*.txt` | Đầu ra thô của bench (PGlite) và probe |
