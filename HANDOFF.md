# HANDOFF — Shop Control ERP (bàn giao cho Codex / agent kế tiếp)

Cập nhật: 06/09/2026 · Repo: `truyenhkm5group-stack/hkt` (GitHub, **PUBLIC**) · Nhánh phát triển: `claude/fashion-erp-poscake-viettelpost-u97pgx` (đồng thời push lên `main`) · Bản chạy thật: https://erp.vnxcommerce.com (VPS, Docker, deploy bằng GitHub Actions).

Đọc kèm: `AGENTS.md` (quy ước bắt buộc), `README.md` (mô tả tính năng chi tiết), `docs/CONVENTIONS.md`, `docs/API-PANCAKE-VIETTELPOST.md`, `docs/LO-TRINH-HOAN-THIEN.md`, `docs/TRIEN-KHAI-VPS.md`, `docs/CHECKLIST-DONG-BO-REALTIME.md`.

---

## 1. Mục tiêu tổng thể

ERP nội bộ cho shop thời trang bán online (chủ yếu qua Facebook/livestream + landing page), đơn lên trên **Pancake POS**, giao bằng **Viettel Post** (COD). Mục tiêu: **số liệu ra quyết định phải đúng thực tế** — giao thành công / hoàn, doanh thu thực thu COD, lợi nhuận, dòng tiền, tồn kho, kế hoạch sản xuất, hiệu quả quảng cáo theo marketer, lương & hoa hồng — và tự động hoá vận hành (cảnh báo, CSKH, chăm sóc khách).

Người dùng cuối là chủ shop + nhân viên (kế toán, kho, CSKH, marketing). Toàn bộ giao diện, commit message, chú thích trong code viết **tiếng Việt có dấu**.

## 2. Tech stack

- Next.js 15.5 (App Router, Server Components, Server Actions) · React 19 · TypeScript strict
- Tailwind CSS v4 · shadcn/ui (Radix) · TanStack Table v8 · nuqs (URL state) · Recharts · lucide-react · sonner
- Drizzle ORM 0.45 · PostgreSQL 16 (production) / **PGlite** (nhúng, cho `npm test` và chạy thử không cần Postgres)
- xlsx (SheetJS 0.18.5) đọc file Excel Viettel Post · zod · jose (JWT phiên đăng nhập) · bcryptjs
- Node 22 (Dockerfile `node:22-alpine`) · Docker Compose (app + scheduler + db + caddy) trên VPS
- Kiểm thử: **không dùng framework** — `tests/sync-fixtures.test.ts` là một `main()` chạy bằng `tsx` với `assert`, trên PGlite (31 nhóm kiểm thử)

## 3. Kiến trúc

```
Pancake POS ──(REST API + webhook)──▶  ERP (Next.js)  ◀──(webhook + Excel/bảng kê + API đối tác)── Viettel Post
Google Sheet (landing form) ──CSV──▶       │        ◀──Marketing API── Facebook Ads
MB Bank (sao kê) ──JSON/CSV──▶             │        ──webhook──▶ Lark / Telegram (cảnh báo)
                                           ▼
                                     PostgreSQL 16
```

- **Server Component page** đọc `searchParams` → `parseListParams()` → hàm trong `lib/queries/*` → render; bảng danh sách là client wrapper `<X>Table` bọc `components/data-table/data-table.tsx`; sort/filter/pagination nằm trên URL (`sort`, `dir`, `page`, `pageSize`, `q`, `period`, các facet).
- **Server Actions** trong `lib/actions/*` ("use server"): kiểm quyền → zod → drizzle → `audit()` → `revalidatePath`.
- **Đồng bộ**: registry job `lib/sync/jobs.ts` (`JOB_DEFINITIONS`), chạy qua `POST /api/sync/<job>` (header `x-cron-secret`), lịch trong `scripts/scheduler.mjs` (container `scheduler`). Job: `pancake-orders` 3′, `vtp-tracking` 10′, `pancake-products` 30′, `pancake-returns` 30′, `pancake-customers` 60′, `pancake-inventory` 60′, `facebook-ads` 60′, `alerts` 10′, `cs-chat` 15′, `ads-billing` 30′, `landing-sheet?new=1` 1′ (nhanh) và `landing-sheet` 10′ (đầy đủ). Job khác chạy tay: `pancake-backfill`, `pancake-reconcile`, `pancake-all`, `vtp-import`, `facebook-ad-index`, `failed-delivery`, `phone-verify`, `data-check`, `outreach-build`.
- **Webhook**: `app/api/webhooks/pancake/[secret]/[[...event]]` và `app/api/webhooks/viettelpost` → ghi `webhook_events` → xử lý → `publish()` (`lib/realtime/bus.ts`) → SSE `/api/events` → `RealtimeProvider` gọi `router.refresh()`.
- **Cache**: `lib/cache.ts` (`memo`, TTL 60–120 s) cho các báo cáo nặng. Khi thay đổi logic báo cáo, dữ liệu trên web có thể trễ tới 2 phút.
- **Quyền**: `lib/auth/session.ts` (`requireUser`, `requirePermission`, `can`), ma trận trong `lib/auth/permissions.ts` (~40 quyền dạng `module:action`), 8 vai trò (`lib/constants/roles.ts`).
- **Cấu hình động** lưu trong bảng `settings` (JSON theo khoá) qua `lib/settings.ts` (`getSettingJson` / `setSettingJson`): `alerts.config`, `cs.rules`, `landing.config`, `outreach.config`, `payroll.config`, `payroll.employees`, `profit.assumptions`, `ads`. Ghi từ xa bằng ops action `set-setting`.

