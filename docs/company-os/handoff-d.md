# Company OS · Agent D — Bàn giao: sổ kho an toàn · trạng thái tồn

Nhánh `claude/cos-d-inventory` (từ `origin/main` 5a3a7ee6) · migration `0133_company_os_inventory`.

## 1. Đã làm

| # | Việc | Tệp chính |
|---|---|---|
| 1 | Xoá phiếu kho: CHẶN phiếu tái nhập đang là chứng từ của `return_inspections` / `return_unidentified`; mọi lượt xoá khác đi qua `guardSecondApproval` (nhóm theo HƯỚNG tác động: xoá RECEIPT/RETURN ⇒ `INVENTORY_WRITE_OFF`, xoá ISSUE/ADJUSTMENT ⇒ `INVENTORY_ADJUSTMENT`; số tiền = `totalCost`, 0đ ⇒ CHƯA BIẾT ⇒ coi như vượt ngưỡng — y hệt lúc TẠO phiếu); lý do BẮT BUỘC (≥ 5 ký tự); `audit()` ghi `before` = đầu phiếu + từng dòng, `reason`, TRƯỚC khi xoá; lượt xoá có điều kiện `not exists` (phiếu kiểm gắn vào giữa chừng ⇒ không xoá, ghi `STOCK_RECEIPT_DELETE_ABORTED`). Vẫn xoá cứng. | `lib/inventory/receipt-delete.ts` (lõi, không `"use server"`), `lib/actions/stock.ts::deleteStockReceipt(id, reason)`, `app/(dashboard)/inventory/receipts/delete-receipt-button.tsx`, `lib/validation/stock.ts` |
| 2 | Tổng tồn trang chủ: `stockRiskSummary` chỉ cộng dòng DƯƠNG (ON_HAND và AVAILABLE), trả thêm `negativeRows`/`negativeQty` (tồn < 0) và `oversoldRows`/`oversoldQty` (khả dụng < 0). Mẫu chưa biết tồn không vào vế nào. Trang chủ in "N mẫu mã âm sổ — cần kiểm" ở chân khối "Việc cần làm hôm nay". | `lib/queries/stock.ts::splitSignedStock`, `lib/queries/dashboard.ts`, `app/(dashboard)/page.tsx` |
| 3 | Cột `stock_receipts.production_order_id` / `production_batch_id` (NULL, FK ON DELETE SET NULL, chỉ mục một phần), không backfill. Hai ô chọn trên form NHẬP HÀNG (lệnh `SENT`, lô `OPEN`; đã gõ tên xưởng ⇒ chỉ hiện của xưởng đó). Máy chủ kiểm: chỉ phiếu `RECEIPT`, mã tồn tại, không huỷ, lô không nối với lệnh KHÁC. Hiện liên kết ở danh sách + chi tiết phiếu. | `db/schema.ts`, `drizzle/0133_company_os_inventory.sql`, `lib/inventory/production-link.ts`, `lib/queries/stock.ts::listOpenProductionLinks`, `receipt-dialog.tsx`, `receipts/page.tsx` |
| 4 | `getModelStockStates(productId)` — theo mẫu mã và tổng theo mẫu; mọi ô `number \| null`. | `lib/queries/model-stock.ts` |
| 5 | Ngưỡng hàng chậm vào `settings` `inventory.slowMoving`: mặc định `DEFAULT_SLOW_MOVING_RULES = { ...SLOW_MOVING_RULES }`, ghi đè THƯA, bộ sai (ngoài 1–1095 ngày, không nguyên, sai thứ tự `lành mạnh ≤ bán chậm < vốn nằm chết`, JSON hỏng) bị BỎ NGUYÊN BỘ và màn hình nói ra. Ô sửa trên `/inventory/planning` (quyền `planning:write`), `audit` có before/after. Trang Quyết định vốn tồn (`decideInventory` + backtest) đọc CÙNG bộ ngưỡng. | `lib/constants/slow-moving.ts`, `lib/queries/slow-moving.ts::loadSlowMovingRules`, `lib/actions/slow-moving.ts`, `slow-moving-rules-editor.tsx`, `lib/constants/inventory-decision.ts` (thêm `slowRules?`), `lib/queries/inventory-decision.ts` |
| — | Ba trạng thái DẪN XUẤT `RETURNING · PENDING_QC · DAMAGED` + `DAMAGED_ITEM_CONDITIONS = DAMAGED · DIRTY · UNSELLABLE`, khai rõ KHÔNG phải bút toán sổ kho. | `lib/constants/inventory.ts` |

## 2. Hợp đồng `getModelStockStates`

