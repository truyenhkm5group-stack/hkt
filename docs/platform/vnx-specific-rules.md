# Kiểm kê logic đặc thù VNX (tổ chức #1) đang nằm lẫn trong mã

> Tài liệu CHỈ ĐỌC — kiểm kê, phân loại, đề xuất chiến lược tách. Không đổi một dòng mã nào.
> Đo trên `origin/main` tại `41002d1e` (27/09/2026). Mọi vị trí là `tệp:dòng` của đúng commit đó.
> Đọc cùng `target-architecture.md` (mô hình SILO: mỗi tổ chức một CSDL, `getDb()` chọn CSDL).
> `AGENTS.md` vẫn đứng trên tài liệu này: nơi nào hai bên nói khác nhau, `AGENTS.md` thắng.

## 1. Tóm tắt

- **125 mục** đặc thù trong bảng chính (mục 2), cộng 19 giả định hạ tầng một-công-ty (mục 4) và 18 rủi ro khi chạy tổ chức thứ hai (mục 5).
- **Theo phân loại:** 42 `INDUSTRY_PACK` · 41 `CONNECTOR` · 29 `TENANT_SPECIFIC` · 13 `GENERIC`.
- **Theo loại:** 19 hằng số ngưỡng · 17 định danh cứng · 15 khác · 13 trạng thái cứng · 12 thời trang · 9 luật kết quả đơn · 9 bản địa hoá · 8 công thức KPI · 7 lương/hoa hồng · 7 COD · 5 vai trò · 4 marketing.
- **Theo mức gắn chặt:** 36 cao · 48 vừa · 41 thấp.
- **Chiến lược chính:** 43 `KEEP_AS_IS` (18 trong số đó có đích dài hạn ghi sau "→") · 30 `TENANT_SETTING` · 23 `CONNECTOR_ADAPTER` · 16 `MODULE_FEATURE` · 13 `INDUSTRY_PACK`.
- **Ba phát hiện nặng nhất:** (1) `FACEBOOK_BUSINESS_ID` có mặc định là BM thật của VNX (`lib/env.ts:78`); (2) `memo()` toàn cục, khoá không có tổ chức (132 lời gọi) — sẽ rò số chéo tổ chức; (3) `ORDER_OUTCOME` và sổ kho gắn chặt tiền COD + chứng từ Viettel Post, nên với tổ chức bán buôn chúng in ra số SAI trông như số thật (đơn công nợ thành "hoàn", tồn không bao giờ giảm).
- **Tin tốt:** 20+ khoá cấu hình đã nằm trong bảng `settings` (`profit.assumptions`, `landing.config`, `alerts.config`, `work.sla`, `work.ownership`, `cs.rules`, `outreach.config`…). Với mô hình SILO chúng tự thành cấu hình của từng tổ chức — việc còn lại là mặc định của chúng đang mang số / tên của VNX.
- Không mục nào ở đây được di dời trong Phase 1 nếu nó chạm contract test (mục 3).

## 2. Bảng chính

Quy ước cột:
- **Loại**: hằng số ngưỡng · luật kết quả đơn · trạng thái cứng · định danh cứng · vai trò · công thức KPI ·
  lương/hoa hồng · marketing · COD · thời trang · bản địa hoá · khác.
- **Phân loại**: `TENANT_SPECIFIC` (chỉ VNX) · `INDUSTRY_PACK` (chung cho thời trang / TMĐT COD Việt Nam) ·
  `CONNECTOR` (gắn Pancake / Viettel Post / Facebook / Lark / SePay…) · `GENERIC` (dùng chung được, chỉ cần tham số hoá).
- **Mức gắn chặt**: thấp = đổi ở một chỗ; vừa = vài tệp / đã có khoá `settings` nhưng mặc định mang số VNX;
  cao = đi vào CSDL (enum, khoá, cột lưu trữ), vào `ORDER_OUTCOME`, hoặc rải ở hàng chục tệp.
- **Chiến lược**: `TENANT_SETTING` · `MODULE_FEATURE` · `INDUSTRY_PACK` · `CONNECTOR_ADAPTER` · `KEEP_AS_IS` (kèm lý do).
  Dòng nào ghi "→" là: Phase 1 giữ nguyên, đích dài hạn là chiến lược sau mũi tên.

### 2.1. Luật kết quả đơn, COD, chứng từ ĐVVC

