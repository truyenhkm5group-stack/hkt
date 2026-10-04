# Bản đồ miền (Domain Map) — phân loại từng thành phần

> Ảnh chụp `origin/main` **7e2edfce** (04/10/2026). Mỗi dòng là một thành phần có thật trong mã.
> Phân loại theo yêu cầu productization, đứng **cạnh** tám nhãn của `docs/platform/platform-boundary.md`
> (CORE · GENERIC_MODULE · INDUSTRY_PACK · TENANT_SPECIFIC · CONNECTOR · SHARED_INFRA · LEGACY · UNKNOWN),
> không thay chúng.

## Nhãn

| Nhãn | Nghĩa trong tài liệu này |
|---|---|
| **A** · AI Sales Core | Thứ khách hàng của sản phẩm AI Sales Agent mua: hội thoại, AI, quy trình bán, đo lường AI |
| **B** · Shared Commerce Core | Nền thương mại + nền tảng dùng chung mà A đứng lên: đơn, khách, sản phẩm, giá, tồn, tổ chức, quyền, billing |
| **C** · Vertical / Customer-specific | Luật hoặc màn hình của một ngành (thời trang COD, hải sản, spa…) hoặc của riêng tổ chức nhà VNX |
| **D** · Legacy | Còn trong mã nhưng không có đường ghi, hoặc đã bị thay |
| **E** · Duplicate | Bản thứ hai của một năng lực đã có ở chỗ khác |
| **F** · Unknown | Chưa đủ chứng cứ để xếp; ghi việc cần điều tra |

Quyết định: **KEEP** giữ nguyên · **REFACTOR** đổi bên trong, giữ hợp đồng · **EXTRACT** rút thành lớp/dịch vụ
riêng có giao diện rõ · **DEPRECATE** ngừng phát triển, có lộ trình gỡ · **REWRITE** viết mới (chỉ khi không có
gì để rút). "Ẩn" = giữ cho tổ chức nhà, không đưa vào sản phẩm AI Sales.

---

## 1. Hội thoại & AI bán hàng

