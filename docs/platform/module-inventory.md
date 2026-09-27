# Nền tảng ERP — Kiểm kê module (đọc từ mã nguồn)

> Đo trên cây `wt-platform` ở `origin/main` = `41002d1e` (27/09/2026). Mọi khẳng định dẫn về tệp thật.
> Số dòng của `db/schema.ts` và `db/index.ts` là của commit `41002d1e` (`git show 41002d1e:db/schema.ts`):
> cây làm việc đang có sửa đổi CHƯA COMMIT của phiên nền tảng (bảng `platform_*`, `getDbFor`), nên số
> dòng trên đĩa lệch từ dòng 4223 trở đi. Bản kiểm kê này mô tả hệ thống TRƯỚC các sửa đổi đó.
> Phụ thuộc giữa module KHÔNG suy từ tên tệp: một script đọc từng tệp `.ts/.tsx` trong `lib/`, `app/`,
> `components/`, bắt (a) mọi `import … from "@/lib/…"` và (b) mọi bảng được chạm qua `schema.<bảng>`,
> `import { <bảng> } from "@/db/schema"` hoặc SQL thô `from/join/into/update <tên_bảng>`, rồi gộp theo
> module. `scripts/` KHÔNG được tính (script vận hành, không phải bề mặt sản phẩm).
>
> Tài liệu đi kèm: `docs/platform/data-ownership.md` (từng bảng thuộc module nào). Khoá module ở đây
> là khoá LÀM VIỆC của bản kiểm kê; phần 7 đối chiếu với bản nháp sổ module ở
> `docs/platform/shared-contracts.md` §5 và chỉ ra chỗ mã nguồn nói khác bản nháp.

## 0. Con số tổng

| Hạng mục | Số | Nguồn |
| --- | --- | --- |
| Trang (`page.tsx`) trong `app/(dashboard)/` | 97 (+ `app/login`, `app/print/production/[id]`) | `find app -name page.tsx` |
| Segment cấp 1 trong `app/(dashboard)/` | 34 thư mục (+ 9 tệp ở gốc: `page.tsx`, `layout.tsx`, `business-brief.tsx`…) | `ls app/(dashboard)` |
| Route API (`route.ts`) | 27, trong 15 thư mục cấp 1 của `app/api/` | `find app/api -name route.ts` |
| `lib/queries/*.ts` | 197 | |
| `lib/actions/*.ts` | 81 | |
| `lib/constants/*.ts` | 216 (luật thuần, client-safe) | |
| Bảng / enum | 144 `pgTable` / 7 `pgEnum` (+289 `check(...)`) | `db/schema.ts` |
| Khoá quyền `module:action` | 66 trong `ALL_PERMISSIONS` (+1 khoá cũ `reports:view` chỉ còn trong `LEGACY_IMPLIES`) | `lib/auth/permissions.ts` |
| Mục menu | 44 | `lib/constants/department-modules.ts` |
| Job đồng bộ | 45 khoá trong sổ job `lib/sync/jobs.ts` (gồm khoá gộp `all`); lịch ở `scripts/scheduler.mjs` | |

## 1. Bảng module

Tenant-aware: **mọi module hiện là "Không (một tenant)"** — `db/index.ts:182` mở MỘT kết nối từ MỘT
`DATABASE_URL`; không truy vấn nào mang khái niệm tổ chức. Cột "Dependencies" chỉ ghi module KHÁC
(không ghi `core`, vì gần như mọi tệp đều import `lib/auth/*`, `lib/audit.ts`): "bảng" = đọc/ghi thẳng
bảng của module đó; "import" = import mã `lib/` của module đó (số trong ngoặc = số tệp import).

