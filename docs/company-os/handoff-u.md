# Company OS — Bàn giao Agent U (xác định mẫu mã cho hàng hoàn KHÔNG NHÃN sau khi nhận)

Nhánh `claude/cos-gan-mau-hoan-khong-nhan` (từ `origin/main` f1b4ddb4) · migration `0144_company_os_unidentified_identify` (journal `when = 1790006483765`, theo Tech Lead).

## Khoảng trống được đóng

Agent R ghi: món hàng hoàn không nhãn chỉ chọn được mẫu mã LÚC NHẬN KIỆN. Món nhận vội chưa nhận ra mẫu thì không bao giờ đếm được về mẫu nào và không nhập lại tồn được sau khi sửa — chỉ còn huỷ / trả xưởng. `setUnidentifiedConditionAction` có nhận `variantId` nhưng không màn hình nào gọi, không ghi ai chọn, không chặn đổi mẫu khi hàng đã vào tồn.

Nay có MỘT đường bấm: **Xác định mẫu mã** → gõ mã chủ shop (`Q001`…) → bấm màu → bấm size → xác nhận. Có ở hai chỗ, cùng một biểu mẫu: dòng của bàn "Hàng hoàn không có mã vận đơn" và dòng "không nhãn" trong khối "Hàng hoàn không tái nhập".

## Đã dựng

| Phần | Tệp |
|---|---|
| 0144: `variant_identified_at` · `variant_identified_by` (ảnh chụp tên) · `variant_identified_by_user_id` (FK users SET NULL) · `variant_identify_note`. NULL được, không DEFAULT, không backfill. CHECK `return_unidentified_variant_identified_check`: mốc và tên đi cùng nhau. Tách khỏi `identified_*` (đó là nối ĐƠN). | `db/schema.ts`, `drizzle/0143_…sql`, `_journal.json`, `tests/migration-upgrade-path.test.ts` (MOI + khối khẳng định) |
| Luật thuần `checkVariantIdentify` (ASSIGN · CHANGE · SAME; lỗi NO_VARIANT · STALE · STOCK_RECEIVED · NEEDS_REASON), `unidentifiedStockReceived`, `VARIANT_FIX_ADJUSTMENT_HREF` | `lib/constants/return-unidentified.ts` |
| `unidentifiedReworkRestockRowsSql` / `unidentifiedReworkRestockRows` (SQL chạm sổ vẫn nằm trong tệp của sổ) | `lib/queries/return-dispositions.ts` |
| `identifyUnidentifiedVariant` — đường ghi DUY NHẤT sau lúc nhận: khoá dòng `FOR UPDATE`, đọc phiếu nguyên món + dòng `RESTOCK_AFTER_REWORK` TRONG khoá, hỏi luật, ghi mẫu + ảnh chụp + người + mốc + ghi chú, phát `return.variant_identified` cùng giao dịch. Không chạm tồn. `variantsOfProductCode` (qua `resolveProductByCode`; mã mơ hồ ⇒ không chọn hộ; mẫu ẩn vẫn hiện, gắn "ngừng bán"). `setUnidentifiedCondition` THÔI nhận mẫu mã. Nhận kiện có chọn mẫu cũng ghi người / mốc. `listUnidentifiedReturns` trả `holdingQty` + `reworkRestockRows`; `HOLDING_QTY_SQL` là MỘT biểu thức cho tiêu đề bàn và từng dòng. Dòng thời gian của món có bước "Xác định mẫu mã". | `lib/returns/unidentified.ts` |
| `identifyUnidentifiedVariantAction` (`inventory:write`, nhật ký `return.unidentified.variant_identified` / `…variant_changed` với trước/sau), `variantsOfProductCodeAction`. Action đổi kết luận bỏ `variantId`. | `lib/actions/returns-unidentified.ts` |
| Sự kiện `return.variant_identified` LIVE (chủ E — miền hàng hoàn; subject `return_inspection`, `subject_id = unidentified:<id>`, `payload.grain = "UNIDENTIFIED"`; `model_id` khi sản phẩm đã vào sổ mẫu) + nhãn tiếng Việt; chiều dòng thời gian INVENTORY có sẵn qua subject. | `lib/constants/domain-events.ts`, `tests/company-os-models.test.ts` (danh sách hợp đồng +1) |
| Ô chọn chung `VariantPicker` (mã hàng → màu → size, rơi về tìm tự do) + `IdentifyVariantPanel`. Bàn không nhãn bỏ bản ô chọn riêng. | `app/(dashboard)/inventory/returns/identify-variant.tsx` (mới), `unidentified-section.tsx`, `disposition-section.tsx`, `page.tsx` |
| Lỗi hiển thị của R: dòng bàn không nhãn in "× <còn giữ tạm> (nhận N)"; hết phần giữ tạm thì nhãn "Đã có kết cục cho toàn bộ". | `unidentified-section.tsx` |
| Biểu mẫu "Sửa xong · nhập lại" của món không nhãn chưa có mẫu nói trước và khoá nút Ghi; thông điệp máy chủ trỏ nút mới. | `disposition-section.tsx`, `lib/returns/disposition.ts` (một dòng chữ) |
| Kiểm thử | `tests/company-os-unidentified-identify.test.ts` (đăng ký ngay sau R) |

## Quyết định cần biết

