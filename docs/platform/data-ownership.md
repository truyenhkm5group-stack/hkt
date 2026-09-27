# Nền tảng ERP — Sở hữu dữ liệu (từng bảng trong `db/schema.ts`)

> Đọc từ `db/schema.ts` ở commit `41002d1e` (origin/main, 27/09/2026; `git show 41002d1e:db/schema.ts`,
> 7.664 dòng). Số dòng `Lnnn` trong bảng là dòng `export const … = pgTable(` ở commit đó — cây làm việc
> đang có sửa đổi CHƯA COMMIT thêm bảng `platform_*` sau dòng 4223 nên số dòng trên đĩa lệch. Bốn bảng
> `platform_*` của control plane KHÔNG nằm trong kiểm kê này (chúng chưa tồn tại ở origin/main).
>
> FK và khoá UNIQUE được trích bằng script (mọi `.references(() => X.col)`, `foreignKey({ foreignColumns })`,
> `.unique()`, `.primaryKey()`, `uniqueIndex(...).on(...)`); đã đối chiếu: script bắt đủ 71/71
> `uniqueIndex("…")` và 144/144 `pgTable(`. Cột "Module khác chạm" đếm tệp trong `lib/`, `app/`,
> `components/` chạm bảng qua drizzle hoặc SQL thô (không tính `scripts/`). Khoá module trùng với
> `docs/platform/module-inventory.md`.

## 1. Con số

| Hạng mục | Số | Ghi chú |
| --- | --- | --- |
| Bảng (`pgTable`) | **144** | |
| Enum Postgres (`pgEnum`) | **7** | `role` (L14), `order_stage` (L17), `shipment_stage` (L34), `cod_status` (L48), `expense_category` (L51), `approval_status` (L948), `idea_status` (L1471) |
| Ràng buộc `check(...)` | 289 | Phần lớn "enum mềm" bằng `text` + `CHECK … IN (…)`; giống hệt ở mọi tổ chức vì cùng bộ migration |
| Bảng có FK tới `users` | **81** | 121 cột FK trỏ `users.id` (`grep -o "references(() => users.id"`) |
| Tổng `.references(` | 311 | |
| Bảng mang khoá chính do ĐỐI TÁC sinh (không phải uuid ERP) | 10 | `orders`, `order_items` (`lib/integrations/pancake/mapper.ts:257`, lùi về `<orderId>-<n>`), `order_returns` (`mapper.ts:689`), `products`, `product_variants`, `warehouses`, `inventory_histories` (Pancake); `fb_ads`, `fb_adsets`, `ad_account_billing` (Facebook) |

Phân loại (tổng = 144):

| Phân loại | Số bảng | Nghĩa |
| --- | --- | --- |
| `TENANT` | 121 | Dữ liệu nghiệp vụ của tổ chức — nằm trong CSDL của tổ chức |
| `TENANT·CONFIG` | 8 | Cấu hình do tổ chức khai (`settings`, `access_roles`, `positions`, `departments`, `bank_rules`, `work_recurrences`, `metric_targets`, `salary_policies`) — vẫn là TENANT |
| `TENANT·PROCESS` | 3 | Vết tiến trình job/webhook của tổ chức (`sync_runs`, `sync_state`, `webhook_events`) |
| `TENANT·SECRET` | 1 | `integration_tokens` — chứa bí mật; không bao giờ sao lên control plane |
| `TENANT·DERIVED` | 1 | `canonical_order_outcome` — dựng lại được từ nguồn |
| `TENANT·CACHE` | 1 | `cs_semantic_verdicts` — đệm kết luận model, xoá được |
| `REFERENCE` | 1 | `vtp_status_registry` — từ vựng trạng thái của ĐVVC (xem ghi chú) |
| `PLATFORM (đặc biệt)` | 8 | `tech_*` — công cụ phát triển/vận hành CHÍNH NỀN TẢNG (kho mã, deploy, sự cố), không phải dữ liệu khách |

Hầu như KHÔNG có dữ liệu tham chiếu dạng bảng: danh mục mã trạng thái, luật, ngưỡng nằm trong mã
(`lib/constants/*.ts`, 216 tệp) hoặc trong `pgEnum`/`CHECK`. Chúng đi cùng bản build/migration nên
tự động giống nhau ở mọi tổ chức — đổi chúng cho MỘT tổ chức là việc của cấu hình (`settings`), không
phải của bảng tham chiếu.

Số bảng theo module chủ: core 14 · creative 12 · logistics 11 · production 11 · payroll 11 · work 11 ·
ads 9 · returns 9 · tech 8 · products 7 · purchasing 6 · cod 6 · orders 5 · finance 5 · cs 4 ·
outreach 3 · ideas 3 · inventory 2 · landing 2 · alerts 2 · customers 1 · ai 1 · management 1.

## 2. Bảng theo module

Cột "Bảng cha": các bảng được FK trỏ tới (trừ `users`, ghi riêng là `(+users)`). Cột UNIQUE bỏ qua PK
`id` uuid do ERP sinh. **Trong mô hình silo, mọi ràng buộc UNIQUE dưới đây tự động là "duy nhất trong
MỘT tổ chức"** — vì mỗi tổ chức một CSDL — nên không cần thêm cột tổ chức vào khoá nào. Ghi chú chỉ nêu
riêng những khoá mà tính duy nhất TOÀN CẦU có ý nghĩa (mã của đối tác bên ngoài), vì đó là chỗ control
plane phải định tuyến hoặc chặn hai tổ chức nhận cùng một định danh.