- `actualStock` / `available`: `erpStockExpr` / `availableStockExpr` — `null` khi `stockKnown = false`.
- `reserved`: `variantSalesSubquery.reserved`. `returning`: `.awaitingReturn` — **GỒM CẢ** kiện đã về chờ kiểm (sổ kho chỉ bỏ kiện khỏi nhóm này khi có phiếu tái nhập); `pendingQc` là phần tách của nó, KHÔNG cộng hai số (`basis.returningIncludesPendingQc = true`).
- `inProduction`: `openPoQtyByVariant()` (không đếm trùng lệnh ↔ lô). Lô đang mở CHƯA chia màu/size của mẫu này ở `basis.inProductionUnsplitUnits` (không chia hộ). Ô lệnh không khớp màu/size chỉ biết ở mức TOÀN SHOP (`basis.inProductionUnmappedUnitsShopWide`) — hàm gốc không tách theo mẫu.
- `pendingQc`: số MÓN của kiện `RECEIVED` qua `listPendingInspections` (món theo `product-context`). Kiện toàn shop chưa ghép được món ⇒ `basis.pendingQc = "ITEM_QTY_LOWER_BOUND"` + `pendingQcUnattributedParcels`. Trần đọc 5.000 kiện, vượt ⇒ `pendingQcTruncated`.
- `damaged`: tổng `actual_qty` của `return_inspection_items` mang kết luận trong `DAMAGED_ITEM_CONDITIONS`. Mẫu mã đã có hàng hoàn quay về mà chưa có dòng kiểm từng món nào ⇒ `null`; chưa có kiện nào quay về ⇒ `0` thật. Kết luận CẢ KIỆN (`return_inspections.unsellable_qty`) không có mẫu mã nên KHÔNG quy vào đây.
- Tổng theo mẫu: tồn/khả dụng chỉ cộng dòng dương của mẫu mã đã biết tồn (`splitSignedStock`), `null` khi không mẫu mã nào biết tồn; `coverage` nói bao nhiêu mẫu mã đứng sau con số.

### Sửa sau bàn giao — B1 (lỗi QA tìm ra)

`openPoQtyByVariant()` từng đếm lệnh `SENT` đủ số, bỏ qua phiếu `RECEIPT` nối lệnh qua cột 0132 ⇒ cùng
một món nằm ở cả tồn thực tế lẫn đang sản xuất cho tới khi có người bấm "Đã nhận". Nay:

- `openQtyAfterReceived(planned, delivered, received)` (lib/constants/workshop-ledger.ts) — MỘT phép
  trừ: `max(0, planned − max(delivered, received))` khi có phiếu nối; không phiếu nối ⇒ đúng
  `planned − delivered` như cũ (kể cả đợt trả âm). Đã trả và đã nhập có thể là CÙNG món nên lấy số lớn
  hơn, không cộng.
- Lệnh SX: trừ theo từng mẫu mã (phép ghép "màu|size" có sẵn); `units` và `capital` chỉ còn phần chưa
  về. Ô không ghép được mẫu mã không bị trừ (không biết trừ gì).
- Lô xưởng: `openBatchQtyByVariant(batches, deliveries, receivedByBatch?)` trừ phiếu nối lô; ngữ nghĩa
  đợt xưởng trả không đổi. `linkedReceiptQty("order" | "batch")` ở lib/queries/workshop-ledger.ts đọc số.
- Mọi nơi đọc (kế hoạch/thiếu hàng qua `suggestedNetOfOpenPo`, quyết định vốn tồn, trang 360) đi qua
  hàm này — không nơi nào tự trừ.
- Kiểm thử: `tests/company-os-inventory.test.ts` (phần thuần + khối CSDL "4b. B1": không phiếu nối ⇒ số
  y như trước; nhập một phần; phiếu không nối / phiếu tái nhập hoàn không trừ; lệnh nhập vượt ⇒ 0) và
  bước 5 của `tests/company-os-e2e-lifecycle.test.ts`. Đột biến 6/6 bị bắt: PO không trừ phiếu · lô
  không trừ phiếu · cộng thay vì lấy số lớn hơn · kẹp đợt trả âm về 0 · đếm cả phiếu tái nhập · `units`
  không trừ.
- Chỗ hở còn lại: phiếu chỉ nối LỆNH mà lệnh ấy đã có LÔ nối vào (lệnh bị bỏ, lô thay) thì không trừ
  vào lô — lô chỉ nhận phiếu nối chính nó.

## 3. Lệch so với đề bài — và vì sao

