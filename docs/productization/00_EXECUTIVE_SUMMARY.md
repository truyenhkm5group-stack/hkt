# 00 · Tóm tắt điều hành — AI Sales Agent for Social Commerce

> Trạng thái đo ngày **04/10/2026** (production `739dcfe8`, 200 migration, `/api/health` ok). Bảng dưới là **Definition of
> Done** của lệnh chủ shop, từng mục kèm bằng chứng (PR / tệp / bài kiểm) và việc còn thiếu. Một mục chỉ ghi **ĐẠT** khi
> mã đã vào `main`; nhánh / PR đang mở ghi **ĐANG GỘP**. Cập nhật tệp này mỗi khi một PR của chương trình gộp.

## 1. Một đoạn

ERP đã là nền tảng nhiều tổ chức kiểu SILO (mỗi tổ chức một CSDL — `docs/platform/target-architecture.md`), có tự đăng
ký, gói, thu phí, sổ dùng AI, mẫu ngành. Chương trình AI Sales biến chatbot bán hàng đa tổ chức (`lib/sales-chatbot`)
thành sản phẩm chính, đo được tới **đơn giao thành công** theo `ORDER_OUTCOME`. Phần đã có: lõi đơn an toàn cho máy
(#525), lời nhắc theo ngành (#527), cô lập tổ chức có bài tấn công riêng cho AI bán hàng (#532). Đang gộp: sổ sự kiện +
màn Hiệu quả (#522), kinh tế SaaS + Owner Cockpit (#533), Messenger trực tiếp (#517), gói «Chỉ cần AI bán hàng» (#530),
Phát lại hội thoại cũ và bốn chế độ vận hành pilot (nhánh `claude/ai-sales-replay`, `claude/ai-sales-che-do`).

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
| 2 | Cô lập tổ chức có bài kiểm tự động | ĐẠT | `tests/tenant-attack.test.ts`, `platform-isolation*.test.ts`, `ai-sales-isolation.test.ts` (#532, có đột biến) | Thêm bảng mới của #522 / replay / copilot vào ảnh chụp của #532 khi gộp |
| 3 | Không `tenant == X` trong lõi | ĐẠT | `git grep` 04/10: không rẽ nhánh theo mã tổ chức | Mẫu chiến dịch tên «HSLC» trong `lib/wholesale/campaigns.ts` là DỮ LIỆU mẫu, không phải luật — xem sổ rủi ro R-3 |
| 4 | Human + AI một mô hình tác nhân | ĐANG GỘP | #522: `actor_kind` AI / HUMAN / SYSTEM / CUSTOMER | Câu trả lời của người chỉ mang `users.id` khi có hộp thư người trong ERP (M8) |
| 5 | Conversation có mô hình chuẩn | ĐẠT (một phần) | `sales_chat_conversations` / `messages` / `inbound` dùng chung WEB · FANPAGE · (MESSENGER #517) | Lớp kênh (M6) |
| 6 | Sales Event Ledger | ĐANG GỘP | #522 append-only, `dedupe_key` UNIQUE | — |
| 7 | Phễu từ sự kiện tin cậy | ĐANG GỘP | #522 màn «Hiệu quả» | — |
| 8 | AI Sales Dashboard | ĐANG GỘP | #522 `/ai/sales-chatbot/performance` | — |
| 9 | Human vs AI Benchmark | ĐANG GỘP | #522 nhóm AI_ONLY / AI_THEN_HUMAN / HUMAN_ONLY; nhánh thử nghiệm ngẫu nhiên (nhánh `claude/ai-sales-che-do`) | Theo TỪNG NGƯỜI: chờ M8 |
| 10 | Sales Leaderboard | CHƯA | — | Cần `users.id` cho câu trả lời người (M8); không xếp hạng người bằng chỉ số họ không quyết (AGENTS §24) |
| 11 | Upsell / cross-sell analytics | ĐANG GỘP (upsell) | #522 sự kiện upsell mời / nhận / từ chối | Cross-sell tách riêng: chưa có nguồn phân biệt |
| 12 | Delivered Revenue | ĐANG GỘP | #522 qua `ORDER_OUTCOME` + độ phủ kết cục | — |
| 13 | Cost / Order, Cost / Delivered Order | ĐANG GỘP | #522 chi phí AI / đơn giao | Chi phí người: chủ shop khai (ROI v1) |
| 14 | Customer ROI Engine | ĐANG GỘP (v1) | #522 tiết kiệm ước tính (nhãn ước tính, người khai) | Lương / hoa hồng thật theo người (M8 + payroll) |
| 15 | Drill-down KPI → hội thoại | MỘT PHẦN | Danh sách hội thoại + replay / copilot hiện từng hội thoại | Liên kết từ từng ô KPI của #522 |
| 16 | Fashion là mẫu ngành | ĐẠT | #518 Fashion COD, #527 gói lời nhắc `fashion` | — |
| 17 | HSLC là mẫu ngành | ĐẠT | `seafood-commerce` (#457), gói `food` (#527), bảng giá sỉ + công nợ (#455) | — |
| 18 | HSLC chạy Observe / Copilot / AI-vs-Human / Autopilot | ĐANG GỘP | nhánh `claude/ai-sales-che-do` + `19_HSLC_PILOT.md` | Messenger / Zalo nối cổng sau khi gộp |
| 19 | SaaS analytics (MRR, ARR, New, Expansion, Contraction, Churn, GRR, NRR, CAC-ready, biên) | ĐANG GỘP | #533 + `11_SAAS_METRICS_SPEC.md` | CAC: chưa có nguồn chi phí bán hàng của nền tảng (khai UNAVAILABLE) |
| 20 | Owner Cockpit | ĐANG GỘP | #533 `/platform/saas` | — |
| 21 | Kinh tế từng tenant | ĐANG GỘP | #533 cột MRR · AI nền tảng trả · đóng góp | Hạ tầng / hỗ trợ chưa phân bổ (chưa có căn cứ) |
| 22 | AI usage / cost được đo | ĐẠT | `platform_ai_usage` (0176) theo tổ chức × tính năng × nguồn | — |
| 23 | Time-to-Value | ĐANG GỘP | #533 mốc kích hoạt | Mốc «đơn AI giao thành công đầu tiên»: chờ #522 |
| 24 | Historical Replay / Evaluation | ĐANG GỘP | nhánh `claude/ai-sales-replay` + `22_HISTORICAL_REPLAY.md` | Nguồn lịch sử Pancake (v2); nối kết cục đơn |
| 25 | Billing-ready | ĐẠT | #454 thu phí, #485 mua thêm, gói + hạn mức (`lib/entitlements`) | Tài khoản nhận tiền: HUMAN GATE |
| 26–27 | Khách #3 / #4 không fork mã | ĐẠT | `/start` tự đăng ký (#497, #504), mẫu ngành, module theo tổ chức | — |
| 28 | Onboarding chuẩn không cần thao tác CSDL tay | ĐẠT | `/start` tạo tổ chức + CSDL qua `provisionOrganization` | — |
| 29 | E2E then chốt pass | MỘT PHẦN | `self-service-journey` (khách → bot → đơn), `sales-events` (#522) | Một bài đi trọn khách → AI → đơn → giao → phân tích → ROI sau khi #522 gộp |
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