## 4. Cấu trúc thư mục quan trọng

```
app/(dashboard)/<module>/            page.tsx (server) · columns.tsx · <x>-table.tsx · [id]/page.tsx
  ads · alerts · audit · cod · cs · customers · expenses · integrations · inventory(/receipts, /planning, /planning/orders)
  landing · orders · outreach · payroll · products · reports(/returns) · returns · settings(/users, /profile) · shipments
app/api/                             events (SSE) · export/* (CSV) · health · notifications · refresh · sync/[job] · webhooks/*
app/login · app/print/production/[id]
components/data-table/               data-table.tsx (bảng dùng chung, gom nhóm cha–con, sort URL) · toolbar.tsx · pagination.tsx
components/                          app-sidebar.tsx (menu theo nhóm Vận hành / Kho / Tài chính / Hệ thống) · status-badge.tsx · ...
db/schema.ts                         toàn bộ schema Drizzle + relations + types
db/index.ts                          getDb() (Postgres hoặc PGlite), auto-migrate khi khởi động
drizzle/                             migration SQL 0000 → 0020 + meta/
lib/queries/                         truy vấn chỉ-server: return-rate.ts (ORDER_OUTCOME — TRÁI TIM của mọi báo cáo), profit-nominal.ts,
                                     profit-cash.ts, ads-performance.ts, dashboard.ts, payroll.ts, products.ts, stock.ts, planning.ts,
                                     shipments.ts, cod.ts, orders.ts, landing.ts, order-hints.ts, ...
lib/actions/                         server actions theo module
lib/integrations/pancake/            client.ts · sync.ts · mapper.ts · webhook.ts · pages.ts (Pages API: chat, reply_inbox)
lib/integrations/viettelpost/        client.ts (partner API) · sync.ts · statement.ts (parse Excel/CSV) · statement-db.ts (ghi DB)
lib/integrations/facebook/           client.ts · sync.ts (chi tiêu) · billing.ts (ngưỡng thanh toán) · mapping.ts · match.ts
lib/integrations/bank/               import.ts · ledger.ts (sao kê MB Bank → chi phí vận hành)
lib/alerts/                          rules.ts (quy tắc cảnh báo) · risk.ts · lark.ts · telegram.ts · config.ts
lib/cs/                              detect.ts · chat-detect.ts · failed-delivery.ts · phone-verify.ts
lib/landing/                         sheet.ts (đọc Google Sheet, ghép đơn POS) · pos.ts (tạo đơn Pancake)
lib/constants/                       returns.ts (RETURN_RULE, OrderOutcome, shipmentOutcome, RETURN_RATE_SORTABLE), viettelpost.ts,
                                     pancake.ts, landing.ts, profit.ts, planning.ts, payroll.ts, cs.ts, alerts.ts, roles.ts, ...
lib/sync/                            jobs.ts · runner.ts · consistency.ts (data-check)
scripts/                             scheduler.mjs · sync.ts · seed-*.ts · import-*.ts · set-setting.ts · vtp-*.ts (probe/debug) · install-vps.sh · bootstrap.sh
tests/sync-fixtures.test.ts          toàn bộ kiểm thử (PGlite)
.github/workflows/deploy-vps.yml     deploy (workflow_dispatch, ~7 phút, SSH → scripts/bootstrap.sh)
.github/workflows/ops-vps.yml        vận hành từ xa: status · logs · db-query (CHỈ ĐỌC) · run-job · set-setting · backup · restart · ...
docs/                                tài liệu (xem đầu file)
```

## 5. Database / schema quan trọng (`db/schema.ts`)

Bảng: `users`, `warehouses`, `customers`, `products`, `product_variants`, `variant_stocks`, `inventory_histories`, `orders`, `order_items`, `order_status_history`, `order_returns`, `shipments`, `shipment_events`, `cod_batches`, `stock_receipts`, `stock_receipt_items`, `expenses`, `ad_spends`, `fb_ads`, `ad_account_billing`, `landing_orders`, `cs_cases`, `outreach_targets`, `notifications`, `production_orders`, `audit_logs`, `sync_runs`, `sync_state`, `webhook_events`, `integration_tokens`, `settings`.

Enum: `role`, `order_stage` (NEW, WAITING, CONFIRMED, PACKING, READY_TO_SHIP, SHIPPED, DELIVERED, PAID, RETURNING, PARTIAL_RETURN, RETURNED, CANCELLED, DELETED…), `shipment_stage` (PENDING, PICKED_UP, IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERY_FAILED, DELIVERED, RETURNING, RETURNED, CANCELLED), `cod_status` (PENDING, COLLECTED, RECONCILED, PAID_TO_BANK, NOT_APPLICABLE…), `expense_category`.