### core (14)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `access_roles` (L68) | TENANT·CONFIG | — | `code` | Vai trò tuỳ chỉnh của tổ chức. `code` duy nhất trong tổ chức. |
| `positions` (L95) | TENANT·CONFIG | `departments` | `code` | Chức danh; không sinh quyền (AGENTS 29). Module khác chạm: payroll,work. |
| `users` (L113) | TENANT | `access_roles`, `positions` | `email` | Danh tính đăng nhập nằm TRONG CSDL tổ chức: `email` UNIQUE chỉ trong một tổ chức. Một người ở hai tổ chức = hai dòng, hai mật khẩu — control plane phải quyết định có danh tính toàn cục hay không. JWT hiện không mang mã tổ chức (xem ghi chú phiên). Module khác chạm: ads,alerts,creative,cs,dashboard,logistics,orders,outreach,payroll,production,returns,work. |
| `audit_logs` (L910) | TENANT | — (+`users`) | — | Nhật ký nghiệp vụ của tổ chức. Nhật ký của control plane (tạo/tắt tổ chức, bật module) phải là bảng RIÊNG ở control plane. Module khác chạm: cs,hạ tầng,logistics,orders,tech,work. |
| `approval_requests` (L962) | TENANT | — (+`users`) | `approval_pending_fingerprint_uq(requestedBy,group,payloadFingerprint)` | Sổ phê duyệt hai bước. |
| `sync_runs` (L4150) | TENANT·PROCESS | — | — | Vết chạy job của tổ chức. Bộ lập lịch (`scripts/scheduler.mjs`) hiện gọi MỘT ERP ⇒ phải lặp theo tổ chức. Module khác chạm: ads,dashboard,finance,logistics,management,production,tech. |
| `sync_state` (L4171) | TENANT·PROCESS | — | `PK key` | Con trỏ đồng bộ (PK `key`, ví dụ `pancake.orders.updated_at.cursor`) — khoá toàn cục trong CSDL; đúng nghĩa trong silo. Module khác chạm: logistics,tech. |
| `webhook_events` (L4177) | TENANT·PROCESS | — | `webhook_events_dedupe_uq(dedupeKey)` | Gói webhook đã nhận; `dedupe_key` duy nhất. Module khác chạm: finance,logistics,management. |
| `integration_tokens` (L4212) | TENANT·SECRET | — | `PK provider` | PK = `provider` ⇒ MỘT token mỗi nhà cung cấp mỗi CSDL (hiện chỉ VTP ghi, `lib/integrations/viettelpost/client.ts:160`). Chứa bí mật — không được sao lên control plane. Module khác chạm: logistics. |
| `settings` (L4220) | TENANT·CONFIG | — | `PK key` | PK = `key` — MỘT giá trị toàn cục cho cả công ty (ví dụ `auth.rolePermissions`, `alerts.config` chứa webhook Lark/Telegram, `landing.config`). Trong silo giữ nguyên; cấu hình module bật/tắt phải nằm ở control plane, không ở đây. Module khác chạm: ads,alerts,creative,finance,hạ tầng,products. |
| `departments` (L4976) | TENANT·CONFIG | — (+`users`) | `code` | `code` duy nhất trong tổ chức. Module khác chạm: payroll,work. |
| `department_members` (L4993) | TENANT | `departments` (+`users`) | `department_members_uq(departmentId,userId)` | Module khác chạm: work. |
| `user_messages` (L6041) | TENANT | — (+`users`) | `user_messages_dedupe_uq(dedupeKey)` | Hộp thư cá nhân (phiếu lương); `dedupe_key` duy nhất. Module khác chạm: payroll. |
| `domain_events` (L7158) | TENANT | `product_models` (+`users`) | `dedupe_key` | Sổ sự kiện append-only của miền mới; `dedupe_key` duy nhất. Module khác chạm: production. |

### orders (5)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `canonical_order_outcome` (L837) | TENANT·DERIVED | `orders`, `shipments` | — | Lớp tăng tốc vật chất hoá `ORDER_OUTCOME`; dựng lại được từ orders+shipments (job `outcome-materialize`). Module khác chạm: alerts,inventory,management,outreach,reports,returns,work. |
| `orders` (L1211) | TENANT | `customers`, `warehouses` (+`users`) | PK `id` (id đơn Pancake) | PK = id đơn Pancake (text, có thể > 2^53) — ERP không tự sinh id đơn. Tổ chức không dùng Pancake cần nguồn id khác (REFACTOR). Module khác chạm: ads,alerts,cod,core,creative,cs,customers,dashboard,finance,inventory,landing,logistics,management,outreach,payroll,production,products,purchasing,reports,returns,work. |
| `order_items` (L1346) | TENANT | `orders`, `product_variants` | PK `id` (id dòng Pancake) | PK text từ Pancake. Module khác chạm: ads,alerts,core,creative,cs,customers,finance,inventory,landing,logistics,management,outreach,payroll,production,products,purchasing,reports,returns,work. |
| `order_status_history` (L1372) | TENANT | `orders` | `order_status_history_uq(orderId,status,updatedAt)` | Unique (order_id, status, updated_at). Module khác chạm: core,inventory,reports. |
| `stock_wait_log` (L1398) | TENANT | `orders` | — | Sổ chờ hàng theo ngày (ghi bởi job alerts). Module khác chạm: alerts,inventory. |

### customers (1)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `customers` (L1032) | TENANT | — | `pancake_id` | `pancake_id` UNIQUE — mã phía Pancake. Module khác chạm: alerts,core,cs,landing,orders,reports. |

