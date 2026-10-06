# Kế hoạch theo phase — trạng thái thật

*Sứ mệnh `saas-platform-restructure` (sổ chung `ai-control/registry`), nhánh `feat/saas-platform-restructure`. Phụ thuộc:
PR #612 (pricing-billing-foundation) — nhánh này dựng TRÊN nó (entitlement tính năng, gói `commercial`, Margin Guard), phải
gộp sau nó.*

## Thứ tự và vì sao khác đề bài

Đề bài gợi ý Identity (Phase 3) trước Product Catalog (Phase 4). Audit cho thấy danh tính đang là SILO theo workspace
(một người hai workspace = hai tài khoản) và gắn chặt vào tính chất an toàn "JWT `org` ⇒ tra trong CSDL đó"; hợp nhất nó là
thay đổi xác thực rủi ro cao nhất của cả chương trình, trong khi Account / Product / Subscription / Usage / Cost / Billing
KHÔNG cần nó. Nên đợt 1 dựng toàn bộ lớp thương mại trên mô hình danh tính hiện có, và danh tính hợp nhất đi riêng.

| Phase | Nội dung | Trạng thái |
|---|---|---|
| 0 | Audit repo, worktree, PR, mã SaaS / chatbot / auth / billing | **XONG** (README §2, OWNERSHIP §2) |
| 1 | Mô hình chuẩn: Account → Workspace → Product Subscription | **XONG** — 0224 |
| 2 | Control plane lõi (tài khoản, thuê bao, nhật ký cấp tài khoản) | **XONG** |
| 3 | Danh tính hợp nhất (User toàn nền tảng + Membership + chuyển workspace trong phiên) | CHƯA — sứ mệnh riêng, rủi ro xác thực cao; giữ bất biến SECURITY §3 |
| 4 | Danh mục Product → Capability → Feature + entitlement hiệu lực | **XONG** (catalog + #612) |
| 5 | Thuê bao + nền đo dùng (sổ chung idempotent, một chỉ số một nguồn) | **XONG** |
| 6 | Sổ chi phí + bộ máy giá → bảng kê (hoá đơn / chargeback) | **XONG** — thu tiền phần vượt chờ chủ nền tảng chốt đơn giá |
| 7 | VNXCommerce là khách nội bộ | **XONG** — tài khoản `vnxcommerce`, thuê bao ERP + Chốt Đơn, chargeback |
| 8 | Chốt Đơn làm chủ miền chatbot | **XONG ở mức khai báo + thuê bao**; runtime VNX chuyển theo OWNERSHIP §4 |
| 9 | Ranh giới ERP ↔ Chốt Đơn | **XONG** (lời gọi hàm có luật, INTEGRATION §2) — `PancakePosSink` là việc của Phase 8b |
| 10 | `/chatbot` là cửa vào | **XONG** — khung chủ sở hữu + đưa sang `/ai/sales-chatbot`; thành chuyển hướng khi runtime cũ tắt |
| 11 | Operator Console | **XONG** — `/platform/customers`, `/platform/products` (+ `/platform`, `/platform/saas` có sẵn) |
| 12 | Cổng khách | **MỘT PHẦN** — «Sản phẩm của tôi» ở `/settings/plan`; tự đổi gói theo sản phẩm, API key, tên miền theo sản phẩm chưa có |
| 13 | KPI SaaS | **MỘT PHẦN** — `/platform/saas` (MRR, NRR/GRR, churn, kích hoạt) + kinh tế theo khách / sản phẩm ở console; ARPA theo sản phẩm chờ có gói riêng |
| 14 | Dọn di sản | **XONG phần entitlement** — nhà đọc gói GÁN cho nó (cột `plan`, 0225) qua cùng resolver với khách; bài so trước/sau + đột biến (`tests/saas-internal-plan.test.ts`). Còn: hạn mức AI nhà (đi cùng khoá AI `HOME`), chặn thu phí nhà ở `lib/billing/**` — ENTITLEMENTS «Nhánh GIỮ» |

## Phase 8b — chuyển runtime bán hàng của VNX (cần chủ shop)

Bốn chặn kỹ thuật ở OWNERSHIP §4. Mỗi chặn là một PR riêng; bước bật `ai_sales` ở chế độ bóng cho page đầu tiên và mỗi lần
chuyển page là **quyết định của chủ shop** (production không đảo được nửa chừng).

## Acceptance

| Bài | Ở đâu | Kết quả |
|---|---|---|
| Customer03 chỉ qua nền tảng | `tests/saas-platform.test.ts::testCustomer03` | tài khoản → workspace → thuê bao → module → quản trị → liên kết kích hoạt; idempotent; thuê thêm; huỷ; chạy lại job hỏng |
| Product03 không đổi lõi | `::testProduct03` | danh mục thử với sản phẩm thứ ba: cấp phát, sổ dùng, đọc dùng, bảng kê |
| VNXCommerce nội bộ | `::testMigration`, `::testInternalAndStatements` | INTERNAL / chargeback, ERP + Chốt Đơn, cùng cấu trúc với khách ngoài |
| Cô lập | `::testIsolation` | console, cổng khách, SDK |