1. **Trang chủ KHÔNG in tổng ON_HAND ở đâu cả.** `stockRisk.states` có trong `getDashboardData` nhưng không màn hình nào vẽ nó; trang chủ chỉ dùng `atRisk`. Nên số "mẫu âm sổ" đặt ở dòng chân khối "Việc cần làm hôm nay" (cạnh "mẫu mã cần sản xuất gấp"), trỏ `/inventory/planning`.
2. **Không có đường gỡ một kiện ĐÃ ĐẾM.** `undoReturnArrived` / `undoReturnReceived` chỉ gỡ kiện CHƯA đếm và chú thích mã nguồn nói rõ sửa số đã đếm phải bằng phiếu điều chỉnh. Thông điệp chặn nói đúng điều đó — không bịa một đường gỡ.
3. **AVAILABLE cũng chỉ cộng dòng dương** (không chỉ ON_HAND): nếu không, bất biến "khả dụng ≤ tồn thực tế" của `tests/inventory.test.ts` có thể vỡ khi chỉ một vế bị kẹp. Phần khả dụng âm đếm ở `oversoldRows/Qty` (đó là đơn chờ hàng — `/inventory/shortage`).
4. **Chặn thêm phiếu RETURN đang gắn `return_unidentified`** (FK ở đó là RESTRICT — trước đây xoá sẽ nổ lỗi CSDL thô).
5. **Chạm hai tệp ngoài danh sách sở hữu**: `lib/constants/inventory-decision.ts` và `lib/queries/inventory-decision.ts` (thêm tham số `slowRules?` mặc định = hằng số cũ, truyền bộ ngưỡng đang hiệu lực). Không làm thì chỉnh ngưỡng ở `settings` làm trang Hàng chậm và trang Quyết định vốn tồn nói hai ngưỡng khác nhau. Tệp chung `db/schema.ts` sửa tại chỗ hai cột + quan hệ (hợp đồng §0: cột thêm vào bảng cũ thì sửa tại chỗ).
6. **Thêm ba hàm ĐỌC (không tiền) vào `lib/queries/workshop-ledger.ts`** (`openBatchLinkOptions`, `batchLinkFacts`, `unsplitOpenBatchUnitsForProduct`): `tests/workshop-ledger.test.ts` chỉ cho tệp của sổ đặt xưởng chạm bảng `production_batches`. Bản đầu đọc thẳng bảng từ sổ kho và bài kiểm ấy đỏ — sửa bằng cách đi qua hàm của sổ, KHÔNG nới danh sách cho phép của bài kiểm.
7. **Không phát `stock_receipt.linked_production`** — sổ sự kiện của Agent A chưa có trên `main`, và hợp đồng §2 ghi D chỉ thêm cột ở Wave 1.
8. **Kiểm thử xoá dùng cổng duyệt giả lập** dựng từ hai hàm quyết định THẬT (`isEnforced`, `overThreshold`) — `guardSecondApproval` cần phiên đăng nhập. Mã nguồn được quét để chắc action truyền đúng `gate: guardSecondApproval`. Không chạm nội bộ cổng (Agent G đang sửa).

## 4. Kiểm thử

`tests/company-os-inventory.test.ts` (đăng ký sau `testInventoryDecision` trong `tests/sync-fixtures.test.ts`, tự dọn mã `cosd-` và khoá `inventory.slowMoving`). Không phụ thuộc đồng hồ: mọi mốc cố định, không truy vấn nào được khẳng định lọc theo "N ngày trước".

Kiểm đột biến — mỗi đột biến sửa MỘT chỗ, chạy lại riêng bộ này, rồi hoàn nguyên. 13/13 BỊ BẮT:

| Đột biến | Bài bắt |
|---|---|
| M1 bỏ chặn phiếu RETURN có phiếu kiểm | "phiếu RETURN đang gắn phiếu kiểm phải bị CHẶN" |
| M2 bỏ vế `not exists` khi xoá | "phiếu kiểm vừa gắn vào ⇒ không xoá" |
| M3 bỏ kiểm lý do | "thiếu lý do thì không xoá" |
| M4 bỏ nhánh NEEDS_APPROVAL | "cưỡng chế bật ⇒ xoá điều chỉnh phải chờ người thứ hai" |
| M5 bỏ `before: snapshot` trong nhật ký | "nhật ký giữ ĐẦU PHIẾU" |
| M6 ON_HAND quay lại cộng tồn có dấu | "không được cộng tồn có dấu vào ON_HAND" |
| M7 sửa hộ một ô thay vì bỏ nguyên bộ | "bộ sai thứ tự bị BỎ NGUYÊN BỘ" |
| M8 bỏ kiểm loại phiếu khi gắn lệnh | "chỉ phiếu Nhập hàng gắn được lệnh" |
| M9 tồn chưa biết thành 0 | "chưa biết là null — KHÔNG phải … 0" |
| M10 hỏng mặc định 0 khi đã có hàng quay về | "hỏng CHƯA BIẾT" |
| M11 bỏ FK lệnh SX trong migration | "CSDL chặn mã lệnh bịa" |
| M12 gõ lại con số mặc định | "mặc định phải LẤY LẠI từ hằng số" |
| M13 báo cáo quyết định không truyền ngưỡng | "báo cáo quyết định phải truyền ngưỡng đang hiệu lực" |