| # | Mục | Vị trí (tệp:dòng) | Loại | Phân loại | Mức gắn chặt | Chiến lược tách đề xuất |
|---|---|---|---|---|---|---|
| 1 | `RETURN_RULE`: `maxCodForReturn` 50.000 · `maxCodForFakeDelivery` 100.000 · `maxFeeForFakeDelivery` 10.000 | `lib/constants/returns.ts:2-21` | hằng số ngưỡng | INDUSTRY_PACK | cao | `KEEP_AS_IS` → `INDUSTRY_PACK` (gói "COD Việt Nam", ngưỡng là tham số của gói, tổ chức ghi đè). Lý do giữ: contract test + AGENTS §3.4 |
| 2 | `ORDER_OUTCOME` — một biểu thức `case` 25 nhánh là kết quả đơn cho MỌI báo cáo | `lib/queries/return-rate.ts:225-299` | luật kết quả đơn | INDUSTRY_PACK | cao | `KEEP_AS_IS` → `INDUSTRY_PACK` (xem mục 3) |
| 3 | Nhánh tiền thực thu < 50K ⇒ `RETURNED`, 50K–100K ⇒ `RETURNED_BY_RULE` đứng **TRƯỚC** mã 501 chiều đi | `lib/queries/return-rate.ts:247-250` | luật kết quả đơn | INDUSTRY_PACK | cao | `KEEP_AS_IS` → `INDUSTRY_PACK`. Chỉ đúng với hàng giá > 100K (xem mục 5, R-02) |
| 4 | Sáu mã cuối VTP `501/503/504/101/107/201` + cờ `IS_RETURNING` (`leg_type`) quyết định kết quả | `lib/queries/return-rate.ts:48-75`, `lib/constants/viettelpost.ts:46` | trạng thái cứng | CONNECTOR | cao | `KEEP_AS_IS` → `CONNECTOR_ADAPTER` (adapter ĐVVC trả "kết cục chuẩn": giao/hoàn/huỷ/tiêu huỷ + chiều) |
| 5 | "Doanh thu bị sửa sau khi giao" = sự kiện `status_name like 'Nhập doanh thu%'` trong 2 phút sau mốc giao ⇒ hoàn | `lib/queries/return-rate.ts:146-151` | luật kết quả đơn | CONNECTOR | cao | `KEEP_AS_IS` → `CONNECTOR_ADAPTER` (dò chữ tiếng Việt của VTP, không phải luật chung) |
| 6 | Có vận đơn chiều hoàn (`shipments.order_reference = vtp_order_number`) ⇒ hoàn dù VTP ghi 501 | `lib/queries/return-rate.ts:205-209` | luật kết quả đơn | CONNECTOR | cao | `KEEP_AS_IS` → `CONNECTOR_ADAPTER` |
| 7 | Bằng chứng tiền = `cod_collected > 0` hoặc dòng bảng kê VTP; chưa có ⇒ tạm dùng COD khai báo | `lib/queries/return-rate.ts:113-129`, `lib/queries/return-rate.ts:157` (`IS_PROVISIONAL`) | COD | INDUSTRY_PACK | cao | `KEEP_AS_IS` → `INDUSTRY_PACK` |
| 8 | Tiền trả trước = `orders.prepaid + orders.transfer_money` (trường Pancake) | `lib/queries/return-rate.ts:30` | COD | CONNECTOR | vừa | `CONNECTOR_ADAPTER` (đơn chuẩn phải có "đã thanh toán trước" không phụ thuộc Pancake) |
| 9 | Cước đơn = `shipments.shipping_fee`, lùi về `orders.partner_fee` (Pancake) | `lib/queries/return-rate.ts:23` | COD | CONNECTOR | vừa | `CONNECTOR_ADAPTER` |
| 10 | Nhánh lùi theo trạng thái Pancake (`o.stage in DELIVERED/PAID/SHIPPED` ⇒ `UNKNOWN`; `RETURNING/PARTIAL_RETURN` ⇒ `RETURNED`) | `lib/queries/return-rate.ts:289-297` | luật kết quả đơn | CONNECTOR | cao | `KEEP_AS_IS` → `CONNECTOR_ADAPTER` |
| 11 | `ORDER_OUTCOME_VERIFIED` (bản "tiền có chứng từ") dùng cùng hai ngưỡng | `lib/queries/return-rate.ts:463-475` | luật kết quả đơn | INDUSTRY_PACK | cao | `KEEP_AS_IS` → `INDUSTRY_PACK` |
| 12 | `REPORTABLE_ORDER` = `o.stage <> 'NEW'`; `CONFIRMED_STAGES` dùng ở 23 tệp `lib/queries` | `lib/queries/return-rate.ts:98`, `lib/constants/pancake.ts:62` | trạng thái cứng | CONNECTOR | cao | `KEEP_AS_IS` → `CONNECTOR_ADAPTER` (ánh xạ "đơn đã chốt" theo nguồn đơn) |
| 13 | `SHIPMENT_LEFT_WAREHOUSE` — "hàng đã rời kho" CHỈ theo mốc/chặng vận đơn ĐVVC; sổ kho trừ tồn bằng nó | `lib/queries/return-rate.ts:504-505`, `lib/queries/stock.ts:62-93` | luật kết quả đơn | INDUSTRY_PACK | cao | `KEEP_AS_IS` → `MODULE_FEATURE` ("xuất kho qua ĐVVC" vs "xuất kho bằng phiếu") |
| 14 | `VTP_DESTROYED` (503 = tiêu huỷ, không về kho) — sổ kho loại khỏi "hoàn chờ nhận" | `lib/queries/return-rate.ts:72` | trạng thái cứng | CONNECTOR | vừa | `CONNECTOR_ADAPTER` |
| 15 | Nhãn kết quả chép cứng ngưỡng vào chữ: "thu > 100K", "thu < 50K", "thu 50K–100K" | `lib/constants/returns.ts:48-50` | hằng số ngưỡng | INDUSTRY_PACK | vừa | `INDUSTRY_PACK` — dẫn xuất nhãn từ `RETURN_RULE` thay vì gõ lại |
| 16 | Chữ giải thích trên màn hình chép lại "COD thực > 100K / 100.000đ / 50K–100K" | `app/(dashboard)/reports/page.tsx:294,336`, `app/(dashboard)/payroll/page.tsx:243`, `app/(dashboard)/expenses/ads-performance.tsx:51,165`, `app/(dashboard)/reports/returns/columns.tsx:178,191,197`, `app/(dashboard)/reports/returns/page.tsx:320`, `lib/queries/preship-risk-backtest.ts:333` | hằng số ngưỡng | INDUSTRY_PACK | vừa | `INDUSTRY_PACK` — in từ `RETURN_RULE`; hôm nay đổi ngưỡng là 9 chỗ chữ nói sai |
| 17 | Bản sao luật ngoài hàm chung: `50000`/`100000` gõ cứng trong SQL của script đối chiếu (trái AGENTS §3.4) | `scripts/returns-parity.ts:91-101` | luật kết quả đơn | INDUSTRY_PACK | vừa | `KEEP_AS_IS` (script ops đo lịch sử); ghi nhận để khi tách gói ngành thì script đọc `RETURN_RULE` |
| 18 | `legBaseCode()` — mã chiều về = mã gốc + `[số]P[số]` (regex lười, AGENTS §3.7) | `lib/integrations/viettelpost/statement.ts:243-248` | trạng thái cứng | CONNECTOR | cao | `KEEP_AS_IS` → `CONNECTOR_ADAPTER` |
| 19 | `expandSheetRange()` — sửa vùng dữ liệu khai sai của Excel VTP | `lib/integrations/viettelpost/statement.ts:77` | khác | CONNECTOR | thấp | `CONNECTOR_ADAPTER` |
| 20 | `mapVtpStatusText()` — dịch chữ trạng thái tệp "Danh sách vận đơn" theo bối cảnh cờ "Trả hàng" | `lib/integrations/viettelpost/statement.ts:367` | trạng thái cứng | CONNECTOR | cao | `CONNECTOR_ADAPTER` |
| 21 | Bảng mã VTP → chặng (`VTP_STATUS`), mã lý do 20–47 / 1–17, tập lý do "khách từ chối" | `lib/constants/viettelpost.ts:6-106` | trạng thái cứng | CONNECTOR | cao | `CONNECTOR_ADAPTER` |
| 22 | `505` / `515` / `502` — đề nghị hoàn vs đã duyệt hoàn vs đang về; chốt ca care theo mã | `lib/constants/care-return-approval.ts:6-23` | trạng thái cứng | CONNECTOR | vừa | `CONNECTOR_ADAPTER` |
| 23 | Hành động gửi sang VTP (`order/UpdateOrder` TYPE 1–5, 11; `order/edit`) | `lib/constants/viettelpost.ts:148-160`, `lib/care/carrier-capabilities.ts:34-39` | trạng thái cứng | CONNECTOR | vừa | `CONNECTOR_ADAPTER` (giao diện "hành động ĐVVC") |
| 24 | Nguồn chứng từ ghi vào CSDL: `VTP_WEBHOOK` · `VTP_IMPORT` · `VTP_POLL` · `VTP_UI_MANUAL_VERIFICATION` (`shipment_events.source`) | `lib/constants/truth.ts:101-113` | trạng thái cứng | CONNECTOR | cao | `KEEP_AS_IS` (giá trị đã lưu trong CSDL; đổi tên là mồ côi lịch sử) → `CONNECTOR_ADAPTER` thêm nguồn mới, không đổi nguồn cũ |
| 25 | Mã vận đơn thử của VTP `"123456789101112"` bị loại khỏi đối soát | `lib/constants/truth.ts:283` | định danh cứng | CONNECTOR | thấp | `CONNECTOR_ADAPTER` |
| 26 | Link tra cứu viettelpost.vn | `lib/constants/viettelpost.ts:188` | định danh cứng | CONNECTOR | thấp | `CONNECTOR_ADAPTER` |
| 27 | `CARRIER_HANDOFF_STAGES` + `least()` của chứng cứ bàn giao | `lib/constants/carrier-handoff.ts:126-190` | luật kết quả đơn | GENERIC | vừa | `KEEP_AS_IS` — khái niệm dùng chung được, chỉ nguồn chứng từ là VTP |
| 28 | Nhịp đối chiếu HOT 5 / WARM 30 / COLD 240 phút, trần lùi 24 giờ | `lib/constants/vtp-reconcile.ts:47-51,95` | hằng số ngưỡng | CONNECTOR | thấp | `CONNECTOR_ADAPTER` |
| 29 | Đo webhook rơi: ngưỡng 120 phút, mẫu tối thiểu 30 | `lib/constants/webhook-gap.ts:39-45` | hằng số ngưỡng | CONNECTOR | thấp | `CONNECTOR_ADAPTER` |
| 30 | Tuổi chặng (watch/warning/exception theo từng chặng) | `lib/constants/shipment-status-age.ts:133-167` | hằng số ngưỡng | INDUSTRY_PACK | vừa | `TENANT_SETTING` (đã có ghi đè thưa `logistics.dwell-sla`, AGENTS §54) |
| 31 | `COD_OVERDUE_DAYS = 5` | `lib/constants/cod.ts:113` | COD | INDUSTRY_PACK | thấp | `TENANT_SETTING` |
| 32 | Nhắc nhập tệp "Danh sách vận đơn" từ 10:00 giờ VN; cảnh báo `VTP_ORDER_LIST_DUE` bật mặc định | `lib/constants/feed-freshness.ts:27`, `lib/constants/alerts.ts:62`, `lib/alerts/rules.ts:810-830` | COD | CONNECTOR | vừa | `MODULE_FEATURE` (chỉ bật khi tổ chức có connector VTP) |
| 33 | Bảng kê VTP qua Gmail (heartbeat, cảnh báo `STATEMENT_MAIL_SILENT`, `COD_STATEMENT_MISSING`) | `lib/integrations/viettelpost/statement-mail.ts:21`, `lib/constants/alerts.ts:94` | COD | CONNECTOR | vừa | `MODULE_FEATURE` + `CONNECTOR_ADAPTER` |
| 34 | Nguồn chứng từ thanh toán `VTP_COD_STATEMENT` | `lib/constants/payments.ts:7` | COD | CONNECTOR | vừa | `CONNECTOR_ADAPTER` |
| 35 | Đối soát một lần "sổ hàng hoàn viết tay (HMT)" của kho VNX | `lib/constants/hmt-returns.ts:1-48` | khác | TENANT_SPECIFIC | thấp | `MODULE_FEATURE` (tắt mặc định; công cụ di trú của riêng VNX) |

### 2.2. Pancake POS (nguồn đơn, khách, sản phẩm, hội thoại)