### products (7)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `marketer_prices` (L626) | TENANT | `products` (+`users`) | `marketer_prices_product_from_uq(productId,effectiveFrom)` | Giá báo MKT theo mã, có ngày hiệu lực (luật riêng VNX, chốt 25/09/2026). Module khác chạm: inventory,purchasing. |
| `warehouses` (L1016) | TENANT | — | PK `id` (uuid Pancake) | Bản sao kho Pancake; PK = uuid Pancake. Sổ kho ERP (`stock_receipts`) KHÔNG có cột kho ⇒ giả định một kho. Module khác chạm: core,inventory. |
| `products` (L1067) | TENANT | — | PK `id` (uuid Pancake) | PK = uuid sản phẩm Pancake (mã phía đối tác, không do ERP sinh). Module khác chạm: ads,core,creative,inventory,landing,logistics,orders,outreach,payroll,production,purchasing,reports,returns,work. |
| `product_notes` (L1106) | TENANT | `products`, `product_variants` (+`users`) | — | Ghi chú tự do; không vào phép tính (AGENTS 46). |
| `product_variants` (L1132) | TENANT | `products` | PK `id` (uuid Pancake) | PK = uuid biến thể Pancake. Module khác chạm: ads,core,creative,finance,inventory,landing,logistics,management,orders,payroll,production,purchasing,reports,returns. |
| `variant_stocks` (L1167) | TENANT | `product_variants`, `warehouses` | `variant_stocks_variant_warehouse_uq(variantId,warehouseId)` | Tồn theo kho do Pancake báo (không phải sổ kho ERP). Module khác chạm: core. |
| `inventory_histories` (L1189) | TENANT | `product_variants`, `warehouses` | PK `id` (id Pancake) | PK = id Pancake (int64 → text). Module khác chạm: core,inventory. |

### inventory (2)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `stock_receipts` (L2118) | TENANT | `suppliers`, `production_orders`, `production_batches` | — | Phiếu kho — sổ tồn ERP. KHÔNG có `warehouse_id` ⇒ một kho duy nhất. Module khác chạm: finance,management,orders,payroll,production,products,purchasing,reports,returns. |
| `stock_receipt_items` (L2147) | TENANT | `stock_receipts`, `product_variants`, `shipments` | — | Module khác chạm: finance,management,orders,payroll,production,products,purchasing,reports,returns. |

### purchasing (6)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `suppliers` (L443) | TENANT | — (+`users`) | `suppliers_name_uq(…biểu thức)` | Xưởng/NCC; unique `lower(name)`. Module khác chạm: management,production. |
| `production_orders` (L460) | TENANT | `products`, `suppliers`, `design_versions` (+`users`) | `code` | `code` duy nhất theo tổ chức. Module khác chạm: creative,finance,inventory,management,orders,production. |
| `production_batches` (L546) | TENANT | `products`, `suppliers`, `production_orders` (+`users`) | `production_batches_code_no_uq(productCode,batchNo)` | Unique (product_code, batch_no). |
| `production_deliveries` (L646) | TENANT | `production_batches` (+`users`) | — |  |
| `fabric_orders` (L666) | TENANT | `products`, `production_batches`, `suppliers` (+`users`) | — | Đặt vải — đặc thù may mặc. |
| `supplier_payments` (L704) | TENANT | `production_batches`, `fabric_orders` (+`users`) | — |  |

### production (11)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `product_models` (L7116) | TENANT | `products`, `design_concepts` (+`users`) | `code` | Sổ mẫu (Company OS); `code` duy nhất. Module khác chạm: ideas,inventory,management,returns,work. |
| `product_model_state_history` (L7192) | TENANT | `product_models`, `domain_events` (+`users`) | — | Append-only. |
| `production_topics` (L7248) | TENANT | `product_models`, `suppliers` (+`users`) | — | Module khác chạm: management,work. |
| `production_topic_messages` (L7281) | TENANT | `production_topics` (+`users`) | — |  |
| `production_topic_files` (L7324) | TENANT | `production_topics` (+`users`) | — | Metadata tệp; nội dung ở `production_topic_file_chunks`. |
| `production_topic_file_chunks` (L7353) | TENANT | `production_topic_files` | `production_topic_file_chunks_seq_uq(fileId,seq)` | Tệp (tới 50 MB) lưu trong CSDL theo khúc ⇒ ảnh hưởng dung lượng mỗi CSDL tổ chức. |
| `cost_sheets` (L7367) | TENANT | `product_models`, `production_topics` (+`users`) | `cost_sheets_model_version_uq(modelId,version)` | Module khác chạm: management. |
| `cost_sheet_lines` (L7402) | TENANT | `cost_sheets` | — |  |
| `samples` (L7426) | TENANT | `product_models`, `production_topics`, `suppliers` (+`users`) | `samples_model_version_uq(modelId,version)` | Module khác chạm: management,work. |
| `sample_reviews` (L7464) | TENANT | `samples` (+`users`) | — |  |
| `design_versions` (L7488) | TENANT | `product_models`, `samples`, `sample_reviews`, `cost_sheets` (+`users`) | `design_versions_model_version_uq(modelId,version)` | Bản thiết kế bất biến. Module khác chạm: management. |

### logistics (11)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `shipments` (L1644) | TENANT | `orders`, `cod_batches` | `vtp_order_number` | `vtp_order_number` UNIQUE — mã vận đơn Viettel Post là mã TOÀN CẦU phía VTP. Webhook VTP tới một URL chung ⇒ control plane cần bảng định tuyến (tài khoản/secret VTP → tổ chức). Module khác chạm: ads,alerts,cod,lib/constants (mảnh SQL),core,creative,cs,customers,dashboard,finance,hạ tầng,inventory,landing,management,orders,outreach,payroll,products,purchasing,reports,returns,work. |
| `shipment_events` (L1811) | TENANT | `shipments` | `shipment_events_uq(shipmentId,source,status,occurredAt)` | Unique (shipment_id, source, status, occurred_at). Module khác chạm: alerts,lib/constants (mảnh SQL),core,cs,management,orders,reports,returns,work. |
| `vtp_status_registry` (L1873) | REFERENCE | `shipments` | `status_key` | Sổ quan sát mã/chữ trạng thái VTP. Nội dung là TỪ VỰNG của ĐVVC (giống nhau mọi tổ chức) nhưng số lần/lần đầu/lần cuối là của tổ chức ⇒ để trong CSDL tổ chức; ghi rõ là tham chiếu, không tham gia phép tính (AGENTS 47). Module khác chạm: core. |
| `vtp_webhook_gaps` (L1933) | TENANT | `shipments`, `vtp_import_batches` | `vtp_webhook_gaps_uq(shipmentId,carrierEventAt,carrierStatusText)` | Phép đo chỗ hụt webhook. |
| `vtp_import_batches` (L1986) | TENANT | — (+`users`) | — | Sổ lượt nhập tệp VTP (checksum nội dung). Module khác chạm: alerts,core. |
| `shipment_care` (L4430) | TENANT | `shipments`, `orders` (+`users`) | `shipment_care_active_uidx(shipmentId)` | Unique một đợt active mỗi vận đơn. Module khác chạm: ads,management,returns. |
| `carrier_action_requests` (L4523) | TENANT | `shipments` (+`users`) | `idempotency_key` | `idempotency_key` duy nhất. |
| `care_business_actions` (L4580) | TENANT | `shipment_care`, `shipments`, `carrier_action_requests` (+`users`) | — |  |
| `care_decisions` (L4654) | TENANT | `shipment_care`, `shipments` (+`users`) | — |  |
| `care_case_events` (L4696) | TENANT | `shipments` (+`users`) | — | Module khác chạm: ads,work. |
| `care_actions` (L4778) | TENANT | `shipments`, `orders` (+`users`) | — | Append-only. Module khác chạm: returns. |

