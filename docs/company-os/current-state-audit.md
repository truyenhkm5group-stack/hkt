# Company OS — Audit trạng thái thật (25/09/2026)

> Đo trên `origin/main` @ `bb6b860d`, đọc mã nguồn, **không** đọc production. Sáu mảng audit chạy song
> song, mỗi dòng dưới đây có tệp:dòng làm chứng trong ghi chép gốc của phiên. Con số production (vd
> "độ phủ quy kết ~49–72%") là con số mã nguồn tự ghi lại trong chú thích, không phải đo lại hôm nay.
>
> Ký hiệu: **KEEP** giữ nguyên · **EXTEND** có nhưng thiếu · **CONSOLIDATE** có nhiều bản chồng nhau ·
> **BUILD** chưa có · **FIX** có nhưng sai / hở.

## Kết luận một đoạn

ERP **không** trống. Nửa sau của vòng đời — đơn, vận đơn, COD, hoàn, sổ kho, kế hoạch sản xuất, lệnh
đặt xưởng, sổ xưởng, lợi nhuận danh nghĩa/thực, quyết định quảng cáo, vòng creative AI, hàng đợi công
việc, Tech room — đều đã chạy trên production. Thứ **không** tồn tại là **trục nối**: không có một
thực thể "mẫu" mà mọi module cùng trỏ vào, không có vòng đời mẫu, không có sổ sự kiện bền, và nửa đầu
của sản xuất (topic hỏi giá → costing có phiên bản → sample → bản thiết kế đã duyệt) chưa có một bảng
nào. Mọi module hiện nối nhau bằng **so khớp chuỗi mã** (`products.custom_id` = `design_concepts.code`).

## 1. Danh tính mẫu · R&D · Creative · trang 360

| Capability | Existing | Route/API | DB | Status | Missing | Action |
|---|---|---|---|---|---|---|
| Sản phẩm gốc | có | `/products` | `products` (PK = uuid Pancake), `product_variants` | KEEP | — | Pancake là chủ; ERP không ghi đè |
| Mã mẫu ổn định | một phần | — | `products.custom_id` (chữ tự do, không UNIQUE); `design_concepts.code` `TK-YYMMDD-NN` | EXTEND | không có mã chung, không ràng buộc duy nhất | Sổ đăng ký mẫu (`product_models`) dùng lại mã chủ shop |
| Tra mã → sản phẩm | có | nhiều nơi | — | KEEP | — | dùng lại `resolveProductByCode` (`lib/queries/product-code.ts:165`) |
| Vòng đời mẫu + lịch sử | **không** | — | — | BUILD | trạng thái, lịch sử, máy trạng thái | xem hợp đồng |
| Phán quyết mẫu (WINNER/RISK/LOSER) | một phần | `/products/performance` | tính lúc đọc | EXTEND | không lưu, độ mịn biến thể | dùng lại, không viết bộ chấm thứ tư |
| Trang chi tiết sản phẩm | một phần | `/products/[id]` | kho, đơn, ghi chú | EXTEND | thiếu ads, creative, sản xuất, lợi nhuận, phán quyết, dòng thời gian | mở rộng thành trang 360 |
| Dòng thời gian thực thể | chỉ ĐƠN | `/orders/[id]` | đọc gộp 5 nguồn | EXTEND | không có dòng thời gian MẪU | thêm `getModelTimeline` |
| Bảng ý tưởng | có | `/ideas` | `marketing_ideas` (+ảnh, bình luận) | CONSOLIDATE | không nối sản phẩm, không nối creative | thêm liên kết mẫu |
| Nguồn Spy / R&D | có | `/marketing/creatives?tab=nguon` | `creative_sources` kind SPY/RND | KEEP | tách khỏi `/ideas` | liên kết, không gộp bảng |
| Creative (ảnh, prompt, caption, cha–con, nhà cung cấp, chi phí) | có | `/marketing/creatives` | `creative_variants`, `creative_images`, `creative_manual_gens` | KEEP | **không có video** | video: DEFER |
| Phán quyết creative (snapshot ngày) | có | tab đang chạy / thư viện | `creative_verdicts`, `creative_learnings` | EXTEND | WIN = chỉ số đơn, không lợi nhuận/CPO | thêm cổng lợi nhuận |
| Thư viện mẫu thắng | một phần | tab thư viện | `creative_variants.library_at` | EXTEND | không lọc theo mẫu/ngày | thêm lọc |
| Thiết kế mới DNA → mockup → MOQ → lệnh SX | có | tab thiết kế | `design_concepts` (DRAFT/TESTING/WIN/LOSE/PRODUCTION), `product_dna` | KEEP | chỉ phủ mẫu TK mới | là tiền thân vòng đời — nối vào sổ mẫu |