| # | Mục | Vị trí (tệp:dòng) | Loại | Phân loại | Mức gắn chặt | Chiến lược tách đề xuất |
|---|---|---|---|---|---|---|
| 36 | Bảng trạng thái số Pancake → `OrderStage` (0,17,11,20,1,12,13,8,9,2,3,16,4,15,5,6,7) | `lib/constants/pancake.ts:4-22` | trạng thái cứng | CONNECTOR | cao | `CONNECTOR_ADAPTER` |
| 37 | `orderStageEnum` mang ngữ nghĩa Pancake (`WAITING`, `PAID`, `PARTIAL_RETURN`, `DELETED`) | `db/schema.ts:17-31` | trạng thái cứng | CONNECTOR | cao | `KEEP_AS_IS` (enum CSDL; silo nên mọi tổ chức cùng enum) — adapter phải ánh xạ vào đúng tập này |
| 38 | Khoá chính = id Pancake: `orders.id` (chuỗi Pancake), `product_variants.id` (uuid Pancake), `customers.pancake_id`, `orders.shop_id/page_id/post_id/conversation_id` | `db/schema.ts:1214-1257`, `db/schema.ts:1135`, `db/schema.ts:1036` | định danh cứng | CONNECTOR | cao | `KEEP_AS_IS` (silo: không va chạm giữa tổ chức) → `CONNECTOR_ADAPTER` cần đường tạo đơn gốc ERP |
| 39 | Nguồn đơn theo mã Pancake (`-1` Facebook … `-17` Shopify), trạng thái đối tác vận chuyển trong Pancake | `lib/constants/pancake.ts:94-131` | trạng thái cứng | CONNECTOR | vừa | `CONNECTOR_ADAPTER` |
| 40 | `PANCAKE_SHOP_ID`, `PANCAKE_API_KEY`, `PANCAKE_ACCESS_TOKEN` — một shop cho cả tiến trình | `lib/env.ts:48-71`, `lib/integrations/pancake/client.ts:34-42` | định danh cứng | CONNECTOR | cao | `CONNECTOR_ADAPTER` + credential theo tổ chức (xem mục 4) |
| 41 | Landing đẩy đơn nháp vào Pancake (`warehouse_id` Pancake, `posNote`) | `lib/constants/landing.ts:60-64` | khác | CONNECTOR | vừa | `MODULE_FEATURE` + `CONNECTOR_ADAPTER` |
| 42 | Luật phát hiện case CSKH bằng từ khoá trên THẺ / GHI CHÚ / HỘI THOẠI Pancake ("doi size", "doi mau", "chat qua", "bao lay"…) | `lib/constants/cs.ts:237-321` | khác | CONNECTOR | vừa | `TENANT_SETTING` (đã là `cs.rules`); bộ mặc định chuyển vào `INDUSTRY_PACK` thời trang |
| 43 | Bot nhắn khách giao hụt qua Pancake kèm SĐT bưu tá bóc từ ghi chú VTP; gán `assignee = 'Bot ERP'` | `lib/cs/failed-delivery.ts:48,189-241` | khác | CONNECTOR | vừa | `MODULE_FEATURE` |
| 44 | Yếu tố rủi ro "Pancake đánh dấu chặn"; ngưỡng điểm 20/40 | `lib/constants/preship-risk.ts:107-108,196` | công thức KPI | CONNECTOR | vừa | `CONNECTOR_ADAPTER` (yếu tố tuỳ nguồn) + `TENANT_SETTING` (ngưỡng) |
| 45 | Bot chat bán hàng Pancake + Gemini (container riêng, một volume, một bộ khoá) | `docker-compose.prod.yml:55-86`, `chatbot/erp-entry.mjs` | khác | CONNECTOR | vừa | `MODULE_FEATURE` |
| 46 | Gửi tin hàng loạt / kịch bản băn khoăn trong cửa sổ 24 giờ của Meta, qua Pancake Pages | `lib/constants/outreach.ts:88-99` | marketing | CONNECTOR | vừa | `MODULE_FEATURE` + `CONNECTOR_ADAPTER` |
| 47 | Giá vốn "sống": phiếu nhập ERP → giá vốn Pancake → giá nhập mẫu mã (AGENTS §3.13) | `lib/queries/cogs.ts`, AGENTS.md §3.13 | công thức KPI | CONNECTOR | vừa | `KEEP_AS_IS` → `CONNECTOR_ADAPTER` (bậc Pancake là tuỳ chọn) |

### 2.3. Facebook Ads, quy kết marketer, landing

| # | Mục | Vị trí (tệp:dòng) | Loại | Phân loại | Mức gắn chặt | Chiến lược tách đề xuất |
|---|---|---|---|---|---|---|
| 48 | **ID Business Manager của VNX làm giá trị mặc định**: `FACEBOOK_BUSINESS_ID` lùi về `"336423739082347"` | `lib/env.ts:77-79` | định danh cứng | TENANT_SPECIFIC | cao | `TENANT_SETTING` — bỏ mặc định; thiếu thì báo "chưa cấu hình" như Pancake. Tổ chức thứ hai quên biến sẽ đọc BM của VNX nếu token có quyền |
| 49 | Tỷ giá USD→VND mặc định 25.500 | `lib/env.ts:84-86` | bản địa hoá | GENERIC | thấp | `TENANT_SETTING` |
| 50 | Quy kết ĐƠN → marketer bằng ảnh chụp phân công FANPAGE (`order_attributions`, cổng bằng chứng) | `lib/constants/fanpage-attribution.ts:55-170`, `lib/attribution/fanpage-evidence.ts:20-33`, `db/schema.ts:3904-4014` | marketing | INDUSTRY_PACK | cao | `MODULE_FEATURE` ("quy kết theo trang bán") |
| 51 | Quy kết TIỀN QC → marketer: ghép tay → bí danh trong tên chiến dịch → tài khoản QC của marketer | `lib/integrations/facebook/mapping.ts:40-59`, `lib/constants/marketer-attribution.ts:98-125` | marketing | TENANT_SPECIFIC | vừa | `TENANT_SETTING` (quy ước đặt tên chiến dịch là của VNX) |
| 52 | Luật "tổng đơn của marketer + Chưa gán = số đơn XÁC NHẬN PANCAKE trong kỳ" | AGENTS.md §3.9, `lib/queries/order-marketer.ts` | marketing | CONNECTOR | vừa | `KEEP_AS_IS` → `CONNECTOR_ADAPTER` ("đơn đã chốt" theo nguồn đơn) |
| 53 | Định dạng mã hàng `[A-Z]{1,2}\d{3}` (Q002, X001) dò trong tên chiến dịch / utm / tên tab sheet / SQL | `lib/constants/landing.ts:270,317-320`, `lib/landing/sheet.ts:212,377,389`, `lib/queries/landing.ts:75`, `lib/integrations/facebook/match.ts:8` | định danh cứng | TENANT_SPECIFIC | vừa | `TENANT_SETTING` (mẫu mã hàng của tổ chức) |
| 54 | Ngưỡng cảnh báo độ phủ quy kết 70% | `lib/constants/marketer-attribution.ts:197` | hằng số ngưỡng | GENERIC | thấp | `TENANT_SETTING` |
| 55 | Luật quyết định QC: tăng khi ≥ 1,3× hoà vốn, cắt khi < 0,8×, GTC thấp < 65%, tối thiểu 10 đơn kết thúc | `lib/constants/ads-decision.ts:12-42` | hằng số ngưỡng | INDUSTRY_PACK | vừa | `TENANT_SETTING` (căng với AGENTS §38 "không hard-code ngưỡng đạt/không đạt") |
| 56 | Ngân sách ngày tối thiểu 50.000đ khi ghi QC | `lib/constants/ads-write.ts:84` | hằng số ngưỡng | CONNECTOR | thấp | `CONNECTOR_ADAPTER` (trần của Meta theo tiền tệ tài khoản) |
| 57 | Học ngưỡng thanh toán QC, bước tối thiểu 100.000đ | `lib/integrations/facebook/billing.ts:15` | hằng số ngưỡng | CONNECTOR | thấp | `CONNECTOR_ADAPTER` |
| 58 | Nhãn `account_status` / `disable_reason` của tài khoản QC Facebook | `lib/constants/alerts.ts:103-130` | trạng thái cứng | CONNECTOR | thấp | `CONNECTOR_ADAPTER` |
| 59 | Vòng mẫu QC: chi tối thiểu 50.000đ, loại mockup theo phân vị, đăng 6:00, danh mục hàng thời trang (Đầm/váy, Áo kiểu, Set bộ…) | `lib/constants/creative-loop.ts:232,1112,1321`, `lib/creative/design.ts:184`, `lib/creative/dna.ts:50` | thời trang | INDUSTRY_PACK | vừa | `MODULE_FEATURE` + `INDUSTRY_PACK` (danh mục) |
| 60 | Landing: 1 sản phẩm = 499.000 + ship 25.000; gói ≥ 2 free ship (luật free ship CỨNG trong hàm, không trong cấu hình) | `lib/constants/landing.ts:64-69`, `lib/landing/sheet.ts:25`, `app/(dashboard)/landing/landing-config.tsx:78` | hằng số ngưỡng | TENANT_SPECIFIC | vừa | `TENANT_SETTING` (giá, phí đã ở `landing.config`; thêm ngưỡng free ship) |
| 61 | Landing tách "Size XL, Màu Đỏ Đô" và gói "1 Sản phẩm 499k" | `lib/constants/landing.ts:302-320` | thời trang | INDUSTRY_PACK | thấp | `INDUSTRY_PACK` |
| 62 | Giá báo MKT hiệu lực từ `"2026-09-01"` | `lib/constants/marketer-price.ts:41-45` | lương/hoa hồng | TENANT_SPECIFIC | vừa | `TENANT_SETTING` (mốc chuyển đổi của riêng VNX) |
| 63 | Mốc lịch sử `POST_LINK_SHIPPED_AT = 2026-09-09` | `lib/integrations/facebook/ads-index.ts:80` | khác | TENANT_SPECIFIC | thấp | `KEEP_AS_IS` — tổ chức mới có toàn bộ dữ liệu sau mốc nên vô hại |
| 64 | Chú thích / ví dụ mang ID thật: page `757928024065008`, TK QC `968797992379957` | `lib/attribution/fanpage-evidence.ts:30`, `scripts/seed-employees.ts:3` | định danh cứng | TENANT_SPECIFIC | thấp | `KEEP_AS_IS` (chỉ là chú thích, không chạy) |