### returns (9)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `order_returns` (L1417) | TENANT | `orders` | PK `id` (id phiếu Pancake) | Phiếu đổi/trả Pancake; PK từ Pancake. Module khác chạm: core,cs. |
| `return_inspections` (L2186) | TENANT | `shipments`, `orders`, `stock_receipts` (+`users`) | — | Module khác chạm: ads,alerts,inventory,logistics,management,orders,production,work. |
| `return_inspection_items` (L2264) | TENANT | `return_inspections`, `shipments`, `product_variants` (+`users`) | — | Module khác chạm: production. |
| `hmt_return_reconciliation` (L2329) | TENANT | `product_variants`, `shipments` (+`users`) | `idempotency_key` | Đối soát với bảng tính hàng hoàn "HMT" — nguồn riêng của VNX (`lib/constants/hmt-returns.ts`). Module khác chạm: management. |
| `return_unidentified` (L2436) | TENANT | `product_variants`, `orders`, `shipments`, `stock_receipts` (+`users`) | `code`; `return_unidentified_receipt_uk(stockReceiptId)` | `code` duy nhất; unique `stock_receipt_id`. Module khác chạm: inventory. |
| `hmt_workbooks` (L4388) | TENANT | — (+`users`) | `hmt_workbooks_sha_uq(sha256)` | Tệp bảng tính HMT tải lên; unique `sha256`. |
| `shipment_return_reasons` (L6276) | TENANT | `shipments` (+`users`) | — |  |
| `return_reason_observations` (L6358) | TENANT | `shipments`, `orders` (+`users`) | `return_reason_obs_uq(dedupeKey)` | `dedupe_key` duy nhất. |
| `return_dispositions` (L7540) | TENANT | `return_inspections`, `return_unidentified`, `return_inspection_items`, `product_variants`, `stock_receipts` (+`users`) | `request_key` | `request_key` duy nhất. Module khác chạm: inventory,production. |

### cod (6)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `cod_batches` (L1442) | TENANT | — | `cod_batches_reference_uq(reference)` | Đợt tiền COD; `reference` duy nhất theo tổ chức. Module khác chạm: alerts,finance,logistics,reports. |
| `vtp_statement_files` (L1564) | TENANT | — | `vtp_statement_files_name_uq(filename)` | Unique `filename` — tên tệp bảng kê VTP; duy nhất theo tổ chức là đủ. Module khác chạm: alerts,core,logistics. |
| `cod_statement_lines` (L1596) | TENANT | `cod_batches`, `shipments` | `cod_statement_lines_key_code_uq(statementKey,trackingCode)` | Unique (statement_key, tracking_code). Module khác chạm: alerts,finance,logistics,orders. |
| `payment_transactions` (L2037) | TENANT | `orders`, `shipments`, `(tự tham chiếu)` | `payment_transactions_idempotency_uq(idempotencyKey)`; `payment_transactions_reversal_uq(reversesTransactionId)` | Unique `idempotency_key`, `reverses_transaction_id`; tự tham chiếu. Module khác chạm: orders. |
| `payment_evidence` (L2077) | TENANT | `payment_transactions` | `payment_evidence_source_uq(source,sourceNamespace,sourceReference,sourceLineKey)`; `payment_evidence_document_uq(documentHash,sourceLineKey)` | Unique theo nguồn chứng từ và theo `document_hash`. |
| `payment_reviews` (L2097) | TENANT | `orders`, `shipments` | — |  |

### finance (5)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `expenses` (L2637) | TENANT | — | — | Module khác chạm: management,payroll,reports. |
| `bank_accounts` (L2708) | TENANT | — | `bank_accounts_natural_uq(provider,gateway,accountNumber,subAccount)` | Unique (provider, gateway, account_number, sub_account). Số tài khoản ngân hàng là định danh toàn cầu thật ⇒ webhook SePay chung URL cần định tuyến số TK → tổ chức. Module khác chạm: alerts. |
| `bank_transactions` (L2737) | TENANT | — | `bank_txn_ref_idx(bankRef)`; `bank_txn_provider_uq(provider,providerTxnId)` | `bank_ref` UNIQUE, (provider, provider_txn_id) UNIQUE — mã giao dịch SePay toàn cầu. Module khác chạm: alerts,cod,core,management,orders,payroll,purchasing,reports,work. |
| `bank_rules` (L2847) | TENANT·CONFIG | — | — | Quy tắc gán nhãn của tổ chức. |
| `bank_transaction_links` (L2901) | TENANT | `bank_transactions` | `bank_txn_links_uq(txnId,targetType,targetId)` | Đối chiếu đa hình (`target_type`/`target_id`) — không FK tới đích. Module khác chạm: alerts,purchasing. |