Cột then chốt cho báo cáo:
- `orders`: `stage`, `cod`, `prepaid`, `transfer_money`, `cash`, `partner_fee`, `total_price_after_discount`, `inserted_at`, `page_id`, `ad_id`, `conversation_id`, `customer_id`, `bill_phone`, `ship_*`.
- `shipments`: `order_id` (NULL với vận đơn ngoài Pancake / vận đơn chiều về), `vtp_order_number` (UNIQUE — dùng để upsert), `tracking_code`, `order_reference` (mã đơn đối tác; với vận đơn chiều về = mã vận đơn gốc), `stage`, `vtp_status_name`, `vtp_status_date`, `cod_amount` (tiền thu hộ khai), `cod_collected` (**tiền THỰC THU** — từ webhook 501 / bảng kê / danh sách vận đơn), `shipping_fee`, `cod_status`, `cod_paid_to_bank_at`, `delivered_at`, `returned_at`, `is_final`, `last_vtp_sync_at`.
- Tồn kho ERP = `stock_receipt_items` (nhập/điều chỉnh) − giao thật − đang giao (xem `lib/queries/stock.ts::erpStockExpr`).

Migration gần nhất: `0014_perf_indexes`, `0015_production_orders`, `0016_notifications_occurred_at`, `0017_fb_ads`, `0018_role_leader`, `0019_landing_orders`, `0020_landing_ad_id`. **Session này KHÔNG thêm migration** (mọi thay đổi là logic truy vấn / UI). Migration tự chạy khi app khởi động (`db/index.ts`, tắt bằng `SKIP_AUTO_MIGRATE`).

## 6. Business rules quan trọng (KHÔNG được phá)

### 6.1 Kết quả đơn — `ORDER_OUTCOME` (`lib/queries/return-rate.ts`)

Là một biểu thức SQL `CASE` dùng chung cho **mọi** báo cáo (Tổng quan, Báo cáo lợi nhuận danh nghĩa + tiền thật, Quảng cáo / Marketer, Lương, Tỷ lệ giao thành công, Đối soát COD, Đơn landing page, Tồn kho, Kế hoạch đặt hàng SX, Chăm sóc & bán chéo). Yêu cầu `FROM orders o LEFT JOIN shipments s ON s.order_id = o.id`. Giá trị: `NOT_SHIPPED | IN_TRANSIT | DELIVERED | RETURNED | RETURNED_BY_RULE | CANCELLED`.

Ngưỡng (`lib/constants/returns.ts::RETURN_RULE`): `maxCodForFakeDelivery = 100_000` · `maxCodForReturn = 50_000` · `maxFeeForFakeDelivery = 10_000`.

Biểu thức phụ:
```
FEE           = coalesce(nullif(s.shipping_fee,0), o.partner_fee, 0)
COD_COLLECTED = coalesce(s.cod_collected, 0)
COD           = coalesce(nullif(s.cod_collected,0), nullif(s.cod_amount,0), o.cod, 0)   -- doanh thu COD của đơn
PREPAID       = coalesce(o.prepaid,0) + coalesce(o.transfer_money,0)
FEE_RULE        = s.stage='DELIVERED' AND PREPAID <= 100K AND (COD <= 100K OR (COD = 0 AND FEE > 0 AND FEE < 10K))
RETURN_COD_RULE = s.stage='DELIVERED' AND PREPAID < 50K AND COD < 50K
LEG_RULE        = s.vtp_order_number IS NOT NULL AND EXISTS (shipments rl: rl.id<>s.id AND rl.stage='DELIVERED' AND rl.cod_amount=0
                  AND rl.shipping_fee BETWEEN (0,10K) AND (rl.order_reference = s.vtp_order_number
                  OR rl.vtp_order_number ~ ('^'||s.vtp_order_number||'[0-9]?P[0-9]+$')))
```
Thứ tự CASE (chính xác như code hiện tại):
```
1. s.stage IN ('RETURNING','RETURNED')                                                        → RETURNED
2. COD_COLLECTED > 100K AND (s.stage='DELIVERED' OR s.cod_status IN ('COLLECTED','RECONCILED','PAID_TO_BANK')) → DELIVERED
3. RETURN_COD_RULE  (đã giao nhưng doanh thu < 50K)                                           → RETURNED
4. s.stage='DELIVERED' AND (FEE_RULE OR LEG_RULE)  (COD 50K–100K, hoặc có vận đơn chiều về)   → RETURNED_BY_RULE
5. s.stage='DELIVERED'                                                                         → DELIVERED
6. s.stage IN ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERY_FAILED') AND o.stage NOT IN ('CANCELLED','DELETED') → IN_TRANSIT
7. o.stage IN ('CANCELLED','DELETED')                                                          → CANCELLED
8. o.stage IN ('RETURNING','PARTIAL_RETURN','RETURNED')                                        → RETURNED
9. o.stage IN ('DELIVERED','PAID')                                                             → DELIVERED
10. o.stage = 'SHIPPED'                                                                        → IN_TRANSIT
11. else                                                                                       → NOT_SHIPPED
```
Ý nghĩa nghiệp vụ (do chủ shop quy định, đã thống nhất):
- **Đơn giao thành công thật = doanh thu COD thực > 100.000đ** (thu đủ tiền của khách) hoặc khách đã chuyển khoản trước > 100K. Không phụ thuộc vào việc Viettel Post có báo "giao thành công" hay không.
- **Đơn có doanh thu < 50.000đ = ĐƠN HOÀN** (khách trả hàng, shop không thu được COD). Viettel Post vẫn ghi "Giao thành công" cho chiều hoàn / giao thành công một phần, nên **tuyệt đối không được chỉ dựa vào trạng thái vận đơn** để tính đơn thành công.
- Doanh thu 50K–100K (chỉ thu phí xem hàng / thu thiếu) = không thành công (`RETURNED_BY_RULE`); `RETURNED` và `RETURNED_BY_RULE` đều là "hoàn" trong mọi tổng hợp (`RETURNED_OUTCOMES`).
- Trạng thái vận đơn Viettel Post luôn ưu tiên hơn trạng thái Pancake (Pancake do nhân viên cập nhật tay).
- Vận đơn **chiều về** (mã gốc + `[số]P[số]`, ví dụ `PKE1506697767` → `PKE15066977671P1`) được lưu thành dòng `shipments` **riêng** (`order_id NULL`, `order_reference` = mã gốc, COD 0, `cod_status = NOT_APPLICABLE`), không đè lên vận đơn gốc; `LEG_RULE` nhận ra đơn gốc là đơn hoàn. `legBaseCode()` trong `statement.ts` dùng regex **lười** `^([A-Z0-9]{8,}?)[0-9]?P[0-9]+$`.
- Tỷ lệ giao thành công = giao TC / (giao TC + không TC) trên đơn đã kết thúc; cột "dự kiến" trộn thêm đơn chờ phát lại theo xác suất học từ lịch sử (`failedToReturnRate()`).