### 2.4. Lợi nhuận, chi phí, quyết định hàng hoá

| # | Mục | Vị trí (tệp:dòng) | Loại | Phân loại | Mức gắn chặt | Chiến lược tách đề xuất |
|---|---|---|---|---|---|---|
| 65 | Giả định lợi nhuận mặc định: ship 17.000, đóng gói 5.000, NV vận đơn 2.000 / 10.000 mỗi đơn cứu, cố định 5 triệu/tháng, hoàn 45% (GTC 55% "mức hàng mới phải đạt"), 50 / 10 đơn kết thúc, rủi ro tồn 10%, thuế 1,5%, phí ngoại tệ 1,1% | `lib/constants/profit.ts:109-127` | hằng số ngưỡng | TENANT_SPECIFIC | vừa | `TENANT_SETTING` (đã là `profit.assumptions`; mặc định của tổ chức mới phải là "chưa khai", không phải số VNX) |
| 66 | Cước dự phòng khi thiếu dữ liệu 17.000 / 34.000 | `lib/constants/profit.ts:130-131` | hằng số ngưỡng | TENANT_SPECIFIC | vừa | `TENANT_SETTING` |
| 67 | Thang bậc tỷ lệ GTC ước tính (ghi đè → đo từng đơn → lịch sử 90 ngày → giả định), `MAX_BORROWED_SHARE 0,5` | `lib/constants/delivery-rate.ts:121,388-442` | công thức KPI | INDUSTRY_PACK | vừa | `KEEP_AS_IS` → `INDUSTRY_PACK` (chỉ có nghĩa khi có hoàn COD) |
| 68 | `expenseCategoryEnum` (ADS, SHIPPING, RETURN_FEE, PACKAGING, PURCHASE…) | `db/schema.ts:51` | khác | INDUSTRY_PACK | cao | `KEEP_AS_IS` (enum CSDL) |
| 69 | Sổ thẩm quyền chi phí: QC ← tài khoản QC, giá vốn ← phiếu kho, cước/phí hoàn ← vận đơn / bảng kê ĐVVC | `lib/constants/cost-sources.ts:33-113`, `lib/constants/cost-authority.ts:27-240` | công thức KPI | INDUSTRY_PACK | cao | `KEEP_AS_IS` → `INDUSTRY_PACK` (nguồn thẩm quyền là cấu hình của gói) |
| 70 | "Đáng nhân bản" mẫu: ≥ 10 món giao, GTC ≥ 70%, biên đóng góp ≥ 25%, QC ≤ 30%, tồn 7–90 ngày; "đáng lo" hoàn ≥ 40%, GTC < 50%, tồn > 120 ngày | `lib/constants/product-verdict.ts:38-59` | hằng số ngưỡng | INDUSTRY_PACK | vừa | `TENANT_SETTING` (căng với AGENTS §38) |
| 71 | Quyết định tồn kho / hàng chậm: lịch sử ≥ 14 ngày, cổng 80/80/50%, mẫu ≥ 5 / 20; chết 60 ngày, dư 120, chậm 60, lành mạnh 45 | `lib/constants/inventory-decision.ts:74-92`, `lib/constants/slow-moving.ts:7-18` | hằng số ngưỡng | GENERIC | thấp | `TENANT_SETTING` (`inventory.slowMoving` đã có) |
| 72 | Kế hoạch đặt sản xuất: MOQ của XƯỞNG, lead time, ngày phủ | `lib/constants/planning.ts:1-16,160-187,274` | thời trang | INDUSTRY_PACK | thấp | `TENANT_SETTING` (đã là `inventory.planning`) + `INDUSTRY_PACK` (khái niệm xưởng) |

### 2.5. Lương, hoa hồng

| # | Mục | Vị trí (tệp:dòng) | Loại | Phân loại | Mức gắn chặt | Chiến lược tách đề xuất |
|---|---|---|---|---|---|---|
| 73 | Mô hình nhân sự trong `settings`: % lợi nhuận TỔNG shop, % lợi nhuận CÁ NHÂN, tài khoản QC (`accountIds`), bí danh chiến dịch | `lib/constants/payroll.ts:4-44` | lương/hoa hồng | TENANT_SPECIFIC | cao | `KEEP_AS_IS` → `MODULE_FEATURE` ("chia lợi nhuận cho marketer") |
| 74 | Cơ sở tính lương `profit1 / profit2 / cash / nominal` (giá trị đã lưu trong `payroll_periods.basis`) | `lib/constants/payroll.ts:99-183` | lương/hoa hồng | TENANT_SPECIFIC | cao | `KEEP_AS_IS` (giá trị lưu trữ, kỳ đã chốt bất biến — AGENTS §21) |
| 75 | Chia % lợi nhuận theo mã: chủ mã / người chạy cùng (`ownerSharePct`, `crossPct`) | `lib/constants/payroll.ts:185-205` | lương/hoa hồng | TENANT_SPECIFIC | vừa | `MODULE_FEATURE` |
| 76 | `PAYROLL_CALC_VERSION = 5`: giá vốn phía MKT dùng giá báo MKT từ 01/09/2026, tiền phạt xưởng cộng cho MKT phụ trách mã | `lib/constants/payroll.ts:54-69` | lương/hoa hồng | TENANT_SPECIFIC | cao | `KEEP_AS_IS` (phiên bản công thức của kỳ đã chốt) |
| 77 | Danh sách phòng ban CỦA BẢNG LƯƠNG (Marketing, Sale / CSKH, Kho / Đóng gói…) — danh sách thứ hai, lệch `DEPARTMENT_CODES` | `lib/constants/payroll.ts:83` | vai trò | TENANT_SPECIFIC | thấp | `TENANT_SETTING` (và dẫn xuất từ sổ phòng ban) |
| 78 | Lương tự động: chốt ngày 01, trả ngày 15, nhắc duyệt ngày 13, bắt đầu 09:00 VN, xác nhận 48 giờ, cơ sở `profit1` | `lib/constants/payroll-autopilot.ts:22-46,79-82` | lương/hoa hồng | TENANT_SPECIFIC | vừa | `TENANT_SETTING` |
| 79 | Khấu trừ luật định PIT · BHXH · BHYT · BHTN | `lib/constants/payroll-statutory.ts:30-75` | bản địa hoá | INDUSTRY_PACK | vừa | `INDUSTRY_PACK` (gói "pháp lý Việt Nam") |
| 80 | Ngân hàng nhận lương theo BIN NAPAS / VietQR | `lib/constants/vn-banks.ts:15-61` | bản địa hoá | INDUSTRY_PACK | thấp | `INDUSTRY_PACK` (gói Việt Nam) |
| 81 | Cơ sở "lợi nhuận trước thù lao biến đổi" và luật từng thành phần chi phí | `lib/constants/compensation-profit.ts:55-151` | lương/hoa hồng | GENERIC | vừa | `KEEP_AS_IS` (luật chung đúng cho mọi tổ chức trả theo lợi nhuận) |

### 2.6. Tổ chức, vai trò, công việc, KPI

