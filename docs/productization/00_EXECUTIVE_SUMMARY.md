# 00 · Tóm tắt điều hành — AI Sales Agent for Social Commerce

> Trạng thái đo ngày **04/10/2026** (cập nhật tối 04/10 sau khi #522 #533 #537 #538 #539 #546 #547 #549 vào main). Bảng dưới là **Definition of
> Done** của lệnh chủ shop, từng mục kèm bằng chứng (PR / tệp / bài kiểm) và việc còn thiếu. Một mục chỉ ghi **ĐẠT** khi
> mã đã vào `main`; nhánh / PR đang mở ghi **ĐANG GỘP**. Cập nhật tệp này mỗi khi một PR của chương trình gộp.

## 1. Một đoạn

ERP đã là nền tảng nhiều tổ chức kiểu SILO (mỗi tổ chức một CSDL — `docs/platform/target-architecture.md`), có tự đăng
ký, gói, thu phí, sổ dùng AI, mẫu ngành. Chương trình AI Sales biến chatbot bán hàng đa tổ chức (`lib/sales-chatbot`)
thành sản phẩm chính, đo được tới **đơn giao thành công** theo `ORDER_OUTCOME`. Phần đã có: lõi đơn an toàn cho máy
(#525), lời nhắc theo ngành (#527), cô lập tổ chức có bài tấn công riêng cho AI bán hàng (#532), sổ sự kiện + màn
Hiệu quả (#522), kinh tế SaaS + Owner Cockpit (#533), sổ dùng theo ngày (#537), phát lại hội thoại cũ + bốn chế độ vận hành
pilot (#538), bài E2E trọn vòng (#539). Tối 04/10 thêm: so AI vs Người theo nhánh + drill-down về hội thoại (#547), xu hướng 4 tuần trong Cockpit (#549),
Messenger trực tiếp (#517), gói «Chỉ cần AI bán hàng» (#530). Đang gộp: bộ hội thoại vàng M1 (#540), Zalo OA (#555).

## 2. Kiến trúc đã chốt khác bản lệnh ở đâu (và vì sao)

| Lệnh nói | Thực tế kho mã | Quyết định |
|---|---|---|
| Mọi entity mang `tenant_id` | SILO: mỗi tổ chức một CSDL; mặt phẳng điều khiển (`platform_*`) ở CSDL nhà | Giữ SILO. Cô lập là tính chất của kết nối CSDL, không phải của từng câu `WHERE` — bài kiểm tấn công chứng minh (§3 mục 2) |
| Một bảng Agent chung Human/AI/System | `actor_kind` trên sổ sự kiện (#522) + `users.id` cho người; AI / máy là `NULL` có nghĩa rõ (AGENTS §34) | Không thêm bảng Agent cho tới khi có ≥ 2 AI agent khác nhau trong một tổ chức |
| Event ledger theo danh sách 40 loại | `sales_conversation_events` 17 loại có CHECK (#522) — mỗi loại có nguồn THẬT | Thêm loại khi có nguồn; không khai loại chưa ghi được |

## 3. Definition of Done

| # | Mục | Trạng thái | Bằng chứng | Còn thiếu |
|---|---|---|---|---|
| 1 | Fashion và HSLC chạy trên cùng nền tảng | ĐẠT | VNX (nhà) + `hslc-*` trên production; Fashion COD #518; mẫu `seafood-commerce` | — |
| 2 | Cô lập tổ chức có bài kiểm tự động | ĐẠT | `tests/tenant-attack.test.ts`, `platform-isolation*.test.ts`, `ai-sales-isolation.test.ts` (#532 + bản mở rộng: sổ sự kiện, phát lại, Copilot, màn Hiệu quả; có đột biến) | — |
| 3 | Không `tenant == X` trong lõi | ĐẠT | `git grep` 04/10: không rẽ nhánh theo mã tổ chức | Mẫu chiến dịch tên «HSLC» trong `lib/wholesale/campaigns.ts` là DỮ LIỆU mẫu, không phải luật — xem sổ rủi ro R-3 |
| 4 | Human + AI một mô hình tác nhân | ĐẠT | #522: `actor_kind` AI / HUMAN / SYSTEM / CUSTOMER | Câu trả lời của người chỉ mang `users.id` khi có hộp thư người trong ERP (M8) |
| 5 | Conversation có mô hình chuẩn | ĐẠT (một phần) | `sales_chat_conversations` / `messages` / `inbound` dùng chung WEB · FANPAGE · (MESSENGER #517) | Lớp kênh (M6) |
| 6 | Sales Event Ledger | ĐẠT | #522 append-only, `dedupe_key` UNIQUE | — |
| 7 | Phễu từ sự kiện tin cậy | ĐẠT | #522 màn «Hiệu quả» | — |
| 8 | AI Sales Dashboard | ĐẠT | #522 `/ai/sales-chatbot/performance` | — |
| 9 | Human vs AI Benchmark | ĐẠT | #522 nhóm AI_ONLY / AI_THEN_HUMAN / HUMAN_ONLY; #547 khối «AI vs Người — theo nhánh thử nghiệm» (chia ngẫu nhiên #538, ý định điều trị, ORDER_OUTCOME, độ phủ nhánh người, mẫu < 10 ⇒ «—») | Theo TỪNG NGƯỜI: chờ M8 |
| 10 | Sales Leaderboard | CHƯA | — | Cần `users.id` cho câu trả lời người (M8); không xếp hạng người bằng chỉ số họ không quyết (AGENTS §24) |
| 11 | Upsell / cross-sell analytics | ĐẠT (upsell) | #522 sự kiện upsell mời / nhận / từ chối | Cross-sell tách riêng: chưa có nguồn phân biệt |
| 12 | Delivered Revenue | ĐẠT | #522 qua `ORDER_OUTCOME` + độ phủ kết cục | — |
| 13 | Cost / Order, Cost / Delivered Order | ĐẠT | #522 chi phí AI / đơn giao | Chi phí người: chủ shop khai (ROI v1) |
| 14 | Customer ROI Engine | ĐẠT (v1) | #522 tiết kiệm ước tính (nhãn ước tính, người khai) | Lương / hoa hồng thật theo người (M8 + payroll) |
| 15 | Drill-down KPI → hội thoại | ĐẠT | #547: ô nhóm · lý do chuyển người · nhánh trên màn Hiệu quả → `/ai/sales-chatbot/conversations`; xem lại một hội thoại `/ai/sales-chatbot/conversations/<id>` (chữ + công cụ + sổ sự kiện, che SĐT) | — |
| 16 | Fashion là mẫu ngành | ĐẠT | #518 Fashion COD, #527 gói lời nhắc `fashion` | — |
| 17 | HSLC là mẫu ngành | ĐẠT | `seafood-commerce` (#457), gói `food` (#527), bảng giá sỉ + công nợ (#455) | — |
| 18 | HSLC chạy Observe / Copilot / AI-vs-Human / Autopilot | ĐẠT | #538 + `19_HSLC_PILOT.md` | Messenger / Zalo nối cổng sau khi gộp |
| 19 | SaaS analytics (MRR, ARR, New, Expansion, Contraction, Churn, GRR, NRR, CAC-ready, biên) | ĐẠT | #533 + `11_SAAS_METRICS_SPEC.md` | CAC: chưa có nguồn chi phí bán hàng của nền tảng (khai UNAVAILABLE) |
| 20 | Owner Cockpit | ĐẠT | #533 `/platform/saas` | — |
| 21 | Kinh tế từng tenant | ĐẠT | #533 cột MRR · AI nền tảng trả · đóng góp | Hạ tầng / hỗ trợ chưa phân bổ (chưa có căn cứ) |
| 22 | AI usage / cost được đo | ĐẠT | `platform_ai_usage` (0176) theo tổ chức × tính năng × nguồn | — |
| 23 | Time-to-Value | ĐẠT | #533 mốc kích hoạt; mốc «đơn AI giao thành công đầu tiên» qua `ORDER_OUTCOME` (#539) | — |
| 24 | Historical Replay / Evaluation | ĐẠT | #538 + `22_HISTORICAL_REPLAY.md` | Nguồn lịch sử Pancake (v2); nối kết cục đơn |
| 25 | Billing-ready | ĐẠT | #454 thu phí, #485 mua thêm, gói + hạn mức (`lib/entitlements`) | Tài khoản nhận tiền: HUMAN GATE |
| 26–27 | Khách #3 / #4 không fork mã | ĐẠT | `/start` tự đăng ký (#497, #504), mẫu ngành, module theo tổ chức | — |
| 28 | Onboarding chuẩn không cần thao tác CSDL tay | ĐẠT | `/start` tạo tổ chức + CSDL qua `provisionOrganization` | — |
| 29 | E2E then chốt pass | ĐẠT | `tests/e2e-ai-sales-platform.test.ts` (#539): tin khách → AI → đơn thật → giao (`ORDER_OUTCOME`) → Hiệu quả + ROI → mốc kích hoạt → sổ dùng → Owner Cockpit | Đường người tương đương để so (cần M8) |
| 30 | CI gates pass | ĐẠT | Mọi PR gộp qua `gates` (typecheck · lint · test hai lượt · build) | — |
| 31 | Smoke production sau release | ĐẠT | Workflow deploy chạy `scripts/smoke.ts`; trang mới phải có trong danh sách (`smoke-coverage`) | — |
| 32 | Chiến lược migration / backfill / lùi | ĐẠT | `MIGRATION_PLAN.md`; mỗi PR ghi cách lùi; `migration:renumber` | — |
| 33 | Không dữ liệu giả trong phân tích | ĐẠT | Chưa biết ⇒ `—` (AGENTS §42); bài kiểm khoá null ≠ 0 ở #533 / replay / copilot | — |
| 34 | Chỉ số có định nghĩa | ĐẠT (phần đã có) | `METRIC_CATALOG`, `11_…`, `22_…`, `19_…` | Thêm vào sổ khi #522 gộp |
| 35 | Không lỗ hổng chéo tổ chức P0 | ĐẠT (đã biết) | Bài tấn công + quét tĩnh S17–S21 | Chạy lại khi thêm kênh mới |
| 36 | Không lỗi toàn vẹn dữ liệu P0 | ĐẠT (đã biết) | TD-01/02/03 (giá do người gọi, tồn ngoài transaction, trùng đơn) đóng ở #525 | — |

## 4. Chỉ mục tài liệu (danh sách 00–22 của lệnh → tệp thật)

| Lệnh | Tệp |
|---|---|
| 01 Current architecture · 02 Domain inventory · 03 Tech debt | `CURRENT_STATE.md` · `DOMAIN_MAP.md` · `TECH_DEBT.md` |
| 04 Tenant audit | `CURRENT_STATE.md` §đa tổ chức + `docs/platform/target-architecture.md`, `docs/platform/security-final.md` |
| 05 Target architecture | `TARGET_ARCHITECTURE.md` |
| 06 Canonical data model · 07 Sales event spec · 08 Metric dictionary · 09 Human-AI benchmark · 10 ROI | `TARGET_ARCHITECTURE.md` §4–5 + tài liệu đi kèm #522 |
| 11 SaaS metrics · 12 Owner cockpit | `11_SAAS_METRICS_SPEC.md` · `12_OWNER_COCKPIT_SPEC.md` (#533) |
| 13 Vertical template | `docs/verticals/ROADMAP.md`, `lib/blueprints`, gói lời nhắc #527 |
| 14 Migration plan · 16 Rollout | `MIGRATION_PLAN.md` |
| 15 Test strategy | `AGENTS.md` §6, §9, §50, §65 + bài kiểm nêu ở bảng DoD |
| 17 Risk register | `17_RISK_REGISTER.md` |
| 19 HSLC pilot | `19_HSLC_PILOT.md` (nhánh chế độ vận hành) |
| 20 Runbook | `docs/platform/pilot-readiness.md`, `docs/platform/billing.md` |
| 22 Historical replay | `22_HISTORICAL_REPLAY.md` (nhánh replay) |
| Sản phẩm AI Sales | `AI_SALES_PRODUCT_SPEC.md` |

## 5. Cổng người (HUMAN GATE) đang chờ chủ shop

1. Khai **chi phí hạ tầng + hỗ trợ / tháng** ở `/platform/saas` (sau #533) — biên gộp mới có số.
2. Khai **tài khoản nhận tiền** thuê bao ở `/platform`.
3. Chọn lộ trình chế độ cho HSLC (quan sát bao lâu, tỷ lệ AI khi thử nghiệm) — `19_HSLC_PILOT.md` §4.
4. Giá gói «Chỉ cần AI bán hàng» (#530).
