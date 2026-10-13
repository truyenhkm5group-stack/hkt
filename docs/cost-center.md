# Trung tâm giá vốn — một nơi đặt giá vốn kế hoạch, hai chế độ báo cáo

Chủ shop giao 13/10/2026 (P0 "Hợp nhất toàn bộ quản lý giá vốn"). Tài liệu này là luật; mã ở
`lib/constants/estimated-cost.ts` (luật thuần), `lib/actions/estimated-cost.ts` (đường ghi duy nhất),
`lib/queries/profit-nominal.ts` (báo cáo), `lib/queries/cost-center.ts` + `/inventory/cost-center` (màn hình).
Kiểm thử: `tests/cost-center.test.ts` (8 kịch bản nghiệm thu) + `tests/estimated-cost.test.ts`.

## 1. Lỗi P0 — "sửa giá vốn giả định trên BCLN không áp dụng"

Nguyên nhân gốc có HAI lớp, cả hai trong `getNominalProfitReport`:

1. **Giá thật luôn thắng.** Giá dự tính chỉ lấp sản phẩm mà `LINE_UNIT_COST` ra 0. Mã có phiếu nhập
   (Q004: phiếu 185.000) ⇒ `cogsUnknownQty = 0` ⇒ con số vừa sửa bị bỏ qua hoàn toàn.
2. **Giá báo MKT thắng số đặt tay** (luật 5 cũ, 26/09/2026). Mã có giá báo (Q004: 160.000) ⇒ mọi con số
   đặt tay, kể cả nút "Dùng làm giá ước tính" của bảng giá thành đã chốt, đều bị giá báo đè. Màn hình
   còn GIẤU ô sửa trong trường hợp này.

Bộ đệm KHÔNG phải nguyên nhân: action đã `clearMemo()` + `revalidatePath("/reports")`.

## 2. Luật mới

| # | Luật |
|---|------|
| 5' | **Giá kế hoạch đặt tay thắng giá báo MKT.** Giá báo chỉ là tham chiếu lùi cho mã CHƯA đặt kế hoạch, mang nguồn `MARKETER_PRICE` + nhãn "Tạm tính". Lương MKT vẫn đọc giá báo — đó là cơ sở hoa hồng, không phải giá vốn của shop. |
| 6 | **Ngày hiệu lực + lịch sử, không xoá.** Mỗi lần đặt là một dòng (`PlannedCostEntry`: giá, ngày hiệu lực, lý do, người — email + `users.id`, lúc ghi). "Bỏ giá" cũng là một dòng. Mỗi mã có ĐÚNG MỘT dòng hiệu lực tại một thời điểm: ngày hiệu lực muộn nhất ≤ thời điểm (giờ VN), hoà thì dòng ghi sau. Bản lưu cũ đọc như hiệu lực từ đầu — không migration, không backfill. |
| 7 | **Hai chế độ BCLN** (`?gv=kehoach`). `ACTUAL` (mặc định, như cũ): giá chứng từ, chỗ trống lấp bằng giá kế hoạch ⇒ "Tạm tính". `PLANNED`: mã đã đặt giá kế hoạch tính TOÀN BỘ theo giá kế hoạch (kể cả khi có phiếu nhập); mã chưa đặt đứng trên giá thật, nhãn "Thực tế (chưa đặt kế hoạch)". Giá báo MKT không bao giờ là giá kế hoạch. |

Giá kế hoạch áp theo dòng hiệu lực vào **cuối kỳ** đang xem (kỳ "Toàn bộ" ⇒ hôm nay) — cùng mốc với giá báo cũ.

## 3. Nguồn giá vốn — trước / sau