| # | Mục | Vị trí (tệp:dòng) | Loại | Phân loại | Mức gắn chặt | Chiến lược tách đề xuất |
|---|---|---|---|---|---|---|
| 82 | `roleEnum` 8 vai trò hệ thống (ADMIN, MANAGER, LEADER, ACCOUNTANT, WAREHOUSE, CS, MARKETING, VIEWER) | `db/schema.ts:14`, `lib/constants/roles.ts:4-26` | vai trò | INDUSTRY_PACK | cao | `KEEP_AS_IS` (enum CSDL; tổ chức khác dùng vai trò tuỳ chỉnh `access_roles`) |
| 83 | Mẫu quyền mặc định theo vai trò | `lib/auth/permissions.ts:253-297` | vai trò | GENERIC | vừa | `TENANT_SETTING` (đã có `auth.rolePermissions`) |
| 84 | 8 phòng ban cố định (MANAGEMENT, MARKETING, SALES, LOGISTICS, WAREHOUSE, PRODUCTION, FINANCE, HR), nhóm case → phòng, vai trò → phòng | `lib/constants/departments.ts:26-52,88-127` | vai trò | INDUSTRY_PACK | cao | `KEEP_AS_IS` (khoá phòng đi vào `work.ownership`, `metric_targets`, thẻ điểm) |
| 85 | Luật sở hữu việc mặc định (nguồn/loại → phòng) | `lib/constants/work-ownership.ts:38-124` | vai trò | GENERIC | thấp | `TENANT_SETTING` (đã có `work.ownership`) |
| 86 | Hạn xử lý 23 loại cảnh báo (`CASE_SLA_HOURS`: đơn mới 12h, CSKH 4h, COD quá hạn 168h, `VTP_ORDER_LIST_DUE` 8h…) | `lib/constants/action-queue.ts:508-538` | hằng số ngưỡng | INDUSTRY_PACK | thấp | `TENANT_SETTING` (đã có `work.sla`) |
| 87 | SLA care: phản hồi đầu 2h, đóng 24h, hiện "đã xử lý" 7 ngày; SLA nút thắt fulfillment; cửa sổ leo thang CSKH 72h | `lib/constants/care.ts:212-219`, `lib/constants/fulfillment-bottleneck.ts:84`, `lib/constants/cs.ts:67` | hằng số ngưỡng | INDUSTRY_PACK | thấp | `TENANT_SETTING` |
| 88 | Cửa sổ nghi trùng đơn 48h / ứng viên trùng 24h, ngưỡng điểm trùng 4 | `lib/constants/order-duplicate.ts:139`, `lib/constants/fanpage-attribution.ts:70,133` | hằng số ngưỡng | GENERIC | thấp | `TENANT_SETTING` (đã có `orders.duplicate-rule`) |
| 89 | Ngưỡng cảnh báo mặc định (dư nợ QC 80%, khách hoàn ≥ 2 đơn & ≥ 40%, chờ xử lý 24h, treo 4 ngày…) và 20 cờ bật mặc định | `lib/constants/alerts.ts:44-62` | hằng số ngưỡng | INDUSTRY_PACK | thấp | `TENANT_SETTING` (đã là `alerts.config`); cờ nguồn-riêng phải phụ thuộc module |
| 90 | Sổ module điều hướng: `/landing`, `/chatbot`, `/outreach`, `/marketing/fanpages`, `/import-vtp`, `/cod`, `/inventory/workshop`, `/models`, `/production`, `/tech`… | `lib/constants/department-modules.ts:58-388` | khác | INDUSTRY_PACK | vừa | `MODULE_FEATURE` (sổ module = khoá bật/tắt của nền tảng) |
| 91 | Sổ chỉ số (khoá lưu trong `performance_snapshots.metric_key`, không đổi được) | `lib/constants/metric-catalog.ts:70-325` | công thức KPI | INDUSTRY_PACK | cao | `KEEP_AS_IS` (AGENTS §37) → `INDUSTRY_PACK` thêm chỉ số theo gói, không đổi khoá cũ |
| 92 | Thẻ điểm từng phòng | `lib/constants/department-performance.ts:40-156` | công thức KPI | INDUSTRY_PACK | vừa | `INDUSTRY_PACK` |
| 93 | Mẫu OKR kèm đích gợi ý (GTC 85%, đóng trong hạn 90%, tỷ lệ hoàn 12%…) | `lib/constants/okr-templates.ts:44-117` | công thức KPI | INDUSTRY_PACK | thấp | `INDUSTRY_PACK` (mẫu không tự kích hoạt — AGENTS §23) |
| 94 | Mẫu BSC mặc định theo phòng | `lib/constants/bsc.ts:39` | công thức KPI | INDUSTRY_PACK | thấp | `INDUSTRY_PACK` |
| 95 | `CS_BOT_ASSIGNEES = ["Bot ERP"]` — tên job trong ô phụ trách | `lib/constants/cs.ts:69`, `lib/cs/failed-delivery.ts:200,241` | định danh cứng | GENERIC | thấp | `KEEP_AS_IS` (tên máy, giống nhau ở mọi tổ chức) |
| 96 | Mốc vá lịch sử: `REOPEN_GUARD_LIVE_AT` 18/09/2026, `LEDGER_LIVE_AT` 20/09/2026 | `lib/constants/care-reopen-class.ts:96`, `lib/constants/agent-run-ledger.ts:44` | khác | TENANT_SPECIFIC | thấp | `KEEP_AS_IS` — tổ chức mới chỉ có dữ liệu sau mốc nên phân loại "di sản" rỗng |
| 97 | Sổ tự động hoá theo phòng mang số đo production VNX (`measuredAt` 23–24/09/2026) | `lib/constants/department-ai.ts:140-491` | khác | TENANT_SPECIFIC | thấp | `KEEP_AS_IS` (tài liệu sống của VNX) → tách thành dữ liệu của tổ chức vận hành |

### 2.7. Thời trang (size / màu / mẫu / xưởng)

| # | Mục | Vị trí (tệp:dòng) | Loại | Phân loại | Mức gắn chặt | Chiến lược tách đề xuất |
|---|---|---|---|---|---|---|
| 98 | Cột `product_variants.color`, `product_variants.size` | `db/schema.ts:1144-1145` | thời trang | INDUSTRY_PACK | cao | `KEEP_AS_IS` (cột CSDL; tổ chức khác để trống, dùng `attributes`) |
| 99 | Thứ tự size `XXS … 5XL, FREESIZE` | `lib/constants/production.ts:1-11` | thời trang | INDUSTRY_PACK | thấp | `INDUSTRY_PACK` |
| 100 | Loại case CSKH `EXCHANGE_SIZE`, `EXCHANGE_COLOR`, `SIZE_ADVICE` | `lib/constants/cs.ts:3-20` | thời trang | INDUSTRY_PACK | vừa | `INDUSTRY_PACK` |
| 101 | Lý do hoàn `SIZE_TIGHT(_TOP/_BOTTOM)`, `SIZE_LOOSE(...)` | `lib/constants/return-reason.ts:58-63` | thời trang | INDUSTRY_PACK | vừa | `INDUSTRY_PACK` |
| 102 | Vòng đời MẪU (test → triển vọng → thắng → lên mã), tín hiệu mẫu, phán quyết mẫu | `lib/constants/model-lifecycle.ts:1-284`, `lib/constants/model-signal.ts:1-334` | thời trang | INDUSTRY_PACK | cao | `MODULE_FEATURE` ("Mẫu & thử thị trường") |
| 103 | Topic sản xuất (hỏi giá xưởng → giá thành → mẫu thử → duyệt → lệnh SX), mở sớm cho mẫu triển vọng | `lib/constants/production-os.ts:1-60`, `lib/constants/early-topic.ts:1-60` | thời trang | INDUSTRY_PACK | cao | `MODULE_FEATURE` ("Sản xuất gia công") |
| 104 | Mã tạm `TEST-YYMMDD-NN` cho mẫu chưa có mã | `lib/constants/provisional-model.ts:18-26` | thời trang | TENANT_SPECIFIC | thấp | `TENANT_SETTING` (tiền tố mã tạm) |
| 105 | Sổ đặt xưởng: vải shop mua / xưởng lo, lô, trả hàng | `lib/constants/workshop-ledger.ts:28-48` | thời trang | INDUSTRY_PACK | vừa | `MODULE_FEATURE` |
| 106 | Thiếu hàng giao đơn: bảng màu × size gửi Lark, đề xuất đặt xưởng | `lib/constants/stock-shortage.ts:1-67` | thời trang | INDUSTRY_PACK | vừa | `MODULE_FEATURE` |

### 2.8. Định danh, thương hiệu, hạ tầng