## 2. Ads · quy kết · chấm thắng thua · rào chi tiền

| Capability | Existing | Route/API | DB | Status | Missing | Action |
|---|---|---|---|---|---|---|
| Đồng bộ chi tiêu FB (chiến dịch×ngày, ad×ngày khi khớp) | có | job `facebook-ads` | `ad_spends` (`grain`) | KEEP | reach/frequency/video | — |
| Chỉ mục ad/adset | có | job index | `fb_ads` (có `post_id`), `fb_adsets` | KEEP | không có bảng chiến dịch riêng | — |
| Chiến dịch → mẫu / marketer | một phần | `/expenses` tab ads | `settings` + `ad_spends.product_id/marketer_id` | EXTEND | khớp theo tên; 1 chiến dịch = 1 mẫu | hàng đợi rà ánh xạ |
| Đơn → ad/adset/chiến dịch | một phần (~49–72%) | `/ads` | `orders.ad_id`, `post_id` | KEEP | bài chạy nhiều chiến dịch = mơ hồ (cố ý) | — |
| Đơn → fanpage → marketer | có | `/marketing/fanpages` | `order_attributions` | KEEP | — | luật 67 |
| Creative ↔ ad | một phần | creatives | `creative_variants.fb_ad_id` | EXTEND | ad cũ/tay không có bản ghi creative | — |
| Số đơn của creative | có nhưng **đếm thiếu** | vòng creative | chỉ `orders.ad_id` | FIX | bỏ qua đường post→ad (`ORDER_AD_ID`) | dùng `ORDER_AD_ID` |
| Lợi nhuận + quyết định theo chiến dịch/adset/ad/mẫu | có | `/ads` | `ads_decision_ledger` | KEEP | — | — |
| P&L marketing theo ngày | có | `/ads/daily` | tính lúc đọc | FIX | adset/ad in chi tiêu "chưa biết" dù đã có độ mịn ad | bật lại |
| Chấm quảng cáo (4 bộ chấm) | có | nhiều | — | CONSOLIDATE | 4 bộ chấm có thể nói ngược nhau | tín hiệu mẫu GỘP các phán quyết có sẵn, không thêm bộ thứ 5 |
| Ghi ngân sách: copilot, rào, phanh, nhật ký | có | `/ads` | `ads_budget_changes` | KEEP | 4 trần chưa được chủ shop xác nhận | HUMAN GATE |
| Kill switch | có | — | `settings` | KEEP | — | — |
| Nháp nhân bản mẫu thắng (PAUSED → người duyệt) | có | creatives | `creative_scale_drafts` | KEEP | trần 5M/ngày mới là đề xuất | HUMAN GATE |
| CPO hoà vốn / trần chi QC mỗi đơn | có ở `/reports?tab=nominal` (`adsCeiling`) | báo cáo danh nghĩa | — | EXTEND | không có trên `/ads`, không theo chiến dịch | đưa lên bảng quyết định |

## 3. Sản xuất: topic → costing → sample → bản duyệt → kế hoạch → lệnh → xưởng → nhập kho

