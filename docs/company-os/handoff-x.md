# Company OS — Bàn giao Agent X (vòng phản hồi tồn kho → creative / quảng cáo)

Nhánh `claude/cos-xa-ton-ve-creative` (từ `origin/main` `bf58dead`) · migration `0141_company_os_stock_feedback`
(journal `idx` 141, `when` = 1790006301853 — số do Tech Lead cấp).

Đặc tả §21 P4: *"Khi Slow / Dead: ERP tạo recommendation … Phải liên kết stock → Creative → Ads. Đây là feedback
loop trở lại đầu quy trình."* Dựng thành **ĐỀ XUẤT người bấm** — không ghi Facebook, không đổi ngân sách, không gọi
máy vẽ ảnh.

## 1. Đã dựng

| Phần | Tệp |
|---|---|
| Luật thuần `deriveStockFeedback(input)` → `{ recommendations[], insufficient[] }`; mỗi đề xuất `{ kind, what, why, data[], action, alternatives[], basis, impact, caveat }`; `stockRunsOutBeforeRestock`, `openPoCovers`, `creativeGenHref`, `mergeStockFeedbackSuggestions` (trang 360), `manualGenPreselect` (vòng mẫu) | `lib/constants/stock-feedback.ts` |
| Đọc nguồn cả shop MỘT lượt: `getStockFeedbackShop({ adsVisible, onlyProductId? })`, `getStockFeedbackForProduct`, `lastCreativeDatesByProduct` | `lib/queries/stock-feedback.ts` |
| Cockpit: 2 loại `SCALE_STOCK_RISK` (ngay sau `ADS_CUT`) · `STOCK_PUSH` (cuối), nguồn `STOCK_FEEDBACK` | `lib/constants/owner-decisions.ts` (chỉ THÊM) |
| Cockpit: `stockFeedbackSourceKey`, `stockFeedbackToItems`, bộ đọc `loadStockFeedback`; `SourceLoader` nhận thêm `kinds?` (loại người xem được thấy) | `lib/queries/owner-decisions.ts` (chỉ THÊM + truyền `kinds`) |
| CHECK `recommendation_decisions_kind_check` nhận 11 loại | `drizzle/0141_company_os_stock_feedback.sql`, `db/schema.ts`, `_journal.json` |
| Trang 360 — khối Đề xuất đọc `getStockFeedbackForProduct` qua `loadSource` | `app/(dashboard)/models/[id]/blocks.tsx` |
| Vòng mẫu `?tab=duyet&product=<id>#gen-tay`: CHỌN SẴN ảnh sản phẩm thật của mã ở "Gen ảnh bằng tay" | `app/(dashboard)/marketing/creatives/{page,approve-tab,manual-gen-panel,manual-gen}.tsx` |
| Kiểm thử | `tests/company-os-stock-feedback.test.ts` (đăng ký sau Agent L); sửa khẳng định có sẵn: `company-os-cockpit` (quyền `planning:view` nay thấy `STOCK_PUSH`; CHECK đọc migration MỚI NHẤT), `company-os-owner-digest` (nguồn giả thêm `STOCK_FEEDBACK`), `migration-upgrade-path` (+0141) |

## 2. Hai đề xuất

| Loại | Khi nào (không ngưỡng mới) | Việc chính → lối khác | Số liệu | Khoá cockpit |
|---|---|---|---|---|
| `PUSH_STOCK` / cockpit `STOCK_PUSH` | có mẫu mã BIẾT tồn mà `decideInventory` ra `OVERSTOCK` / `CLEARANCE_CANDIDATE` | creative mới (`/marketing/creatives?tab=duyet&product=<id>#gen-tay`) → `/outreach` · `/ads?dim=product&period=30d` · `/inventory/decisions`. QC của mã **CẮT** (chi đã ghép) ⇒ việc chính đổi sang `/outreach`, VÌ SAO nói *"Quảng cáo đang lỗ … đẩy tồn bằng ưu đãi / khách cũ thay vì tăng quảng cáo"* | khả dụng · đủ bán (Σ khả dụng ÷ Σ tốc độ, không bán ⇒ —) · bán 30 ngày · giá trị tồn (ƯỚC TÍNH, giá nhập gần nhất) · creative gần nhất · vào thư viện gần nhất · chi QC 30 ngày (chỉ khi được xem QC; chưa ghép ⇒ —) | `stock:PUSH:<productId>:<băm>` — căn cứ = tập (mẫu mã : kết luận tồn). KHÔNG có QC trong căn cứ ⇒ cùng khoá cho mọi người xem |
| `SCALE_BLOCKED_BY_STOCK` / cockpit `SCALE_STOCK_RISK` | lá phiếu `/ads` chiều mã hàng = **SCALE** VÀ chi đã ghép VÀ có mẫu mã BIẾT tồn là `STOCKOUT_RISK` hoặc đủ bán < thời gian SX (đúng phép so của `decideInventory`) | `/inventory/planning` → `/inventory/planning/orders` · `/ads` · `/inventory/decisions`; lệnh/lô đặt xưởng đã phủ đủ (số nên đặt đã trừ = 0) ⇒ việc chính `/inventory/purchasing` và câu nói *"đã phủ đủ … hàng chưa về thì đơn tăng thêm phải chờ"*; phủ một phần ⇒ "k/n mẫu mã" | đủ bán (ngắn nhất) · thời gian SX · đã đặt xưởng · nên đặt thêm (đã trừ) · hạn đặt sớm nhất · chi QC | `stock:SCALE:<productId>:<băm>` — căn cứ = SCALE + PO_NONE/PARTIAL/COVERED + tập mẫu mã |

