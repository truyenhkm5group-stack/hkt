# Company OS · Agent SC — Bàn giao: lối tắt sản xuất (điền sẵn, người lưu)

Nhánh `claude/cos-rut-gon-san-xuat` (từ `origin/main` `07d70ac4`) · **không migration**.

## Vì sao

Đo production 27/09/2026: đội chạy sản xuất NGOÀI ERP — 0 topic · 0 giá thành · 0 mẫu · 0 bản duyệt ·
1 lệnh SX không trỏ bản duyệt · 0/8 phiếu nhập nối lệnh. Từng bước đã có trên ERP (C: topic → giá thành →
mẫu → bản duyệt → lệnh; D: phiếu nối lệnh; P2: "Nối với lệnh SX" cho phiếu đã có) nhưng đi từ bước này
sang bước kia là nhiều màn hình và gõ lại. SC thêm ba LỐI TẮT điền sẵn — mọi lượt ghi vẫn đi qua đường
ghi CÓ SẴN, người sửa rồi bấm lưu.

## Soát trước khi làm (đề bài: có rồi thì mở rộng, không thêm cái thứ hai)

| Lối tắt | Đã có gì | Làm gì |
|---|---|---|
| Bản duyệt → Lập lệnh SX | Có link `/inventory/planning/orders/new?product=` ở 3 chỗ (Kế hoạch SX, chỗ hở chứng cứ P2, Thiếu hàng) — KHÔNG chọn sẵn bản duyệt / xưởng; trang bản duyệt không có nút nào | **Mở rộng** trang `new` có sẵn: nhận `?design=`; thêm nút trên từng bản duyệt |
| Lệnh ĐÃ GỬI → Nhập kho theo lệnh | Không có. Có ô chọn lệnh trên form Nhập hàng (D) và "Nối với lệnh SX" cho phiếu đã có (P2) | **Mở rộng** hộp thoại Nhập hàng có sẵn bằng `prefill` + `?nhap-lenh=` |
| Topic ĐÃ CHỐT → Giá thành V1 | Không có. Chỉ có "Phiên bản giá thành mới" (bảng trống) | Nút mới, đi qua `createCostSheetCore` |

## Đã dựng

| Phần | Tệp |
|---|---|
| Luật THUẦN: trạng thái + câu lý do của ba nút, `receiptPrefillFromPo` (ô lệnh − phiếu nối, MỘT phép trừ `openQtyAfterReceived`), `costV1Prefill`, `prefillDesignId`, `prefillSupplier` | `lib/constants/production-shortcuts.ts` (mới) |
| Đọc: `loadDesignPoShortcuts`, `getNewPoPrefill`, `getPoReceiptPrefill` (qua `linkedReceiptQty("order")` của sổ đặt xưởng) | `lib/queries/production-shortcuts.ts` (mới) |
| Lõi V1: đọc topic → dòng khởi tạo → `createCostSheetCore(onlyFirst)` | `lib/production/shortcuts.ts` (mới) |
| `createCostSheetCore` thêm cờ `onlyFirst`: khoá dòng mẫu `FOR UPDATE`, mẫu đã có bảng ⇒ trả `existing`, không đẻ V2. Không cờ ⇒ y như cũ | `lib/production/costing.ts` |
| Action `startCostSheetFromTopic` (`production:write`, nhật ký `COST_SHEET_CREATE` kèm `shortcut`) | `lib/actions/production-costing.ts` |
| Nút dùng chung: bật ⇒ link; tắt ⇒ nút xám + câu lý do + link tới thứ đã có | `components/shortcut-action.tsx` (mới) |
| "Lập lệnh SX" trên từng bản duyệt (trang topic + bàn sản xuất của mẫu) | `app/(dashboard)/production/_components/model-desk.tsx`, `production/topics/[id]/page.tsx`, `production/models/[id]/page.tsx` |
| Trình sửa lệnh: `?design=` chọn sẵn bản duyệt (chỉ khi thuộc mẫu), điền xưởng, câu nói nguồn | `app/(dashboard)/inventory/planning/orders/new/page.tsx` |
| "Nhập kho theo lệnh SX" trên trang lệnh (+ link ở danh sách với lệnh ĐÃ GỬI) | `inventory/planning/orders/[id]/page.tsx`, `inventory/planning/orders/page.tsx` |
| Hộp thoại Nhập hàng nhận `prefill`: tự mở, điền xưởng · tham chiếu = mã lệnh · lệnh · số còn phải nhập; lọc "Chỉ mẫu mã của lệnh"; in ô không khớp mẫu mã; mở lại ⇒ điền lại từ số mới | `inventory/receipts/receipt-dialog.tsx`, `inventory/receipts/page.tsx` |
| "Lập giá thành V1" trong khối giá thành (topic): có giá ⇒ tạo NHÁP; không giá ⇒ mở bảng trống kèm câu nhắc | `production/_components/cost-sheets.tsx` |
| Kiểm thử | `tests/company-os-production-shortcuts.test.ts` (đăng ký sau Agent Q trong `tests/sync-fixtures.test.ts`) |