| Thành phần | Tệp / đường dẫn | Nhãn | Quyết định | Ghi chú |
|---|---|---|---|---|
| Vòng hội thoại `chatTurn` | `lib/sales-chatbot/engine.ts:515-750` | A | KEEP + REFACTOR lời nhắc | Lõi agent tốt nhất trong kho. Lời nhắc mang ví dụ hải sản (TD-09) |
| Lời nhắc hệ thống | `engine.ts:114-176` | A (nhiễm C) | REFACTOR | Tách luật chung · gói ngành · cấu hình tổ chức |
| Chọn provider + tự lùi model | `engine.ts:389-411` | A | KEEP | `platform` / `anthropic-byok` / `openai-byok` / `gemini-byok` |
| 16 công cụ | `lib/sales-chatbot/tools.ts:118-241` | A | KEEP + EXTRACT phần thương mại | Luật giá/tồn/chốt nằm ở đây thay vì ở lõi đơn (TD-01, TD-02) |
| Quy trình 5 bước | `stages.ts` (`QUOTE → CONSULT → INFO → UPSELL → CONFIRM`, `DONE`, `DECLINED`) | A | KEEP | Mốc chuyển bước chưa được ghi (TD-04) |
| Trả lời mẫu | `quick-replies*.ts`, bảng `sales_chat_quick_replies(_images)` | A | KEEP | Regex kg là C; ảnh lưu `bytea` trong CSDL |
| Nhắc khách im lặng | `followup*.ts` | A | KEEP | Bản thứ ba của "bám khách" trong kho (E với `chatbot/src/salesagent.js`, `lib/outreach`) |
| Ghi đơn từ hội thoại do người chốt | `order-sync*.ts` | A | KEEP | Giá trị riêng: AI làm thư ký cho nhân viên. Tách sổ AI riêng (TD-06) |
| Tự học / sổ tay | `lessons*.ts`, `playbook*.ts` | A | KEEP | Bài học vào lời nhắc ngay; chủ shop sửa/xoá được |
| Khách cũ quay lại | `returning.ts` | A | KEEP | Phụ thuộc định danh SĐT (TD-20) |
| Báo nhân viên khi handoff | `alerts.ts:59-84` | A | KEEP | Đi qua `lib/messaging` (đúng hướng) |
| Báo cáo chi phí AI / đơn | `cost-report.ts` | A | KEEP + mở rộng | Nối kết cục giao thành công (TD-15) |
| Phí ship / miễn ship của bot | `shipping.ts` | B/C | EXTRACT | Một trong ba nguồn phí ship (TD-21) |
| Kênh fanpage qua Pancake | `fanpage.ts` (1.011 dòng), `app/api/webhooks/pancake/fanpage/[token]` | A (lối vào) + C (Pancake) | EXTRACT → `ChannelAdapter` | Một page/tổ chức (TD-11); bỏ qua ảnh/voice |
| Kênh web công khai | `public.ts`, `app/chat/page.tsx` | A | KEEP | `<slug>.<miền>/chat` |
| Cấu hình bot | `config.ts`, `settings.ts`, `settings['ai.salesChatbot*']` | A | KEEP | Trần 10 vòng / 40 tin / 60 lượt |
| Bảng hội thoại | `sales_chat_conversations`, `sales_chat_messages`, `sales_chat_inbound` | A | KEEP + thêm sổ sự kiện | `state` jsonb vừa là giỏ hàng vừa là phễu |
| UI quản trị bot | `app/(dashboard)/ai/sales-chatbot/**` | A | KEEP | Không có truy vấn trong UI |
| **Bot nhà** `chatbot/` (9.761 dòng JS) | `chatbot/src/*`, container `erp-chatbot` | C + E | **DEPRECATE** sau khi rút vision/voice/persona | Đang trả lời ~10 page của nhà — xếp cuối lộ trình (M9) |
| Lời nhắc thời trang | `chatbot/prompts/system.md` | C | Thành gói ngành `fashion` | 499K/849K, size theo kg, Rayon |
| Vision / voice / persona theo quảng cáo | `chatbot/src/vision.js`, `voice*.js`, `adpersona.js`, `adbots.js` | C (ý tưởng là A) | EXTRACT thành công cụ / năng lực kênh | Bot đa tổ chức chưa có |
| Provider AI riêng của bot nhà | `chatbot/src/ai.js`, `gemini.js`, `openai.js` | E | DEPRECATE | |
| Sổ chi phí riêng | `chatbot/src/aicost.js` | E | DEPRECATE | Trùng `platform_ai_usage` |
| Trạng thái bằng tệp | `chatbot/src/store.js`, `settings.js` | D | DEPRECATE | Không CSDL ⇒ không đo được |
| Cầu nối ERP ↔ bot nhà | `app/api/chatbot/[...path]`, `lib/integrations/chatbot/*`, `/chatbot`, `/chatbot/ad-bots` | C | DEPRECATE cùng bot nhà | |
| Gửi tin hàng loạt / nurture | `lib/outreach/*`, `/outreach`, `/outreach/broadcast` | C + E | REFACTOR vào chiến dịch của agent | Dùng token Pancake của nhà |
| CSKH từ hội thoại Pancake | `lib/cs/*`, `/cs`, `cs_cases`, `cs_semantic_verdicts`, `conversation_funnel` | C | KEEP cho nhà; EXTRACT bộ phân loại ý định sau | Mẫu tốt cho vế "người" của benchmark |
| Copilot ERP | `lib/ai/copilot.ts`, `tools/*`, `ai_interactions` | B (nội bộ) | KEEP, ẩn | Không phải agent bán hàng |
| AI Builder | `lib/ai-builder/*`, `/settings/ai-builder` | B | KEEP | Lớp provider BYOK của nó đang được bot dùng chung |
| Sổ dùng AI + hạn mức + công tắc | `lib/ai-usage/*`, `platform_ai_usage` | B | KEEP + tách feature | Sổ tiền AI duy nhất nên là đây |
| Gửi tin nhóm nội bộ | `lib/messaging/*`, `messaging_deliveries` | B | KEEP | Không phải kênh tới khách |
| Hộp thư cá nhân | `lib/inbox/send.ts`, `user_messages` | B | KEEP | |
| Realtime | `lib/realtime/bus.ts`, `/api/events` | B | KEEP | Chưa có loại sự kiện chat |