| Capability | Existing | Route/API | DB | Status | Missing | Action |
|---|---|---|---|---|---|---|
| Topic hỏi giá / trao đổi phương án | **không** | — | — | BUILD | thực thể, luồng trao đổi, trạng thái | bảng mới; KHÔNG dùng lại `marketing_ideas` |
| Costing có phiên bản V1/V2/chốt | **không** | `/reports` (1 số/mẫu) | `settings.profit.estimatedCosts` | BUILD | phiên bản, thành phần, khoá bản chốt | bảng mới; bản chốt thay dần giá ước tính |
| Thành phần giá (vải, công, phụ liệu, in, đóng gói, vận chuyển, hao hụt) | một phần (vải + công thực tế) | `/inventory/workshop?tab=cost` | `fabric_orders`, `production_batches` | EXTEND | phụ liệu, in, đóng gói, vận chuyển, hao hụt | dòng costing |
| Giá báo MKT | có | workshop | `marketer_prices` | KEEP | — | — |
| Sample V1/V2/… + duyệt/sửa/loại | **không** | — | — | BUILD | toàn bộ | bảng mới |
| Bản thiết kế đã duyệt, bất biến | **không** | — | `design_concepts.dna` sửa được | BUILD | ảnh chụp đóng băng | bảng mới; lệnh SX tham chiếu |
| Gợi ý số lượng sản xuất | có | `/inventory/planning` | `settings.inventory.planning` | EXTEND | không lưu gợi ý; không trừ hàng đang sản xuất ở trang kế hoạch | lưu ảnh chụp gợi ý |
| Số máy gợi ý vs số người chốt + lý do | **không** | editor chỉ điền sẵn | — | BUILD | — | cột trên lệnh SX |
| Lệnh đặt xưởng | có | `/inventory/planning/orders` | `production_orders` (DRAFT/SENT/RECEIVED/CANCELLED) | EXTEND | trạng thái giữa, liên kết bản duyệt | mở rộng, KHÔNG thay |
| Số lượng kế hoạch/xác nhận/sản xuất/nhận/lỗi | một phần | `/inventory/workshop/[id]` | PO `cells` + lô `ordered/agreed_qty` + `production_deliveries` | CONSOLIDATE | tách lỗi/hỏng | một chỗ đọc |
| Ma trận màu×size | có, **hai kiểu khoá** | cả hai | PO `"màu\|size"`, lô `variantId` | CONSOLIDATE | — | chuẩn hoá về `variantId` (dần) |
| Xưởng / nhà cung cấp | có | `/inventory/purchasing` | `suppliers` | KEEP | lead time/MOQ theo xưởng | — |
| Sổ xưởng (công nợ + giao hàng) | có | `/inventory/workshop` | `production_batches`, `production_deliveries`, `supplier_payments` | KEEP | — | — |
| Mua vải / vật tư | một phần (vải) | workshop tab vải | `fabric_orders` | EXTEND | phụ liệu, BOM | DEFER BOM |
| Phiếu nhập ↔ lệnh SX | **không** (ghép đoán trong báo cáo) | `/inventory/receipts` | `stock_receipts` không có FK | FIX | FK, "nhận hàng theo lệnh" | thêm cột |

## 4. Kho · đơn · Viettel Post · hoàn

| Capability | Existing | Route/API | DB | Status | Missing | Action |
|---|---|---|---|---|---|---|
| Sổ kho (phiếu kho) | có | `/inventory/receipts` | `stock_receipts(_items)` | FIX | **xoá cứng được**, xoá không qua duyệt hai bước; xoá phiếu RETURN làm mồ côi phiếu kiểm hoàn | chặn/duyệt, ghi ảnh chụp trước khi xoá |
| Tồn thực tế / khả dụng / đã chốt (dẫn xuất) | có | `lib/queries/stock.ts` | sổ + đơn + vận đơn | KEEP | — | một công thức (luật 10) |
| Trạng thái tồn | một phần | trang chủ | 5 trạng thái | EXTEND | RETURNING, chờ kiểm, hỏng không phải trạng thái tên riêng | trạng thái DẪN XUẤT từ bảng có sẵn |
| Chống âm kho | một phần | trang thiếu hàng cắm cờ | — | FIX | tổng ON_HAND trang chủ cộng cả dòng âm | tách dòng âm |
| Phân bổ chờ hàng | có | `/inventory/shortage` | — | KEEP | — | luật 70 |
| Đơn Pancake | có | webhook + job | `orders`, `order_items`, `order_status_history` | KEEP | — | — |
| Vận đơn VTP + nhật ký | có | webhook, `/shipments/[id]` | `shipments`, `shipment_events` (unique, gần như append-only) | KEEP | — | — |
| Nhập tệp VTP chạy thử + vết | có | `/import-vtp` | `vtp_import_batches` | KEEP | — | — |
| Hàng đợi đối chiếu VTP | có | `/shipments?view=reconcile` | — | KEEP | — | — |
| Quét mã nhận hoàn | có | `/inventory/returns` | `return_inspections` | KEEP | — | — |
| Tra hoàn theo mã/đơn/SĐT | có | bàn quét | — | KEEP | — | — |
| Kết quả kiểm hoàn | một phần | trạm kiểm | `return_inspection_items` | EXTEND | không có SỬA LẠI / HUỶ BỎ HÀNG | thêm kết quả |
| Tái nhập qua phiếu RETURN | có | — | `stock_receipts` kind RETURN | KEEP | — | — |
| Hoàn không nhãn | có | `/inventory/returns` | `return_unidentified` | KEEP | — | — |
| Tốc độ bán / ngày phủ / ngày hết | có | `/inventory/planning` | — | CONSOLIDATE | **hai định nghĩa tốc độ** (gộp vs ròng) | chọn một |
| Chậm / chết / tồn dư | có | planning | — | CONSOLIDATE | ngưỡng cứng trong mã; không HOT; không sell-through | đưa ngưỡng vào settings |
| Máy quyết định vốn tồn + backtest | có (beta) | `/inventory/decisions` | — | KEEP | — | — |
| Gợi ý đặt lại → lệnh SX | có | planning → orders/new | — | KEEP | — | — |
| Xả tồn nối vào ads/creative | một phần (chỉ outreach) | `/outreach` | — | BUILD | ads/creative không đọc tồn | vòng phản hồi (P4) |