## Luật đã chốt

1. **Số lượng của "Lập lệnh SX" = `buildMatrixForProduct`** — đúng thứ `saveProductionOrder` TÍNH LẠI và
   lưu vào `suggested_cells` khi bấm Chốt, nên "lệch gợi ý một ô là phải ghi lý do" đứng nguyên (có bài
   kiểm). Bản duyệt chọn sẵn chỉ khi mã thuộc CHÍNH mẫu của sản phẩm (mã lạ ⇒ không chọn, in câu vàng).
2. **Xưởng điền sẵn**: xưởng của topic của mẫu được duyệt → không có thì xưởng đã làm mẫu được duyệt →
   không có thì để trống. Tên đọc từ DANH MỤC theo khoá (luật 34), không nhận từ URL.
3. **Bấm hai lần không đẻ bản thứ hai**: đã có lệnh DRAFT/SENT trỏ bản duyệt ⇒ nút tắt, lý do "Đã có lệnh
   … đang mở" + link tới lệnh đó · nhập đủ số lệnh ⇒ nút nhập kho tắt · V1 đã có ⇒ lõi trả lại V1
   (kể cả hai cú bấm đồng thời — khoá dòng mẫu).
4. **Còn phải nhập = ô lệnh − đã nhập qua phiếu NHẬP HÀNG nối lệnh**, cộng các ô về cùng mẫu mã TRƯỚC rồi
   trừ một lần, kẹp 0 (nhập vượt ⇒ 0). Phiếu không nối / tái nhập hoàn không trừ. Cùng số với
   `openPoQtyByVariant` (bài kiểm so trên cùng dữ liệu). Ô không khớp mẫu mã (hoặc mẫu mã đã gỡ) KHÔNG
   điền — in ra để nhập tay.
5. **Dòng V1 chỉ từ topic, luôn MỘT dòng `OTHER`**: xưởng báo đúng một mức ⇒ "Giá xưởng báo"; báo NHIỀU
   mức khác nhau ⇒ máy KHÔNG chọn (không biết mức nào ứng với phương án đã chốt) và KHÔNG lùi về giá mong
   muốn — mở bảng trống, liệt kê các mức; chưa báo giá mà có "Giá SX mong muốn" ⇒ dòng mang nhãn "Giá SX
   mong muốn của shop (chưa phải giá xưởng báo)"; không giá nào ⇒ bảng trống, không ghi gì. Giá BÁN không
   bao giờ vào bảng. Dòng dựng LẠI ở máy chủ, không nhận từ trình duyệt.
6. **Quyền = quyền của hành động bên dưới**: lập lệnh `planning:write` (đúng trang `new` + `saveProductionOrder`,
   không phải `production:write` như đề bài gợi ý — xem lệch 1) · nhập kho `inventory:write` · V1
   `production:write`. Nút tắt luôn kèm câu lý do: không quyền · chưa có bản duyệt · mẫu chưa có sản phẩm
   Pancake · lệnh chưa gửi xưởng · lệnh đã nhận / huỷ · đã nhập đủ · topic chưa chốt.