### 6.2 Biểu thức mức VẬN ĐƠN (khi chỉ truy vấn bảng `shipments`)

`lib/queries/return-rate.ts` (SQL, cần `LEFT JOIN orders` để có `PREPAID`):
```
SHIPMENT_COD       = coalesce(nullif(s.cod_collected,0), s.cod_amount, 0)
SHIPMENT_DELIVERED = s.stage='DELIVERED' AND (SHIPMENT_COD > 100K OR PREPAID > 100K)
SHIPMENT_RETURNED  = s.stage IN ('RETURNING','RETURNED') OR (s.stage='DELIVERED' AND NOT (SHIPMENT_COD > 100K OR PREPAID > 100K))
```
`lib/constants/returns.ts::shipmentOutcome(s, prepaid)` (TypeScript, client-safe, cùng ngưỡng) trả `DELIVERED | RETURNED | RETURNED_BY_RULE | null`; dùng cho badge từng dòng trang Vận đơn ("Thực tế: hoàn (không thu được tiền)").

Trang Vận đơn (`shipmentSummary`) đếm giao thành công / hoàn bằng hai biểu thức này (không còn đếm theo `stage`).

### 6.3 Doanh thu, lợi nhuận, marketing, tồn kho, kế hoạch SX

- Doanh thu giao thành công = `sum(order_items.line_total)` (hoặc `orders.total_price_after_discount`) **filter ORDER_OUTCOME = 'DELIVERED'**. Đơn hoàn: doanh thu 0, chịu cước gửi + phí hoàn (mặc định 17K / 34K, sửa trong Giả định).
- Báo cáo danh nghĩa (`profit-nominal.ts`): đơn ĐÃ XÁC NHẬN lên trong kỳ × tỷ lệ GTC ước tính; đơn nhiều mã chia 1/N (`ordersWeighted`), doanh số phân bổ theo tiền hàng (`salesAfterDiscount`) — tổng các mã = thẻ KPI.
- Marketer (`ads-performance.ts`): đơn xác nhận gán theo `ad_id → fanpage → tiền QC → chủ mã`, phần không gán được vào "Chưa gán marketer" để **tổng luôn khớp** số đơn xác nhận Pancake; LN sau QC = (LN ròng + QC) × tỷ trọng − QC riêng − QC test.
- Giá vốn tính "sống": giá nhập phiếu ERP gần nhất → giá vốn Pancake trên đơn → giá nhập mẫu mã.
- Tồn kho ERP = Nhập − giao thật (`ORDER_OUTCOME='DELIVERED'`) − đang giao; hàng hoàn coi như đã về kho. Cột "Bán ròng 30 ngày" (`products.ts::sold30Subquery`) **loại đơn huỷ và đơn hoàn**.
- Kế hoạch đặt hàng SX (`planning.ts::demandSubquery`): nhu cầu = đơn không huỷ, không hoàn (`ORDER_OUTCOME NOT IN ('CANCELLED','RETURNED','RETURNED_BY_RULE')`) trong cửa sổ N ngày.
- Lương: mặc định trên lợi nhuận dòng tiền thực; marketer nhận diện theo tên chiến dịch / tài khoản QC / fanpage.

### 6.4 Nhập dữ liệu Viettel Post

- API đối tác Viettel Post **không trả** vận đơn tạo qua Pancake (mã khách GLMTQY) → nguồn trạng thái thật là **file "Danh sách vận đơn" xuất từ viettelpost.vn** (Đối soát COD → Nhập danh sách vận đơn, chọn nhiều tệp) và **bảng kê "Tiền hàng đã trả"**.
- File Excel VTP khai báo sai `<dimension ref="A1:AU23"/>` dù có hàng nghìn dòng → **`expandSheetRange()`** (`statement.ts`) tính lại `!ref` từ ô có thật. Không được bỏ.
- Cột "Mã Vận Đơn" chứa mã chiều về, cột "Mã đơn hàng" chứa mã gốc → parser đọc cả hai (`LIST_COL.order`), ghép chiều về TRƯỚC ghép trực tiếp.
- `applyVtpOrderList` chỉ **nâng** trạng thái COD (không hạ); `cod_collected` chỉ ghi khi file có số > 0.
- `mapVtpStatusText` kiểm tra trạng thái hoàn TRƯỚC "giao thành công"; không match `"huy"` dạng substring (đã dính `"chuyen"`).