## 5. Tài chính · lợi nhuận

| Capability | Existing | Route/API | DB | Status | Missing | Action |
|---|---|---|---|---|---|---|
| P&L đơn giao thành công | có | `/reports?tab=pnl` | — | KEEP | — | — |
| Lợi nhuận danh nghĩa theo mẫu (đủ ads+giá vốn+cước+hoàn+opex+rủi ro tồn+thuế) | có | `/reports?tab=nominal` | — | KEEP | không xuất CSV | EXTEND |
| Lợi nhuận tiền thật | có (cấp shop) | `/reports?tab=cash/truth` | — | KEEP | không theo mẫu/marketer | — |
| Cầu lợi nhuận → tiền | có | — | — | KEEP | — | — |
| Ước tính vs thực đạt, cùng mẫu, cạnh nhau | một phần | nominal, `/ads` | — | EXTEND | không có cột "lợi nhuận ròng thực đạt theo mẫu" | BUILD cột |
| Ảnh chụp ước tính để so sau | **không** | — | ledger chỉ lưu thực tế | BUILD | không đo được độ chính xác dự báo | lưu dự phóng |
| Lợi nhuận theo marketer | có (3 đường) | nominal, `/ads/daily`, lương | — | CONSOLIDATE | ba con số cùng tên "lợi nhuận" | nhãn + đối chiếu |
| Lợi nhuận + hoà vốn theo chiến dịch/adset/ad | có | `/ads` | — | KEEP | — | — |
| Chuỗi giá vốn (luật 13) + đóng băng lúc giao | có | — | `recognized_cogs` | KEEP | báo cáo danh nghĩa dùng giá vốn SỐNG | ghi rõ |
| Trần chi QC mỗi đơn | có | nominal | — | KEEP | không lên `/ads` | EXTEND |
| ROAS hoà vốn | có | `/ads` | ledger | KEEP | — | — |
| Chênh lệch giá sản xuất (kế hoạch vs thực) | một phần (phiếu nhập vs xưởng) | workshop | — | EXTEND | không so costing/giá PO/giá ước tính | báo cáo chênh lệch |

## 6. Control plane · công việc · duyệt · audit · thông báo · agent · lịch job · quyền · cockpit

