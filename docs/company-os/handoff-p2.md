# Company OS — Bàn giao Agent P2 (ERP chỉ ra chỗ LỜI KHAI ≠ CHỨNG CỨ)

Nhánh `claude/cos-chi-ra-cho-lech` (từ `origin/main` 8065857d) · **không migration**.

## Vì sao

Đo production 26/09/2026 (ops company-os-summary): 7 mẫu đã khai vòng đời (SAMPLING 1 · SELLING 3 ·
CLEARANCE 3) nhưng production_topics 0 · cost_sheets 0 · samples 0 · design_versions 0; 8 phiếu NHẬP
HÀNG, 0 phiếu nối lệnh / lô. Người khai trạng thái trong ERP còn việc sản xuất thật ở ngoài, phiếu nhập
không nối về lần đặt xưởng. P2 làm ERP CHỈ RA hai chỗ lệch để người đóng — chỉ gợi ý, không sửa hộ.

## Đã dựng

| Phần | Tệp |
|---|---|
| Luật thuần: `LIFECYCLE_REQUIRED_EVIDENCE` (7 trạng thái sản xuất → đúng MỘT chứng từ), `lifecycleEvidenceGap`, `matchReceiptToOrders`, `prefilledOrderId` | `lib/constants/evidence-gaps.ts` (mới) |
| Dữ kiện: `listModelEvidenceFacts` / `listLifecycleEvidenceGaps` (cả shop), `evidenceFactsOfSummary` (trang 360, từ `getModelProductionSummary` của C — không truy vấn thêm), `listLinkableReceipts` | `lib/queries/evidence-gaps.ts` (mới) |
| Hai mục sổ lỗ hổng (luật 45): `lifecycle-without-evidence` (= LIFECYCLE_WITHOUT_EVIDENCE, **AMBIGUOUS**, MEDIUM, phòng `TEAM_DEPARTMENT.PRODUCTION` — luật 69, hôm nay về Kho) · `receipt-linkable-to-po` (= RECEIPT_LINKABLE_TO_PO, **RESOLVABLE**, HIGH, phòng Kho). `fixable` suy ra từ loại. | `lib/constants/data-quality-issues.ts` |
| `/data-quality`: hai dòng mới + ví dụ MỞ ĐƯỢC (`DqIssueRow.links`, link thẳng tới mẫu / phiếu) + dải đếm theo LOẠI chỗ trống (nhóm có dòng / tổng nhóm · tổng dòng · "chưa đếm được" tách riêng). Khoá đệm `data-quality:issues:v2`. | `lib/queries/data-quality-issues.ts`, `app/(dashboard)/data-quality/page.tsx` |
| Nối phiếu ĐÃ CÓ vào lệnh SX — trước đây không có đường nào (ô chỉ có trên form TẠO phiếu). Lõi `linkExistingReceiptCore`: `validateProductionLink` của D · thêm đúng một điều kiện (sản phẩm của lệnh có trên phiếu) · chỉ phiếu CHƯA nối (điều kiện nằm trong câu UPDATE ⇒ đua thì một người thắng) · phát `stock_receipt.linked_production` cùng giao dịch (cùng khoá chống trùng với đường tạo) · `audit` `STOCK_RECEIPT_LINK_PRODUCTION` có trước/sau. Server action `linkStockReceiptToProductionOrder` (`inventory:write`, zod `linkReceiptSchema`). | `lib/inventory/receipt-create.ts` (tệp phát sự kiện đã khai), `lib/actions/stock.ts`, `lib/validation/stock.ts` |
| Ô "Nối với lệnh SX" ở chi tiết phiếu (`/inventory/receipts?receipt=<id>&po=<id>`): ứng viên do máy chủ tính, một ứng viên / `po` hợp lệ ⇒ điền sẵn, nhiều ⇒ để trống. Chỉ hiện với phiếu NHẬP HÀNG chưa nối và người có `inventory:write`. | `app/(dashboard)/inventory/receipts/{page,link-production-control}.tsx` |
| Trang 360: ô vàng trong thẻ "Trạng thái khai" — "Trạng thái khai “Làm mẫu” nhưng ERP chưa có mẫu xưởng nào — ghi mẫu xưởng hoặc sửa trạng thái" + link chỗ ghi chứng từ + "Sửa trạng thái" (neo `#trang-thai-khai`). Gác quyền khối PRODUCTION (`planning:view`), đọc qua `productionOnce`, đứng sau `Suspense`. | `app/(dashboard)/models/[id]/{blocks,page}.tsx` (`BlockCtx.modelCode` thêm) |
| Kiểm thử | `tests/company-os-evidence-gaps.test.ts` (đăng ký sau `testCompanyOsSummaryDb`); `tests/company-os-model-360.test.ts` nới regex một chữ (`productionOnce(` là `loadSource`) |