## Lệch đề bài — và vì sao

1. **Quyền lập lệnh là `planning:write`, không phải `production:write`**: trang `/inventory/planning/orders/new`
   và `saveProductionOrder` đòi `planning:write`; đề bài nói "respect permissions of the underlying action".
2. **Gợi ý của trình sửa lệnh KHÔNG phải `suggestedNetOfOpenPo`.** Đề bài giả định nút "Điền theo đề xuất
   ERP" đi qua `suggestedNetOfOpenPo`; soát mã thì nó (và phép tính lại lúc lưu) là `buildMatrixForProduct`
   = `r.suggested` của Kế hoạch SX, CHƯA trừ lệnh đang mở. Lối tắt dùng ĐÚNG đường của trình sửa — điền
   số khác thì máy chủ tính lại ra số khác và đòi lý do cho mọi ô. Hệ quả có sẵn từ trước (không do SC):
   mẫu đang có lệnh SENT mở trình sửa sẽ được gợi ý đặt lại đủ số. Chặn một phần: nút "Lập lệnh SX" tắt
   khi đã có lệnh đang mở trỏ CÙNG bản duyệt. **Tech Lead:** muốn trình sửa trừ lệnh đang mở thì sửa
   `buildMatrixForProduct` (một chỗ, cả hiển thị lẫn lúc lưu) và loại chính lệnh đang sửa khỏi phép trừ.
3. **Xưởng lùi về xưởng làm mẫu** khi topic không khai xưởng (từ 27/09 biểu mẫu topic không còn ô xưởng,
   nên hầu hết topic mới sẽ trống) — vẫn là chứng từ đã có, không đoán.
4. **Nút "Nhập kho theo lệnh" ở danh sách lệnh** không tính số còn lại từng dòng (tránh N truy vấn); trang
   phiếu tự nói "đã nhập đủ" nếu vậy.
5. Nút "Lập lệnh SX" nằm trên TỪNG bản duyệt trong khối "Bản thiết kế đã duyệt" (dùng chung trang topic và
   bàn sản xuất của mẫu), không thêm khối riêng.

## Kiểm thử + đột biến

Xem `tests/company-os-production-shortcuts.test.ts`: thuần (300 ca tính chất "không âm, không vượt lệnh"),
quét mã nguồn (người `insert` vào `production_orders` / `stock_receipts` / `cost_sheets` / `cost_sheet_lines`
đúng bằng danh sách cũ; tệp lối tắt không ghi CSDL; V1 qua `createCostSheetCore(onlyFirst)`; quyền; không
`router.refresh`), CSDL PGlite (topic → V1 báo giá / giá mong muốn / trống, bấm lại + bấm đồng thời; duyệt
mẫu → bản duyệt → nút + điền sẵn; ô = gợi ý máy chủ lưu, sửa ô đòi lý do; lệnh SENT → phiếu nối 4 + 7 vượt
+ phiếu không nối ⇒ còn 6/0, khớp `openPoQtyByVariant`; nhập đủ ⇒ tắt). Không mốc đồng hồ nào.

**Đột biến 22/22 bị bắt** (mỗi cái sửa MỘT chỗ, chạy lại bộ SC, hoàn nguyên): M1 còn phải nhập không kẹp 0 ·
M2 trừ theo từng ô thay vì gộp mẫu mã · M3 lệnh nháp vẫn nhập kho · M4 bỏ chặn đã nhập đủ · M5 bỏ qua lệnh
đang mở trỏ bản duyệt · M6 chọn sẵn bản duyệt lạ · M7 xưởng mẫu trước xưởng topic · M8 nhiều mức báo giá ⇒
lấy một mức · M9 giá mong muốn đội tên giá xưởng báo · M10 báo giá mơ hồ ⇒ lùi về giá mong muốn · M11 bỏ rào
`onlyFirst` trong lõi · M12 lối tắt không truyền `onlyFirst` · M13 action bỏ kiểm quyền · M14 trừ phiếu nối
LÔ thay vì LỆNH · M15 nút lập lệnh bỏ quyền · M16 trình sửa lệnh không coi ô là gợi ý · M17 `insert` thẳng
bảng giá thành ngoài lõi · M18 điền sẵn cả khi nút tắt · M19 V1 không đòi topic đã chốt · M20 topic không
giá vẫn gọi lõi · M21 `onlyFirst` không khoá dòng mẫu (chỉ bài quét mã nguồn bắt — PGlite một kết nối
không tái hiện được hai giao dịch thật sự song song) · M22 nút tắt không in lý do.

