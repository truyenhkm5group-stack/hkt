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

**Chế độ THỰC TẾ mặc định có đổi số ở MỘT trường hợp hẹp** (đúng là lỗi được sửa, không phải tác dụng phụ):
mã vừa có giá đặt tay cũ, vừa có giá báo MKT, VÀ còn sản phẩm chưa có giá thật. Trước: phần chưa có giá
lấp bằng giá báo; nay lấp bằng giá đặt tay (luật 5'). Kéo theo `expectedCogs`, LN, dự phòng rủi ro, phần
chênh giá báo của bảng MKT (`/reports`, `/ads/daily`, `/reports/target`) và số tiền giá dự tính ở cổng
duyệt đặt xưởng của các mã ấy. Mã có giá thật đủ, hoặc chỉ có một trong hai giá, KHÔNG đổi. Số mã bị
ảnh hưởng trên production phải đo bằng ops `db-query` (kết quả mã hoá, giải trên máy vận hành).

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
nút Lưu chỉ mở khi bản xem trước khớp đúng các ô đang sửa. Xem trước dùng đúng dòng sẽ hiệu lực vào
cuối kỳ của lịch sử SAU khi thêm (dòng có ngày hiệu lực sớm hơn dòng đang áp ⇒ Δ = 0); bỏ giá ở mã còn
sản phẩm chưa có giá thật ⇒ Δ "chưa tính được" (đích phụ thuộc giá tham chiếu). Xem trước cần cả quyền
xem (`reports:nominal` + phạm vi REPORTS) lẫn quyền sửa. Ghi trong một giao dịch khoá dòng `settings`:
hai người lưu cùng lúc không xoá lịch sử của nhau; dòng lịch sử đọc không hiểu được giữ nguyên văn. Nút "Điền giá báo MKT cho mã chưa có kế hoạch"
chỉ ĐIỀN ô, không lưu — biến giá báo thành giá kế hoạch là việc người bấm.

Quyền: xem `reports:nominal`; sửa `reports:assumptions` (như ô cũ).

## 5. Quyết định chủ shop 13/10/2026 (sau PR #834)

1. **Giá vốn thực tế = giá báo MKT đang hiệu lực HÔM NAY, cho MỌI đơn, ở MỌI báo cáo** (lương, BCLN, quảng
   cáo, kế hoạch SX, giá trị tồn theo mẫu mã, hàng hoàn…). Một khối SQL: `lib/queries/current-marketer-cost.ts`,
   đứng đầu `LINE_UNIT_COST` · `lineUnitCost` · `ORDER_COGS` · giá vốn ghi nhận lúc giao. Mã chưa khai giá
   báo (hoặc giá báo đang hiệu lực = 0 ₫) lùi về phiếu nhập gần nhất → Pancake → giá nhập mẫu mã.
   - Đơn có ÍT NHẤT MỘT dòng có giá báo mang căn cứ `MARKETER_PRICE` (các dòng khác vẫn lấy bậc chứng từ
     trong cùng con số) và KHÔNG đóng băng giá vốn ghi nhận: MKT lưu / sửa / xoá giá báo ⇒
     `rematerializeProductOrders` dựng lại giá vốn mọi đơn của mã ngay (nhật ký gộp
     `MARKETER_PRICE_COGS_REBUILD`); job `rematerializeStale` bắt dòng giá vừa tới ngày hiệu lực, dòng giá mới / sửa
     đè (dấu `created_at`) và đơn mang căn cứ giá báo mà mã không còn giá báo. Xoá MỘT dòng giá khi mã còn dòng cũ
     hơn KHÔNG để lại dấu: nếu lượt dựng lại lúc xoá lỗi, màn hình báo lỗi và người bấm phải lưu lại để dựng lại.
     Đơn còn một dòng KHÔNG có nguồn giá nào là CHƯA BIẾT (NULL), không bao giờ ghi tổng thiếu dưới nhãn giá báo. Đơn không có dòng nào có giá báo giữ luật đóng băng 11/09/2026.
   - Ảnh chụp kỳ ĐÃ CHỐT (lương khoá, review FINAL) không đổi. **NHƯNG** lượt quyết toán lương tự động (tháng
     M+2 tính lại kỳ M bằng tỷ lệ đã chốt, luật 71) đọc số HÔM NAY — MKT đổi giá báo trong khoảng đó thì máy
     sinh dòng "Quyết toán … truy thu / truy lĩnh" cho phần **% lợi nhuận toàn shop** (`totalProfit` đi theo giá vốn
     shop = giá báo hiện tại). Phần lợi nhuận cá nhân MKT đi theo giá báo NGÀY LÊN ĐƠN (`cogsDeliveredMkt`) nên chỉ đổi
     ở mã chưa có giá báo ngày lên đơn. Chờ chủ shop quyết có
     giữ hệ quả này không.
2. **Phiếu nhập giữ luật 13**: đơn giá phiếu nhập mới = giá báo MKT theo ngày nhập.
3. Giá vốn KẾ HOẠCH vẫn sửa / áp dụng được ở Trung tâm giá vốn và nút bút BCLN để xem kịch bản (chế độ
   "Giá vốn kế hoạch").
