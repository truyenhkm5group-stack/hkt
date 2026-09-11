# Release 11/09/2026 — tích hợp Care Engine + AI Copilot (OpenAI/Anthropic) + nối giao diện

Vai trò: Integration + Release Lead. Một release, một lần deploy.

## 1. Tình trạng trước khi tích hợp (14:40 UTC+7 → 13:42 UTC)

| Mục | Giá trị |
|---|---|
| Production (`Deploy ERP to VPS` #226, thành công 11:24 UTC) | `9dd6823` |
| `origin/main` | `1320cc8` (= production + 1 commit docs sổ ngân hàng) |
| Nhánh Fable `claude/serene-hopper-bsfnnh` | `9d7a288` care engine, `ffb0112` AI copilot (chưa lên main) |
| Nhánh UI `claude/erp-ui-redesign-opus5` | chưa có lúc bắt đầu; xuất hiện lúc ~14:05 UTC với HEAD `d51a6f0` = đúng 5 commit (`daaee23`, `1ef0f53`, `a5ada15`, `478dcc9`, `d51a6f0`), merge-base `36df968` |
| Nhánh cũ (`perf/p0-reporting-speed`, `claude/release-engineering-p0`, `hotfix/vtp-import-recovery`, `claude/vtp-direct-fulfillment-p1`, `codex/erp-data-truth-p0`, `claude/erp-data-truth-p0`, `claude/mb-bank-transaction-app-3am23s`, `wip/*`) | không có merge-base với `main` hiện tại; `main` là siêu tập nội dung (mọi khác biệt là `main` mới hơn) ⇒ không mang gì thêm |

KPI snapshot production TRƯỚC (ops `kpi-snapshot`, 13:42:30 UTC, SHA 9dd6823):

| Chỉ số | Trước |
|---|---|
| Đơn: tổng / giao thành công / hoàn / hoàn theo luật / đang giao / chưa rõ / chưa gửi / huỷ | 2.587 / 430 / 939 / 0 / 326 / 13 / 224 / 655 |
| GTC | 31,4 % |
| Tiền: lên đơn / giao thành công / thực nhận có chứng từ / COD đang chờ | 993.371.498 / 228.862.000 / 212.052.000 / 15.314.000 |
| Quy mô: đơn / vận đơn / sự kiện / việc đang mở / hoàn chờ kiểm đếm | 2.587 / 1.988 / 27.933 / 324 / 530 |
| `shipment_care` / `carrier_action_requests` | 0 / 0 dòng (chưa ai thao tác) |
| `drizzle.__drizzle_migrations` | 60 dòng, max id 60 |
| `bank_transactions` | 80 dòng |

## 2. Nhánh tích hợp `release/integration-2026-09-11` (từ `1320cc8`)

| Commit | Nội dung |
|---|---|
| `b308ea1` | Care engine backend (cherry-pick 9d7a288): vòng đời 9 trạng thái, `care_case_events` chỉ-thêm, service không phụ thuộc phiên, ma trận năng lực VTP, adapter ĐVVC retry/idempotent, báo cáo attribution chặt; migration 0061 |
| `d4d15b8` | AI Copilot foundation (cherry-pick ffb0112): provider trừu tượng, registry tool đọc/ghi, token xác nhận, `ai_interactions`; migration 0062 |
| `ae92665` | OpenAI Responses provider + router 3 bậc, 8 tool ERP + resolve/reopen, ngăn kéo copilot toàn cục, "Tóm tắt bằng AI", nút Mở lại case, báo cáo care (doanh thu cứu được, khối lượng theo người), thẻ AI ở Kết nối dữ liệu |
| `7114871` | Khoá AI lên VPS qua GitHub Secrets (deploy + ops `apply-ai-env`), `check-integrations --ai` |
| `07659f6` | Merge 5 commit UI Opus: ngôn ngữ thiết kế chung, StatStrip ba bậc, thẻ chỉ số bấm được, chữ vào ⓘ, khung xương khớp trang, docs/design-system.md — không xung đột văn bản, review ngữ nghĩa sidebar/dashboard |
| `a8a1a99` | Một image `erp-app:local` cho app + scheduler; tiêu đề SectionCard không bị bộ lọc ép cột |
| `95db80e` | Dựng image ở GitHub Actions, đẩy GHCR theo SHA, VPS chỉ `docker pull` (deploy #227 và #228 chết SIGKILL khi `next build` trên VPS 1,9 GB / 0 swap) |
| `80af7ec` | docs TRIEN-KHAI-VPS: đường deploy chuẩn |

Luật xung đột đã áp dụng: nghiệp vụ / truy vấn / hợp đồng / quyền giữ bản `main` + Fable; trình
bày / bố cục / tương tác lấy của Opus. 23 tệp Opus sửa không tệp nào bị `main` chạm từ merge-base
⇒ merge sạch; review ngữ nghĩa: `components/app-sidebar.tsx` chỉ đổi trình bày (allowedNavItems và
quyền giữ nguyên), `app/(dashboard)/page.tsx` đổi `<Link>` bọc thẻ thành `href` của MetricCard /
StatStrip (truy vấn `getDashboardData` / `getBusinessBrief` giữ nguyên), thanh đầu trang (⌘K, AI ✦)
không đổi; test `drilldown-contract` của Opus chạy xanh cùng bộ test Fable.

## 3. Cổng phát hành

Chạy trên checkout SẠCH (worktree tách riêng) cho `ae92665` và `a8a1a99`, rồi `npm run gate` cho
`95db80e`: integrity ✓ · tsc ✓ · eslint --max-warnings=0 ✓ · npm test TẤT CẢ KIỂM THỬ ĐẠT ✓ · build ✓ ·
sổ migration khớp đĩa ✓ · không lộ bí mật ✓ — 7/7 ba lần.

QA trình duyệt local (PGlite + dữ liệu demo 1.126 đơn, Chromium 1440×900) trên cây gộp: 42 route
HTTP 200, 0 RENDER_ERROR, 0 lỗi console / pageerror / hydration; chụp Tổng quan, Cần xử lý, Đơn
hàng, Vận đơn & care (+ báo cáo, tất cả), Đổi/trả, Kiểm đếm hoàn, Kho, COD, Bank, Lợi nhuận, Dòng
tiền, Khách, Hiệu quả SP, Kết nối, Tìm kiếm ⌘K, AI Copilot; đổi trạng thái care tại dòng vá ngay
(value = IN_PROGRESS không tải lại); ngăn kéo AI hiện đúng "AI chưa được cấu hình" khi thiếu khoá.
Phát hiện & sửa: tiêu đề SectionCard ở Cần xử lý bị bộ lọc ép thành cột 40px (lỗi có từ trước).
Hiệu năng route nặng nhất local: `/` 1,1 s lạnh, `/cod` 1,2 s, còn lại < 0,8 s.

## 4. Deploy

| Lần | SHA | Kết quả |
|---|---|---|
| #227 | `ae92665` | HỎNG ở `next build` trong Docker trên VPS (SIGKILL sau 623 s; hai image dựng song song) — production không bị đụng |
| #228 | `a8a1a99` | HỎNG cùng chỗ dù chỉ còn một image (SIGKILL sau 147 s; `npm ci` 11 phút vì tráo bộ nhớ). VPS: 2 CPU, 1.963 MB, 0 swap, load 7,6 |
| #229 | `80af7ec` | **THÀNH CÔNG** (14:51 → 15:02 UTC): dựng + đẩy image 3 phút 13 giây trên máy chạy GitHub, VPS kéo về + khởi động lại 5 phút 39 giây; `/api/health` trả đúng commit `80af7ec0583a` |


## 5. Xác minh production sau deploy (15:03–15:07 UTC, SHA `80af7ec`)

**Smoke** (ops `smoke`, đăng nhập thật, trong container): **39/39 đạt · 0 lỗi ứng dụng · 0 sai
quyền · 0 quá hạn**; 1 màn hình chậm `/ads` 6,0 s (lỗi hiệu năng có từ trước, P2 đã ghi). Trang
hằng ngày: `/` 210 ms · `/orders` 88 ms · `/shipments` 107 ms · `/cod` 89 ms · `/bank` 51 ms ·
`/reports` 232 ms · `/alerts` 80 ms · `/integrations` 69 ms.

**Cơ sở dữ liệu** (ops `db-query`, chỉ đọc):

| Mục | Trước (13:43) | Sau (15:07) |
|---|---|---|
| `drizzle.__drizzle_migrations` | 60 | **62** (0061 care_lifecycle, 0062 ai_interactions đã áp) |
| `shipment_care` | 0 dòng | 1 dòng `WAITING_CUSTOMER` (đội đã dùng bàn làm việc; ánh xạ trạng thái đúng) |
| `care_case_events` | (chưa có bảng) | 0 dòng, bảng đã tạo |
| `ai_interactions` | (chưa có bảng) | 0 dòng, bảng đã tạo |
| `carrier_action_requests` | 0 | 0 |
| `bank_transactions` | 80 | 80 (sổ ngân hàng không đổi) |
| Việc đang mở (`notifications` chưa đóng) | 324 | 341 (dữ liệu vận hành trong ngày) |
| Kiện đang giao thất bại | — | 44 |

**KPI parity** (ops `kpi-snapshot` trước / sau): xem mục 6.

## 6. KPI snapshot trước / sau (ops `kpi-snapshot`, cùng công thức `ORDER_OUTCOME`)

| Chỉ số | Trước 13:42 UTC (`9dd6823`) | Sau 15:40 UTC (`80af7ec`) | Nhận xét |
|---|---|---|---|
| Đơn tổng | 2.587 | 2.595 | +8 đơn mới trong 2 giờ (Pancake) |
| Giao thành công | 430 | 430 | không đổi |
| Hoàn | 939 | 942 | +3 kiện hoàn về theo sự kiện VTP mới (+23 sự kiện) |
| Hoàn theo luật | 0 | 0 | |
| Đang giao / chưa rõ / chưa gửi / huỷ | 326 / 13 / 224 / 655 | 323 / 13 / 232 / 655 | dịch chuyển theo đơn mới và sự kiện mới |
| GTC | 31,4 % | 31,3 % | mẫu số tăng 8 đơn |
| Tiền lên đơn | 993.371.498 | 993.895.498 | +524.000 = đơn mới |
| Tiền giao thành công | 228.862.000 | 228.862.000 | **không đổi** |
| Thực nhận có chứng từ | 212.052.000 | 212.052.000 | **không đổi** |
| COD đang chờ | 15.314.000 | 15.314.000 | **không đổi** |
| Vận đơn / sự kiện | 1.988 / 27.933 | 1.988 / 27.956 | +23 sự kiện webhook |
| Việc đang mở / hoàn chờ kiểm đếm | 324 / 530 | 345 / 530 | việc mới sinh theo dữ liệu trong ngày |

Kết luận parity: mọi con số tiền theo chứng từ giữ nguyên; các chênh lệch đều là dữ liệu mới phát
sinh trong 2 giờ giữa hai lần chụp, không có chênh lệch do đổi công thức. Không đụng `ORDER_OUTCOME`,
COD/payment truth, recognized COGS, phân bổ chi phí, sổ ngân hàng, ShipmentAttempt 1:N, tồn kho.

## 7. Trạng thái AI Copilot trên production

- Mã, migration, ngăn kéo, thẻ Kết nối dữ liệu: **đã lên**. `ai_interactions` đã tạo (0 dòng).
- Khoá OpenAI chủ shop cấp: **chưa vào máy chủ**. Lý do: repo PUBLIC ⇒ không thể đi qua ô `arg`
  của workflow (log công khai), không commit, không set-setting; phiên làm việc này không có
  quyền tạo GitHub Secret và không gọi được api.openai.com (proxy chặn) nên chưa kiểm được khoá.
- Đường làm: chủ shop tạo Secret `OPENAI_API_KEY` (Settings → Secrets and variables → Actions →
  New repository secret) → chạy workflow *Vận hành ERP trên VPS* action `apply-ai-env`: ghi vào
  `.env`, khởi động lại app + scheduler, rồi `check-integrations --ai` ping model thật và chạy một
  câu hỏi thật qua vòng lặp copilot (in meta, không in câu trả lời). Từ đó mỗi lần deploy tự giữ khoá.
- Cho tới lúc đó, ngăn kéo AI hiện "AI chưa được cấu hình. Chưa có OPENAI_API_KEY…", app không lỗi.
- Model routing khi bật: routine gpt-5.6-luna · copilot gpt-5.6-terra · analysis gpt-5.6-sol
  (`AI_MODEL` ghi đè bậc copilot; Anthropic dự phòng haiku-4-5 / opus-5 / opus-5).

## 8. Còn lại

- **P1** `/ads` 6,0 s lần mở đầu (smoke đánh dấu CHẬM, không chặn) — việc hiệu năng đã ghi từ vòng 4.
- **P1** VPS 1,9 GB / 0 swap: đã bỏ dựng image trên máy; nên thêm swap 1 GB để an toàn khi
  Postgres + app tăng dữ liệu (chủ shop quyết).
- **P2** Giá gpt-5.6-* chưa có trong bảng ước tính chi phí ⇒ `costUsd` ghi là chưa biết.
- **P2** Tool AI cho Orders/CSKH (write), Inventory, Profit hiện chỉ có tool ĐỌC; tool GHI ngoài care
  bị cấm ở MVP theo sàn rủi ro — mở là quyết định của chủ shop.
- Chưa có Secret ⇒ chưa đo được độ trễ / chi phí model thật trên production.

## 9. Việc chủ shop cần làm

1. Tạo GitHub Secret `OPENAI_API_KEY` (giá trị khoá đã gửi riêng cho phiên này — không dán vào chat
   công khai / ô arg / commit). Tuỳ chọn Variable `AI_PROVIDER=openai`.
2. Chạy ops `apply-ai-env`, đọc kết quả `check-integrations --ai`, mở ERP → ✦ AI → "Tóm tắt kiện này".
3. Quyết định: thêm swap 1 GB cho VPS; có mở tool ghi AI ngoài care không.