### payroll (11)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `payroll_periods` (L5546) | TENANT | — (+`users`) | `payroll_periods_uq(periodKey,basis)` | Unique (period_key, basis). Module khác chạm: purchasing. |
| `marketer_profit_carryover` (L5643) | TENANT | — (+`users`) | `marketer_carryover_uq(employeeId,monthKey,componentCode)` |  |
| `salary_policies` (L5744) | TENANT·CONFIG | `departments` (+`users`) | `code` | `code` duy nhất. |
| `salary_policy_versions` (L5775) | TENANT | `salary_policies` (+`users`) | `salary_policy_versions_uq(policyId,version)` |  |
| `salary_policy_components` (L5815) | TENANT | `salary_policy_versions` | `salary_policy_components_uq(versionId,code)` |  |
| `employment_assignments` (L5869) | TENANT | `departments`, `positions` (+`users`) | — |  |
| `employee_policy_assignments` (L5908) | TENANT | `salary_policies` (+`users`) | — |  |
| `payroll_inputs` (L5945) | TENANT | — (+`users`) | `payroll_inputs_uq(employeeId,periodKey,inputKey)` |  |
| `payroll_adjustments` (L6002) | TENANT | — (+`users`) | — |  |
| `payroll_confirmations` (L6067) | TENANT | — (+`users`) | `payroll_confirmations_uq(periodKey,basis,round,employeeId)` |  |
| `payroll_payout_lines` (L6106) | TENANT | `bank_transactions` (+`users`) | `payroll_payout_lines_uq(periodKey,basis,employeeId)`; `payroll_payout_lines_note_uq(transferNote)`; `payroll_payout_lines_txn_uq(bankTxnId)` | Unique `transfer_note`, `bank_txn_id`. |

### ads (9)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `ad_account_billing` (L408) | TENANT | — | `PK account_id` | PK = `account_id` tài khoản quảng cáo Facebook (mã TOÀN CẦU). Hai tổ chức không được dùng chung một tài khoản QC — cần kiểm ở control plane nếu cho phép gắn tài khoản. |
| `fb_adsets` (L3025) | TENANT | — | PK `id` (adset_id Facebook) | PK = adset_id Facebook (mã toàn cầu). |
| `fb_ads` (L3044) | TENANT | — | PK `id` (ad_id Facebook) | PK = ad_id Facebook (mã toàn cầu). Module khác chạm: orders,reports. |
| `ad_spends` (L3073) | TENANT | `products` | `ad_spends_external_key_uq(externalKey)` | `external_key` duy nhất (khoá chi tiêu từ Facebook). Module khác chạm: core,creative,dashboard,finance,orders,payroll,production,products,reports,work. |
| `ads_decision_ledger` (L3160) | TENANT | — | `ads_decision_ledger_day_uq(decisionDay,dimension,entityKey)` | Unique (decision_day, dimension, entity_key). |
| `ads_budget_changes` (L3265) | TENANT | `ads_decision_ledger` (+`users`) | — |  |
| `fanpages` (L3904) | TENANT | — | `fanpages_external_uq(externalPageId)` | `external_page_id` UNIQUE — id Page Facebook toàn cầu; cũng là khoá định tuyến tiềm năng cho webhook Pancake Pages. Module khác chạm: creative,outreach. |
| `fanpage_marketer_assignments` (L3957) | TENANT | `fanpages` (+`users`) | `fanpage_assign_open_uq(fanpageId)` | Unique một phân công đang mở mỗi fanpage. |
| `order_attributions` (L4001) | TENANT | `orders`, `fanpages`, `fanpage_marketer_assignments` | `order_attribution_order_uq(orderId)` | Unique `order_id`. Module khác chạm: orders,payroll,reports. |

### creative (12)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `creative_images` (L3334) | TENANT | — | — | Ảnh lưu trong CSDL. |
| `creative_sources` (L3356) | TENANT | `products`, `creative_images` (+`users`) | `creative_sources_fb_ad_uq(fbAdId)` | `fb_ad_id` duy nhất. |
| `creative_batches` (L3405) | TENANT | — (+`users`) | `creative_batches_day_uq(batchDay)` | Unique `batch_day` — MỘT lô mỗi ngày cho cả công ty (giả định một tổ chức; silo giữ nguyên nghĩa). Module khác chạm: production. |
| `creative_variants` (L3450) | TENANT | `creative_batches`, `products`, `creative_sources`, `creative_variants`, `creative_images`, `design_concepts` (+`users`) | `creative_variants_batch_slot_uq(batchId,slot)`; `creative_variants_batch_name_seq_uq(batchId,nameSeq)`; `creative_variants_fb_ad_uq(fbAdId)` | Unique `fb_ad_id`, (batch, slot), (batch, name_seq). Module khác chạm: inventory,production. |
| `creative_fb_actions` (L3554) | TENANT | `creative_batches`, `creative_variants` (+`users`) | — |  |
| `creative_verdicts` (L3594) | TENANT | `creative_variants` | `creative_verdicts_day_variant_uq(verdictDay,variantId)` | Module khác chạm: production. |
| `creative_learnings` (L3616) | TENANT | — | `creative_learnings_day_uq(learningDay)` | Unique `learning_day` — một bản học mỗi ngày cho cả công ty. |
| `design_concepts` (L3641) | TENANT | `creative_batches`, `creative_images`, `production_orders` (+`users`) | `design_concepts_code_uq(code)`; `design_concepts_production_order_uq(productionOrderId)` | `code` duy nhất; unique `production_order_id`. Module khác chạm: production. |
| `product_dna` (L3691) | TENANT | `products` | `product_dna_product_uq(productId)` | Unique `product_id`. |
| `creative_scale_drafts` (L3721) | TENANT | `creative_variants`, `creative_batches` (+`users`) | `creative_scale_drafts_variant_kind_uq(variantId,kind)` |  |
| `creative_manual_gens` (L3783) | TENANT | `products`, `creative_sources` (+`users`) | — |  |
| `creative_manual_gen_images` (L3822) | TENANT | `creative_manual_gens`, `creative_images`, `creative_variants` (+`users`) | `creative_manual_gen_images_gen_seq_uq(genId,seq)` |  |