| Chỗ | Trước | Sau |
|---|---|---|
| BCLN · nút bút "Bàn dự tính" | Ghi `profit.estimatedCosts`, chỉ hiện khi thiếu giá, bị giá báo + giá thật che | Ghi CÙNG đường `setPlannedCosts`; hiện ở mọi mã; mở đúng giá kế hoạch đang lưu |
| BCLN · giá vốn | Một chế độ: thật → dự tính (giá báo > đặt tay) → 0 | Hai chế độ có nhãn từng dòng (Thực tế / Tạm tính / Kế hoạch / Chưa biết) |
| Bảng giá thành (Sản xuất) | "Dùng làm giá ước tính" — bị giá báo đè | "Dùng làm giá kế hoạch" — cùng đường ghi, chỉ bản ĐÃ CHỐT |
| Phiếu nhập kho | Đơn giá = giá báo MKT theo ngày nhập (luật 13) | **Không đổi.** Phiếu không ghi vào giá kế hoạch (kiểm thử quét mã nguồn) |
| Giá báo MKT | Thắng giá dự tính | Chỉ tham chiếu lùi + cơ sở hoa hồng; không ghi vào giá kế hoạch |
| Giá SX xưởng | Chỉ đọc ở tab Giá SX thực tế | Chỉ đọc, hiện thêm ở Trung tâm giá vốn kèm "tạm tính / đã chốt"; không tự thành giá vốn |
| Đặt xưởng · cổng duyệt | Giá báo > đặt tay | Giá kế hoạch > giá báo (cùng `getEstimatedCosts`) |
| Lương, dòng tiền thực, sổ kho, AI | Không đọc giá dự tính | Không đổi — vẫn không đọc |

## 4. Trung tâm giá vốn (`/inventory/cost-center`, phòng Tài chính)

Theo mã: giá kế hoạch (sửa được, hàng loạt) + ngày hiệu lực + người sửa + lịch sử · phiếu kho gần nhất ·
giá SX xưởng (tạm tính / đã chốt) · giá báo MKT (tham chiếu) · giá vốn / sp BCLN đang dùng ở **cả hai
chế độ** trong kỳ chọn (đọc từ chính `getNominalProfitReport`, nên không thể lệch BCLN) · chênh kế hoạch − phiếu.

Sửa hàng loạt: gõ giá (0 = bỏ giá) → chọn ngày hiệu lực (trống = mọi kỳ) → lý do → **Xem trước tác động**
(Δ giá vốn, Δ LN danh nghĩa, Δ LN ròng gồm dự phòng rủi ro tồn kho, theo kỳ chọn — `plannedCostImpact`) →
nút Lưu chỉ mở khi bản xem trước khớp đúng các ô đang sửa. Nút "Điền giá báo MKT cho mã chưa có kế hoạch"
chỉ ĐIỀN ô, không lưu — biến giá báo thành giá kế hoạch là việc người bấm.

Quyền: xem `reports:nominal`; sửa `reports:assumptions` (như ô cũ).

## 5. Những gì CỐ Ý chưa đổi (cần chủ shop quyết)

1. **Phương pháp giá vốn thực tế.** `LINE_UNIT_COST` = đơn giá phiếu NHẬP gần nhất của mẫu mã → giá vốn
   Pancake trên đơn → giá nhập mẫu mã. Đổi sang bình quân gia quyền / FIFO theo lô là đổi số lợi nhuận
   mọi báo cáo (AGENTS.md mục 7) — bản này không làm.
2. **Luật 13 (phiếu nhập định giá bằng giá báo MKT).** Yêu cầu nói "phiếu nhập chỉ ghi đơn giá thực tế
   của lô". Hôm nay kho không nhập giá, nên bỏ luật 13 ⇒ phiếu mới ghi 0 = CHƯA BIẾT. Cần chủ shop chọn
   nguồn đơn giá thật cho phiếu (hoá đơn xưởng / giá SX đã chốt) trước khi đổi.
3. **Q001–Q004 trên production.** Chênh BCLN ↔ SX thực tế là đúng thiết kế (BCLN không đọc sổ xưởng);
   chênh nhỏ kiểu 149.821 vs 150.000 là bình quân của nhiều mẫu mã khác giá (phiếu cũ / giá Pancake).
   Con số từng mẫu mã phải đo bằng ops `db-query` (kết quả mã hoá — mục 4) trên máy vận hành.