## 5. SQL chỉ-đọc để chủ shop / ops `db-query` so trước–sau (mục 2)

Máy này không đọc được production. Câu dưới đây dựng lại sổ kho (nhập ròng − đã rời kho, lượt vận đơn chính) cho mẫu mã đã có ≥ 1 phiếu NHẬP, rồi so tổng CÓ DẤU (cách cũ) với tổng DƯƠNG (cách mới). Tổng trang chủ chỉ chạy trên các dòng của bảng Kế hoạch SX nên có thể lệch nhẹ với câu này; phần âm là thứ cần đọc.

```sql
with rc as (
  select ri.variant_id, sum(ri.quantity) as received,
         count(distinct ri.receipt_id) filter (where r.kind = 'RECEIPT') as docs
  from stock_receipt_items ri join stock_receipts r on r.id = ri.receipt_id group by 1),
sh as (
  select oi.variant_id,
         coalesce(sum(oi.quantity) filter (where s.picked_up_at is not null
           or s.stage::text in ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERY_FAILED','DELIVERED','RETURNING','RETURNED')), 0) as shipped
  from order_items oi join orders o on o.id = oi.order_id
  left join shipments s on s.order_id = o.id and (
    not exists (select 1 from shipments sh0 where sh0.order_id = o.id and sh0.id <> s.id)
    or s.id = (select x.id from shipments x where x.order_id = o.id
               order by (x.stage::text = 'DELIVERED') desc, x.attempt_no desc nulls last, x.created_at desc, x.id limit 1))
  group by 1),
v as (select rc.variant_id, rc.received - coalesce(sh.shipped, 0) as stock from rc left join sh using (variant_id) where rc.docs > 0)
select sum(stock) as tong_co_dau_cu,
       coalesce(sum(stock) filter (where stock > 0), 0) as tong_duong_moi,
       count(*) filter (where stock < 0) as mau_am_so,
       coalesce(-sum(stock) filter (where stock < 0), 0) as mon_am
from v;
```

Nghĩa: `tong_duong_moi − tong_co_dau_cu = mon_am` — đúng số món mà tổng cũ đã lặng lẽ xoá khỏi hàng có thật.

## 6. Còn lại / đề xuất

- **Đề xuất (không làm):** thay xoá cứng bằng BÚT TOÁN ĐẢO (phiếu `ADJUSTMENT` ngược dấu trỏ về phiếu gốc) — sổ kho thành append-only, nhật ký không còn là bản duy nhất. Đổi cách kho làm việc ⇒ cần chủ shop quyết.
- Yêu cầu duyệt đã được CHẤP THUẬN chưa có đường "thực hiện lại" tiêu thụ đúng một lần — việc của Agent G. Lượt xoá gửi `action: "stock.receipt_delete"`, `entity: "STOCK_RECEIPT"`, `entityId: <mã phiếu>`, `payload: { receiptId, reason }` để G khớp.
- Tổng theo mẫu của `inProduction` chưa gồm ô lệnh SX không khớp màu/size của RIÊNG mẫu đó (chỉ có số toàn shop).
- Trang 360 (A2) cần in `coverage` và `basis` cạnh con số, không chỉ con số.

## 7. CỔNG NGƯỜI (HUMAN GATE)

- Bật cưỡng chế `approval.enforce` cho `INVENTORY_ADJUSTMENT` / `INVENTORY_WRITE_OFF` là việc của CHỦ SHOP — khi TẮT (mặc định hôm nay), xoá phiếu vẫn chạy như cũ nhưng giờ BẮT BUỘC lý do và để lại ảnh chụp.
- Đổi ngưỡng hàng chậm: ô sửa đã có, nhưng AGENTS.md mục 7 — ngưỡng nghiệp vụ đổi khi chủ shop yêu cầu.
- Chạy câu SQL mục 5 trên production để ghi số trước/sau vào PR (máy này không có quyền).
- Migration 0132 (`when = 1790002708245`, chừa chỗ +60.000 cho 0131) áp khi app khởi động. **RỦI RO THỨ TỰ:** drizzle bỏ qua vĩnh viễn migration có `when` nhỏ hơn mốc đã áp — nếu 0132 lên production TRƯỚC `0131` của Agent A thì `0131` phải mang `when` > `1790002708245` (Tech Lead đánh lại mốc/số lúc gộp). Không trùng số hiệu với `main` (đo `git ls-tree origin/main drizzle/` cuối là `0130`).