### 6.5 Landing page (Google Sheet)

- Đọc `export?format=csv&gid=` (không dùng gviz vì mất SĐT), cấu hình `sheetTabs` dạng `"Q003=1293871758, Q002=571194026"`.
- 1 sản phẩm không ghi giá = 499.000 + 25.000 ship; gói ≥ 2 sản phẩm lấy giá gói, free ship. Không đoán mẫu mã khi không rõ cả size lẫn màu.
- Ghép đơn POS cùng SĐT (9 số cuối) trong ± `dedupeDays` quanh ngày điền form; hiện đơn POS gần nhất của SĐT + trạng thái ĐVVC.
- Pancake API **không có endpoint sửa đơn** → ERP chỉ tạo đơn nháp, không ghi ngược.

### 6.6 Khách cũ mua lại (chống sót đơn)

Cảnh báo `ORDER_INCOMPLETE` (đơn NEW/WAITING/CONFIRMED/PACKING/READY_TO_SHIP thiếu SĐT hoặc địa chỉ, chưa có vận đơn) kèm gợi ý từ đơn cũ (`lib/queries/order-hints.ts`: khớp `customer_id → conversation_id → phone`); case CSKH `ORDER_NOT_CREATED` khi tin shop có cụm chốt đơn (`cs.rules.closingKeywords`) mà chưa có đơn; **gợi ý, không tự điền**.

## 7. Tích hợp API hiện có

| Hệ thống | Cách dùng | File |
|---|---|---|
| Pancake POS Open API | `api_key` query; đơn/sản phẩm/kho/khách/đổi trả; webhook không ký → xác thực bằng secret trong URL; tạo đơn (`createOrder`) — **không có update-order** | `lib/integrations/pancake/*`, `docs/API-PANCAKE-VIETTELPOST.md` |
| Pancake Pages API | `PANCAKE_ACCESS_TOKEN`; đọc hội thoại (CSKH, phone-verify, closing detect), `reply_inbox` (chăm sóc & bán chéo, nhắn khách giao thất bại) | `lib/integrations/pancake/pages.ts` |
| Viettel Post Partner API | token đối tác (`loginVTP` / `Login+ownerconnect`) lưu `integration_tokens`; `getOrderDetailV3`, `order-filter`, `UpdateOrder`, `order/edit`, push history/re-push; webhook hành trình | `lib/integrations/viettelpost/client.ts`, `sync.ts` |
| Viettel Post Excel / bảng kê | Danh sách vận đơn (xlsx/csv), bảng kê tổng hợp (dán bảng) & chi tiết (file) | `statement.ts`, `statement-db.ts`, `app/(dashboard)/cod/statement-dialog.tsx` |
| Facebook Marketing API | System User token; chi tiêu theo ngày × chiến dịch mọi tài khoản trong BM; ngưỡng thanh toán; ad index (ad_id → page/campaign) | `lib/integrations/facebook/*` |
| Google Sheets | CSV export công khai (link "Bất kỳ ai có liên kết – Người xem") | `lib/landing/sheet.ts` |
| MB Bank | nhập sao kê JSON/CSV thủ công → chi phí vận hành | `lib/integrations/bank/*` |
| Lark Suite / Telegram | Custom Bot webhook gửi cảnh báo (URL lưu trong `settings.alerts.config`) | `lib/alerts/lark.ts`, `telegram.ts` |

Đã thử và **loại bỏ**: tự động đăng nhập web viettelpost.vn (SSO `id.viettelpost.vn`, supperapp endpoints trả `EXPIRED_TOKEN`); OIDC password grant thất bại. Không quay lại hướng này trừ khi Viettel Post mở API cho mã khách của shop.

## 8. Environment variables / secrets (CHỈ TÊN — không ghi giá trị)

`.env` (trên VPS, tạo bởi `scripts/bootstrap.sh` từ GitHub Secrets; mẫu `.env.example`):
`DATABASE_URL`, `AUTH_SECRET`, `CRON_SECRET`, `APP_URL`, `ERP_INTERNAL_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`,
`PANCAKE_API_KEY`, `PANCAKE_SHOP_ID`, `PANCAKE_BASE_URL`, `PANCAKE_PAGES_BASE_URL`, `PANCAKE_ACCESS_TOKEN`, `PANCAKE_WEBHOOK_SECRET`, `PANCAKE_BACKFILL_DAYS`,
`VIETTELPOST_API_KEY`, `VIETTELPOST_USERNAME`, `VIETTELPOST_PASSWORD`, `VIETTELPOST_BASE_URL`, `VIETTELPOST_WEBHOOK_SECRET`, `VIETTELPOST_WEB_TOKEN` (thử nghiệm, không dùng),
`FACEBOOK_ACCESS_TOKEN`, `FACEBOOK_BUSINESS_ID`, `FACEBOOK_API_VERSION`, `FACEBOOK_USD_VND`,
`SYNC_*_EVERY_MINUTES` (lịch scheduler), `SKIP_AUTO_MIGRATE`.