## 2. Thương mại lõi

| Thành phần | Tệp / bảng | Nhãn | Quyết định | Ghi chú |
|---|---|---|---|---|
| Lõi tạo/sửa/huỷ đơn | `lib/records/order-create.ts` (788 dòng) | B | **EXTRACT** → `OrderService` | Người và máy cùng đi qua; nhận đơn giá từ người gọi (TD-01) |
| Đơn hàng | `orders`, `order_items`, `order_status_history` (`db/schema.ts:1216,1351,1377`) | B (gắn C) | KEEP bảng; thêm cột `origin`, `sales_conversation_id` | id = id Pancake (TD-13) |
| Phiếu giao / phiếu thu đơn ERP | `order_delivery_notes`, `order_payments`, `lib/records/order-payments.ts` | B | KEEP | CHECK `LIKE 'erp-%'` |
| Bảng giá + công nợ | `price_lists`, `price_list_items`, `customer_trade_terms`; `lib/constants/price-lists.ts` (`quoteUnitPrice`, `checkCredit`, `allocatePayment`) | B | KEEP — nền của `PricingService` | Hàm thuần, đã dùng chung form + bot |
| Khách hàng | `customers`, `lib/records/customer-create.ts`, `lib/queries/customers.ts` | B | REFACTOR định danh SĐT | `phone` không UNIQUE (TD-20) |
| Sản phẩm / mẫu mã | `products`, `product_variants`, `lib/records/product-create.ts`, `lib/products/import*` | B | KEEP | |
| Danh mục cho bot | `lib/sales-chatbot/catalog.ts` (`sellableCatalog`, `searchCatalog`, `stockFor`) | B | EXTRACT → `CatalogService` | Chấm điểm từ khoá trong bộ nhớ, trần 2.000 mẫu mã |
| Sổ kho ERP | `stock_receipts(_items)`, `lib/queries/stock.ts` | B | KEEP công thức (AGENTS §3.10) | Một kho, suy ra, không giữ hàng (TD-02, TD-22) |
| Tồn của Pancake | `variant_stocks`, `inventory_histories`, `warehouses` | E/C | DEPRECATE khỏi mọi con số | |
| Liên hệ khách / mua lại | `customer_touchpoints`, `lib/records/touchpoints.ts`, `lib/reorder/*`, `/customers/reorder` | B | KEEP | Nguồn cho "AI nhắc mua lại" |
| Lịch hẹn / liệu trình | `appointments`, `customer_packages`, `lib/records/appointments.ts`, `/appointments` | C (spa) | KEEP như gói ngành | Bot có `book_appointment`, `find_booking_slots` |
| Thiếu hàng / chờ hàng / kế hoạch | `stock_wait_log`, `lib/actions/stock-shortage.ts`, `/inventory/planning*` | B/C | KEEP, ẩn với khách AI Sales | |
| Mua hàng / NCC | `/inventory/purchasing`, `suppliers` | B | KEEP | Module `purchasing` |
| Đồng bộ Pancake POS | `lib/integrations/pancake/*`, webhook `/api/webhooks/pancake/[secret]` | B-connector (chỉ nhà) | REFACTOR thành adapter theo tổ chức (sau) | Tạo cả `shipments` từ đơn (`sync.ts:341`) |
| Landing | `lib/landing/*`, `landing_orders`, `/landing` | C (VNX) | KEEP, ẩn | 499K + 25K, Google Sheet, đẩy vào POS |
| Sản xuất / xưởng / mẫu mã | `lib/production/*`, `production_*`, `fabric_orders`, `product_models`, `/production`, `/models`, `lib/workshop/*` | C (may mặc) | KEEP, ẩn | |
| Custom object / metadata / workflow | `lib/objects`, `lib/metadata`, `lib/workflow`, `lib/pages`, `lib/blueprints`, `/settings/*`, `/p/[slug]`, `/o/[object]` | B (nền tảng) | KEEP | Builder — không phải trọng tâm AI Sales nhưng là cách cấu hình gói ngành |
| Sự kiện miền | `lib/events/emit.ts`, `domain_events`, `lib/constants/domain-events.ts` | B | KEEP + thêm tên mốc bán hàng | `order.*` chỉ phát cho đơn `erp-` |