## Đường bấm (máy này: `next start` + PGlite + seed-admin + seed-demo + `syncModelRegistry`, Chrome headless qua playwright-core, 1440px)

Gieo bằng lõi: topic "Hỏi giá SP001" ĐÃ CHỐT, xưởng "Xưởng SC Demo", một lượt báo giá 235.000 ₫. Bấm:
1. Trang topic: "Lập giá thành V1 · 235.000 ₫/sp" (câu "Điền từ báo giá…") → toast "Đã tạo V1 (nháp)" → bảng
   V1 Nháp 235.000 ₫, nút V1 biến mất.
2. "Ghi mẫu V1" (xưởng SC Demo) → "Mẫu đã về — gửi duyệt" → "Duyệt mẫu" ⇒ "Bản duyệt V1" có nút "Lập lệnh SX"
   (`/inventory/planning/orders/new?product=demo-p-1&design=…`).
3. Trình sửa lệnh: câu "Mở từ bản duyệt V1: đã chọn sẵn bản duyệt và xưởng “Xưởng SC Demo” (xưởng của
   topic)…", ô xưởng = Xưởng SC Demo, ô bản duyệt = "Bản duyệt V1", 9 ô = gợi ý Kế hoạch SX (dữ liệu demo
   gợi ý 0 cả 9 ô) "khớp từng ô". Gõ 20 vào một ô ⇒ đòi lý do ⇒ ghi lý do ⇒ "Chốt bảng đặt hàng" ⇒ lệnh
   PO-20260927-01 trỏ bản duyệt V1. Trang lệnh (nháp): "Nhập kho theo lệnh SX" xám + "Lệnh SX chưa gửi
   xưởng — …". Quay lại topic: "Đã có lệnh PO-20260927-01 đang mở trỏ bản duyệt này…" + link.
4. "Đánh dấu đã gửi xưởng" ⇒ "còn phải nhập 20 sp" ⇒ "Nhập kho theo lệnh SX" ⇒ `/inventory/receipts?nhap-lenh=…`
   hộp thoại tự mở: xưởng + tham chiếu PO-20260927-01 + ô lệnh chọn sẵn + 1 mẫu mã = 20. Sửa 15 (đếm thật) ⇒
   "Đã nhập 15 sản phẩm"; danh sách phiếu in "Lệnh PO-20260927-01"; trang lệnh "còn phải nhập 5 sp"; bấm
   lại ⇒ điền 5 ⇒ lưu ⇒ nút tắt "đã nhập đủ số của lệnh". Lỗi console: 0 ở cả bốn lượt.

## Cổng (Windows, cây `wt-cos-sc`, công cụ Bash)

`npm run typecheck` sạch · `npm run lint` sạch · `npm test` **TẤT CẢ KIỂM THỬ ĐẠT** (573 dòng ✓, gồm ba dòng
SC) · `npm run build` thành công (`/production/topics/[id]` 1,74 kB · `/inventory/planning/orders/[id]` 4,01 kB ·
`/inventory/planning/orders/new` 147 B · `/inventory/receipts` 11,6 kB). Chưa chạy trên bản checkout sạch
theo SHA — việc của Tech Lead lúc gộp.

## HUMAN GATE

Không ngưỡng mới, không migration, không tự động. Sau deploy: nút chỉ HIỆN — chưa ai bấm thì số production
không đổi.