GitHub Actions Secrets: `VPS_HOST`, `VPS_PASSWORD` hoặc `VPS_SSH_KEY`, `PANCAKE_API_KEY`, `PANCAKE_ACCESS_TOKEN`, `VIETTELPOST_API_KEY`, `VIETTELPOST_USERNAME`, `VIETTELPOST_PASSWORD`, `ADMIN_PASSWORD`, `FACEBOOK_ACCESS_TOKEN`. Variables: `ERP_DOMAIN`, `PANCAKE_SHOP_ID`, `ADMIN_EMAIL`, `VPS_USER`, `FACEBOOK_BUSINESS_ID`.

Webhook Lark/Telegram, ngưỡng, mẫu tin: trong bảng `settings` (ghi bằng ops `set-setting`), không trong repo.

**Repo là PUBLIC**: không bao giờ commit `.env`, token, URL webhook, mật khẩu; không in secret ra log Actions (các script probe đã che token).

## 9. Lệnh

```bash
npm install
cp .env.example .env            # điền giá trị; để trống DATABASE_URL → dùng PGlite nhúng
npm run dev                     # http://localhost:3000
npm run typecheck && npm run lint
npm test                        # tests/sync-fixtures.test.ts trên PGlite — phải in "TẤT CẢ KIỂM THỬ ĐẠT"
npm run build                   # production build (bắt buộc trước khi push nếu chạm client/server boundary)
npm run db:generate             # tạo migration Drizzle sau khi sửa db/schema.ts (KHÔNG sửa tay SQL đã có)
npm run db:migrate · npm run db:seed · npm run seed:demo · npm run scheduler · npm run sync -- <job>
```
Docker local: `docker compose up` (xem README). Deploy: GitHub → Actions → **Deploy ERP to VPS** → Run workflow trên `main` (chỉ `workflow_dispatch`, ~7 phút). Vận hành từ xa: Actions → **Vận hành ERP trên VPS** (`ops-vps.yml`) với action `db-query` (SQL chỉ đọc, mỗi lần 1 câu lệnh — CTE không dùng được qua nhiều câu; cast `::text` khi so sánh enum), `run-job`, `set-setting`, `logs`, `backup`, `restart`, …

## 10. Những gì đã hoàn thành (đến 06/09/2026)

Mọi module trong bảng tính năng của `README.md`: Tổng quan · Đơn hàng · Vận đơn (+ thao tác VTP) · Cần xử lý & thông báo (Lark/Telegram) · CSKH (chat detect, giao không thành, xác nhận SĐT, chống sót đơn khách cũ) · Chăm sóc & bán chéo · Đơn landing page (near-realtime, Q002/Q003) · Đối soát COD (bảng kê + danh sách vận đơn + vận đơn chiều về) · Khách hàng · Đổi/trả · Sản phẩm & tồn kho · Nhật ký kho · Nhập hàng & kiểm kê · Kế hoạch đặt hàng SX + bảng chốt gửi xưởng · Chi phí vận hành (+ sao kê MB) · Quảng cáo (hiệu suất marketer/mã hàng, ngưỡng thanh toán) · Báo cáo lợi nhuận (3 tab) · Tỷ lệ giao thành công · Lương & hoa hồng · Phân quyền chi tiết · Kết nối dữ liệu · Nhật ký thao tác.

## 11. Thay đổi trong session này (mới nhất trước) — 4 commit cuối

| Commit | Nội dung |
|---|---|
| `d1c71da` | Bảng gom nhóm (Sản phẩm & tồn kho, Tỷ lệ GTC): sắp xếp lại **thứ tự nhóm** theo cột đang sắp xếp trên dòng cha; thêm `compareValues`. |
| `eed0f9c` | Sửa sắp xếp bảng: `clearOnDefault:false` cho `sort`/`dir` (nuqs xoá `dir=desc` → trang mặc định `asc` không bao giờ giảm dần được); `DataTable` nhận `defaultSort`/`defaultDir`/`sortable`; tự xử lý bấm sắp xếp (cột chỉ hiển thị cũng bấm được); `RETURN_RATE_SORTABLE` chuyển sang `lib/constants/returns.ts`; 4 cột Nhập/Giao thật/Hoàn/Đang giao sắp xếp được. |
| `8771598` | **Doanh thu COD < 50K = đơn hoàn** trên mọi báo cáo: `maxCodForReturn`, `RETURN_COD_RULE` trong `ORDER_OUTCOME`; `SHIPMENT_COD/DELIVERED/RETURNED`; trang Vận đơn đếm theo doanh thu; `shipmentOutcome()` + badge "Thực tế: hoàn"; "Bán ròng 30 ngày" loại đơn hoàn. Kết quả thật: giao TC 859 → 642, hoàn 488 → 705 (217 vận đơn COD < 50K, 214 là chiều về). |
| `5f27b5c` | `expandSheetRange()` — file VTP khai báo `A1:AU23` nhưng có 1448 dòng; trước đó chỉ đọc 23 dòng (hiển thị "28 vận đơn" thay vì 1595). |
| `a748274` | Ghép vận đơn chiều về (`legBaseCode`, đọc cột "Mã đơn hàng", ghi leg thành shipment riêng). |
| `60c0d13` | Chống sót đơn khách cũ: `ORDER_INCOMPLETE`, `order-hints.ts`, `ORDER_NOT_CREATED`, `findClosingMessage`. |
| `5d2d9b4`…`6a36d1f` | Landing page: đọc tab theo gid, size/màu, giá 499k+25k, trạng thái đơn POS, lọc Q002/Q003, ghép POS ± ngày, chi tiết ĐVVC. |