## 3. Vận chuyển, thanh toán, tài chính

| Thành phần | Tệp / bảng | Nhãn | Quyết định | Ghi chú |
|---|---|---|---|---|
| Viettel Post | `lib/integrations/viettelpost/*` (11 tệp, ~3.800 dòng), `shipments`, `shipment_events`, `vtp_*` | C-connector (chỉ nhà) | KEEP; bọc `CarrierAdapter` khi có tenant thứ hai cần | Không có tạo vận đơn, không báo phí |
| Kết cục đơn | `lib/queries/return-rate.ts` (`ORDER_OUTCOME`), `canonical_order_outcome` | B (lõi) + C (nhánh VTP/COD) | KEEP — **contract test khoá** | AI Sales analytics dùng lại, không tính lại (AGENTS §0.2) |
| Ngưỡng COD | `lib/constants/returns.ts::RETURN_RULE` | C | KEEP — chỉ sửa khi chủ shop yêu cầu | Hằng biên dịch (TD-15) |
| Chăm sóc vận đơn | `lib/care/*`, `shipment_care`, `care_*`, `/shipments` | C (VNX) | KEEP, ẩn | |
| Hàng hoàn / kiểm hoàn | `lib/returns/*`, `return_*`, `hmt_*`, `/returns`, `/inventory/returns` | C (VNX) | KEEP, ẩn | |
| COD / bảng kê | `cod_batches`, `cod_statement_lines`, `vtp_statement_files`, `/cod`, `/import-vtp` | C (VNX/VTP) | KEEP, ẩn | |
| Payment foundation P0.1 | `payment_transactions`, `payment_evidence`, `payment_reviews` | **D** | DEPRECATE hoặc REWRITE thành sổ thanh toán đơn | 0 đường ghi (TD-23) |
| Ngân hàng / SePay | `lib/integrations/bank/*`, `bank_*`, `/bank`, webhook `/api/webhooks/sepay` | B (connector chỉ nhà) | KEEP | Billing nền tảng đang đọc sổ này (TD-17) |
| Chi phí / phân bổ / thẩm quyền | `lib/queries/cost-engine.ts`, `cost-allocation.ts`, `lib/constants/cost-*.ts`, `expenses`, `/expenses`, `/finance*` | B | KEEP, ẩn với khách AI Sales | Luật 14, 15, 18 |
| Báo cáo lợi nhuận / GTC / phễu | `/reports/*`, `lib/queries/{profit,return-rate,sales-funnel,conversion-funnel,…}` | B + C | KEEP, ẩn | Ba phễu: `sales-funnel` (từ đơn), `conversation-funnel` (trước đơn, nhà), `conversion-funnel` (F — quan hệ với hai phễu kia chưa kiểm) |
| Lương / hoa hồng | `lib/payroll/*`, `payroll_*`, `salary_*`, `/payroll/*`, `/my-payslip` | C (VNX) | KEEP, ẩn | Kỳ đã chốt bất biến — vùng CAO rủi ro |

## 4. Marketing, quảng cáo, nội dung

| Thành phần | Tệp / bảng | Nhãn | Quyết định | Ghi chú |
|---|---|---|---|---|
| Chi tiêu Meta của nhà | `lib/integrations/facebook/*`, `ad_spends`, `fb_ads`, `fb_adsets`, `/ads`, `/ads/daily` | C | KEEP, ẩn | Ghi ngân sách thật (`ads_budget_changes`) |
| Chi tiêu Meta theo tổ chức | `lib/marketing/meta-ads-org.ts`, connector `meta-ads-org`, job `ads-spend-org` | B | KEEP | Nền cho "ad → hội thoại → đơn" của AI Sales |
| Quy kết fanpage → marketer | `order_attributions`, `fanpages`, `fanpage_marketer_assignments`, `lib/attribution/*` | C | KEEP, ẩn; EXTRACT quy kết theo chiến dịch sau | |
| Creative loop | `lib/creative/*` (31 tệp), 12 bảng `creative_*`, `/marketing/creatives` | C | KEEP, ẩn | Gọi OpenAI thẳng, không ghi sổ AI chung (TD-25) |
| Video Scale | `lib/video-scale/*`, 15 bảng `video_scale_*`, `/marketing/video-scale` | C + E (ống creative thứ hai) | KEEP, ẩn | Veo/Omni/TTS/nhạc |
| Ý tưởng / thiết kế / DNA | `marketing_ideas*`, `design_concepts`, `product_dna`, `/ideas` | C | KEEP, ẩn | |