| # | Mục | Vị trí (tệp:dòng) | Loại | Phân loại | Mức gắn chặt | Chiến lược tách đề xuất |
|---|---|---|---|---|---|---|
| 107 | Tiêu đề / mô tả ứng dụng "VNXcommerce ERP … shop thời trang … Pancake POS & Viettel Post" | `app/layout.tsx:16-17` | định danh cứng | TENANT_SPECIFIC | thấp | `TENANT_SETTING` (thương hiệu tổ chức) |
| 108 | Logo & chữ "VNXcommerce", nhãn topnav, chân trang đăng nhập | `components/brand.tsx:4-40`, `components/app-topnav.tsx:106`, `app/login/page.tsx:58` | định danh cứng | TENANT_SPECIFIC | thấp | `TENANT_SETTING` (đăng nhập đứng TRƯỚC khi biết tổ chức ⇒ chữ nền tảng) |
| 109 | Tin thử Telegram / Lark "VNXcommerce ERP" | `lib/actions/alerts.ts:126,134,357`, `scripts/set-setting.ts:23` | định danh cứng | TENANT_SPECIFIC | thấp | `TENANT_SETTING` |
| 110 | Lời nhắc hệ thống AI: "VNXcommerce ERP (shop bán quần áo, giao qua Viettel Post, thu COD)", AI CTO, agent Tech AI | `lib/ai/prompt.ts:7`, `lib/agents/cto.ts:66`, `lib/constants/agent-system-prompt.ts:33,38,56` | định danh cứng | TENANT_SPECIFIC | vừa | `TENANT_SETTING` (hồ sơ ngành/kênh của tổ chức chèn vào lời nhắc) |
| 111 | Mẫu tin khách hàng: tên shop mặc định **"Hải An Fashion"**, "50k/váy", "giữ size", mẫu xem trước "chị Lan · Đầm Q002" | `lib/constants/outreach.ts:52-85`, `lib/actions/outreach.ts:36-37,105` | định danh cứng | TENANT_SPECIFIC | thấp | `TENANT_SETTING` (đã là `outreach.config`; mặc định phải trống) |
| 112 | Tên miền `erp.vnxcommerce.com` làm mặc định (compose, workflow, cài VPS, ô nhập mẫu) | `docker-compose.prod.yml:31,95`, `.github/workflows/deploy-vps.yml:190,314`, `.github/workflows/agent-run.yml:152,272`, `scripts/install-vps.sh:87,214`, `app/(dashboard)/alerts/marketing-digest-form.tsx:119` | định danh cứng | TENANT_SPECIFIC | vừa | `KEEP_AS_IS` (Phase 1 vẫn một triển khai, một tên miền) → cấu hình nền tảng |
| 113 | Email mặc định `admin@vnxcommerce.com`, `qa-session-test@vnxcommerce.com` | `.github/workflows/deploy-vps.yml:198`, `scripts/install-vps.sh:98`, `.github/workflows/ops-vps.yml:709`, `scripts/session-revocation-e2e.ts:36` | định danh cứng | TENANT_SPECIFIC | thấp | `KEEP_AS_IS` → cấu hình nền tảng |
| 114 | Phòng Tech AI / AI CTO / GitHub App `erp-agent-vnx`, `User-Agent: vnxcommerce-erp` — vận hành CHÍNH kho mã này | `lib/agents/*`, `lib/tech/*`, `lib/integrations/github/client.ts:171`, `lib/integrations/github/dispatch.ts:155`, `.github/workflows/agent-open-pr.yml:3` | khác | TENANT_SPECIFIC | vừa | `MODULE_FEATURE` — chỉ bật cho tổ chức vận hành nền tảng, KHÔNG bao giờ cho khách |
| 115 | Smoke deploy nhận diện trang bằng chữ "VNXcommerce" | `scripts/smoke.ts:287` | định danh cứng | TENANT_SPECIFIC | thấp | `KEEP_AS_IS` → đổi khi đổi thương hiệu (smoke đỏ nếu quên) |
| 116 | Dữ liệu demo "Glovico Fashion" | `scripts/seed-demo.ts:192` | định danh cứng | TENANT_SPECIFIC | thấp | `KEEP_AS_IS` (chỉ dữ liệu demo) |

### 2.9. Bản địa hoá (giờ, tiền, ngôn ngữ, định dạng Việt Nam)

| # | Mục | Vị trí (tệp:dòng) | Loại | Phân loại | Mức gắn chặt | Chiến lược tách đề xuất |
|---|---|---|---|---|---|---|
| 117 | Múi giờ `Asia/Ho_Chi_Minh`: 66 lần / 33 tệp (kể cả SQL `at time zone 'Asia/Ho_Chi_Minh'`) | `lib/format.ts:1`, `lib/queries/cost-allocation.ts:17`, `lib/queries/control-tower.ts:166-277`, `lib/queries/conversion-funnel.ts:477-479`, `lib/integrations/facebook/sync.ts:16`, `scripts/scheduler.mjs:252` | bản địa hoá | GENERIC | cao | `KEEP_AS_IS` (Phase 1 mọi tổ chức ở VN) → `TENANT_SETTING` (một hàm `orgTimeZone()`) |
| 118 | Độ lệch `+07:00` gõ cứng khi dựng mốc ngày: 36 lần / 23 tệp | `lib/constants/payroll-autopilot.ts:46,82`, `lib/marketing/digest.ts:80-86`, `lib/integrations/bank/statement.ts:67`, `lib/integrations/bank/sepay.ts:165`, `lib/integrations/http.ts:212`, `lib/constants/landing.ts:195-204`, `lib/actions/bank.ts:290` | bản địa hoá | GENERIC | cao | `KEEP_AS_IS` → `TENANT_SETTING` (lỗi âm thầm nếu tổ chức ở múi khác: ngày lệch ở hai đầu kỳ) |
| 119 | Tiền = số nguyên VND, `formatVND` in "₫" (222 lần / 82 tệp), `Intl` `vi-VN` (199 lần / 87 tệp) | `lib/format.ts:68-91` | bản địa hoá | GENERIC | cao | `KEEP_AS_IS` (AGENTS §1; không có trường tiền tệ trong CSDL) |
| 120 | Giao diện tiếng Việt cứng, `<html lang="vi">`, không có thư viện i18n | `app/layout.tsx:30`, `package.json` | bản địa hoá | GENERIC | cao | `KEEP_AS_IS` (AGENTS §1 bắt buộc tiếng Việt) |
| 121 | Chuẩn hoá SĐT Việt Nam (9 số cuối, `+84` → `0`) | `lib/integrations/http.ts:223`, `lib/constants/landing.ts:172`, `lib/constants/return-match.ts:145`, `lib/queries/preship-risk.ts:38` | bản địa hoá | INDUSTRY_PACK | vừa | `INDUSTRY_PACK` (gói Việt Nam) |
| 122 | Vùng / miền Việt Nam (Bắc/Trung/Nam, 6 vùng kinh tế) | `lib/constants/vn-regions.ts:33-146` | bản địa hoá | INDUSTRY_PACK | thấp | `INDUSTRY_PACK` |
| 123 | SePay (Open Banking VN), mã danh mục sao kê → nhóm kế toán | `lib/env.ts:154-173`, `lib/integrations/bank/statement.ts:22-40` | khác | CONNECTOR | vừa | `CONNECTOR_ADAPTER` |
| 124 | Lark / Telegram làm kênh cảnh báo (webhook trong `alerts.config`) | `lib/alerts/lark.ts`, `lib/alerts/telegram.ts`, `lib/constants/alerts.ts:20-53` | khác | CONNECTOR | thấp | `CONNECTOR_ADAPTER` (kênh thông báo); cấu hình đã ở `settings` |
| 125 | Google Sheet chỉ qua CSV công khai (landing) | `lib/landing/sheet.ts`, AGENTS.md §5 | khác | CONNECTOR | thấp | `CONNECTOR_ADAPTER` |

## 3. Không được đụng trong Phase 1

Những luật dưới đây là **bất khả xâm phạm** theo `AGENTS.md` (§0, §3, §8) và bị khoá bằng kiểm thử
chạy trong `npm test` — workflow deploy dừng nếu chúng đỏ. **Trong nền tảng đích, chúng là luật của
GÓI NGÀNH "TMĐT COD Việt Nam" và của TỔ CHỨC VNX, KHÔNG phải luật của lõi.** Nhưng Phase 1 **không
di dời, không tham số hoá, không đổi tên** chúng: đổi chỗ ở của một luật là đổi đường đi của mọi con
số tiền, và contract test chỉ chứng minh luật đúng ở chỗ nó đang đứng.

