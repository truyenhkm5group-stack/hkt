# VNX SaaS Operating System — kiến trúc control plane

*06/10/2026 · migration `0224_saas_control_plane` · mã `lib/saas/*` · kiểm thử `tests/saas-platform.test.ts`.
Tài liệu này mô tả MÃ ĐANG CÓ. Phần chưa làm nằm ở `PLAN.md`, không trộn vào đây.*

Đọc kèm: `OWNERSHIP.md` (ai sở hữu miền nào, chatbot), `INTEGRATION.md` (ranh giới ERP ↔ Chốt Đơn, SDK),
`ENTITLEMENTS.md`, `USAGE.md`, `COST_BILLING.md`, `PROVISIONING.md` (runbook), `SECURITY.md`, `PLAN.md`.
Nền móng trước đó: `docs/platform/target-architecture.md` (SILO), `docs/platform/pricing-billing-foundation.md`
(gói cấu hình được, entitlement tính năng, Margin Guard — PR #612).
Thiết kế sản phẩm vỏ khách Chốt Đơn (08/10/2026): `INBOX_V2.md` (hộp thư) · `ORDER_CANDIDATE.md` (đơn đang lên từ hội thoại) ·
`HELP_CENTER.md` (trợ giúp ba tầng + vào việc 10 bước) · `SHELL_AUDIT_2026-10-08.md` (kiểm vỏ ở 390 px / 1366 px).

## 1. Một câu

**Một mặt phẳng điều khiển nhỏ trong CSDL nhà (`platform_*`) quản lý KHÁCH → WORKSPACE → THUÊ BAO SẢN PHẨM →
ENTITLEMENT, đo dùng + chi phí, dựng bảng kê; mỗi sản phẩm giữ dữ liệu nghiệp vụ của nó trong CSDL riêng của từng
workspace. Khách nội bộ (VNXCommerce) và khách ngoài đi CÙNG một lõi — khác nhau đúng hai cột dữ liệu.**

```
                           VNX SaaS PLATFORM  (một mã nguồn, một tiến trình — modular monolith)
                                         │
                    CONTROL PLANE  (CSDL nhà, getPlatformDb(), bảng platform_*)
   ┌──────────────────────────────────────────────────────────────────────────────────────────┐
   │ Account (platform_accounts)  →  Workspace (platform_organizations)  →  Product Subscription │
   │ Danh mục Product → Capability → Feature  (lib/saas/catalog.ts — mã nguồn)                   │
   │ Gói / giá (platform_plans + commercial)   Entitlement (lib/saas/entitlements.ts + #612)     │
   │ Sổ dùng: platform_ai_usage · platform_tenant_usage_daily · platform_usage_events            │
   │ Sổ chi phí: AI · khai nền theo tháng · platform_cost_entries     Bộ máy giá → bảng kê        │
   │ Job cấp phát (platform_provisioning_jobs)   Nhật ký (platform_audit_log)   KPI (/platform/*) │
   └──────────────────────────────────────────────────────────────────────────────────────────┘
                                         │  hợp đồng v1: lib/saas/sdk.ts
              ┌──────────────────────────┼─────────────────────────────┐
         ERP data plane          Chốt Đơn data plane            Sản phẩm thứ ba
   (orders, products, stock…   (sales_chat_*, settings          (bảng của nó, trong
    trong CSDL workspace)       ai.salesChatbot*, …)             CSDL workspace)
```

## 2. Mô hình tenancy chuẩn — ánh xạ vào dữ liệu đang có

Không tạo thực thể trùng chỉ vì tên khác. Bảng so khớp (đo production 06/10/2026: 7 workspace — nhà `vnx`, ba
workspace HSLC, ba workspace thử):

| Khái niệm chuẩn | Ở đâu | Ghi chú |
|---|---|---|
| **Account** (khách thương mại) | `platform_accounts` — MỚI ở 0224 | `account_type` INTERNAL/EXTERNAL · `billing_mode` INTERNAL_CHARGEBACK/EXTERNAL_INVOICE · status · hồ sơ pháp nhân (tên pháp lý, MST, email chứng từ) |
| **Organization** (pháp nhân) | hồ sơ pháp nhân TRÊN tài khoản | Chưa có khách nào có hai pháp nhân; tách bảng riêng khi có dữ liệu thật đòi hỏi (PLAN.md) — tạo bảng rỗng bây giờ là nguồn sự thật thứ hai không ai ghi |
| **Workspace** (ranh giới cô lập) | `platform_organizations` (giữ tên) | "Tổ chức" trong UI cũ = workspace. `code` nằm trong JWT, khoá đệm, tên CSDL nên KHÔNG đổi tên bảng. Thêm cột `account_id` |
| **Product** | `lib/saas/catalog.ts::PRODUCTS` (mã nguồn) | `erp`, `chotdon` |
| **Capability** | `ProductDef.capabilities` → module đã có (`platform-modules.ts`) | module = đơn vị bật/tắt kỹ thuật có sẵn cổng đường dẫn + quyền |
| **Feature** | `lib/pricing/features.ts` (#612) | entitlement thương mại theo gói |
| **Plan / PlanEntitlement** | `platform_plans` (+ `commercial`, + `product_keys` 0224) | `product_keys NULL` = gói GỘP (mọi gói bán từ trước) |
| **CustomerEntitlementOverride** | `platform_org_pricing` (#612) | ghi đè tính năng / hạn mức / mức áp theo workspace |
| **Subscription** | `platform_product_subscriptions` — MỚI | workspace × sản phẩm; `plan_key NULL` = theo gói workspace |
| **Billing standing** (trả tới ngày) | `platform_subscriptions` (0187, giữ) | một dòng / workspace, nguồn sự thật của `paid_through` |
| **User / Membership / Role** | `users` trong CSDL workspace + `platform_identities` | xem `SECURITY.md` §3 — chưa hợp nhất danh tính |
| **UsageEvent** | `platform_ai_usage` (AI) · `platform_usage_events` (MỚI, chung) | một chỉ số một nguồn |
| **UsageAggregation** | `platform_tenant_usage_daily` (0204) + gộp lúc đọc | không có bảng gộp thứ hai |
| **PricingRule** | `platform_plans.price_vnd` · `addon_prices` · `commercial.overage` | chỉ bộ máy bảng kê đọc |
| **BillableUsage / Invoice / InvoiceItem** | bảng kê nháp (tính lúc đọc) · `platform_billing_statements` (chốt) · `platform_invoices` (thu tiền 0187) | |
| **Payment** | `platform_billing_payments` (0187) | khớp tiền qua sổ ngân hàng nhà |
| **CostEvent / CostLedger** | `platform_ai_usage.cost_usd` · `platform.economics.costs` · `platform_cost_entries` (MỚI) | |
| **ProvisioningJob** | `platform_provisioning_jobs` — MỚI | |
| **Deployment** | một mã nguồn cho mọi workspace; `lib/version.ts::runningVersion` | không có "bản theo khách" |
| **AuditLog** | `platform_audit_log` (+ `target_account_id`) và `audit_logs` trong CSDL workspace | |

## 3. Quyết định kiến trúc

**S1 — Workspace = ranh giới cô lập = một CSDL (SILO giữ nguyên).** Không thêm `account_id` vào bảng nghiệp vụ nào.

**S2 — Danh mục sản phẩm là MÃ NGUỒN, cấu hình khách là DỮ LIỆU** (cùng nguyên tắc P6 của sổ module). Thêm sản phẩm thứ
ba = thêm một mục `PRODUCTS` (khả năng, tính năng, chỉ số dùng, module cấp) — mô hình khách, thuê bao, sổ dùng, bộ máy
bảng kê không đổi (bài kiểm Product03).

**S3 — Lõi thương mại dùng chung.** `customers · products · orders · inventory` (+ `core`, `work`) do ERP sở hữu nhưng được
cấp kèm mọi sản phẩm cần nó. Workspace là khách ERP ⇔ có ít nhất một module ĐỘC QUYỀN của ERP; khách Chốt Đơn ⇔ `ai_sales`
bật (hoặc runtime cũ `connector_pancake.chatbot`). Shop «Chỉ cần AI bán hàng» vì vậy KHÔNG bị tính là khách ERP.

**S4 — Gói gộp không bị chép.** Mọi gói bán từ trước là gói gộp (ERP + chatbot một giá). Thuê bao sản phẩm mặc định
`plan_key NULL` = "theo gói workspace"; bảng kê tính gói gộp MỘT lần cho workspace. Gói riêng một sản phẩm khai
`product_keys` + gán `plan_key` trên thuê bao.

**S5 — Tình trạng thuê bao tính lúc đọc.** Người vận hành chọn `ACTIVE · PAUSED · CANCELED`; `TRIAL · PAST_DUE · EXPIRED`
là hàm thuần của lựa chọn đó + thu phí (`policy.ts::effectiveSubscriptionStatus`) — đúng tới từng ngày, không cần job.

**S6 — Khách nội bộ = dữ liệu, không phải nhánh mã.** Mọi chỗ `account_type` / `billing_mode` đổi hành vi nằm trong
`lib/saas/policy.ts` + bộ máy bảng kê; bài kiểm quét `lib/ app/ components/` chặn so sánh ở nơi khác. Không tài khoản nào
được miễn đo; `INTERNAL` không cấp quyền gì.

**S7 — Một chỉ số một nguồn, một khoản chi một nguồn.** Khai ở `ProductMetric.source` và ở CHECK hạng mục của
`platform_cost_entries` (không nhận AI, không nhận hạ tầng / hỗ trợ nền).

**S8 — Runtime sản phẩm không biết giá.** Giá chỉ ở gói và chỉ bộ máy bảng kê đọc (bài kiểm quét `lib/sales-chatbot`).

**S9 — Modular monolith.** Không dịch vụ mới, không hàng đợi mới: job cấp phát chạy đồng bộ trong server action, có dòng
job + bước + idempotent + chạy lại; sổ là Postgres.

## 4. Các phần đã chạy

| Phần | Mã | Màn hình |
|---|---|---|
| Tài khoản, gắn workspace, gộp bằng chuyển workspace | `lib/saas/accounts.ts` | `/platform/customers/[code]` |
| Danh mục sản phẩm | `lib/saas/catalog.ts` | `/platform/products`, `/platform/products/[key]` |
| Thuê bao sản phẩm + tình trạng hiệu lực | `accounts.ts`, `policy.ts` | trang khách |
| Entitlement theo sản phẩm | `lib/saas/entitlements.ts` | trang khách, `/settings/plan` |
| Sổ dùng chung + đọc dùng theo nguồn | `lib/saas/ledger.ts` | trang khách, trang sản phẩm |
| Sổ chi phí + phân bổ có căn cứ | `ledger.ts`, `allocation.ts` | trang khách, danh sách khách |
| Bộ máy giá → bảng kê (hoá đơn / chargeback) | `statement.ts`, `customers.ts`, `billing.ts` | trang khách (nháp + chốt) |
| Job cấp phát | `lib/saas/provisioning.ts` | danh sách khách (tạo), trang khách (thuê / huỷ / chạy lại) |
| Hồ sơ thương mại cho MỌI workspace mới | bước 6 của `provisionOrganization` | — |
| Hợp đồng nền tảng ↔ sản phẩm v1 | `lib/saas/sdk.ts` | — |
| Operator Console | `lib/saas/console.ts`, `lib/actions/saas.ts` | `/platform/customers`, `/platform/products` |
| Cổng khách «Sản phẩm của tôi» | `lib/saas/portal.ts` | `/settings/plan` |
| `/chatbot` là cửa vào của Chốt Đơn | `components/saas/chatbot-entry.tsx` | `/chatbot` |

## 5. VNXCommerce — khách nội bộ

Migration 0224 tạo tài khoản `vnxcommerce` (INTERNAL · INTERNAL_CHARGEBACK) sở hữu workspace nhà, với thuê bao ERP + Chốt
Đơn (Chốt Đơn chạy bằng runtime cũ — bot nhà — tới khi chuyển xong, `OWNERSHIP.md` §4). Trang `/platform/customers/vnxcommerce`
dùng đúng trang, đúng component của khách ngoài. Bảng kê của VNX là **chargeback**: gói nội bộ (chưa khai giá nội bộ ⇒
dòng chưa biết, không bịa) + chi phí AI nền tảng trả + phần phân bổ hạ tầng / chi phí chung. Biên gộp in **N/A** — một
trung tâm chi phí không có doanh thu thị trường.

## 6. Operator Console

`/platform/customers` (danh sách: mỗi khách một MỨC SỨC KHOẺ — Nguy cấp · Cần chú ý · Chưa đủ dữ liệu · Khoẻ · Đã dừng — kèm
LÝ DO cụ thể, lọc nhanh `?muc=`; một dòng mỗi workspace: sản phẩm · gói, đăng nhập · hoạt động, kênh · khách AI, AI 24 giờ, đơn
AI, khách AI / gói, doanh thu · biên; tạo khách; chi phí cấp nền tảng) → `/platform/customers/[code]` (khối Sức khoẻ · tổng
quan · workspace · sản phẩm + entitlement + thao tác · dùng · bảng kê nháp + chốt · chi phí & biên · triển khai · job cấp phát
· nhật ký) · `/platform/products` → `/platform/products/[key]`.

Sức khoẻ khách: hàm phân loại THUẦN `lib/saas/customer-health.ts`, mức · lý do · chỗ chưa đo · ngưỡng khai ở
`lib/constants/customer-health.ts` (ngưỡng chủ shop đã chốt ở nơi khác thì lấy lại hằng đang chạy — SLO AI bán hàng, trần phiên
đăng nhập, ngưỡng cảnh báo của phiên bản giá; còn lại là mặc định kỹ thuật, chủ shop đổi được), tín hiệu đọc MỘT lượt gom ở CSDL
nhà (`lib/saas/customer-signals.ts`, không mở CSDL tổ chức nào — trang một khách đọc thêm trạng thái kích hoạt để lời khuyên
«chưa ai đăng nhập» nói đúng việc). Mức = lý do NẶNG NHẤT (không điểm tổng có trọng số — spec §7). Tín hiệu bắt buộc không đọc
được, hoặc đọc được mà chưa đủ để kết luận (nền tin khách ngắn, cửa sổ hoạt động chụp thiếu ngày, mốc kích hoạt không đọc
được, đồng hồ khách AI chưa đo khi gói có trần) ⇒ «Chưa đủ dữ liệu», KHÔNG BAO GIỜ «Khoẻ». Sức khoẻ luôn của HIỆN TẠI (mốc đọc +
khách AI kỳ hiện tại) — xem tiền kỳ cũ bằng `?ky=` không đổi mức. Cờ bảng kê ở đầu trang một khách (lỗ gộp — chỉ khách đã trả
tiền · quá hạn · hết hạn · cấp phát hỏng · chi phí chưa biết · lệch module ↔ thuê bao) giữ nguyên. Kinh tế nền tảng (MRR
movement, NRR/GRR, kích hoạt) vẫn ở `/platform/saas`; sức khoẻ CSDL ở `/platform`.

## 7. Cổng khách

`/settings/plan` (đã có: gói, hạn mức, thanh toán VietQR, mua thêm, VAT) + khung «Sản phẩm của tôi» (tài khoản, sản phẩm,
tình trạng, khả năng, tính năng hiệu lực). Không chi phí AI, không token, không biên.