### File đã sửa và lý do (từ `6a36d1f` tới `d1c71da`)

| File | Lý do |
|---|---|
| `lib/queries/return-rate.ts` | Thêm `RETURN_COD_RULE` (<50K → RETURNED) vào `ORDER_OUTCOME`; thêm `SHIPMENT_COD/DELIVERED/RETURNED`; re-export `RETURN_RATE_SORTABLE`. |
| `lib/constants/returns.ts` | `maxCodForReturn = 50_000`; nhãn `RETURNED`; `shipmentOutcome()`; `RETURN_RATE_SORTABLE` (client-safe). |
| `lib/queries/shipments.ts` | `shipmentSummary` đếm theo doanh thu (LEFT JOIN orders); mỗi dòng thêm `outcome`. |
| `lib/queries/products.ts` | `sold30Subquery` loại đơn huỷ/hoàn (bán ròng). |
| `app/(dashboard)/shipments/columns.tsx`, `page.tsx` | Badge "Thực tế: hoàn / không thành công"; nhãn kết quả. |
| `app/(dashboard)/products/columns.tsx` | Tiêu đề "Bán ròng 30 ngày"; `accessorKey` cho 4 cột số. |
| `components/data-table/data-table.tsx` | Sửa sort (nuqs clearOnDefault, defaults theo trang, prop `sortable`, toggle tự viết, sắp xếp nhóm cha, `compareValues`). |
| `app/(dashboard)/*/*-table.tsx` (orders, shipments, cod, customers, audit, sync-runs, inventory, returns, expenses, products, return-rate) | Truyền `defaultSort` (+ `defaultDir`, `sortable` nơi cần). |
| `app/(dashboard)/reports/returns/columns.tsx`, `cod/statement-dialog.tsx` | Chú thích quy tắc 50K/100K. |
| `lib/integrations/viettelpost/statement.ts` | `expandSheetRange`, `sheetMatrix`, `legBaseCode`, đọc cột "Mã đơn hàng", sửa `mapVtpStatusText`. |
| `lib/integrations/viettelpost/statement-db.ts` | Ghép leg trước, ghi leg thành shipment riêng, trả `legs`. |
| `lib/alerts/rules.ts`, `lib/constants/alerts.ts` | Quy tắc `ORDER_INCOMPLETE`. |
| `lib/queries/order-hints.ts` (mới) | Gợi ý SĐT/địa chỉ từ đơn cũ. |
| `lib/cs/chat-detect.ts`, `lib/constants/cs.ts` | `findClosingMessage`, case `ORDER_NOT_CREATED`. |
| `lib/landing/sheet.ts`, `lib/landing/pos.ts`, `lib/queries/landing.ts`, `lib/constants/landing.ts`, `lib/actions/landing.ts`, `app/(dashboard)/landing/*` | Toàn bộ cải tiến landing page. |
| `app/(dashboard)/orders/[id]/page.tsx` | Banner gợi ý đơn cũ. |
| `tests/sync-fixtures.test.ts` | Kiểm thử cho mọi thay đổi trên (đơn 30K → RETURNED, 60K → RETURNED_BY_RULE, GTC 3/(3+5) = 37,5 %, leg, expandSheetRange, hints, closing message, landing filters). |
| `README.md` | Cập nhật mô tả tính năng. |

## 12. Đang làm dở / câu hỏi đang chờ chủ shop

1. **106 mã vận đơn trong file VTP không có trong ERP** (vận đơn tạo thẳng trên viettelpost.vn, không qua Pancake). Đã hỏi chủ shop chọn: (a) ghi thành vận đơn lẻ (`order_id NULL`) để theo dõi COD/trạng thái, hay (b) chỉ liệt kê để đối chiếu tay. **Chưa có câu trả lời** — không tự quyết.
2. Deploy `d1c71da` đã thành công nhưng chủ shop **chưa xác nhận** đã bấm sắp xếp thấy đúng trên trang Sản phẩm & tồn kho. Nếu vẫn sai, xin URL có `?sort=&dir=` để chẩn đoán.

## 13. Bug / technical debt còn lại

- Các trang render `<DataTable>` trực tiếp trong `page.tsx` (landing, payroll, reports, cs, outreach) chưa truyền `defaultSort` → mũi tên mặc định không hiện (chỉ thẩm mỹ).
- Sắp xếp nhóm cha là **client-side trong trang hiện tại**; với > 1 trang, thứ tự nhóm chỉ đúng trong trang.
- `docs/CONVENTIONS.md` còn nói "`enableSorting: false` nếu không sort được" — nay cột sort được quyết bởi `accessorKey` hoặc prop `sortable`; cần cập nhật doc.
- `ORDER_OUTCOME` là CASE lớn chạy trên mọi báo cáo (không có bảng tổng hợp sẵn); có `0014_perf_indexes` nhưng khi dữ liệu lớn nên cân nhắc materialized view / cột `outcome` tính sẵn (xem lộ trình giai đoạn 4).
- Tồn kho vẫn tính hàng hoàn là đã về kho ngay khi đơn thành hoàn (chưa có bước "nhận hàng hoàn").
- Bảng kê COD chưa tự đối chiếu với tiền vào ngân hàng.
- `next lint` đã deprecated (Next 16 bỏ) → sớm chuyển sang ESLint CLI.
- Số "đơn chờ xử lý" bị thổi phồng khi Pancake không cập nhật trạng thái giao.
- Kiểm thử là một file `main()` duy nhất (chạy tuần tự, ~30 s); fixture dùng chung nên thêm đơn mới cho `rr-var` có thể làm lệch assertion khác (đã từng: stock 8→6, `lg-9101` tách riêng).