## 5. Vận hành nội bộ, công việc, KPI

| Thành phần | Tệp / bảng | Nhãn | Quyết định | Ghi chú |
|---|---|---|---|---|
| Hàng đợi việc (phép chiếu) | `lib/work/*`, `lib/queries/work-adapters.ts`, `work_items*`, `/work/*` | B (cơ chế) + C (nguồn việc VNX) | KEEP | Thêm nguồn "hội thoại chờ người" cho AI Sales (luật 19: phép chiếu, không bản sao) |
| Sổ chỉ số + đích + thẻ điểm | `lib/constants/metric-catalog.ts`, `metric-bindings.ts`, `metric-registry.ts`, `lib/metrics/scorecard.ts`, `metric_targets` | B | **KEEP — nền cho Sales Analytics** | Có sẵn mức tin cậy, độ phủ, `UNAVAILABLE`, chiều càng-thấp-càng-tốt |
| OKR / BSC / kỳ review | `okr_*`, `bsc_*`, `review_cycles`, `performance_snapshots` | B | KEEP | Kỳ FINAL bất biến |
| Hiệu suất nhân viên | `lib/queries/staff-performance.ts`, `department-performance.ts` | C (quy kết theo chữ Pancake) | KEEP, ẩn | Vế "người" của benchmark ở nhà |
| Cảnh báo | `lib/alerts/*` (`rules.ts` 1.311 dòng), `notifications`, `/alerts` | B (cơ chế) + C (luật VNX) | REFACTOR luật theo module (sau) | |
| Duyệt | `lib/approvals/*`, `approval_requests`, `/approvals` | B | KEEP | Một trong năm cơ chế duyệt |
| "Cần anh quyết" / cockpit / chất lượng dữ liệu | `lib/owner-decisions`, `/cockpit`, `/data-quality`, `recommendation_decisions` | C | KEEP, ẩn | Đọc chéo 11 module |
| Nhật ký | `lib/audit.ts`, `audit_logs`, `/audit` | B | KEEP | |
| Lượt mở trang | `lib/usage/page-visits.ts`, `page_visit_daily` | B | KEEP | |
| Xuất dữ liệu tổ chức | `lib/exports/tenant-data.ts`, `/settings/data-export` | B | KEEP | Cần thêm hội thoại AI vào danh mục xuất |

## 6. Nền tảng, tổ chức, xác thực, billing