### ideas (3)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `marketing_ideas` (L1473) | TENANT | `product_models` | — | Module khác chạm: production. |
| `marketing_idea_images` (L1515) | TENANT | `marketing_ideas` | — | Ảnh lưu trong CSDL. |
| `marketing_idea_comments` (L1533) | TENANT | `marketing_ideas` | — |  |

### landing (2)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `landing_orders` (L2954) | TENANT | `product_variants`, `orders` | `row_key` | `row_key` duy nhất (dòng Google Sheet). Module khác chạm: ads,orders. |
| `landing_attributions` (L4085) | TENANT | `orders`, `landing_orders` | `landing_attribution_order_uq(orderId)` | Unique `order_id`. Module khác chạm: ads,orders. |

### outreach (3)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `outreach_targets` (L275) | TENANT | `customers`, `orders` | `dedupe_key` | `dedupe_key` duy nhất theo tổ chức. |
| `outreach_broadcasts` (L337) | TENANT | — (+`users`) | — |  |
| `outreach_broadcast_recipients` (L368) | TENANT | `outreach_broadcasts` | `outreach_broadcast_recipients_uq(broadcastId,pageId,conversationId)` | Khoá gồm `page_id` + `conversation_id` của Pancake/Facebook — mã toàn cầu phía đối tác; silo tự tách. |

### cs (4)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `cs_cases` (L148) | TENANT | `orders`, `customers` (+`users`) | `dedupe_key` | `dedupe_key` duy nhất theo tổ chức. Module khác chạm: ads,logistics,management,orders,work. |
| `cs_case_events` (L248) | TENANT | `cs_cases` (+`users`) | — | Nhật ký append-only của case. |
| `conversation_funnel` (L4838) | TENANT | `orders` | `conversation_funnel_uq(pageId,conversationId)` | Unique (page_id, conversation_id) — mã phía Pancake Pages. Module khác chạm: orders,outreach. |
| `cs_semantic_verdicts` (L4948) | TENANT·CACHE | — | `PK fingerprint` | Bộ nhớ đệm kết luận model; PK = dấu vân tay đầu vào. Xoá được, dựng lại tốn tiền. |

### alerts (2)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `notifications` (L732) | TENANT | — (+`users`) | `dedupe_key` | Hàng đợi cảnh báo; `dedupe_key` duy nhất theo tổ chức. Module khác chạm: ads,dashboard,management,orders. |
| `action_evidence` (L2594) | TENANT | — (+`users`) | `action_evidence_notification_idx(notificationId)` | Bằng chứng hành động khi đóng cảnh báo; unique `notification_id`. Module khác chạm: management. |

### work (11)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `work_items` (L5037) | TENANT | `departments` (+`users`) | `work_items_source_uq(sourceType,sourceKey)` | Unique (source_type, source_key). Module khác chạm: core. |
| `work_item_events` (L5137) | TENANT | `work_items` (+`users`) | — | Module khác chạm: ads. |
| `work_recurrences` (L5174) | TENANT·CONFIG | `departments` (+`users`) | — |  |
| `metric_targets` (L5232) | TENANT·CONFIG | — (+`users`) | `metric_targets_uq(metricKey,scope,…biểu thức)` | Đích chỉ số (AGENTS 38). Module khác chạm: management. |
| `okr_objectives` (L5314) | TENANT | `departments`, `(tự tham chiếu)` (+`users`) | — | Tự tham chiếu (cha–con). |
| `okr_key_results` (L5357) | TENANT | `okr_objectives` (+`users`) | — |  |
| `okr_checkins` (L5394) | TENANT | `okr_key_results` (+`users`) | — |  |
| `bsc_scorecards` (L5422) | TENANT | `departments` (+`users`) | `bsc_scorecards_uq(scope,departmentId,period)` |  |
| `bsc_metrics` (L5443) | TENANT | `bsc_scorecards` | — |  |
| `review_cycles` (L5485) | TENANT | `departments` (+`users`) | `review_cycles_uq(kind,scope,departmentId,period)` | Kỳ đã chốt bất biến (snapshot). |
| `performance_snapshots` (L6197) | TENANT | — | `performance_snapshots_uq(period,subjectType,subjectId,metricKey)` | Ảnh chụp bất biến; unique (period, subject_type, subject_id, metric_key). |

### management (1)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `recommendation_decisions` (L7626) | TENANT | — (+`users`) | — | Append-only. |

### ai (1)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `ai_interactions` (L4740) | TENANT | — (+`users`) | — | Nhật ký gọi AI (token, chi phí). Chi phí AI cho TỪNG tổ chức phải được control plane tổng hợp (billing) mà không đọc nội dung. Module khác chạm: creative,cs,tech. |

### tech (8)