Tác động: `STOCK_PUSH` = Σ vốn giải phóng (`capitalFreeable`); `SCALE_STOCK_RISK` = Σ lãi gộp ƯỚC TÍNH mất nếu hết
hàng. Một vế chưa biết ⇒ cả tổng `—`. Khoá không mang ngày và không mang số đếm trôi — "Bỏ qua" có hiệu lực tới khi
bộ máy nói điều khác.

**Chưa biết ⇒ không đề xuất.** Mẫu mã `DATA_INSUFFICIENT` không bao giờ là căn cứ và không cộng vào số (lưu ý "n mẫu mã
khác chưa biết tồn"). SCALE trên chi CHƯA GHÉP (luật 67) hoặc SCALE mà tồn toàn bộ chưa biết ⇒ không đề xuất, trả một
câu "Chưa kết luận (dữ liệu chưa đủ)" (cockpit: ghi chú khối; 360: ⚠). Cổng dữ liệu trang tồn DATA_INSUFFICIENT ⇒ lưu ý
"chỉ tham khảo" đi kèm.

**Quyền.** `STOCK_PUSH`: `planning:view` (màn hình chủ `/inventory/decisions`). `SCALE_STOCK_RISK`: `planning:view` +
`expenses:view` + phạm vi `ADS` ≠ NONE. Bộ đọc KHÔNG đọc quảng cáo khi người xem không thấy `SCALE_STOCK_RISK` (không
phải đọc rồi giấu): đề xuất đẩy tồn của người đó không có ô chi, không link /ads, không chữ nào về quảng cáo.

**Lark (L).** Hai loại không nằm trong `OWNER_DIGEST_URGENT_KINDS` ⇒ chỉ vào BẢN SÁNG, không kích tin trong ngày.
Không sửa gì ở L.

**Trang 360.** Gác `ctx.allowed.INVENTORY`, phần QC theo `ctx.allowed.ADS`. `mergeStockFeedbackSuggestions` THAY đề xuất
trùng / mâu thuẫn đúng chỗ: `SCALE_BLOCKED_BY_STOCK` thay "Tăng ngân sách" (`ads-SCALE`) — không để một khối vừa bảo
tăng vừa bảo đừng tăng; `PUSH_STOCK` thay "Xả tồn / đẩy bán" (`inventory-clear`) — cùng một kết luận tồn. Còn lại nối
cuối. `deriveModelSuggestions` (A2) không bị sửa.

**Vòng mẫu.** `?product=` chỉ là giá trị KHỞI ĐẦU của ô "Ảnh sản phẩm thật làm gốc" (ảnh `PRODUCT_PHOTO` đầu tiên của
mã; quảng cáo cũ không được chọn). Có dòng nhắc "Máy CHƯA vẽ gì — bấm Gen khi anh/chị muốn"; mã chưa có ảnh ⇒ giữ
mặc định cũ và nói ra. Không lượt vẽ nào được kích.

## 3. Chỗ lệch đề bài — và vì sao

1. **Cần migration 0141** (đề bài "không dự kiến"): CHECK `kind` của sổ phản ứng (0139) liệt kê đúng 9 loại — thiếu thì
   mọi cú Chấp nhận / Bỏ qua / Nhắc lại trên hai loại mới bị CSDL từ chối. Chỉ DROP + ADD CHECK, không đụng dòng nào.
   **Gộp với Agent T** (cũng thêm một loại cockpit): migration ÁP SAU CÙNG phải liệt kê HỢP các loại;
   `tests/company-os-cockpit.test.ts` nay so CHECK của migration MỚI NHẤT với `OWNER_DECISION_KINDS` nên sẽ ĐỎ nếu
   thiếu — đừng nới bài đó, sửa migration cuối.
2. Link quảng cáo là `/ads?dim=product&period=30d` — trang /ads đọc `dim` (không phải `dimension`) và KHÔNG có ô lọc
   `q`; không thêm bộ lọc mới vào /ads trong gói này.
3. Kế hoạch SX không có tham số lọc theo mã ⇒ link `/inventory/planning` (+ `/inventory/planning/orders` để lập đơn).
4. Không đọc danh sách xả của `/outreach` (`clearanceProducts`): nó chạy lịch sử hoàn 90 ngày + kế hoạch cho cả shop —
   quá nặng cho cockpit; đề xuất chỉ LINK sang `/outreach` (không nhân bản luật xả của outreach).
5. `SourceLoader` nhận thêm `kinds?` — cần để bộ đọc biết người xem có được xem quảng cáo không mà không gọi lại
   `decideScope` (bản tin máy của L dùng `scopeOk` riêng).
6. Model 360 dùng kỳ quảng cáo CỐ ĐỊNH 30 ngày cho vòng phản hồi (cùng cockpit), không theo bộ lọc kỳ của trang.

## 4. Kiểm thử · đột biến · đường bấm

Xem báo cáo cuối phiên (SHA, cổng, đột biến, đường bấm) — tóm tắt ở mục 5.

## 5. HUMAN GATE

1. Migration 0141 áp khi deploy (chỉ đổi CHECK).
2. Chủ shop xác nhận quyền: người chỉ có `planning:view` thấy "Tồn chậm — đẩy bằng creative / khách cũ" ở cockpit.
3. Chủ shop xác nhận cách đọc "đừng tăng ngân sách" khi lệnh đặt xưởng ĐÃ phủ đủ số (vẫn hiện, việc chính đổi sang Mua
   hàng & xưởng) — hay muốn ẩn hẳn khi đã phủ.