| Thành phần | Tệp / bảng | Nhãn | Quyết định | Ghi chú |
|---|---|---|---|---|
| Định tuyến CSDL | `db/index.ts` (`getDb`, `getPlatformDb`, bể `max 2`/tổ chức) | B | KEEP | Một cửa duy nhất |
| Ngữ cảnh tổ chức | `lib/platform/context.ts` | B | REFACTOR mặc định rỗng ⇒ hẹp (TD-19) | |
| Sổ tổ chức / cấp tổ chức | `lib/platform/{organizations,provision}.ts`, `scripts/platform-provision-org.ts` | B | KEEP | Đăng ký chạy `CREATE DATABASE` đồng bộ |
| Migration nhiều CSDL | `db/migrate.ts`, `scripts/verify-migrations.ts` | B | KEEP | Xoá 13 bảng `platform_*` ở CSDL tổ chức |
| Tên miền con / trang công khai | `lib/platform/{host,host-org,site-host,publish}.ts`, `deploy/Caddyfile` | B | KEEP | |
| Webhook theo tổ chức | `lib/platform/webhooks.ts` (`WEBHOOK_BINDINGS`) | B | KEEP | Chỉ `PANCAKE_FANPAGE` là URL_SECRET theo tổ chức |
| Sổ module / năng lực / cờ | `lib/constants/platform-modules.ts` (27 module), `lib/platform/capabilities.ts`, `module-config.ts`, `org-flags.ts`, `kill-switches.ts` | B | KEEP; REFACTOR `ai_sales.dependsOn` (TD-12) | |
| Sổ connector + bí mật | `lib/connectors/*`, `org_connections` | B | KEEP | 11 PER_ORG / 14 HOME_ONLY |
| Credential nhà | `lib/platform/credentials.ts` (`assertHomeCredentials`) | B | KEEP | |
| Xác thực / phiên / OAuth | `lib/auth/*`, `middleware.ts`, `/login`, `/login/chon-cua-hang` | B | KEEP | Chống dò trong bộ nhớ (TD-29) |
| RBAC 3 chiều | `lib/auth/{permissions,access,scope-guard}.ts`, `access_roles`, `positions` | B | KEEP; REFACTOR `platform:operate` (TD-18) | |
| Đăng ký tự phục vụ / mời / đặt lại mật khẩu | `lib/onboarding/*`, `lib/users/*`, `/start`, `/join`, `/reset` | B | KEEP | Thêm lối "chỉ AI Sales" |
| Thương hiệu | `lib/branding/*`, `/settings/branding` | B | KEEP | |
| Billing | `lib/billing/*`, `platform_plans`, `platform_subscriptions`, `platform_invoices`, `platform_billing_payments` | B (gắn C) | REFACTOR (TD-16, TD-17) | Đối soát đọc sổ ngân hàng của VNX |
| Hạn mức | `lib/entitlements/*` | B | REFACTOR thêm đơn vị AI Sales | |
| Pilot / sức khoẻ / hỗ trợ | `lib/platform/{pilot,support}.ts`, `/platform`, `/platform/org/[code]` | B | KEEP | |
| Mẫu ngành | `lib/blueprints/*` (9 mẫu) · `ORG_TEMPLATES` · `BUSINESS_TYPE_SPEC` | B · **D** · **E** | KEEP blueprints; DEPRECATE hai bộ còn lại (TD-26) | |
| Phòng Tech / AI CTO / agent runner | `lib/tech/*`, `lib/agents/*`, 8 bảng `tech_*`, `/tech/*`, workflow `agent-*.yml` | C (công cụ của nhà cung cấp) | KEEP, ẩn; EXTRACT ra khỏi CSDL shop (rất muộn) | `requiresHomeCredentials: true` |
| Hằng số pháp nhân | `lib/constants/company.ts` | B | KEEP | Danh tính nhà vận hành nền tảng — đúng chỗ |

## 7. Chỗ chưa rõ (F) — việc điều tra

| Câu hỏi | Vì sao quan trọng | Cách trả lời |
|---|---|---|
| HSLC đang dùng kênh nào nhiều hơn: FANPAGE hay WEB? Bao nhiêu hội thoại/ngày, bao nhiêu % HANDOFF? | Quyết định thứ tự adapter và mức đầu tư `/chat` | `db-query` không đọc được CSDL tổ chức (ghi nhớ dự án) ⇒ cần một ops tóm tắt chỉ-đọc cho `sales_chat_*` theo tổ chức |
| Model thật bot nhà đang chạy | Bot nhà mặc định `gemini-2.5-flash` trong mã, README ghi flash-lite; khoá mới 404 với 2.5 | Đọc `.env` trong volume `chatbot_data` qua ops (không in khoá) |
| Bot nhà có thật sự tự xác nhận đơn trên POS không | `orders.js:907` gửi `status:1`; có thể bị chặn bởi cài đặt trang | Đếm đơn POS nguồn bot theo trạng thái lúc tạo |
| `conversion-funnel.ts` quan hệ thế nào với hai phễu kia | Tránh phễu thứ tư cho AI Sales | Đọc mã + so định nghĩa |
| Phần nghiệp vụ trong `chatbot/admin/index.html` (42 hàm) | Mất gì khi gỡ bot nhà | Đọc trước M9 |
| `lib/outreach`, `cs-chat` còn dùng thật trên production không | Ảnh hưởng quyết định DEPRECATE | `sync_runs` + `page_visit_daily` |