| Luật | Nơi ở hôm nay | Khoá bằng | Trong nền tảng đích |
|---|---|---|---|
| `ORDER_OUTCOME` — nguồn chân lý DUY NHẤT của kết quả đơn (mục 2, 3, 10, 11) | `lib/queries/return-rate.ts:225`, đặc tả `docs/business-rules/ORDER_OUTCOME.md` | `tests/contract-order-outcome.test.ts`, `tests/canonical-outcome.test.ts` | Luật của gói ngành; lõi chỉ biết "kết cục đơn" là một enum |
| Thứ tự căn cứ: chứng từ ĐVVC (501/503/504/101/107/201 + `IS_RETURNING`) trước, rồi tiền thực thu | AGENTS §3.2, `lib/queries/return-rate.ts:48-75` | contract test | Adapter ĐVVC cung cấp "kết cục chuẩn"; gói ngành quyết thứ tự |
| `RETURN_RULE` 50K / 100K; hai giá trị hoàn luôn gộp | `lib/constants/returns.ts:2-21`, AGENTS §3.3–3.4 | contract test | Tham số của gói ngành, tổ chức ghi đè — CHỈ khi chủ sở hữu tổ chức yêu cầu (AGENTS §7) |
| "Không bao giờ coi `shipments.stage = 'DELIVERED'` / Pancake 'Đã nhận' là giao thành công" | AGENTS §3.2, `return-rate.ts:289-297` | contract test | Luật của gói; lõi không có khái niệm "Pancake" |
| `NULL` là CHƯA BIẾT, không phải 0 | AGENTS §0.3, §42, `lib/format.ts` | `tests/contract-order-outcome.test.ts` + kiểm thử định dạng | **Thuộc LÕI** — giữ nguyên cho mọi tổ chức |
| Hàng hoàn không tự vào tồn; sổ kho trừ theo `SHIPMENT_LEFT_WAREHOUSE` | AGENTS §3.10, `lib/queries/stock.ts`, `return-rate.ts:504` | kiểm thử sổ kho trong `tests/sync-fixtures.test.ts` | Nguyên tắc "hoàn không tự vào tồn" thuộc lõi; "rời kho = mốc ĐVVC" thuộc gói |
| Vận đơn chiều về là dòng riêng; regex lười `legBaseCode` | AGENTS §3.7, `statement.ts:246` | kiểm thử nhập VTP | Adapter Viettel Post |
| `expandSheetRange()` bắt buộc khi đọc Excel VTP | AGENTS §3.8 | kiểm thử nhập VTP | Adapter Viettel Post |
| Phân bổ chi phí, một nguồn cho một khoản chi, sổ thẩm quyền | AGENTS §3.14–3.18 | `tests/cost-allocation.test.ts` (quét mã nguồn) | Bộ máy thuộc lõi; bảng thẩm quyền mặc định thuộc gói |
| Kỳ review / lương đã chốt là bất biến; `PAYROLL_CALC_VERSION` | AGENTS §3.21, `lib/constants/payroll.ts:69` | các `tests/payroll-*.test.ts` | Lõi (bất biến kỳ chốt); công thức chia lợi nhuận là module của VNX |
| Khoá chỉ số không đổi; `METRIC_SOURCE_VERSION` | AGENTS §37, §40 | `tests/metrics-contract.test.ts`, `tests/metric-shape-consistency.test.ts` | Lõi giữ sổ; gói thêm chỉ số |
| Ba chiều quyền truy cập, chức danh không sinh quyền | AGENTS §28–31 | `tests/access-model.test.ts` | **Thuộc LÕI** |
| Luật care: không mở ca mới cho sự cố cũ, không đóng ca đã đóng hai lần | AGENTS §59, §61 | `tests/care-reopen.test.ts` | Gói ngành (care vận đơn COD) |

Quy tắc chung cho Phase 1: **một thay đổi nền tảng không được làm một assertion nào trong các tệp
trên đổi giá trị kỳ vọng.** Nếu việc tách ra cần đổi một con số kỳ vọng thì việc tách đó sai.

## 4. Giả định một-công-ty trong hạ tầng

Với mô hình SILO (`target-architecture.md` §2), mọi thứ nằm TRONG CSDL (kể cả bảng `settings`,
`db/schema.ts:4220`) tự động thành của từng tổ chức. Chỗ gãy là mọi thứ nằm NGOÀI CSDL: biến môi
trường, bộ nhớ tiến trình, tuyến webhook, lịch chạy.

| # | Giả định | Vị trí | Hậu quả với tổ chức thứ hai |
|---|---|---|---|
| H-01 | Mọi credential tích hợp là biến môi trường toàn cục: Pancake (key, shop, token trang, secret webhook), Facebook (token, BM, phiên bản, tỷ giá), Viettel Post (key, user, mật khẩu, secret webhook), SePay (secret, API key, token), OpenAI/Anthropic | `lib/env.ts:48-173`, `integrationStatus()` `lib/env.ts:192-204` | Một tiến trình chỉ nói chuyện được với MỘT shop Pancake, MỘT BM Facebook, MỘT tài khoản VTP |
| H-02 | `FACEBOOK_BUSINESS_ID` có mặc định là BM thật của VNX | `lib/env.ts:77-79` | Tổ chức quên khai sẽ đồng bộ nhầm tài khoản QC của VNX (nếu token đủ quyền) — rò chéo, không báo lỗi |
| H-03 | Client tích hợp là singleton mức mô-đun, credential đóng băng ở lần tạo đầu | `lib/integrations/pancake/client.ts:266`, `lib/integrations/pancake/pages.ts:227`, `lib/integrations/viettelpost/client.ts:337`, `lib/integrations/facebook/client.ts:446` | Tổ chức B gọi được client của A |
| H-04 | Bộ đếm nhịp gọi API (`lastCallAt`) toàn cục | `lib/integrations/pancake/client.ts:29`, `lib/integrations/viettelpost/client.ts:9`, `lib/integrations/facebook/client.ts:51` | Tổ chức này làm chậm tổ chức kia; không rò dữ liệu |
| H-05 | Tuyến webhook một secret, không mang danh tính tổ chức: `/api/webhooks/pancake/[secret]`, `/api/webhooks/viettelpost`, `/api/webhooks/vtp-statement`, `/api/webhooks/sepay` | `app/api/webhooks/pancake/[secret]/[[...event]]/route.ts:15`, `app/api/webhooks/viettelpost/route.ts:56`, `app/api/webhooks/vtp-statement/route.ts:76`, `app/api/webhooks/sepay/route.ts:62` | Gói tin tới không biết ghi vào CSDL nào |
| H-06 | `/api/sync/[job]` xác thực bằng MỘT `CRON_SECRET`; scheduler gọi MỘT `BASE` | `app/api/sync/[job]/route.ts:16-21`, `scripts/scheduler.mjs:227-230` | Job không có tham số tổ chức |
| H-07 | Lịch job cố định, chạy cho "shop": 28 job định kỳ + 3 job định kỳ tuỳ chọn (Pancake mỗi 3 phút, VTP 10 phút, FB 60 phút, landing 1 phút…) + 6 job hằng ngày theo giờ VN (02:15, 03:00, 03:30, 04:00, 06:30, 08:30) | `scripts/scheduler.mjs:36-222` | Không bật/tắt được theo module; tổ chức không có Pancake vẫn chạy job Pancake mỗi 3 phút |
| H-08 | Khoá "job đang chạy" là `Map` theo TÊN job trong bộ nhớ | `lib/sync/runner.ts:32-34` | `pancake-orders` của A đang chạy ⇒ lượt của B bị bỏ qua "Job đang chạy" |
| H-09 | Bộ nhớ đệm `memo()` toàn cục, khoá KHÔNG có tổ chức — 132 lời gọi | `lib/cache.ts:70-99`; ví dụ `lib/auth/session.ts:137` (`auth:roleTemplates`), `lib/queries/dashboard.ts:315` (`getDashboardData:${period}`) | **Rò dữ liệu chéo**: tổ chức B nhận Tổng quan / mẫu quyền của A trong 60–300 giây |
| H-10 | Trạng thái điều tiết trong `globalThis` (lượt cảnh báo, bản tin chủ shop, thiếu hàng, sổ chờ hàng) và bus realtime SSE chung | `lib/alerts/rules.ts:1222`, `lib/alerts/owner-decision-digest.ts:63`, `lib/alerts/stock-shortage-digest.ts:46`, `lib/alerts/stock-wait-log.ts:23`, `lib/realtime/bus.ts:14` | Cảnh báo của B bị nuốt vì A vừa chạy; sự kiện realtime của A phát tới trình duyệt của B |
| H-11 | `APP_URL` một giá trị — đi vào link trong tin Lark/Telegram | `lib/env.ts:12-14`, `lib/actions/alerts.ts:134` | Chấp nhận được nếu chung tên miền; sai nếu mỗi tổ chức một tên miền |
| H-12 | Phiên đăng nhập JWT không có claim tổ chức; cookie `erp_session` một tên | `lib/auth/session.ts:63`, `lib/constants/session.ts:36` | Chưa biết người đăng nhập thuộc CSDL nào (đã nằm trong kế hoạch `target-architecture.md`) |
| H-13 | Quản trị viên đầu tiên từ `ADMIN_EMAIL` một giá trị | `lib/auth/bootstrap.ts:10` | Không tạo được admin cho tổ chức mới |
| H-14 | Cờ ghi QC `ADS_WRITE_ENABLED` / `ADS_WRITE_MODE` chỉ đọc từ biến môi trường, CỐ Ý không vào `settings` | `lib/env.ts:100-107` | Bật cho VNX là bật cho mọi tổ chức. Giữ nguyên là đúng (chốt an toàn), nhưng phải thêm vế theo tổ chức khi có tổ chức thứ hai |
| H-15 | Một CSDL `erp`, một Caddy một tên miền, một container bot chat một volume | `docker-compose.prod.yml:5-107`, `deploy/Caddyfile:2` | Hạ tầng một khách |
| H-16 | Container `app` KHÔNG đặt `TZ`; chỉ `chatbot` có `TZ: Asia/Ho_Chi_Minh`. Mã tự gắn múi giờ VN ở hơn 100 chỗ | `docker-compose.prod.yml:21-41,68` | Đúng cho VN nhờ gắn cứng; tổ chức ở múi khác sai ngày |
| H-17 | Sao lưu một CSDL | `scripts/erp-backup.sh`, `docker-compose.prod.yml:38` | Tổ chức mới không được sao lưu |
| H-18 | Nhân sự & cơ chế chia lợi nhuận là MỘT dòng JSON trong `settings` (`payroll.employees`) | `lib/constants/payroll.ts:44`, `scripts/seed-employees.ts` | Theo silo thì tự tách; nhưng script ops chỉ nhắm một CSDL |
| H-19 | Phòng Tech AI gắn MỘT kho GitHub (`ERP_GITHUB_REPO` / `GITHUB_REPOSITORY`) | `lib/integrations/github/client.ts:59-61`, `lib/integrations/github/agent-identity.ts:116` | Đúng — kho mã là của nền tảng; nhưng màn hình `/tech` không được lộ cho tổ chức khách |