## Luật đã chốt (và chỗ lệch đề bài)

1. Trạng thái → chứng từ: Bàn SX → topic (mọi trạng thái, kể cả ĐÃ ĐÓNG) · Tính giá thành → bảng giá thành (nháp cũng tính) · Làm mẫu / Duyệt mẫu → một mẫu xưởng bất kỳ · Mẫu đã duyệt → bản thiết kế · Lên kế hoạch / Đang SX → lệnh DRAFT/SENT của sản phẩm (đúng `openOrders` của C). Mỗi trạng thái chỉ đòi chứng từ CỦA NÓ, không đòi cả chuỗi. Trước Bàn SX, Đang bán / Xả tồn / Ngừng, Chưa khai: không bao giờ hỏi.
2. **Lệch nhỏ:** "Đang sản xuất" chấp nhận lệnh NHÁP (đề bài nói "open"; dùng đúng định nghĩa của C thay vì định nghĩa thứ hai). Muốn chặt hơn (chỉ SENT) là một dòng ở `LIFECYCLE_REQUIRED_EVIDENCE` + `HAS`.
3. Khớp phiếu ↔ lệnh: phiếu RECEIPT chưa nối lệnh LẪN lô · lệnh `SENT` · cùng sản phẩm · ngày nhận (giờ VN) ≥ ngày gửi (giờ VN) — so theo NGÀY vì `received_at` là đầu ngày · cùng `supplier_id` khi CẢ HAI biết. Lệnh SENT thiếu `sent_at` ⇒ KHÔNG đề xuất (không chứng minh được thứ tự). Lô xưởng không nằm trong phép khớp (đề bài chỉ nói lệnh).
4. Chủ phòng của mục phiếu là **Kho** (phiếu kho, quyền `inventory:write`) — đề bài chỉ định phòng cho mục vòng đời.
5. Nhãn nhật ký `STOCK_RECEIPT_LINK_PRODUCTION` CHƯA thêm vào `lib/constants/audit.ts` (tệp của P1) — màn hình nhật ký in mã gốc. **Tech Lead:** thêm `"Nối phiếu nhập với lệnh sản xuất"` khi gộp.
6. Hàng đợi `/work` KHÔNG chiếu sổ lỗ hổng (đã kiểm `work-sources` / `work-adapters`) ⇒ không có gì phải khai ở `ALERT_KINDS_OWNED_ELSEWHERE`; bài kiểm đỏ nếu sau này ai nối sổ vào `/work` mà không nghĩ tới đếm hai lần.
7. Chi tiết phiếu chỉ mở được với 200 phiếu gần nhất (giới hạn có sẵn của trang) — production có 8 phiếu.

## Kiểm thử + đột biến

Thuần: mọi trạng thái × có/không chứng từ, chỉ chứng từ của chính trạng thái quyết định, câu chữ + link; khớp phiếu (sản phẩm, 3 trạng thái đóng, ngày sau, cùng ngày VN, 17:30Z = ngày hôm sau, `sent_at` NULL, xưởng khác / một bên trống / cùng, phiếu đã nối lệnh / lô, RETURN/ISSUE/ADJUSTMENT, nhiều ứng viên ổn định với thứ tự đầu vào), điền sẵn; sổ khai; quét mã nguồn (luật thuần không đồng hồ / CSDL, chỉ server action gọi lõi nối, cổng trước giao dịch, `/work` không chiếu). CSDL (PGlite, mã `cos-p2-`, ngày cố định 2001, tự dọn): 16 mẫu → đúng 7 chỗ hở; **trang 360 và trang Chất lượng dữ liệu cùng dữ kiện trên 13 mẫu**; 7 phiếu → đúng 3 có ứng viên (một phiếu 2 ứng viên); `getDataQualityIssues` đếm = phép chiếu, link một lệnh mang sẵn `po`, nhiều lệnh thì không; đọc trang không nối gì / không đổi trạng thái / không phát sự kiện; nối qua cổng (RETURN, lệnh huỷ, lệnh lạ, sản phẩm khác, phiếu đã nối ⇒ từ chối, không sự kiện), nối thành công ⇒ cột + sự kiện + đúng MỘT dòng nhật ký trước/sau, bấm lại bị từ chối, đua hai lượt ⇒ một người thắng.

