# Company OS — Bàn giao Agent E (kết cục hàng hoàn không tái nhập)

Nhánh `claude/cos-e-returns` (từ `origin/claude/cos-nen-mau-va-kho` dba26e0d) · migration `0136_company_os_returns` (journal `when = 1790006060000`, theo chỉ đạo Tech Lead — muộn hơn 0133 của F).

## Đã dựng

| Phần | Tệp |
|---|---|
| Sổ GHI THÊM `return_dispositions` (khối cuối `db/schema.ts`), CHECK: kết cục · `qty > 0` · `subject_key` khớp cột nguồn · phiếu kho ⇔ `RESTOCK_AFTER_REWORK` · huỷ bắt buộc lý do · cột giá trị chỉ với huỷ · bậc giá vốn ∈ `COST_BASES`. FK phiếu kiểm / dòng kiểm / phiếu kho / người làm = RESTRICT; `actor_user_id` NOT NULL (luật 34); `request_key` UNIQUE (chống bấm đúp). Không gieo dòng nào. | `db/schema.ts`, `drizzle/0136_company_os_returns.sql`, `drizzle/meta/_journal.json` |
| Luật thuần: 5 kết cục (2 trạng thái mở `PENDING_DECISION`/`REWORK`, 3 kết cục cuối tiêu số lượng), `DISPOSITION_ALLOWED_FROM` (nhập lại CHỈ sau `REWORK`), `foldDispositions` (gập sổ, ổn định theo `(createdAt, id)`), `checkDispositionRequest`, `NON_RESTOCK_ITEM_CONDITIONS` (dẫn xuất từ `ITEM_CONDITION_RESTOCKS`) | `lib/constants/return-disposition.ts` |
| Đọc: `subjectsQuery` — định nghĩa DUY NHẤT của "đối tượng cần kết cục" (dòng kiểm từng món không cộng tồn, `actual_qty > 0`; hoặc kiện kiểm CẢ KIỆN `INSPECTED`, `unsellable_qty > 0`, không phải `MISSING`, không có dòng từng món), `listDispositionQueue`, `listRecentDispositions`, giá vốn ước tính theo bậc `LINE_UNIT_COST` nhưng bậc cuối là CHƯA BIẾT | `lib/queries/return-dispositions.ts` |
| Lõi ghi (không `"use server"`): một giao dịch — khoá phiếu kiểm → gập lại sổ trong khoá → phiếu RETURN qua `createRestockReceipt` của trạm kiểm (nay được xuất ra, thêm tham số `reference`) → một dòng sổ → `return.disposition_set` (dedupe `return.disposition_set:<id dòng>`, `model_id` qua `product_models.product_id`). Huỷ bỏ hỏi cổng `INVENTORY_WRITE_OFF` TRƯỚC giao dịch; giá chưa biết ⇒ `amount = null` ⇒ cổng coi như vượt ngưỡng. | `lib/returns/disposition.ts`, `lib/returns/inspection.ts` |
| Server action `setReturnDisposition` (`inventory:write`, zod, `gate: guardSecondApproval`, `audit` `RETURN_DISPOSITION_SET`) | `lib/actions/return-dispositions.ts`, nhãn ở `lib/constants/audit.ts` |
| UI: khối "Hàng hoàn không tái nhập" ngay dưới trạm đếm `/inventory/returns#hang-khong-tai-nhap` — mỗi món một dòng, chỉ các nút trạng thái hiện tại cho phép, biểu mẫu số món ĐẾM ĐƯỢC / chọn mẫu mã (kiện cả kiện) / lý do, lịch sử từng món, "Quyết định gần đây"; `?xu-ly=<khoá>` cuộn tới đúng món | `app/(dashboard)/inventory/returns/disposition-section.tsx`, `page.tsx` |
| Nguồn việc MỚI `RETURN_DISPOSITION` (SOURCE, phòng WAREHOUSE, hạn `null` = chủ shop chưa chốt, nút `OPEN_SOURCE`) + adapter `adaptReturnDispositions` gọi CHÍNH `listDispositionQueue` | `lib/constants/work-sources.ts`, `work-ownership.ts`, `work-sla.ts`, `lib/queries/work-adapters.ts` |
| Sự kiện `return.disposition_set` → `LIVE`, emitter `lib/returns/disposition.ts` | `lib/constants/domain-events.ts` |
| `getModelReturnDispositions(productId)` cho trang 360 | `lib/queries/model-returns.ts` |
| Đổi nhãn (chỉ chữ): `/returns` = "Phiếu đổi / trả (Pancake)" (eyebrow "Bán hàng · nguồn Pancake"), `/inventory/returns` = "Kiểm đếm hàng hoàn · kho" | hai `page.tsx`, `lib/constants/department-modules.ts` |
| Kiểm thử | `tests/company-os-returns.test.ts` (đăng ký sau Agent D trong `tests/sync-fixtures.test.ts`), `tests/migration-upgrade-path.test.ts` (+0136, bảng có, 0 dòng) |

## Hợp đồng `getModelReturnDispositions`