| Module | Existing routes | APIs | Tables | Dependencies | Generic? | Tenant-aware? | Action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **dashboard** (Tổng quan) | `/` (`app/(dashboard)/page.tsx`, `business-brief.tsx`, `top-actions.tsx`, `owner-decisions.tsx`, `data-freshness.tsx`) | `/api/events` (SSE, `dashboard:view`), `/api/refresh` | — (không sở hữu bảng) | bảng: orders, logistics, ads, alerts · import: work(6), orders(3), products(3), purchasing(2), finance(2), management(2) | Một phần — khung dùng lại được, nhưng các khối (brief, top-actions, quyết định chủ shop) đều là câu hỏi của VNX | Không (một tenant) | REFACTOR — khối trang chủ phải lọc theo module bật |
| **orders** (Đơn hàng + điều hành theo khâu) | `/orders`, `/orders/[id]`, `/orders/verify`, `/operations`, `/operations/preship`, `/operations/fulfillment`, `/operations/dwell` | `/api/export/orders` | `orders`, `order_items`, `order_status_history`, `stock_wait_log`, `canonical_order_outcome` | bảng: logistics, inventory, products, cod, cs, ads, landing, customers, returns, alerts, finance, purchasing · import: logistics(5), inventory(4), alerts(4), management(3) | Một phần — `orders.id` là id đơn Pancake (`db/schema.ts:1214`), ERP không tự tạo đơn; `ORDER_OUTCOME` (`lib/queries/return-rate.ts`) gắn luật COD Viettel Post | Không (một tenant) | REFACTOR — tách "nguồn đơn" (Pancake) khỏi lõi đơn |
| **customers** (Khách hàng) | `/customers`, `/customers/[id]`, `/customers/retention` | — | `customers` | bảng: orders, logistics · import: orders(2) | Có — CRM mỏng, chỉ phụ thuộc đơn + vận đơn | Không (một tenant) | KEEP |
| **products** (Sản phẩm, tồn Pancake, giá báo MKT) | `/products`, `/products/[id]`, `/products/performance` | `/api/export/products` | `products`, `product_variants`, `product_notes`, `warehouses`, `variant_stocks`, `inventory_histories`, `marketer_prices` | bảng: orders, logistics, ads, inventory · import: inventory(5), orders(5), purchasing(2) | Một phần — id sản phẩm/biến thể/kho là uuid Pancake (`db/schema.ts:1017,1070,1135`); `marketer_prices` là luật riêng VNX | Không (một tenant) | EXTEND |
| **inventory** (Sổ kho ERP) | `/inventory` (nhật ký kho), `/inventory/receipts`, `/inventory/packing` | — | `stock_receipts`, `stock_receipt_items` | bảng: products, purchasing, production, returns, logistics, orders, creative · import: purchasing(9), orders(5) | Có về khái niệm (phiếu dương/âm, AGENTS 10) — nhưng MỘT kho: `stock_receipts` không có `warehouse_id` (`db/schema.ts:2118`) | Không (một tenant) | EXTEND — thêm chiều kho khi có tổ chức nhiều kho |
| **purchasing** (Kế hoạch đặt hàng SX, xưởng, NCC) | `/inventory/planning` (+`/orders`, `/orders/new`, `/orders/[id]`, `/orders/[id]/edit`), `/inventory/purchasing`, `/inventory/workshop`, `/inventory/workshop/[id]`, `/inventory/shortage`, `/inventory/decisions`, `app/print/production/[id]` | `/api/export/planning` | `suppliers`, `production_orders`, `production_batches`, `production_deliveries`, `fabric_orders`, `supplier_payments` | bảng: products, orders, payroll, logistics, inventory, finance · import: inventory(6), production(6), products(5) | Không — đặt xưởng may, đặt vải (`fabric_orders`), ma trận size (`lib/inventory/size-matrix.ts`), sổ xưởng từ Google Sheet (`lib/workshop/sheet-import.ts`) | Không (một tenant) | EXTRACT — gói ngành may mặc |
| **production** (Company OS: vòng đời mẫu → topic → giá thành → mẫu → bản duyệt) | `/models`, `/models/[id]`, `/production`, `/production/topics/new`, `/production/topics/[id]`, `/production/models/[id]` | `/api/production/files/[id]` | `product_models`, `product_model_state_history`, `production_topics`, `production_topic_messages`, `production_topic_files`, `production_topic_file_chunks`, `cost_sheets`, `cost_sheet_lines`, `samples`, `sample_reviews`, `design_versions` | bảng: ideas, products, creative, purchasing, ads, inventory, returns, orders · import: inventory(6), ads(4) | Một phần — vòng đời mẫu là chung cho hàng tự sản xuất, nhưng trạng thái `ADS_TESTING`/`WINNER` (`db/schema.ts:7144`) gắn mô hình test mẫu bằng quảng cáo | Không (một tenant) | EXTRACT — gói ngành |
| **logistics** (Vận đơn, care, Viettel Post) | `/shipments`, `/shipments/[id]`, `/shipments/stock-wait`, `/import-vtp`, `/import-vtp/[batchId]` | `/api/shipments/[id]/push-history`, `/api/shipments/[id]/repush`, `/api/shipments/refresh`, `/api/webhooks/viettelpost`, `/api/webhooks/vtp-statement` | `shipments`, `shipment_events`, `vtp_status_registry`, `vtp_webhook_gaps`, `vtp_import_batches`, `shipment_care`, `carrier_action_requests`, `care_business_actions`, `care_decisions`, `care_case_events`, `care_actions` | bảng: cod, orders, products, cs, returns · import: products(6), alerts(5), returns(4), orders(4) | Một phần — `shipments` mang cột riêng VTP (`vtp_order_number` UNIQUE, `vtp_raw_*`), enum `shipment_stage` dựng theo từ vựng VTP; care (lib/care/*) thì chung | Không (một tenant) | REFACTOR — tách lõi vận đơn/care khỏi connector VTP |
| **returns** (Hàng hoàn, kiểm đếm, lý do hoàn, phiếu đổi/trả Pancake) | `/returns`, `/inventory/returns` | — | `order_returns`, `return_inspections`, `return_inspection_items`, `hmt_return_reconciliation`, `hmt_workbooks`, `return_unidentified`, `return_dispositions`, `shipment_return_reasons`, `return_reason_observations` | bảng: logistics, products, orders, inventory, production · import: orders(8), logistics(5), inventory(3) | Một phần — kiểm hàng hoàn là chung; `hmt_*` là bảng tính "Hàng hoàn HMT" của riêng VNX (`lib/constants/hmt-returns.ts:27`) | Không (một tenant) | EXTEND (+ tách `hmt_*` thành TENANT_SPECIFIC) |
| **cod** (Đối soát COD, chứng từ tiền) | `/cod` | `/api/export/cod` | `cod_batches`, `vtp_statement_files`, `cod_statement_lines`, `payment_transactions`, `payment_evidence`, `payment_reviews` | bảng: logistics, orders, finance · import: logistics(2), orders(2) | Một phần — mô hình chứng từ tiền (`payment_*`) chung; bảng kê là định dạng Viettel Post (`lib/integrations/viettelpost/statement*.ts`) | Không (một tenant) | REFACTOR |
| **finance** (Tổng quan tài chính, sổ ngân hàng, chi phí, hàng đợi tác vụ tài chính) | `/finance`, `/finance-ops`, `/bank`, `/expenses` | `/api/webhooks/sepay` | `expenses`, `bank_accounts`, `bank_transactions`, `bank_rules`, `bank_transaction_links` | bảng: ads, cod, inventory, orders, logistics, purchasing, products · import: ads(8), purchasing(4), orders(4), payroll(3) | Có — sổ ngân hàng + chi phí + thẩm quyền chi phí (`lib/constants/cost-authority.ts`) là mô hình chung; SePay là connector | Không (một tenant) | KEEP (+ tách SePay thành connector) |
| **reports** (Báo cáo lợi nhuận, dòng tiền, phễu, kịch bản, GTC) | `/reports`, `/reports/cashflow`, `/reports/funnel`, `/reports/returns`, `/reports/scenario`, `/reports/stock-wait`, `/reports/target` | `/api/export/report`, `/api/export/return-rate` | — (chỉ đọc; giả định ở `settings['profit.assumptions']`) | bảng: orders, logistics, cod, inventory, ads, finance, products, customers · import: orders(21), finance(11), inventory(7), returns(5) | Một phần — công thức đọc qua `ORDER_OUTCOME` + `RETURN_RULE` (50K/100K, `lib/constants/returns.ts:14,20`) là luật COD của VNX | Không (một tenant) | CONFIGURE — ngưỡng/giả định theo tổ chức |
| **payroll** (Lương & hoa hồng) | `/payroll` (+`/adjustments`, `/assignments`, `/autopilot`, `/migration`, `/payslip`, `/policies`, `/runs`, `/settings`), `/my-payslip` | `/api/export/payroll` | `payroll_periods`, `marketer_profit_carryover`, `salary_policies`, `salary_policy_versions`, `salary_policy_components`, `employment_assignments`, `employee_policy_assignments`, `payroll_inputs`, `payroll_adjustments`, `payroll_confirmations`, `payroll_payout_lines` | bảng: finance, orders, logistics, products, ads, inventory · import: finance(4), ads(3) | Một phần — động cơ chính sách lương có phiên bản là chung; hoa hồng marketer theo fanpage/giá báo MKT là của VNX | Không (một tenant) | CONFIGURE |
| **ads** (Quảng cáo, quy kết fanpage → marketer) | `/ads`, `/ads/daily`, `/marketing/fanpages` | — | `ad_account_billing`, `fb_adsets`, `fb_ads`, `ad_spends`, `ads_decision_ledger`, `ads_budget_changes`, `fanpages`, `fanpage_marketer_assignments`, `order_attributions` | bảng: products, orders, landing, logistics, cs, returns, work, alerts · import: orders(8), reports(7), inventory(6) | Một phần — chỉ Facebook Ads; `FACEBOOK_BUSINESS_ID` có mặc định cứng `336423739082347` (`lib/env.ts:78`) | Không (một tenant) | REFACTOR — tách connector Meta |
| **creative** (Thư viện media, vòng mẫu quảng cáo AI) | `/marketing/creatives` | `/api/creative/images/[id]` | `creative_images`, `creative_sources`, `creative_batches`, `creative_variants`, `creative_fb_actions`, `creative_verdicts`, `creative_learnings`, `design_concepts`, `product_dna`, `creative_scale_drafts`, `creative_manual_gens`, `creative_manual_gen_images` | bảng: products, ai, purchasing, ads, orders, logistics · import: ads(26), ai(22) | Không — đăng camp Facebook tự động cho hàng thời trang; tiêu tiền thật (OpenAI + QC) | Không (một tenant) | DEFER |
| **ideas** (Ý tưởng marketing) | `/ideas`, `/ideas/[id]` | `/api/ideas/images/[id]` | `marketing_ideas`, `marketing_idea_images`, `marketing_idea_comments` | bảng: production · import: production(1) | Có | Không (một tenant) | KEEP |
| **landing** (Đơn landing page) | `/landing` | — | `landing_orders`, `landing_attributions` | bảng: products, customers, orders, logistics · import: alerts(3), orders(1) | Không như hiện tại — đọc CSV Google Sheet theo cấu hình cột, giá mặc định 499K + ship 25K (`lib/constants/landing.ts:64`), đẩy đơn nháp sang Pancake (`lib/landing/pos.ts`) | Không (một tenant) | CONFIGURE |
| **outreach** (Chăm sóc & bán chéo, gửi tin hàng loạt) | `/outreach`, `/outreach/broadcast` | — | `outreach_targets`, `outreach_broadcasts`, `outreach_broadcast_recipients` | bảng: orders, products, logistics, cs, ads · import: orders, reports, purchasing, ads (1 mỗi loại) | Một phần — gửi qua Pancake Pages | Không (một tenant) | CONFIGURE |
| **cs** (CSKH, tin nhắn, bot chat) | `/cs`, `/chatbot` | `/api/chatbot/[...path]` (proxy tới dịch vụ `chatbot/`) | `cs_cases`, `cs_case_events`, `conversation_funnel`, `cs_semantic_verdicts` | bảng: orders, logistics, returns, customers, ai · import: ai(5), alerts(2) | Một phần — case CSKH chung; nguồn hội thoại là Pancake Pages, bot là dịch vụ riêng (`chatbot/README.md`: Pancake + Gemini) | Không (một tenant) | EXTEND |
| **alerts** (Cần xử lý) | `/alerts` | `/api/notifications` | `notifications`, `action_evidence` | bảng: logistics, orders, customers, returns, finance, cod · import: ads(7), cs(4), management(3), orders(3) | Một phần — hạ tầng hàng đợi chung, nhưng `lib/alerts/rules.ts` là MỘT tệp chạm 14 bảng của 6 module khác | Không (một tenant) | REFACTOR — luật cảnh báo đăng ký theo module |
| **work** (Công việc, OKR/BSC, hiệu suất, phòng ban) | `/work` (+`/today`, `/department`, `/all`, `/okr`, `/performance`, `/review`, `/settings`), `/departments` | — | `work_items`, `work_item_events`, `work_recurrences`, `metric_targets`, `okr_objectives`, `okr_key_results`, `okr_checkins`, `bsc_scorecards`, `bsc_metrics`, `review_cycles`, `performance_snapshots` | bảng: products, cs, orders, logistics, returns, finance, ads, tech, production · import: ads(7), logistics(5), returns(4), orders(4), alerts(4) | Có về động cơ (`lib/work/*` thuần); các NGUỒN việc là phép chiếu lên module khác (`lib/queries/work-adapters.ts` đọc cs_cases, tech_tasks, production_topics…) | Không (một tenant) | EXTEND — nguồn việc phải bật/tắt theo module |
| **management** (Cần anh quyết, chất lượng dữ liệu) | `/cockpit`, `/data-quality` | — | `recommendation_decisions` | bảng: alerts, orders, logistics, products, inventory, finance, cs, work, returns, production, purchasing · import: orders(3), returns(3), inventory(3) | Không — tổng hợp chéo 11 module theo câu hỏi của chủ shop VNX | Không (một tenant) | DEFER |
| **tech** (Phòng Tech AI: việc, agent, deploy, sự cố) | `/tech` (+`/agents`, `/cto`, `/deployments`, `/incidents`, `/incidents/[id]`, `/tasks`, `/tasks/[id]`) | `/api/tech/agent-run`, `/api/tech/agent-task` (công khai trong `middleware.ts`, xác thực bằng secret riêng) | `tech_agents`, `tech_tasks`, `tech_task_events`, `tech_agent_runs`, `tech_deployments`, `tech_proposals`, `tech_proposal_tasks`, `tech_incidents` | bảng: ai · import: ai(6) | Không — quản trị KHO MÃ ERP (GitHub PR, workflow deploy); là việc của nhà cung cấp nền tảng, không phải của khách | Không (một tenant) | EXTRACT — về control plane / chỉ tổ chức nhà |
| **ai** (Trợ lý AI dùng chung) | không có trang riêng (UI trong `components/`) | — (server action `lib/actions/ai.ts`) | `ai_interactions` | import: logistics(6), orders(3), dashboard(2), finance(2), products(2) — `lib/ai/tools/erp.ts` gọi 14 tệp `lib/queries/*` | Có về hạ tầng (`lib/ai/provider.ts`, `router.ts`, `budget.ts`); công cụ thì trỏ thẳng module | Không (một tenant) | REFACTOR — công cụ AI phải lọc theo module bật |
| **core** (người dùng, quyền, phòng ban, nhật ký, kết nối dữ liệu, đồng bộ, phê duyệt) | `/settings/users`, `/settings/profile`, `/audit`, `/integrations`, `app/login` | `/api/health`, `/api/perf`, `/api/sync/[job]`, `/api/integrations/test`, `/api/webhooks/pancake/[secret]/[[...event]]` | `access_roles`, `positions`, `users`, `departments`, `department_members`, `audit_logs`, `approval_requests`, `settings`, `integration_tokens`, `sync_runs`, `sync_state`, `webhook_events`, `domain_events`, `user_messages` | bảng (qua connector Pancake + tìm kiếm): customers, products, orders, logistics, returns, ads, cod, finance, work · import: logistics(15), ads(9), tech(9), work(8) | Có | Không (một tenant) | KEEP (lõi) + EXTRACT connector Pancake |

Ghi chú về gán tệp (để người sau lặp lại được phép đo):

- `lib/queries/return-rate.ts` (định nghĩa `ORDER_OUTCOME`) được xếp vào **orders**: nó là kết quả ĐƠN,
  và 21 tệp của reports import nó. Đây là "nhân dùng chung" quan trọng nhất của hệ thống.
- `lib/queries/cogs.ts`, `cogs-quality.ts`, `cost-basis.ts` (giá vốn theo phiếu kho) → **inventory**.
- `lib/actions/org.ts` và `lib/org/*` (tư cách thành viên phòng ban, AGENTS 32) → **core**; phòng ban
  là khái niệm tổ chức, dù trang `/departments` nằm cạnh `/work`.
- `lib/integrations/pancake/*` → connector nguồn đơn (xếp trong **core** ở cột Dependencies vì nó là
  đường ghi duy nhất vào `orders`, `customers`, `products`… — `lib/integrations/pancake/sync.ts` ghi 12
  bảng của 5 module: customers, products, orders, logistics, returns).

### 1.1 Tệp `lib/queries` và `lib/actions` theo module

| Module | `lib/queries/*` | `lib/actions/*` | Thư mục `lib/*` |
| --- | --- | --- | --- |
| dashboard | action-queue, business-brief, dashboard, dashboard-queue, manager-day | — | — |
| orders | cancel-analysis, canonical-outcome, entity-timeline, fulfillment-bottleneck, fulfillment-buckets, order-duplicate, order-hints, order-intake, order-marketer, order-source, orders, packing-waves, preship-risk, preship-risk-backtest, preship-validation, promised-delivery, return-rate, sales-leakage, stage-health | promised-delivery | — |
| customers | crm, customers | — | — |
| products | product-code, product-intelligence, product-notes, products, slow-moving, marketer-price | product-notes, slow-moving, marketer-price | — |
| inventory | cogs, cogs-quality, cost-basis, inventory, inventory-decision, stock, stock-feedback, stock-shortage, stock-wait-report | stock, stock-shortage | `lib/inventory/` (receipt-create/delete/pricing, production-link, size-matrix) |
| purchasing | planning, production, production-variance, purchasing, suppliers, workshop-ledger | estimated-cost, planning, production, suppliers, workshop-ledger | `lib/workshop/` |
| production | early-topic, model-360, model-ads, model-economics, model-production, model-returns, model-signal, model-stock, models, production-files, production-os | models, production-costing, production-samples, production-topic-files, production-topics | `lib/production/`, `lib/models/` |
| logistics | care-case-audit, care-effectiveness, care-performance, care-report, care-workbench, carrier-substate-sql, delivery-rate, delivery-tower, logistics, logistics-config, logistics-freshness, projected-delivery, shipment-quickview, shipment-status-age, shipment-timeline, shipments, vtp-import-batches, vtp-reconcile-queue, vtp-webhook-health | care, care-workbench, delivery-rate-override, logistics-config, shipments-vtp, vtp-capability, vtp-reconcile | `lib/care/`, `lib/integrations/viettelpost/` |
| returns | inspection-truth, return-dispositions, return-exceptions, return-intelligence, return-pipeline, return-reason, return-reason-config, return-reason-report, return-warehouse-kpi, returns | hmt-returns, return-dispositions, return-exceptions, return-reason, return-reason-groups, returns-unidentified, returns-warehouse | `lib/returns/` |
| cod | cod, cod-settlement | cod-statements | (bảng kê ở `lib/integrations/viettelpost/statement*.ts`) |
| finance | bank, bank-link-detail, bank-match, bank-sync, cash-position, cashflow, cashflow-statement, cost-allocation, cost-engine, cost-quality, expense-payment, expense-report, expenses, finance-ledger, finance-linkage, finance-ops, finance-overview, financial-truth | bank, expenses, finance-ops | `lib/finance/`, `lib/integrations/bank/` |
| reports | conversion-funnel, metrics, profit-cash, profit-cash-bridge, profit-coverage, profit-nominal, profit-target, reports, sales-funnel, scenario, staff-performance | report-settings | — |
| payroll | compensation-basis, payroll, payroll-autopilot, payroll-carryover, payroll-cost, payroll-engine, payroll-migration, payroll-period, payroll-policies, payroll-reconcile-source | payroll, payroll-autopilot, payroll-period, payroll-policy, payroll-preview, payroll-run | `lib/payroll/` |
| ads | ads-anomaly, ads-attribution, ads-attribution-coverage, ads-attribution-link, ads-decision, ads-identity-sql, ads-intraday, ads-mapping, ads-performance, ads-roas, attribution-coverage, fanpage-attribution, fb-token-scopes, marketer-daily-nominal, marketing-daily, marketing-ledger, marketing-targets | ads-budget, ads-kill-switch, ads-mapping, fanpage-attribution, marketing-alerts | `lib/marketing/`, `lib/attribution/`, `lib/integrations/facebook/` |
| creative | creative-design, creative-loop, creative-manual-gen, creative-moq, creative-own-ads, creative-plan, creative-scale, creative-sources | creative, creative-config, creative-copy, creative-design, creative-extend, creative-import, creative-manual, creative-manual-gen, creative-names, creative-scale, creative-sources | `lib/creative/` (27 tệp) |
| ideas | ideas | ideas, model-ideas | `lib/ideas/` |
| landing | landing | landing | `lib/landing/` |
| outreach | outreach, outreach-broadcast | outreach, outreach-broadcast | `lib/outreach/` |
| cs | conversation-funnel, cs | cs | `lib/cs/`, `lib/integrations/chatbot/`, dịch vụ `chatbot/` |
| alerts | notifications, action-evidence | alerts | `lib/alerts/`, `lib/evidence/` |
| work | bsc, dept-performance, metric-resolver, metric-targets, okr, performance-history, reviews, work, work-adapters, work-config, work-performance, work-readiness, workforce | metric-targets, okr, work, work-quick, workforce | `lib/work/`, `lib/metrics/` |
| management | control-tower, data-quality, data-quality-issues, evidence-gaps, impact, owner-decisions | owner-decisions | `lib/owner-decisions/` |
| tech | tech, tech-agents, tech-health, tech-ops, tech-proposal | tech | `lib/tech/`, `lib/agents/`, `lib/integrations/github/` |
| ai | — | ai | `lib/ai/`, `lib/integrations/openai/` |
| core | access, approvals, audit, backup-status, integration-health, integrations, search, search-terms, user-messages, users, warm, webhook-health | access, approvals, auth, inbox, org, refresh, search, session-revoke, users | `lib/auth/`, `lib/org/`, `lib/approvals/`, `lib/events/`, `lib/sync/`, `lib/inbox/`, `lib/integrations/pancake/`, `lib/integrations/http.ts` |

## 2. Phân loại năng lực (capability)

### 2.1 Module nghiệp vụ

| Module | Capability | Căn cứ trong mã |
| --- | --- | --- |
| core | CORE | Mọi trang qua `requireUser`/`can` (`lib/auth/*`); `users`, `departments` là cha của 81 bảng có FK tới `users` |
| work | GENERIC_MODULE | `lib/work/distribution.ts`, `escalation.ts` là hàm thuần; nguồn việc khai ở `lib/constants/work-sources.ts` |
| customers | GENERIC_MODULE | |
| products | GENERIC_MODULE (+ `marketer_prices` là TENANT_SPECIFIC) | |
| orders | GENERIC_MODULE — nhưng khoá chính phụ thuộc CONNECTOR Pancake | `orders.id` = id Pancake (`db/schema.ts:1214`) |
| inventory | GENERIC_MODULE | Luật sổ kho AGENTS 10; `lib/queries/stock.ts` |
| finance | GENERIC_MODULE | `lib/constants/cost-authority.ts`, `bank.ts`, `lib/queries/cost-engine.ts` |
| cod | GENERIC_MODULE (lõi `payment_*`) + CONNECTOR (bảng kê VTP) | |
| reports | GENERIC_MODULE — luật là TENANT_SPECIFIC cần cấu hình | `RETURN_RULE` (`lib/constants/returns.ts`), `profit.assumptions` |
| payroll | GENERIC_MODULE (động cơ chính sách) + TENANT_SPECIFIC (hoa hồng MKT) | `lib/payroll/engine.ts`, `policy-graph.ts` |
| logistics | GENERIC_MODULE (care) + CONNECTOR (Viettel Post) | `lib/care/*` vs `lib/integrations/viettelpost/*` |
| returns | GENERIC_MODULE + TENANT_SPECIFIC (`hmt_*`) | |
| ideas | GENERIC_MODULE | |
| alerts | SHARED_INFRA (hàng đợi) + TENANT_SPECIFIC (bộ luật) | `lib/alerts/rules.ts` |
| cs | GENERIC_MODULE + CONNECTOR (Pancake Pages, bot Gemini) | |
| outreach | GENERIC_MODULE + CONNECTOR (Pancake Pages) | `lib/outreach/send.ts` |
| ads | CONNECTOR (Meta) + GENERIC_MODULE (quy kết fanpage) | `lib/integrations/facebook/*`, `lib/attribution/*` |
| landing | TENANT_SPECIFIC | `lib/landing/sheet.ts` (CSV Google Sheet theo cột khai tay) |
| purchasing | INDUSTRY_PACK (may mặc) | `fabric_orders`, `lib/inventory/size-matrix.ts` |
| production | INDUSTRY_PACK | vòng đời mẫu thời trang, `product_models` |
| creative | INDUSTRY_PACK / TENANT_SPECIFIC | vòng đăng camp FB tự động |
| dashboard | TENANT_SPECIFIC (khối) trên khung GENERIC | |
| management | TENANT_SPECIFIC | "Cần anh quyết" = câu hỏi của chủ shop |
| tech | LEGACY đối với sản phẩm khách hàng — thực chất là công cụ vận hành NỀN TẢNG | quản trị kho mã `lib/integrations/github/*` |
| ai | SHARED_INFRA | `lib/ai/provider.ts`, `budget.ts` |

### 2.2 Khối hạ tầng

| Khối | Tệp | Capability | Giả định một tenant đang có | Hệ quả với mô hình silo |
| --- | --- | --- | --- | --- |
| Kết nối CSDL | `db/index.ts` | SHARED_INFRA | Một `DATABASE_URL` (`db/index.ts:13`), một pool giữ ở `globalThis.__erpDb` (`:10-11`), `getDb()` không tham số (`:182`) | Phải chọn pool theo tổ chức của yêu cầu |
| Xác thực | `lib/auth/session.ts`, `password.ts`, `login-throttle.ts`, `middleware.ts` | CORE | JWT ký bằng MỘT `AUTH_SECRET` (`middleware.ts`), token không mang mã tổ chức | Một cookie hợp lệ ở tổ chức A cũng hợp lệ chữ ký ở tổ chức B ⇒ phải thêm claim tổ chức và kiểm |
| RBAC 3 chiều | `lib/auth/permissions.ts`, `lib/auth/access.ts` (đọc `access_roles`, `departments`, `department_members`), `scope-guard.ts`, `payroll-scope.ts` | CORE | Mẫu vai trò ghi đè ở `settings['auth.rolePermissions']` | Đúng nghĩa trong silo; cần thêm cổng "module bật" TRƯỚC quyền |
| Phê duyệt 2 bước | `lib/approvals/*` | CORE | Cờ `settings['approval.enforce']` | Giữ trong CSDL tổ chức |
| Nhật ký | `lib/audit.ts` → `audit_logs` | SHARED_INFRA | — | Nhật ký nền tảng (tạo tổ chức, bật module) phải ở control plane |
| Sự kiện miền | `lib/events/emit.ts` → `domain_events` | SHARED_INFRA | — | Theo tổ chức |
| Công việc | `lib/work/*` | GENERIC_MODULE | Nguồn việc cứng trong `lib/constants/work-sources.ts` | Nguồn của module tắt phải biến mất khỏi hàng đợi |
| Thông báo | `notifications` + `lib/alerts/notification-delivery.ts`, `lark.ts`, `telegram.ts` | SHARED_INFRA | Webhook Lark/Telegram ở `settings['alerts.config']`; tên "VNXcommerce ERP" cứng trong tin (`lib/actions/alerts.ts:126,134,357`) | Tên tổ chức phải lấy từ control plane |
| Hộp thư cá nhân | `lib/inbox/send.ts` → `user_messages` | SHARED_INFRA | — | Theo tổ chức |
| Cấu hình | `lib/settings.ts` → `settings` (PK `key`) | SHARED_INFRA | ~49 khoá hằng `*_KEY` (vd `profit.assumptions`, `payroll.config`, `work.sla`, `logistics.freshness`); tiền tố khoá ≈ module | Giữ trong CSDL tổ chức; bật/tắt module KHÔNG để ở đây |
| Bí mật tích hợp | `lib/env.ts` (biến môi trường), `integration_tokens` | SHARED_INFRA → phải thành cấu hình theo tổ chức | `PANCAKE_API_KEY/SHOP_ID`, `VIETTELPOST_*`, `FACEBOOK_ACCESS_TOKEN`, `SEPAY_*`, `OPENAI_API_KEY` là MỘT bộ mỗi tiến trình (`lib/env.ts:48-188`) | Tổ chức thứ hai không có cách khai credential riêng ⇒ connector chỉ bật được cho tổ chức nhà |
| Bộ nhớ đệm | `lib/cache.ts::memo` | SHARED_INFRA | `Map` trong `globalThis.__erpMemo` (`lib/cache.ts:69-71`), khoá không có tổ chức | Hai tổ chức cùng tiến trình sẽ ĐỌC NHẦM số của nhau ⇒ khoá phải mang mã tổ chức |
| Thời gian thực | `lib/realtime/bus.ts` → `/api/events` (SSE) | SHARED_INFRA | Một `EventEmitter` toàn tiến trình (`bus.ts:14-17`), sự kiện không mang tổ chức | Người dùng tổ chức A nhận sự kiện của B ⇒ lọc theo tổ chức |
| Đồng bộ / job | `lib/sync/runner.ts`, `jobs.ts`, `scripts/scheduler.mjs`, `/api/sync/[job]` | SHARED_INFRA + CONNECTOR | `runningJobs = new Map` khoá theo tên job (`runner.ts:32`); lịch gọi MỘT ERP (`scheduler.mjs:35`) | Khoá chạy phải là (tổ chức, job); lịch lặp theo tổ chức × module bật |
| Đo hiệu năng | `lib/perf/probe.ts`, `registry.ts`, `/api/perf` | SHARED_INFRA | Bộ đếm trong tiến trình | Chấp nhận gộp (số đo của máy, không phải của khách) |
| HTTP tích hợp | `lib/integrations/http.ts` | SHARED_INFRA | — | — |
| Thương hiệu | `app/layout.tsx:16-17`, `app/login/page.tsx:58`, `components/brand.tsx`, `lib/ai/prompt.ts:7`, `lib/agents/cto.ts:66` | TENANT_SPECIFIC | "VNXcommerce" cứng | Lấy tên/nhãn từ control plane |

## 3. Tiền tố quyền → module

Nguồn: `lib/auth/permissions.ts:9-179` (`PERMISSION_GROUPS`). Cột "Trang/route kiểm khoá này" đọc
bằng `grep` chuỗi `"x:y"` trong từng `page.tsx`/`route.ts`. Cột cuối là khoá module ở bản nháp
`shared-contracts.md` §5 mà khoá quyền nên thuộc về.

| Khoá quyền | Nhóm trong `PERMISSION_GROUPS` | Module (kiểm kê này) | Trang / route đang kiểm khoá | Module bản nháp |
| --- | --- | --- | --- | --- |
| `dashboard:view` | Vận hành | dashboard | `/`, `/cockpit`, `/departments`, `/data-quality`, `/operations`, `/operations/fulfillment`, `/api/events` | core |
| `orders:read` | Vận hành | orders | `/orders*`, `/operations/preship`, `/api/refresh`, `/api/export/orders` | orders |
| `orders:export` | Vận hành | orders | `/api/export/orders` | orders |
| `shipments:view` | Vận hành | logistics | `/shipments*`, `/operations/dwell`, `/api/shipments/[id]/push-history`, `/api/refresh` | logistics |
| `shipments:manage` | Vận hành | logistics | `/shipments*`, `/api/shipments/[id]/repush`, `/api/shipments/refresh` (gác cả kết quả care) | logistics |
| `alerts:view` | Vận hành | alerts | `/alerts`, `/api/notifications` | alerts |
| `alerts:manage` | Vận hành | alerts | `/alerts` | alerts |
| `cs:view` | Vận hành | cs | `/cs` | customer_care |
| `cs:manage` | Vận hành | cs | `/cs`, `/orders/[id]` | customer_care |
| `cs:config` | Vận hành | cs | `/chatbot`, `/api/chatbot/[...path]` | customer_care |
| `outreach:view` / `outreach:send` / `outreach:config` | Vận hành | outreach | `/outreach`, `/outreach/broadcast` | marketing |
| `landing:view` / `landing:manage` / `landing:config` | Vận hành | landing | `/landing` | sales_channels |
| `returns:view` | Vận hành | returns | `/returns` | returns |
| `customers:view` | Vận hành | customers | `/customers*` | customers |
| `products:view` | Kho & sản xuất | products + inventory | `/products*`, `/inventory`, `/inventory/packing`, `/inventory/receipts`, `/inventory/returns`, `/api/export/products` | products (nhưng cũng gác trang của inventory và returns) |
| `inventory:write` | Kho & sản xuất | inventory | `/inventory/receipts`, `/inventory/returns`, `/products/[id]` | inventory |
| `inventory:restock-unidentified` | Kho & sản xuất | returns | `lib/actions/returns-unidentified.ts`, `lib/actions/return-dispositions.ts`, `lib/returns/disposition.ts`; UI ở `/inventory/returns` | returns |
| `planning:view` | Kho & sản xuất | purchasing + production | `/inventory/planning*`, `/inventory/purchasing`, `/inventory/workshop*`, `/inventory/shortage`, `/inventory/decisions`, `/production*`, `/api/production/files/[id]`, `/api/export/planning` | production + purchasing (MỘT khoá, HAI module) |
| `planning:write` | Kho & sản xuất | purchasing | các trang `/inventory/planning*`, `/inventory/workshop*`, `/inventory/shortage`, `/inventory/purchasing` | production + purchasing |
| `models:view` / `models:write` | Kho & sản xuất | production | `/models*`, `/production/topics/new`, `/ideas/[id]`, `/products/[id]` | production |
| `production:write` / `production:approve` | Kho & sản xuất | production | `/production*`, `/models/[id]`, `/marketing/creatives` (write) | production |
| `cod:view` | Tài chính | cod | `/cod`, `/api/export/cod` | finance |
| `cod:write` | Tài chính | cod | `/import-vtp`, `/import-vtp/[batchId]` | finance (trang thuộc logistics) |
| `expenses:view` | Tài chính | finance **và** ads | `/expenses`, `/ads`, `/ads/daily` (menu "Quảng cáo" gác bằng khoá chi phí, `department-modules.ts:131`) | finance + marketing |
| `expenses:write` | Tài chính | finance **và** ads | `/expenses`, `/bank`, `/finance-ops`, `/ads`, `/inventory/workshop*`, `/marketing/creatives` | finance + marketing |
| `bank:view` / `bank:write` / `bank:accounts` | Tài chính | finance | `/finance`, `/bank`, `/finance-ops` | finance |
| `reports:delivered` / `reports:cash` / `reports:nominal` | Báo cáo lợi nhuận | reports | `/reports`, `/reports/cashflow`, `/reports/scenario`, `/reports/target`, `/marketing/fanpages` (nominal), `/api/export/report` | finance |
| `reports:returns` | Báo cáo lợi nhuận | reports | `/reports/returns`, `/reports/funnel`, `/products/performance`, `/api/export/return-rate` | returns (+ products, finance) |
| `reports:assumptions` | Báo cáo lợi nhuận | reports | `/reports`, `/production/topics/[id]`, `/production/models/[id]`, `lib/actions/report-settings.ts` | finance |
| `payroll:view-own` / `payroll:view` / `payroll:view-all` | Lương & hoa hồng | payroll | `/payroll`, `/my-payslip` (tính phạm vi ở `lib/auth/payroll-scope.ts`) | payroll |
| `payroll:manage` | Lương & hoa hồng | payroll **và** ads | `/payroll/*`, `/ads`, `/marketing/fanpages`, `/inventory/workshop` | payroll (dùng cả ở marketing, production) |
| `payroll:approve` | Lương & hoa hồng | payroll | `/payroll`, `/payroll/autopilot` | payroll |
| `ideas:view` | Ý tưởng marketing | ideas **và** creative | `/ideas*`, `/marketing/creatives`, `/api/ideas/images/[id]`, `/api/creative/images/[id]` | marketing |
| `ideas:write` / `ideas:review` | Ý tưởng marketing | ideas | `/ideas*`, `/marketing/creatives` (write) | marketing |
| `work:view` / `work:manage` / `work:assign` / `work:department` / `work:all` / `work:admin` | Công việc & mục tiêu | work | `/work*`; `work:all` cả ở `/operations`; `work:admin` cả ở `/shipments` | work |
| `okr:view` / `okr:manage` | Công việc & mục tiêu | work | `/work/okr` | work |
| `performance:view` / `review:manage` | Công việc & mục tiêu | work | `/work/performance`, `/work/review` | work |
| `tech:view` / `tech:manage` | Phòng Tech AI | tech | `/tech*` | ai (bản nháp gọi "Phòng Tech AI") |
| `integrations:view` / `integrations:manage` | Hệ thống | core | `/integrations`, `/api/integrations/test` | core |
| `sync:run` | Hệ thống | core | `/integrations`, `/api/sync/[job]` | core |
| `audit:view` | Hệ thống | core | `/audit` | core |
| `users:manage` | Hệ thống | core | `/settings/users`, `lib/actions/org.ts` | core |
| `settings:manage` | Hệ thống | core | `/api/perf`, `/api/sync/[job]`, `/marketing/creatives` | core |
| `approvals:decide` | Hệ thống | core | suy ra ở `withDerivedApprovalDecide` (`permissions.ts:382`) | core |

Ba điều làm việc gác quyền theo module khó hơn vẻ ngoài:

1. **Khoá quyền KHÔNG đi một-một với module.** Chín khoá đang gác trang của ≥ 2 module: `products:view`,
   `planning:view`, `planning:write`, `expenses:view`, `expenses:write`, `reports:returns`,
   `payroll:manage`, `ideas:view`, `dashboard:view`. Hợp đồng "một khoá thuộc tối đa một module"
   (shared-contracts §5) nghĩa là hoặc (a) cổng module dựa vào ĐƯỜNG DẪN chứ không vào khoá quyền, hoặc
   (b) phải tách khoá — mà tách khoá là đụng AGENTS 29–31 và `settings['auth.rolePermissions']` trên
   production (đã có bản ghi đè cho MANAGER, `permissions.ts:238`).
2. **`LEGACY_IMPLIES` kéo quyền chéo module** (`permissions.ts:185-200`): `orders:read` ⇒ `cs:view`,
   `outreach:view`, `landing:view`; `cs:manage` ⇒ `shipments:manage`, `landing:manage`; `settings:manage`
   ⇒ `cs:config`, `outreach:config`, `alerts:manage`, `integrations:manage`, `landing:config`;
   `expenses:write` ⇒ `reports:assumptions`; `products:view` ⇒ `planning:view`, `models:view`. Tắt một
   module phải loại khoá suy ra của nó SAU bước mở rộng này, không trước.
3. **Vùng nhạy cảm** (AGENTS 30) dựa vào phòng ban sở hữu — cũng là dữ liệu trong CSDL tổ chức, nên
   không xung đột với silo.

## 4. Mục menu → module

Nguồn: `lib/constants/department-modules.ts:61-380` (`components/app-sidebar.tsx` chỉ giữ icon và luật lọc,
`app-sidebar.tsx:66-124`; menu vẽ ở `components/app-topnav.tsx`).

| Vùng (zone) | href | Nhãn | Khoá quyền gác | Module |
| --- | --- | --- | --- | --- |
| EVERYONE | `/` | Tổng quan | `dashboard:view` | dashboard |
| EVERYONE | `/alerts` | Cần xử lý | `alerts:view` | alerts |
| EVERYONE | `/work` | Công việc & mục tiêu | `work:view` | work |
| SALES | `/cs` | CSKH & tin nhắn | `cs:view` | cs |
| SALES | `/orders` | Đơn hàng | `orders:read` | orders |
| SALES | `/landing` | Đơn landing page | `landing:view` | landing |
| SALES | `/customers` | Khách hàng | `customers:view` | customers |
| SALES | `/outreach` | Chăm sóc & bán chéo | `outreach:view` | outreach |
| SALES | `/chatbot` | Bot chat bán hàng | `cs:config` | cs |
| MARKETING | `/ads` | Quảng cáo | `expenses:view` | ads |
| MARKETING | `/ideas` | Ý tưởng marketing | `ideas:view` | ideas |
| MARKETING | `/marketing/creatives` | Thư viện Media | `ideas:view` | creative |
| MARKETING | `/marketing/fanpages` | Fanpage & quy kết MKT | `reports:nominal` | ads |
| LOGISTICS | `/shipments` | Vận đơn & care | `shipments:view` | logistics |
| LOGISTICS | `/returns` | Phiếu đổi / trả (Pancake) | `returns:view` | returns |
| LOGISTICS | `/reports/returns` | Tỷ lệ giao thành công | `reports:returns` | reports (đo GTC; bản nháp xếp returns) |
| WAREHOUSE | `/inventory/packing` | Đóng gói theo lượt | `products:view` | inventory |
| WAREHOUSE | `/products` | Sản phẩm & tồn kho | `products:view` | products |
| WAREHOUSE | `/inventory/receipts` | Nhập hàng & kiểm kê | `products:view` | inventory |
| WAREHOUSE | `/inventory/returns` | Kiểm đếm hàng hoàn · kho | `products:view` | returns |
| WAREHOUSE | `/inventory` | Nhật ký kho | `products:view` | inventory |
| PRODUCTION | `/inventory/planning` | Kế hoạch đặt hàng SX | `planning:view` | purchasing |
| PRODUCTION | `/inventory/workshop` | Đặt xưởng & thanh toán | `planning:view` | purchasing |
| PRODUCTION | `/inventory/shortage` | Thiếu hàng giao đơn | `planning:view` | purchasing |
| PRODUCTION | `/inventory/decisions` | Quyết định vốn tồn kho | `planning:view` | purchasing (đọc sổ kho) |
| PRODUCTION | `/models` | Vòng đời mẫu | `models:view` | production |
| PRODUCTION | `/production` | Topic sản xuất | `planning:view` | production |
| PRODUCTION | `/products/performance` | Hiệu quả mẫu mã | `reports:returns` | products |
| FINANCE | `/finance` | Tổng quan tài chính | `bank:view` · anyOf `bank:view`, `reports:cash`, `cod:view` | finance |
| FINANCE | `/cod` | Đối soát COD | `cod:view` | cod |
| FINANCE | `/bank` | Sổ ngân hàng | `bank:view` | finance |
| FINANCE | `/finance-ops` | Hàng đợi tác vụ tài chính | `bank:view` | finance |
| FINANCE | `/expenses` | Chi phí vận hành | `expenses:view` | finance |
| FINANCE | `/reports` | Báo cáo lợi nhuận | `reports:delivered` · anyOf delivered/cash/nominal | reports |
| FINANCE | `/reports/cashflow` | Dòng tiền | `reports:cash` | reports |
| FINANCE | `/payroll` | Lương & hoa hồng | `payroll:view-own` · anyOf `payroll:view-own`, `payroll:view` | payroll |
| MANAGEMENT | `/cockpit` | Cần anh quyết | `dashboard:view` | management |
| MANAGEMENT | `/departments` | Bản đồ phòng ban & AI | `dashboard:view` | work (org) |
| MANAGEMENT | `/data-quality` | Chất lượng dữ liệu | `dashboard:view` | management |
| SYSTEM | `/tech` | Phòng Tech AI | `tech:view` | tech |
| SYSTEM | `/integrations` | Kết nối dữ liệu | `integrations:view` | core |
| SYSTEM | `/settings/users` | Người dùng | `users:manage` | core |
| SYSTEM | `/audit` | Nhật ký hệ thống | `audit:view` | core |

Trang có tiêu đề nhưng KHÔNG có mục menu (`NAV_TITLES`, `app-sidebar.tsx:156-170`): `/settings/profile`
(core), `/customers/retention` (customers), `/inventory/purchasing` (purchasing), `/import-vtp` (logistics,
gác `cod:write`), `/operations`, `/operations/preship`, `/operations/fulfillment`, `/operations/dwell`
(orders), `/reports/funnel`, `/reports/scenario`, `/reports/target` (reports), `/shipments/stock-wait`
(logistics). Ngoài `NAV_TITLES`: `/my-payslip` (payroll, không kiểm khoá — chỉ đọc của chính mình),
`/ads/daily`, `/reports/stock-wait`, `/orders/verify`, và mọi trang chi tiết `[id]`.

## 5. Phụ thuộc chéo đáng chú ý (đọc bảng của module khác trực tiếp)

Mọi dòng dưới đây là SQL/drizzle chạm thẳng bảng của module khác, không qua hàm của module đó.

| Tệp | Module | Bảng của module khác | Ý nghĩa với việc bật/tắt module |
| --- | --- | --- | --- |
| `lib/integrations/pancake/sync.ts` | connector Pancake | ghi `customers`, `warehouses`, `products`, `product_variants`, `variant_stocks`, `orders`, `order_items`, `order_status_history`, `shipments`, `shipment_events`, `inventory_histories`, `order_returns` | Một connector nuôi 5 module; tắt Pancake = orders/products/customers không có nguồn |
| `lib/queries/return-rate.ts` (`ORDER_OUTCOME`) | orders | `shipments`, `shipment_events`, `cod_statement_lines`, `return_inspections`, `product_variants` | Kết quả đơn cần logistics + cod + returns ⇒ orders thực chất PHỤ THUỘC logistics/cod, không chỉ ngược lại |
| `lib/queries/profit-nominal.ts`, `profit-cash.ts`, `reports.ts`, `profit-coverage.ts` | reports | `orders`, `shipments`, `shipment_events`, `order_items`, `product_variants`, `ad_spends`, `order_attributions`, `stock_receipts`, `stock_receipt_items`, `cod_batches`, `fb_ads`, `bank_transactions`, `expenses` | Báo cáo lợi nhuận đọc 6 module; tắt ads thì `ad_spends` rỗng ⇒ chi phí QC = 0 thay vì CHƯA BIẾT (AGENTS 42) |
| `lib/queries/cost-engine.ts`, `cashflow.ts`, `financial-truth.ts`, `bank-match.ts` | finance | `ad_spends`, `orders`, `shipments`, `stock_receipts`, `stock_receipt_items`, `cod_batches`, `production_orders` | Thẩm quyền chi phí (AGENTS 15/18) coi `ad_spends` là nguồn duy nhất của QC |
| `lib/queries/payroll.ts`, `payroll-reconcile-source.ts` | payroll | `orders`, `order_items`, `shipments`, `order_attributions`, `ad_spends`, `stock_receipts`, `stock_receipt_items`, `expenses`, `product_variants` | Hoa hồng MKT cần ads + orders + inventory |
| `lib/queries/stock.ts`, `cogs.ts`, `inventory-decision.ts` | inventory | `orders`, `order_items`, `shipments`, `canonical_order_outcome`, `production_orders` | Sổ kho trừ "đã xuất qua ĐVVC" (AGENTS 10) ⇒ inventory cần logistics |
| `lib/alerts/rules.ts` | alerts | 14 bảng của 6 module (+ `notifications` của chính nó): `shipments`, `orders`, `customers`, `return_inspections`, `vtp_import_batches`, `bank_transactions`, `cod_batches`, `cod_statement_lines`, `vtp_statement_files`, `bank_transaction_links`, `bank_accounts`, `shipment_events`, `order_items`, `canonical_order_outcome` | Luật cảnh báo phải bỏ qua luật của module tắt |
| `lib/queries/data-quality-issues.ts`, `control-tower.ts`, `evidence-gaps.ts` | management | 11 module (shipments, orders, bank_transactions, cs_cases, shipment_care, metric_targets, hmt_return_reconciliation, stock_receipt_items, return_inspections, product_models, production_topics, cost_sheets, samples, design_versions…) | Trang tổng hợp phải lọc theo module bật |
| `lib/queries/work-adapters.ts`, `dept-performance.ts`, `metric-resolver.ts` | work | `cs_cases`, `tech_tasks`, `production_topics`, `product_models`, `samples`, `orders`, `shipments`, `return_inspections`, `bank_transactions`, `ad_spends`, `care_case_events`, `audit_logs` | Hàng đợi `/work` là PHÉP CHIẾU (AGENTS 19) — nguồn của module tắt phải biến mất |
| `lib/queries/models.ts`, `model-returns.ts` | production | `products`, `product_variants`, `orders`, `order_items`, `ad_spends`, `production_orders`, `stock_receipts`, `return_inspections`, `return_dispositions`, `design_concepts` | Vòng đời mẫu đọc ads + returns + purchasing |
| `lib/queries/creative-loop.ts`, `creative-design.ts` | creative | `ad_spends`, `orders`, `shipments`, `fanpages`, `products`, `production_orders`, `settings` | creative ⇒ ads + orders + purchasing |
| `lib/queries/attribution-coverage.ts` | ads | `shipment_care`, `care_case_events`, `cs_cases`, `return_inspections`, `work_item_events`, `notifications` | Tệp tên "ads" nhưng đo quy kết NGƯỜI trên 4 module khác |
| `lib/queries/stage-health.ts` | orders | `notifications`, `cs_cases`, `bank_transactions`, `production_orders`, `return_inspections`, `stock_receipts` | Điều hành theo khâu đọc 7 module |
| `lib/queries/integration-health.ts`, `search.ts` | core | `ad_spends`, `vtp_statement_files`, `bank_transactions`, `shipments`, `orders`, `customers`, `products`, `work_items` | Lõi đang đọc bảng module ⇒ core không "độc lập" nếu không lọc |
| `lib/ai/tools/erp.ts` | ai | import 14 tệp `lib/queries/*` (orders, cashflow, financial-truth, planning, profit-nominal, stock-shortage, customers…) | Công cụ AI phải lọc theo module bật, nếu không AI trả lời bằng dữ liệu của module đã tắt |
| `lib/sync/jobs.ts` | core | import 35 đường `@/lib/*` của mọi module (`creative/loop`, `payroll/autopilot`, `outreach/build`, `tech/*`, `marketing/*`…) | Sổ job duy nhất; cổng module phải đặt ở đây |

Chiều phụ thuộc thực tế (từ số tệp import + bảng chạm), cho sổ `dependsOn`:
`orders` ⇄ `logistics` (vòng: `ORDER_OUTCOME` đọc vận đơn, vận đơn đọc đơn), `reports` → orders, finance,
inventory, logistics, cod, ads; `inventory` → products, orders, logistics, purchasing; `payroll` → finance,
ads, orders; `creative` → ads, ai; `production` → inventory, ads, purchasing, returns; `returns` → orders,
logistics, inventory; `alerts`/`management`/`work`/`dashboard` → gần như mọi module (tầng tổng hợp).

## 6. Webhook và job — không thuộc module theo đường dẫn

| Đường vào | Tệp | Xác thực | Module / connector |
| --- | --- | --- | --- |
| `/api/webhooks/pancake/[secret]/[[...event]]` | `app/api/webhooks/pancake/...` | secret trong URL (`env.pancake.webhookSecret`) | connector Pancake → orders, products, customers |
| `/api/webhooks/viettelpost` | `app/api/webhooks/viettelpost/route.ts` | secret trong body/header/query (`:21-33`); KHÔNG đặt secret ⇒ nhận mọi gói (`:69`) | connector VTP → logistics |
| `/api/webhooks/vtp-statement` | `app/api/webhooks/vtp-statement/route.ts` | secret | connector VTP → cod |
| `/api/webhooks/sepay` | `app/api/webhooks/sepay/route.ts` | API key / HMAC | connector ngân hàng → finance |
| `/api/sync/[job]` | `app/api/sync/[job]/route.ts` | `CRON_SECRET` hoặc `sync:run`/`settings:manage` | theo từng job trong `lib/sync/jobs.ts` |
| `/api/tech/agent-run`, `/api/tech/agent-task` | `app/api/tech/*` | `AGENT_INGEST_SECRET` (`lib/env.ts:46`) | tech |

Cả bốn webhook dùng MỘT URL cho cả hệ thống và MỘT secret từ biến môi trường; không có gì trong gói
tin cho biết tổ chức nào. Mô hình silo cần một bảng định tuyến ở control plane (secret/URL theo tổ chức,
hoặc định danh bên ngoài → tổ chức: shop id Pancake, số tài khoản SePay, tài khoản VTP).

## 7. Đối chiếu với bản nháp sổ module (`shared-contracts.md` §5)

| Điểm | Bản nháp | Mã nguồn nói | Đề xuất |
| --- | --- | --- | --- |
| `/inventory/planning`, `/inventory/workshop`, `/api/export/planning` | module `production` | Dùng bảng `production_orders`, `production_batches`, `fabric_orders`, `supplier_payments` (`lib/queries/planning.ts`, `workshop-ledger.ts`); `/production` và `/models` dùng bộ bảng Company OS khác hẳn (`product_models`, `production_topics`…) | Chấp nhận được nếu `purchasing` chỉ còn "mua hàng", nhưng hai bộ bảng khác nhau — ghi rõ ranh giới |
| `/cockpit` | `finance` | Gác `dashboard:view`; `lib/queries/owner-decisions.ts` + `lib/owner-decisions/service.ts` đọc production, returns, inventory, orders | Để ở `core`/tầng tổng hợp, không phải finance |
| `/operations` | `logistics` | Gác `dashboard:view`, `work:all`, `orders:read`, `shipments:view`; `lib/queries/stage-health.ts` đọc 7 module | Tầng tổng hợp; `/operations/dwell` mới đúng là logistics |
| `/reports/returns` | `returns` | Gác `reports:returns`, đọc `ORDER_OUTCOME` — là tỷ lệ GIAO THÀNH CÔNG, không phải kiểm hàng hoàn | Hợp lý hơn ở `reports`/`finance` |
| `/departments`, `/data-quality` | `core` | `/data-quality` đọc 11 module (`data-quality-issues.ts`) | core phải lọc nội dung theo module bật |
| `ai` = "Phòng Tech AI" | `/tech`, `/api/tech` | Trợ lý AI (`lib/ai/*`, `lib/actions/ai.ts`, `ai_interactions`) là thứ KHÁC, được creative/cs/tech dùng chung | Tách "tech" (công cụ nền tảng) khỏi "ai" (trợ lý dùng chung) |
| `marketing` gộp ads + ideas + creative + outreach | một module | 4 bộ bảng, 3 bộ khoá quyền (`expenses:*`, `ideas:*`, `outreach:*`) + `reports:nominal`/`payroll:manage` | Nếu giữ một module, bật/tắt con phải là `features` |
| `finance` gồm `/cod`, `/reports` | một module | cod có bảng + connector riêng; reports không sở hữu bảng | Có thể gộp; lưu ý `cod:*` gác `/import-vtp` (trang logistics) |
| `/my-payslip` | payroll | Trang không kiểm khoá nào (chỉ đọc của chính người đăng nhập) | Cổng module phải chặn bằng đường dẫn, không bằng quyền |