**Lỗi thật bài kiểm bắt:** câu con `exists (… where tp.model_id = ${pm.id})` — drizzle bỏ tên bảng khi truy vấn một bảng nên thành `"id"` trần, Postgres gắn vào bảng CON ⇒ mọi mẫu "không có topic", mọi lệnh "khớp chính nó". Sửa bằng `"product_models"."id"` tường minh.

**Đột biến 22/22 bị bắt** (mỗi cái sửa một chỗ, chạy lại bộ P2 + sổ lỗ hổng + A2 thuần, hoàn nguyên): M1 SELLING đòi topic · M2 bỏ kiểm đã có chứng từ · M3 Duyệt mẫu đòi bản duyệt · M4 bỏ lọc SENT · M5 bỏ lọc ngày · M6 so mốc thô thay ngày VN · M7 bỏ lọc xưởng · M8 xưởng chặt khi một bên trống · M9 đề xuất lại phiếu đã nối · M10 máy chọn hộ một lệnh · M11 `sent_at` NULL coi như khớp · M12 điền sẵn khi nhiều ứng viên · M13 lệnh ĐÃ NHẬN là lệnh mở · M14 câu con dùng cột trần · M15 nối bỏ `validateProductionLink` · M16 nối bỏ kiểm sản phẩm · M17 bỏ rào `IS NULL` trong UPDATE (bắt bởi bài đua) · M18 bỏ nhật ký · M19 ghi đè phiếu đã nối · M20 khai tay loại "sửa được" · M21 gõ thẳng phòng Sản xuất · M22 trang đọc tự nối.

## Đường bấm (next start + PGlite + seed demo + `syncModelRegistry`, Chrome headless qua playwright-core, 1440px)

Gieo: SP001 khai **Làm mẫu** (không mẫu xưởng), SP002 khai **Đang bán**; xưởng "Xưởng P2 Demo"; lệnh `P2-PO-001` SENT 20/09 cho SP001; phiếu `PN-P2-01` nhập 25/09, cùng xưởng, chưa nối.
- `/data-quality`: dải loại "Dữ liệu đã có, chưa nối: 1/8 nhóm · 1 dòng", "Nhiều ứng viên — người quyết: 1/6 nhóm · 1 dòng"; dòng "Phiếu nhập chưa nối…" ví dụ "PN-P2-01 → lệnh P2-PO-001" + link; không cuộn ngang.
- Bấm link ⇒ `/inventory/receipts?receipt=…&po=…#chi-tiet`, ô "Nối với lệnh SX" **điền sẵn** "Lệnh P2-PO-001 · gửi 20/09/2026" ⇒ **Nối** ⇒ toast "Đã nối phiếu với lệnh sản xuất"; tải lại: chi tiết in "Lệnh P2-PO-001", ô nối biến mất; `/data-quality` không còn PN-P2-01.
- `/models/<SP001>`: ô vàng "Trạng thái khai “Làm mẫu” nhưng ERP chưa có mẫu xưởng nào — ghi mẫu xưởng hoặc sửa trạng thái. Ghi mẫu xưởng · Sửa trạng thái" (link `/production/models/<id>`, `#trang-thai-khai`). `/models/<SP002>` (Đang bán): không có ô. Lỗi console: 0.

## Cổng

Windows, cây `wt-cos-p2`: `npm run typecheck` sạch · `npm run lint` sạch · `npm test` **TẤT CẢ KIỂM THỬ ĐẠT** (505 dòng ✓; các dòng ⚠ "CHƯA ĐO ĐƯỢC trên win32" là của bài flock/chmod có sẵn) · `npm run build` thành công (`/data-quality` 4,48 kB · `/inventory/receipts` 11,1 kB · `/models/[id]` 4,67 kB). Chưa chạy trên bản checkout sạch theo SHA — việc của Tech Lead lúc gộp.

## HUMAN GATE

Không có ngưỡng mới, không migration, không tự động nào. Sau deploy chủ shop sẽ thấy trên production (theo số 26/09): 1 dòng "Làm mẫu mà chưa có mẫu xưởng" và tối đa 8 phiếu nếu có lệnh SENT khớp — mỗi dòng là một việc NGƯỜI quyết (ghi chứng từ vào ERP hay sửa lời khai / chọn lệnh).