| Capability | Existing | Route/API | DB | Status | Missing | Action |
|---|---|---|---|---|---|---|
| Bus sự kiện bền / outbox | **không** | SSE `/api/events` | — | BUILD | bảng sự kiện append-only, idempotent | `domain_events` |
| Đẩy realtime giao diện | có | `/api/events` | — | KEEP | mất khi khởi động lại (đúng thiết kế) | chỉ để làm mới UI |
| Nhật ký riêng từng miền | có (6+) | — | `work_item_events`, `cs_case_events`, `care_case_events`, `tech_task_events`, `order_status_history`, `shipment_events` | KEEP | — | CHIẾU vào dòng thời gian, không chép |
| Hàng đợi công việc chung | có | `/work` | `work_items` (13 nguồn) | KEEP/EXTEND | duyệt, sản xuất chưa là nguồn việc | thêm nguồn |
| Hàng đợi hành động (cảnh báo) | có | `/alerts`, trang chủ | `notifications` | CONSOLIDATE | hai hàng đợi có thể ghi hai người giữ khác nhau | chọn một cho trang chủ |
| Duyệt hai bước chung | một phần | `/alerts` | `approval_requests` | **FIX** | không gì THỰC THI yêu cầu đã duyệt; `EXECUTED` không bao giờ ghi; bật cưỡng chế không có màn hình | executor + dùng lại yêu cầu đã duyệt |
| Cửa duyệt Tech R2 | có | `/tech/tasks` | `tech_tasks`, `tech_proposals` | KEEP | — | — |
| Cửa ghi ngân sách ads | có | `/ads` | `ads_budget_changes` | KEEP | xác nhận cùng người | — |
| Nhật ký audit | có | `/audit` | `audit_logs` | EXTEND | before/after/lý do/correlation nằm trong jsonb; không có loại tác nhân; lỗi ghi bị nuốt | nâng thành cột |
| Chính sách / cấu hình | một phần | các panel | `settings` | EXTEND | không có sổ chính sách có kiểu | DEFER |
| Thông báo Lark/Telegram | có | `/alerts` | `notifications` | FIX | gửi lỗi không thử lại | DEFER (P4) |
| Lịch job | có | `scripts/scheduler.mjs` | — | KEEP | khoá trong bộ nhớ | — |
| Quan sát job | một phần | `/integrations` | `sync_runs` | FIX | `alerts`, `work-recurrence`, `work-escalation`, `work-snapshot`, `dashboard-warm` không ghi `sync_runs` | bọc `runSyncJob` |
| Correlation ID | một phần | — | trong `audit_logs.detail` | BUILD | — | cột + truyền qua action |
| Idempotency | có (theo bảng) | — | unique keys | KEEP | — | — |
| AI agent (Tech room) | có | `/tech/*` | `tech_*` | KEEP | chỉ phòng Tech có agent | theo thang AI luật 69 |
| Quyền | có | `/settings` | 61 khoá, 8 vai | EXTEND | chưa có khoá cho mẫu / duyệt sản xuất | thêm khoá |
| Cockpit chủ shop | một phần | `/` | đọc | EXTEND | không có hàng đợi QUYẾT ĐỊNH lưu được, không chấp nhận/từ chối | P4 |

## 7. Chồng lấn đã đo (CONSOLIDATE — không xoá, chỉ không đẻ thêm)

1. **Hai mã mẫu**: `products.custom_id` và `design_concepts.code`, nối bằng so chuỗi.
2. **Hai nơi nhận ý tưởng**: `marketing_ideas` và `creative_sources` SPY/RND.
3. **Bốn bộ chấm quảng cáo** (`decideAction`, `ads-performance.rate`, `classifyProduct`, ngưỡng intraday) + **ba bộ chấm mẫu** (product-verdict, creative verdict, `designParentScore`).
4. **Hai sổ lệnh sản xuất** (`production_orders` ↔ `production_batches`, liên kết tuỳ chọn, hai kiểu khoá ô) và **ba sự thật "đã nhận"** (PO RECEIVED · lô DONE · phiếu nhập) không có FK.
5. **Sáu trường đơn giá** không đối chiếu nhau.
6. **Hai định nghĩa tốc độ bán** và **bốn bộ luật "chết / xả"**.
7. **Hai hàng đợi việc** (`/alerts` và `/work`), **năm cơ chế duyệt**, **bốn đường thông báo**, **hai sổ chi phí AI**.
8. **Ba đường lợi nhuận marketer** cùng mang chữ "lợi nhuận".

Luật cho mọi agent Company OS: **không thêm bản thứ N của bất kỳ mục nào ở trên.** Việc gộp làm dần,
có kiểm thử đối chiếu trước/sau, và không đổi con số production mà không đo.
