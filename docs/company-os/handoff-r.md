# Company OS — Bàn giao Agent R (kết cục cho hàng hoàn KHÔNG NHÃN)

Nhánh `claude/cos-hoan-khong-nhan` (từ `origin/main` 8602b942) · migration `0142_company_os_unidentified_dispositions` (journal `when = 1790006362491`, theo Tech Lead).

## Khoảng trống được đóng

Agent E dựng sổ kết cục `return_dispositions` cho hàng hoàn không tái nhập — nhưng chỉ neo được vào phiếu kiểm của kiện CÓ mã vận đơn. Món hàng hoàn mất nhãn (`return_unidentified`) kết luận hỏng / bẩn / sai hàng / không bán được thì không có lối ra: không đưa đi sửa được trong sổ, không huỷ, không trả xưởng. Lối duy nhất là "đổi kết luận sang Đủ rồi tái nhập NGUYÊN MÓN" — không có đường cho "3 cái, 2 cái giặt sạch, 1 cái vứt".

Nay món ấy đi CÙNG sổ, CÙNG máy trạng thái, CÙNG hàng đợi, CÙNG cổng huỷ — và nhập lại tồn đi CÙNG luật quyền + lý do, CÙNG đường lập phiếu của bàn không nhãn.

## Đã dựng

| Phần | Tệp |
|---|---|
| `return_dispositions.unidentified_id` (FK RESTRICT → `return_unidentified`), `inspection_id` bỏ NOT NULL, `restock_authority` (IDENTIFIED / MANAGER_OVERRIDE — chỉ ở dòng nhập lại của món không nhãn). CHECK: `anchor_check` (`num_nonnulls = 1`), `subject_check` ba nhánh (`item:` · `parcel:` · `unidentified:`), `restock_authority_check`. Không backfill, không gieo. | `db/schema.ts`, `drizzle/0142_…sql`, `_journal.json` |
| Độ mịn thứ ba `UNIDENTIFIED`, `SUBJECT_KEY_PREFIX`, `DISPOSITION_GRAIN_LABEL` | `lib/constants/return-disposition.ts` |
| Luật DUY NHẤT tái nhập hàng không nhãn `checkUnidentifiedRestock` + `restockAuthorityOf` (hàm thuần). Nút tái nhập nguyên món của bàn không nhãn nay gọi đúng hàm này (thông điệp giữ nguyên chữ). | `lib/constants/return-unidentified.ts`, `lib/actions/returns-unidentified.ts` |
| Đường lập phiếu duy nhất của bàn không nhãn tách thành `writeUnidentifiedRestockReceipt` — `restockUnidentifiedReturn` và lõi kết cục cùng gọi nó (tham chiếu/ghi chú phiếu nguyên món KHÔNG đổi chữ). Bàn không nhãn chặn đổi kết luận / tái nhập nguyên món khi món đã có dòng sổ (khoá `FOR UPDATE` rồi mới hỏi sổ); chỉ còn cho gắn mẫu mã cho món chưa nhận diện. "Giữ tạm" trừ phần đã có kết cục cuối; thêm `reworkRestockedUnits` / `reworkRestockedOverrideUnits`. | `lib/returns/unidentified.ts` |
| `subjectsQuery` thêm nhánh món không nhãn (chưa vào tồn, kết luận không cộng tồn, `quantity > 0`); giá vốn dùng đơn ĐÃ NỐI; `code` = mã `UR-…`. Hàm cầu nối: `unidentifiedLedgerRows`, `unidentifiedIdsInLedger`, `unidentifiedTerminalQtySql`, `unidentifiedReworkRestockTotals`, `unassignedUnidentifiedDispositions` — mọi SQL chạm sổ vẫn nằm trong các tệp của sổ (bài quét của E không phải nới). | `lib/queries/return-dispositions.ts` |
| Lõi ghi: khoá dòng `return_unidentified` + ĐỌC LẠI đối tượng trong khoá; nhập lại hỏi `checkUnidentifiedRestock` hai lần (trước giao dịch, trong khoá); phiếu qua `writeUnidentifiedRestockReceipt`; `restock_authority` ghi trên dòng sổ; kết quả trả `restockAuthority`. Action đọc `inventory:restock-unidentified` TỪ PHIÊN (`canRestockUnidentified`, mặc định `false`). | `lib/returns/disposition.ts`, `lib/actions/return-dispositions.ts` |
| `receiptDeleteBlockers`: vế sổ kết cục đổi nối TRONG → nối NGOÀI (dòng không nhãn không có phiếu kiểm từng rơi khỏi danh sách chặn), `code` = `UR-…` | `lib/inventory/receipt-delete.ts` (tệp của D — Tech Lead cho phép đúng việc này) |
| Tóm tắt theo mẫu gồm món không nhãn ĐÃ nhận diện mẫu; `basis.unidentifiedSubjects`; `itemSubjects` nay chỉ đếm món từng món | `lib/queries/model-returns.ts`, `app/(dashboard)/models/[id]/blocks.tsx` (một dòng phụ đề) |
| Nguồn việc `RETURN_DISPOSITION` chiếu món không nhãn (thực thể `RETURN_UNIDENTIFIED`, bằng chứng "Bàn hàng hoàn không nhãn") — cùng `listDispositionQueue`, không nguồn nào khác chiếu `return_unidentified` | `lib/queries/work-adapters.ts` |
| UI: khối "Hàng hoàn không tái nhập" hiện món không nhãn với nhãn **không nhãn**, mã `UR-…`, "đã nối vận đơn / chưa nối đơn"; biểu mẫu nhập lại báo trước khi cần quyền + lý do; tiêu đề đếm "trong đó N món không nhãn" và con số cấp shop "không nhãn, chưa gán mẫu". Bàn không nhãn ẩn nút tái nhập nguyên món / "Đã làm lại xong" cho món đã vào sổ và trỏ sang khối kết cục. | `disposition-section.tsx`, `unidentified-section.tsx`, `page.tsx` |
| Kiểm thử | `tests/company-os-unidentified-dispositions.test.ts` (đăng ký sau E), `tests/migration-upgrade-path.test.ts` (+0142), `tests/company-os-returns.test.ts` (một dòng: `shipmentId` nay có thể `null`) |