| Bảng (tên SQL, dòng) | Phân loại | Bảng cha (FK chính) | Khoá tự nhiên UNIQUE đáng chú ý | Ghi chú cô lập |
| --- | --- | --- | --- | --- |
| `tech_agents` (L6457) | PLATFORM (đặc biệt) | — | `tech_agents_key_uq(key)` | Sổ định nghĩa agent của Phòng Tech AI — mô tả kho mã ERP, không phải dữ liệu khách. Không nhân bản cho tổ chức mới; về lâu dài thuộc control plane / nhà cung cấp. |
| `tech_tasks` (L6509) | PLATFORM (đặc biệt) | `tech_agents`, `tech_tasks` (+`users`) | `tech_tasks_code_uq(code)` | Việc phát triển ERP; FK `users` của CSDL VNX. `code` duy nhất. Module khác chạm: work. |
| `tech_task_events` (L6642) | PLATFORM (đặc biệt) | `tech_tasks`, `tech_agents` (+`users`) | — |  |
| `tech_agent_runs` (L6681) | PLATFORM (đặc biệt) | `tech_agents`, `tech_tasks` (+`users`) | `tech_agent_runs_external_ref_uq(externalRef)` | `external_ref` duy nhất (lượt chạy GitHub Actions). Module khác chạm: hạ tầng. |
| `tech_deployments` (L6784) | PLATFORM (đặc biệt) | `tech_tasks`, `tech_deployments` (+`users`) | `tech_deployments_external_uq(provider,externalRunId,externalRunAttempt)` | Unique (provider, external_run_id, attempt) — lượt deploy của CẢ nền tảng, không của một tổ chức. |
| `tech_proposals` (L6882) | PLATFORM (đặc biệt) | `tech_tasks`, `tech_agents`, `tech_proposals` (+`users`) | — |  |
| `tech_proposal_tasks` (L6976) | PLATFORM (đặc biệt) | `tech_proposals`, `tech_tasks` | `tech_proposal_tasks_key_uq(proposalId,key)` |  |
| `tech_incidents` (L7019) | PLATFORM (đặc biệt) | `tech_tasks`, `tech_deployments` (+`users`) | `tech_incidents_code_uq(code)` | Sự cố hệ thống; `code` duy nhất. |

## 3. Khoá mà tính duy nhất TOÀN CẦU có ý nghĩa (định danh của đối tác)

Silo làm mọi UNIQUE thành "theo tổ chức" một cách tự nhiên. Nhưng những khoá dưới đây là mã do bên
ngoài cấp, duy nhất trên toàn thế giới — nên (a) webhook tới MỘT URL chung chỉ định tuyến được về đúng
tổ chức nếu control plane giữ bảng "định danh ngoài → tổ chức", và (b) hai tổ chức nhận cùng một định
danh (cùng Page Facebook, cùng tài khoản QC, cùng shop Pancake) là dấu hiệu cấu hình sai hoặc rò dữ liệu.

| Khoá | Bảng | Ai cấp | Vì sao control plane phải biết |
| --- | --- | --- | --- |
| `vtp_order_number` | `shipments` (L1644) | Viettel Post | Webhook `/api/webhooks/viettelpost` không mang tổ chức; định tuyến theo secret/tài khoản VTP |
| id đơn, dòng, phiếu trả, sản phẩm, biến thể, kho | `orders`, `order_items`, `order_returns`, `products`, `product_variants`, `warehouses`, `inventory_histories`; `customers.pancake_id` | Pancake POS | Webhook Pancake định tuyến bằng `[secret]` trong URL (`app/api/webhooks/pancake/[secret]/…`); shop id nằm ở `PANCAKE_SHOP_ID` (`lib/env.ts:53`) |
| `page_id` + `conversation_id` | `conversation_funnel`, `outreach_broadcast_recipients`; `fanpages.external_page_id` | Facebook / Pancake Pages | Một Page chỉ thuộc một tổ chức |
| `fb_ads.id`, `fb_adsets.id`, `ad_account_billing.account_id`, `ad_spends.external_key`, `creative_sources.fb_ad_id`, `creative_variants.fb_ad_id` | ads, creative | Meta | Một tài khoản QC chỉ thuộc một tổ chức; token hiện đọc cả Business Manager `FACEBOOK_BUSINESS_ID` (`lib/env.ts:78`, mặc định cứng `336423739082347`) |
| `bank_ref`, (`provider`, `provider_txn_id`) | `bank_transactions` (L2737) | SePay / ngân hàng | Webhook `/api/webhooks/sepay` chung URL ⇒ định tuyến theo số tài khoản (`bank_accounts` L2708) |
| (`provider`, `external_run_id`, `external_run_attempt`), `external_ref` | `tech_deployments`, `tech_agent_runs` | GitHub Actions | Lượt deploy/agent là của NỀN TẢNG, không của tổ chức ⇒ lý do xếp `tech_*` là PLATFORM |
| `users.email` | `users` (L113) | người dùng | Không phải mã đối tác, nhưng là danh tính đăng nhập: cùng email ở hai tổ chức là hai tài khoản độc lập trong silo |

Khoá "một dòng mỗi ngày cho cả công ty" — đúng nghĩa trong silo, nhưng là giả định một tổ chức nếu ai đó
định gộp CSDL: `creative_batches.batch_day` (L3405), `creative_learnings.learning_day` (L3616),
`ads_decision_ledger(decision_day, dimension, entity_key)` (L3160), `payroll_periods(period_key, basis)`
(L5546), `performance_snapshots(period, subject_type, subject_id, metric_key)` (L6197).

## 4. Bảng và cột mang giả định "chỉ có một công ty"