`pendingQty` · `reworkQty` · `writtenOffQty` · `returnedToSupplierQty` · `openSubjects` là `number | null`: `null` khi mẫu nằm trong một kiện KIỂM CẢ KIỆN có hàng không bán được (`basis.parcelLevelSubjects > 0`) — phần ấy không chia được theo mẫu, không chia hộ. `restockedAfterReworkQty` luôn chính xác (đọc dòng sổ mang phiếu của đúng mẫu mã). `writeOffValueEstimate` = ảnh chụp giá trị lúc huỷ; `null` nếu có dòng huỷ chưa biết giá (phần đã biết: `writeOffValueKnownPart`, số món chưa biết: `writeOffValueUnknownQty`). Mẫu không có gì ⇒ 0 thật. Giá trị là ƯỚC TÍNH, không vào báo cáo lợi nhuận nào (bài kiểm quét: chỉ 4 tệp của sổ được đọc `return_dispositions`).

## Lệch so với đề bài — và vì sao

1. **Đối tượng không chỉ là dòng kiểm từng món.** Đường đếm nhanh và đếm hàng loạt kết luận CẢ KIỆN mà không sinh dòng `return_inspection_items` — nếu chỉ nhận `inspection_item_id`, món hỏng của mọi kiện đi hai đường ấy (đường phổ biến nhất) sẽ không bao giờ vào hàng đợi. Nên bảng có `inspection_id` NOT NULL + `inspection_item_id` NULL được + `subject_key` có CHECK. Kiện cả kiện nhập lại phải CHỌN mẫu mã trong hàng kỳ vọng của kiện (một mẫu thì lấy luôn).
2. **Sổ theo SỐ LƯỢNG, không chỉ "dòng mới nhất thắng".** Giặt 3 cái, 2 sạch nhập lại, 1 huỷ là ca thường; "dòng mới nhất" làm mất phần còn lại. Phần còn mở = số món − tổng kết cục cuối; trạng thái của phần còn mở = dòng trạng thái gần nhất. Khi dùng trọn số lượng, hành vi trùng với "dòng mới nhất".
3. **`RESTOCK_AFTER_REWORK` chỉ đi sau `REWORK`** (luật ở hằng số + kiểm lại trong khoá) — nếu không đó là đường lật kết luận kiểm bằng một cú bấm.
4. **Kiện "Thiếu hàng" cả kiện bị loại** (đường hàng loạt ghi `unsellable_qty` = số kỳ vọng cho cả "thiếu", tức hàng KHÔNG có mặt); số kiện bị loại in ra ở đầu khối.
5. **Nguồn việc mới thay vì mở rộng `RETURN_INSPECTION`**: nguồn cũ chiếu từ cảnh báo (kiện chưa đếm, độ mịn kiện) và `stage-health` thay số tồn đọng của nó bằng số KIỆN chờ đếm — gộp vào sẽ đếm lẫn. Hai nguồn không chạm cùng một kiện (RECEIVED vs INSPECTED); không loại cảnh báo nào trùng ⇒ không thêm vào `ALERT_KINDS_OWNED_ELSEWHERE`.
6. Tệp ngoài danh sách sở hữu, chỉ THÊM: `lib/constants/audit.ts` (2 nhãn), `lib/constants/work-ownership.ts`, `lib/constants/work-sla.ts`, `lib/queries/work-adapters.ts`, `app/(dashboard)/returns/page.tsx`.

## Còn lại / yêu cầu agent khác

- **Agent D**: `receiptDeleteBlockers` (lib/inventory/receipt-delete.ts) chưa biết `return_dispositions.stock_receipt_id`. FK là RESTRICT nên phiếu nhập lại sau sửa KHÔNG xoá được, nhưng lỗi hiện ra là lỗi CSDL thô (và nhật ký `STOCK_RECEIPT_DELETE` đã ghi trước lượt xoá hỏng). Đề nghị thêm một vế chặn có thông điệp.
- **Agent D**: `getModelStockStates().damaged` vẫn cộng mọi món kết luận hỏng — không trừ phần đã nhập lại / huỷ / trả xưởng. Nếu muốn "hỏng còn trên kệ", đọc `getModelReturnDispositions`.
- **Agent G**: yêu cầu duyệt huỷ gửi `action: "return.disposition_write_off"`, `entity: "RETURN_DISPOSITION"`, `entityId: <subject_key>`, `payload: { subjectKey, qty, variantId, note, valueEstimate, costBasis }` — chưa có đường "thực hiện lại sau khi duyệt"; hôm nay người làm bấm lại sau khi được duyệt.
- Hàng hoàn **mất nhãn** (`return_unidentified`) chưa có kết cục trong sổ này (ngoài phạm vi: nó có vòng đời riêng).
- Hạn xử lý của `RETURN_DISPOSITION` để `null` — chủ shop đặt ở `/work/settings` nếu muốn.
- Chưa đo production (không có quyền). Sau deploy, mọi món không tái nhập đã kiểm từ trước hiện là "Chưa quyết" (không backfill) — số lượng thật sẽ lộ ra ở tiêu đề khối.

## HUMAN GATE

- Bật cưỡng chế `approval.enforce.INVENTORY_WRITE_OFF` là việc của chủ shop (ngưỡng 1.000.000 ₫ có sẵn; giá vốn chưa biết ⇒ coi như vượt ngưỡng).
- Đưa giá trị huỷ ước tính vào báo cáo lợi nhuận = đổi số lợi nhuận ⇒ chủ shop quyết (AGENTS.md mục 7) — bản này cố ý không làm.