## Quyết định cần biết

1. **"Mẫu mã đã xác nhận" = `return_unidentified.variant_id`.** Bảng này KHÔNG lưu mẫu mã đoán nào: cột ấy là mẫu người kho chọn từ danh mục với món hàng trên tay (lúc nhận, hoặc gắn sau) — cùng bản chất với `actual_variant_id` của dòng kiểm từng món. `NULL` ⇒ `model_id = null`, không vào tóm tắt mẫu, đứng ở con số cấp shop. Mẫu mã của ĐƠN ĐÃ NỐI (kể cả khi đơn chỉ có một mẫu) là ĐOÁN và không bao giờ được dùng — bài kiểm gieo đúng ca ấy.
2. **Sự kiện giữ subject `return_inspection`** (sổ sự kiện khai một loại chủ thể; đổi loại của một sự kiện LIVE là làm lệch lịch sử). `subject_id` = khoá `unidentified:<id>` — không bao giờ trùng id phiếu kiểm; `payload.grain = "UNIDENTIFIED"`, `payload.unidentifiedId`, `payload.restockAuthority`.
3. **Nhập lại từng phần KHÔNG ghi `return_unidentified.stock_receipt_id`** (cột một-phiếu-một-món). Chốt chống cộng hai lần là: khoá dòng món + sổ theo số lượng + bàn không nhãn từ chối mọi đường vào tồn khác khi món đã có dòng sổ.
4. **`restock_authority` là cột mới trên sổ**, không suy lại từ trạng thái hiện tại: món có thể được nối đơn SAU khi đã nhập, và lượt nhập lúc ấy vẫn là không chứng từ.
5. `anchor_check` trùng một phần với `subject_check` mới (cả hai chặn "hai neo" / "không neo") — cố ý: `anchor_check` đọc được bằng mắt, `subject_check` là nơi khoá khớp neo.

## Cổng

Xem báo cáo cuối của phiên (SHA, lệnh, kết quả). Kiểm đột biến: xem mục dưới.

## Còn lại

- **Không có đường bấm để gắn mẫu mã cho món không nhãn ĐÃ tạo** (có từ trước bản này: `setUnidentifiedConditionAction` nhận `variantId` nhưng màn hình chỉ chọn mẫu lúc nhận kiện). Hệ quả: món không nhãn chưa nhận diện mẫu chỉ đi được tới huỷ / trả xưởng; nhập lại báo "gắn mẫu mã ở bàn không nhãn trước". Lõi đã cho phép gắn mẫu (giữ kết luận) cả khi món đã vào sổ.
- Chưa đo production (không có quyền). Sau deploy, món không nhãn đang giữ tạm mang kết luận không bán được sẽ hiện "Chưa quyết" (không backfill).
- Duyệt huỷ vẫn phụ thuộc đường "thực hiện lại sau khi duyệt" của Agent G (như E đã ghi).