| # | Chỗ | Giả định | Căn cứ |
| --- | --- | --- | --- |
| 1 | `settings` (L4220), PK `key` | Mỗi khoá cấu hình một giá trị cho cả công ty; ~49 hằng `*_KEY` trong `lib/` (vd `auth.rolePermissions`, `alerts.config`, `profit.assumptions`, `payroll.config`, `work.sla`, `landing.config`, `ads.write.kill`) | `lib/settings.ts:35-48` |
| 2 | `integration_tokens` (L4212), PK `provider` | Một token cho mỗi nhà cung cấp (một tài khoản VTP) | `lib/integrations/viettelpost/client.ts:160-175` |
| 3 | `sync_state` (L4171), PK `key` | Một con trỏ đồng bộ cho mỗi nguồn (một shop Pancake): `pancake.orders.updated_at.cursor`, `pancake.customers.cursor` | `lib/sync/runner.ts:209-215` |
| 4 | `stock_receipts` / `stock_receipt_items` (L2118/L2147) | Sổ kho ERP KHÔNG có cột kho ⇒ tồn thực tế của MỘT kho; trong khi `warehouses`, `variant_stocks`, `orders.warehouse_id` (bản sao Pancake) lại nhiều kho | cột của `stock_receipts`: id, kind, received_at, reference, supplier, supplier_id, production_order_id, production_batch_id, note, total_quantity, total_cost, created_by |
| 5 | Credential tích hợp | MỘT bộ mỗi tiến trình, từ biến môi trường: `PANCAKE_API_KEY`/`PANCAKE_SHOP_ID`, `VIETTELPOST_*`, `FACEBOOK_ACCESS_TOKEN`/`FACEBOOK_BUSINESS_ID`, `SEPAY_*`, `OPENAI_API_KEY`, webhook secret | `lib/env.ts:48-188` |
| 6 | Kết nối CSDL | Một `DATABASE_URL`, một pool ở `globalThis.__erpDb` | `db/index.ts:10-13,182` (commit `41002d1e`) |
| 7 | Bộ nhớ đệm báo cáo | Khoá `memo(key)` không có tổ chức; `Map` toàn tiến trình | `lib/cache.ts:69-71,99` |
| 8 | Sự kiện thời gian thực | Một `EventEmitter` toàn tiến trình; SSE `/api/events` phát mọi sự kiện cho mọi phiên | `lib/realtime/bus.ts:14-25`, `app/api/events/route.ts:27` |
| 9 | Khoá chạy job | `runningJobs` khoá theo TÊN job | `lib/sync/runner.ts:32` |
| 10 | Bộ lập lịch | Gọi `/api/sync/<job>` của MỘT ERP | `scripts/scheduler.mjs:35-86` |
| 11 | Phiên đăng nhập | JWT ký bằng MỘT `AUTH_SECRET`, không có claim tổ chức | `middleware.ts`, `lib/auth/session.ts:60-68` |
| 12 | Enum Postgres | `role` cố định 8 vai trò (L14); `expense_category` cố định 9 nhóm gồm `ADS`, `PURCHASE` (L51); `shipment_stage` theo từ vựng VTP (L34); `order_stage` theo trạng thái Pancake (L17) — đổi cho một tổ chức = migration cho tất cả | `db/schema.ts` |
| 13 | Luật kinh doanh cứng trong mã | Ngưỡng COD 50K/100K (`lib/constants/returns.ts:14,20`); landing 499K + ship 25K (`lib/constants/landing.ts:64`); "Bot ERP" là tên máy (`lib/constants/cs.ts:69`); bảng tính "Hàng hoàn HMT" (`lib/constants/hmt-returns.ts:27`) | |
| 14 | Thương hiệu | "VNXcommerce" cứng ở `app/layout.tsx:16-17`, `app/login/page.tsx:58`, `components/brand.tsx`, lời nhắc AI `lib/ai/prompt.ts:7`, `lib/agents/cto.ts:66`, tin Lark/Telegram `lib/actions/alerts.ts:126,134,357` | |
| 15 | Tài khoản quản trị đầu tiên | `ADMIN_EMAIL` mặc định `admin@shop.local` | `lib/auth/bootstrap.ts:10` |
| 16 | Bảng `tech_*` (L6457–L7019) | Quản trị chính kho mã ERP (GitHub PR, deploy) — chỉ có nghĩa với nhà vận hành nền tảng | FK `users` của CSDL VNX |

## 5. Dữ liệu nhị phân trong CSDL (ảnh hưởng dung lượng / sao lưu MỖI CSDL tổ chức)

| Bảng | Cột | Dạng | Căn cứ |
| --- | --- | --- | --- |
| `marketing_idea_images` | `data` | base64 trong `text` | `db/schema.ts:1524-1525` |
| `vtp_statement_files` | `content` | base64 trong `text` | `db/schema.ts:1569-1570` |
| `creative_images` | `data` | `text` | `db/schema.ts:3345` |
| `hmt_workbooks` | `content` | base64 trong `text` | `db/schema.ts:4396-4397` |
| `production_topic_file_chunks` | nội dung khúc | `bytea` (customType, `db/schema.ts:7310`) — tệp tới 50 MB | `db/schema.ts:7307-7353` |

## 6. Điều chưa chắc (cần người xác nhận)

- **Pancake id có duy nhất toàn cầu hay theo shop?** `orders.id` là "Pancake order id" (L1214) — mã
  không nói rõ id là toàn hệ Pancake hay theo shop. Trong silo không gây trùng; chỉ quan trọng nếu sau
  này định tuyến webhook theo id đơn.
- **`vtp_status_registry` là REFERENCE hay TENANT?** Nội dung (mã + chữ trạng thái VTP) là từ vựng chung,
  nhưng số lần / lần đầu / lần cuối và FK `shipments` là của tổ chức. Xếp REFERENCE vì AGENTS 47 nói nó
  không tham gia phép tính nào; vẫn nằm trong CSDL tổ chức.
- **`tech_*` là PLATFORM** là nhận định kiến trúc, không phải thứ mã nguồn khai: hiện chúng có FK tới
  `users` của CSDL VNX, nên tách chúng ra control plane là một việc có FK phải cắt.
- **Chủ sở hữu vài bảng biên**: `marketer_prices` (xếp products; dùng bởi `lib/inventory/receipt-pricing.ts`,
  `lib/queries/production-variance.ts`, payroll), `stock_wait_log` (xếp orders; ghi bởi `lib/alerts/stock-wait-log.ts`),
  `action_evidence` (xếp alerts; ghi bởi `lib/evidence/record.ts` từ `lib/actions/alerts.ts`),
  `shipment_return_reasons`/`return_reason_observations` (xếp returns; khoá theo `shipments`).
- **Cột "Module khác chạm"** đếm qua regex trên mã nguồn: bắt được drizzle (`schema.x`, import có tên)
  và SQL thô sau `from/join/into/update`; SQL dựng động bằng chuỗi ghép tên bảng (nếu có) sẽ lọt.