## 5. Rủi ro khi tổ chức thứ hai (bán buôn, không Pancake / VTP) chạy cùng mã

Giả định: tổ chức B bán buôn, khách trả bằng chuyển khoản / công nợ, giao bằng xe nhà hoặc hãng khác,
không có Pancake, không có Viettel Post, có thể không chạy Facebook Ads.

| # | Màn hình / job | Điều sẽ xảy ra | Căn cứ |
|---|---|---|---|
| R-01 | **Đơn hàng** (`/orders`) và MỌI báo cáo dựa trên đơn | Trống. Đơn chỉ vào ERP qua đồng bộ / webhook Pancake; khoá chính là id Pancake; landing cũng chỉ đẩy đơn nháp VÀO Pancake. Không có đường tạo đơn gốc ERP | `db/schema.ts:1214`, `lib/sync/jobs.ts:257-311`, `lib/constants/landing.ts:60` |
| R-02 | **Kết quả đơn** (`ORDER_OUTCOME`) nếu B có vận đơn của hãng khác | Đơn **công nợ** (COD 0, trả trước 0) có vận đơn `DELIVERED` mà không có sự kiện VTP ⇒ tiền dùng để kết luận = 0 < 50K ⇒ **`RETURNED`**. Và đơn giá trị ≤ 100K thu đủ tiền ⇒ **`RETURNED` / `RETURNED_BY_RULE` ngay cả khi VTP báo 501 chiều đi**, vì nhánh ngưỡng tiền đứng trước nhánh 501. Tỷ lệ giao thành công, doanh thu GTC, lương, ROAS đều sai theo hướng "hoàn" | `lib/queries/return-rate.ts:247-251,273-277` |
| R-03 | Đơn không có dòng vận đơn | `o.stage` DELIVERED/PAID ⇒ `UNKNOWN`, khác ⇒ `NOT_SHIPPED`. Tỷ lệ GTC = `null` (đúng luật, nhưng mọi thẻ KPI hiện "—") | `lib/queries/return-rate.ts:289-297` |
| R-04 | **Sổ kho** (`/inventory`) | "Đã xuất" chỉ đếm theo mốc ĐVVC ⇒ không có vận đơn VTP thì tồn KHÔNG BAO GIỜ giảm (trừ phiếu ISSUE tay); "đã chốt chưa xuất" không bao giờ giải phóng ⇒ Khả dụng bán trôi âm dần | `lib/queries/return-rate.ts:504-505`, `lib/queries/stock.ts:62-93` |
| R-05 | **Báo cáo lợi nhuận danh nghĩa, Hiệu quả marketing theo ngày** | Tỷ lệ GTC ước tính rơi về bậc cuối = giả định hoàn 45% của VNX ⇒ doanh thu và lợi nhuận bị trừ 45% một khoản hoàn không tồn tại với bán buôn. Cước mặc định 17.000/đơn, đóng gói 5.000, thuế 1,5% cũng là số VNX | `lib/constants/profit.ts:109-131`, `lib/constants/delivery-rate.ts:388-442` |
| R-06 | **Đối soát COD** (`/cod`), **Nhập tệp VTP** (`/import-vtp`), **Vận đơn** (`/shipments`), **Hàng hoàn** (`/returns`, `/inventory/returns`), **Care** | Trống hoặc vô nghĩa; hàng đợi đối chiếu, độ tươi webhook ở trạng thái `UNKNOWN` | `lib/constants/vtp-reconcile-queue.ts`, `lib/queries/vtp-webhook-health.ts` |
| R-07 | **Cảnh báo** — `VTP_ORDER_LIST_DUE` bật mặc định | Ngày nào cũng một việc "chưa từng nhập tệp nào", hạn 8 giờ, vào hàng đợi `/work` và thẻ điểm "việc quá hạn" | `lib/constants/alerts.ts:62`, `lib/alerts/rules.ts:810-830`, `lib/constants/action-queue.ts:538` |
| R-08 | **Scheduler** | `pancake-orders` mỗi 3 phút, `vtp-tracking` 10 phút, `facebook-ads` 60 phút… thất bại "chưa cấu hình" ⇒ `sync_runs` đỏ liên tục ⇒ `tech-incident-watch` mở sự cố sau 3 lượt hỏng | `scripts/scheduler.mjs:36-43`, `lib/integrations/pancake/client.ts:38`, `lib/sync/jobs.ts:204` |
| R-09 | **Quảng cáo / Marketing / Fanpage / Vòng mẫu QC** | Không có FB ⇒ trống. Có FB nhưng không bán qua fanpage ⇒ 100% đơn "Chưa gán marketer", cảnh báo độ phủ < 70% thường trực | `lib/constants/marketer-attribution.ts:197`, `lib/constants/fanpage-attribution.ts:136-160` |
| R-10 | **Lương** (`/payroll`, lương tự động) | Cơ chế chia % lợi nhuận shop / cá nhân / theo mã cho marketer; không có hoa hồng bán buôn theo khách / theo công nợ thu được. Lương tự động chốt ngày 01, trả ngày 15 theo cơ sở `profit1` — lợi nhuận đã méo bởi R-02, R-05 | `lib/constants/payroll.ts:4-205`, `lib/constants/payroll-autopilot.ts:22-36` |
| R-11 | **CSKH** (`/cs`) | Máy sinh case từ thẻ / ghi chú / hội thoại Pancake ⇒ không có case tự động; bot nhắn giao hụt không chạy; loại case size/màu vô nghĩa | `lib/constants/cs.ts:3-20,237-321`, `lib/cs/failed-delivery.ts` |
| R-12 | **Gửi tin / Bot chat / Landing** | Không chạy (Pancake Pages, Meta 24h, Google Sheet → Pancake). Nếu bật, mẫu tin mặc định ký tên "Hải An Fashion" | `lib/constants/outreach.ts:61`, `docker-compose.prod.yml:55` |
| R-13 | **Mẫu / Sản xuất / Sổ đặt xưởng / Thiếu hàng màu × size** | Hiện trên thanh điều hướng dù không áp dụng; đề xuất "mở topic xưởng" | `lib/constants/department-modules.ts:218-262` |
| R-14 | **Rủi ro trước giao** | Điểm dựa trên lịch sử hoàn COD, "Pancake chặn", tỉnh hay hoàn — với bán buôn là nhiễu | `lib/constants/preship-risk.ts:99-196` |
| R-15 | **Trợ lý AI / bản tin** | Lời nhắc hệ thống nói "shop bán quần áo, giao qua Viettel Post, thu COD" ⇒ trả lời sai ngữ cảnh | `lib/ai/prompt.ts:7` |
| R-16 | **Thẻ điểm / OKR / BSC** | Chỉ số care, kiểm hàng hoàn, COD tồn đọng không có dữ liệu ⇒ `UNKNOWN` (đúng luật, nhưng thẻ điểm gần như trống); mẫu OKR gợi ý đích tỷ lệ hoàn 12%, GTC 85% | `lib/constants/metric-catalog.ts:141-251`, `lib/constants/okr-templates.ts:52-104` |
| R-17 | **Tổng quan** (`/`) | Toàn bộ khối logistics / COD / hoàn trống; khối doanh thu phụ thuộc R-01 | `lib/queries/dashboard.ts:315` |
| R-18 | **Rò chéo do hạ tầng** (không phải do thiếu dữ liệu) | Nếu H-09 / H-10 chưa xử lý: B thấy Tổng quan / mẫu quyền của A trong thời gian sống của bộ đệm | `lib/cache.ts:70-99` |

**Kết luận cho lộ trình:** với bán buôn, cái vỡ trước tiên không phải màn hình trống (trống là trung
thực) mà là R-02, R-04, R-05 — ba chỗ **in ra số sai trông như số thật**. Trước khi mở cho tổ chức
không dùng COD Việt Nam, ba chỗ này phải nằm sau cờ module / gói ngành, hoặc tổ chức đó chưa được bật
các báo cáo dựa trên `ORDER_OUTCOME`.