## 14. Quyết định kiến trúc đã thống nhất với chủ shop

1. **Một nguồn sự thật cho kết quả đơn**: `ORDER_OUTCOME`. Mọi báo cáo mới phải dùng nó, không viết lại logic.
2. **Chỉ số chính là TỶ LỆ GIAO THÀNH CÔNG** (không phải tỷ lệ hoàn) vì trạng thái hoàn phụ thuộc dữ liệu VTP nhập tay.
3. Đơn giao thành công = COD thực > 100K; < 50K = hoàn; 50K–100K = không thành công. Ngưỡng nằm trong `RETURN_RULE`, không hard-code chỗ khác.
4. Dữ liệu Viettel Post (webhook, danh sách vận đơn, bảng kê) **ưu tiên hơn** bản sao trên Pancake. Import chỉ **nâng** trạng thái COD.
5. Vận đơn chiều về là dòng `shipments` riêng, không đè lên vận đơn gốc.
6. Marketer report phải **tổng khớp** đơn xác nhận Pancake ("Chưa gán marketer" hứng phần dư).
7. Kho / Tài chính tách nhóm menu; Chi phí vận hành và Quảng cáo là hai module riêng.
8. Landing page: near-realtime bằng job 1 phút + refresh 30 s, không dùng Google API key.
9. Không tự điền dữ liệu khách cũ vào đơn mới — chỉ gợi ý.
10. Mọi thao tác VPS qua `ops-vps.yml`; `db-query` chỉ đọc; scripts lấy từ GitHub Contents API (không dùng raw CDN vì cache).
11. Không dùng tài khoản Facebook cá nhân của chủ shop (chỉ System User token).

## 15. Việc nên làm tiếp (ưu tiên giảm dần)

1. Chốt với chủ shop hướng xử lý **106 vận đơn ngoài Pancake** (mục 12) và làm theo.
2. Xác nhận sắp xếp bảng đã đúng trên production; nếu còn lỗi, chẩn đoán từ URL.
3. Cập nhật `docs/CONVENTIONS.md` phần DataTable (props `defaultSort`, `defaultDir`, `sortable`, gom nhóm).
4. Truyền `defaultSort` cho các bảng còn lại (landing, payroll, reports, cs).
5. Giai đoạn 1 của `docs/LO-TRINH-HOAN-THIEN.md`: kiểm kê đầu kỳ, nhập bảng kê chi tiết, ghép nốt chiến dịch chưa gán marketer — chủ yếu là việc vận hành, ERP hỗ trợ.
6. Bước "nhận hàng hoàn về kho" để tồn kho không tính hàng hoàn chưa về.
7. Đối chiếu ba chiều Pancake ↔ Viettel Post ↔ ngân hàng (job `data-check` mở rộng).
8. Hiệu năng: bảng tổng hợp theo ngày / cột `outcome` tính sẵn cho `ORDER_OUTCOME`.
9. Chuyển `next lint` → ESLint CLI; cân nhắc tách `tests/sync-fixtures.test.ts` thành nhiều file.

## 16. TUYỆT ĐỐI không đổi nếu chưa kiểm tra kỹ

- `lib/queries/return-rate.ts` — `ORDER_OUTCOME`, `FEE_RULE`, `RETURN_COD_RULE`, `LEG_RULE`, `SHIPMENT_*` (ảnh hưởng mọi báo cáo và lương). Mọi thay đổi phải kèm kiểm thử trong `tests/sync-fixtures.test.ts` và đối chiếu số trên production bằng `db-query`.
- `lib/constants/returns.ts::RETURN_RULE` — ngưỡng do chủ shop quy định.
- `lib/integrations/viettelpost/statement.ts` — `expandSheetRange`, `legBaseCode` (regex lười), thứ tự `mapVtpStatusText`; `statement-db.ts` — thứ tự ghép leg trước, không hạ trạng thái COD.
- `lib/integrations/pancake/webhook.ts` & `viettelpost` webhook — idempotent, không để dữ liệu cũ đè dữ liệu mới.
- `db/schema.ts` + `drizzle/*.sql` — chỉ thêm migration mới bằng `npm run db:generate`; không sửa migration đã chạy trên production.
- `components/data-table/data-table.tsx` — dùng chung 30 bảng; sửa phải chạy `npm run build` và thử trên ít nhất một bảng gom nhóm và một bảng thường.
- `.github/workflows/*.yml`, `scripts/bootstrap.sh`, `install-vps.sh` — chạm vào là ảnh hưởng deploy/production; YAML từng vỡ vì thụt lề.
- `lib/auth/permissions.ts` — thay đổi làm mất quyền người dùng thật.
- `lib/cache.ts` TTL và các `memo` key — đổi key có thể làm báo cáo hiển thị số cũ/mới lẫn lộn.