1. **"Đã có hàng vào tồn" chặn cả lượt GÁN**, không chỉ lượt đổi: mẫu cũ có thể bị xoá khỏi danh mục (FK SET NULL) trong khi phiếu vẫn còn — gán mẫu mới lúc ấy là để phiếu và món nói hai điều. Sửa bằng phiếu ĐIỀU CHỈNH (`/inventory/receipts`).
2. **Dòng sổ WRITE_OFF / RETURN_TO_SUPPLIER / REWORK ghi dưới mẫu cũ không chặn lượt đổi** (đề bài chỉ chặn khi có tồn). Dòng sổ giữ `variant_id` là ẢNH CHỤP lúc ghi — không sửa lùi. Hệ quả nhỏ: ô `decisions` của tóm tắt mẫu (đếm theo `return_dispositions.variant_id`) vẫn tính dòng cũ ở mẫu cũ / không mẫu nào; các ô số món (gập từ đối tượng, theo mẫu HIỆN TẠI) chuyển theo mẫu mới.
3. **Chọn lại đúng mẫu đang có không ghi gì** (không nhật ký, không sự kiện, không đổi mốc). Màn hình gửi kèm mẫu nó ĐANG THẤY (`expectedVariantId`); khác CSDL ⇒ từ chối "vừa được người khác xác nhận / đổi".
4. **Máy không xác nhận được mẫu**: `actor.id` null ⇒ từ chối (và CHECK sự kiện USER của `domain_events` chặn lần hai).
5. **Không phát sự kiện cho lượt chọn mẫu lúc nhận kiện** — lượt đó là một phần của biên bản nhận; chỉ ghi người / mốc. Sự kiện đánh dấu lượt xác định SAU.
6. Không có ảnh món hàng: `return_unidentified` không lưu ảnh. Biểu mẫu hiện ghi chú kiểm + ghi chú kho; ô chọn size hiện ảnh DANH MỤC của mẫu (nếu có) để đối chiếu.
7. Không gắn cổng duyệt hai bước: lượt này không đổi một con số tồn / tiền nào.

## Cổng (Windows, worktree riêng, SHA 7dd74a4c)

`npm run typecheck` sạch · `npm run lint` sạch · `npm test` in **TẤT CẢ KIỂM THỬ ĐẠT** (535 dòng ✓) · `npm run build` thành công (`/inventory/returns` 44,5 kB).

### Kiểm đột biến (16/16 bị bắt, chạy riêng bộ U + R rồi hoàn nguyên)

M1 luật bỏ chặn khi đã có tồn · M2 bỏ bắt buộc lý do khi đổi · M3 bỏ chặn màn hình cũ · M4 dịch vụ không đọc dòng nhập lại sau sửa · M5 không ghi khoá tài khoản · M6 chọn lại đúng mẫu vẫn ghi · M7 lập phiếu kho khi gán · M8 dòng bàn in số món ban đầu · M9 gán không ghi `variant_id` · M10 action bỏ kiểm quyền · M11 đổi kết luận nhận lại mẫu mã · M12 không phát sự kiện · M13 migration bỏ CHECK mốc–tên · M14 máy (`actor.id` null) xác nhận được (bắt bởi CHECK sự kiện USER) · M15 nhận kiện có mẫu không ghi người · M16 tiêu đề bàn và dòng dùng hai biểu thức.

Không kiểm được bằng đột biến: đua hai giao dịch thật giữa lượt đổi mẫu và lượt nhập lại — bài quét mã nguồn đòi khoá `FOR UPDATE` + đọc sổ bằng `tx`.

### Đường bấm có thật (next start + PGlite + seed demo, Chrome headless qua playwright-core, 1440px)

Gieo `UR-20260926-00001` (3 món hỏng, không lần ra đơn, CHƯA có mẫu). Tài khoản quản trị, `/inventory/returns`:
- Khối kết cục trước: "không nhãn, chưa gán mẫu: 3 món còn mở".
- Bàn không nhãn → **Xác định mẫu mã** → gõ `sp001` → màu hiện "Be · Đen · Đỏ đô" → **Đen** → size "L · M · S" → **M** → **Xác nhận mẫu mã** → "đã xác định mẫu mã SP001-ĐE-M · Đen · M. Hàng vẫn GIỮ TẠM…". Tải lại: con số "chưa gán mẫu" biến mất; dòng kết cục in "SP001-ĐE-M · Đen · M".
- Khối "Hàng hoàn không tái nhập" → **Đưa đi sửa / giặt** → Ghi → **Sửa xong · nhập lại** (biểu mẫu báo cộng tồn KHÔNG chứng từ, lý do bắt buộc) → 2 món + lý do → Ghi → lịch sử "Sửa xong · nhập lại tồn · 2 món · phiếu tái nhập".
- Tải lại: dòng bàn "SP001-ĐE-M · Đen / M × 1 (nhận 3)"; nút "Đổi mẫu mã" biến mất, thay bằng "Sai mẫu mã? … phiếu điều chỉnh kho".
- Món thứ hai `UR-…00002` (2 món bẩn) đi từ DÒNG KẾT CỤC: "Sửa xong · nhập lại" khi chưa có mẫu ⇒ cảnh báo + nút Ghi khoá → **Xác định mẫu mã** trên dòng (Be/L) → **Đổi mẫu mã** (nút khoá tới khi có lý do) → Be/M + "Đo lại thì là size M" → nhập lại 2 món → "Đã nhập lại 2 món vào tồn qua phiếu tái nhập". Lỗi console: 0.

## Còn lại

- Tech Lead: thêm dòng `return.variant_identified` (chủ E, LIVE từ Agent U) vào `shared-contracts.md` mục 2 và `0144` vào mục 7 — hai tệp của Tech Lead nên tôi không sửa.
- Chưa đo production (không có quyền). Sau deploy, món cũ có mẫu chọn lúc nhận hiện "chưa rõ ai xác nhận" (NULL, không backfill).
- Dòng sổ cũ ghi dưới mẫu cũ không theo lượt đổi (quyết định 2).
