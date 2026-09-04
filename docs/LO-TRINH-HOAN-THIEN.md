# Rà soát ERP & lộ trình hoàn thiện

Cập nhật: 05/09/2026. Mục tiêu: số liệu ra quyết định (lợi nhuận, dòng tiền, tồn kho, lương) phải đúng với thực tế; phần nào chưa chắc thì ERP phải nói rõ nguồn và độ tin cậy.

## 1. Hiện trạng theo module

| Module | Nguồn số liệu | Độ tin cậy hiện tại | Rủi ro / việc phải làm |
|---|---|---|---|
| Đơn hàng, khách hàng, sản phẩm | Pancake POS API (đồng bộ 3 phút + webhook) | Cao | Webhook Pancake cần URL trong Kết nối dữ liệu để realtime. |
| Trạng thái vận đơn | Pancake (trạng thái do nhân viên cập nhật) + Viettel Post (webhook / tra cứu / **nhập danh sách vận đơn**) | **Trung bình** | API đối tác Viettel Post không trả vận đơn của mã khách GLMTQY → ERP chưa tự cập nhật. Cho đến khi Viettel Post mở API: nhập danh sách vận đơn hằng ngày. Đây là gốc của mọi sai lệch về giao thành công, hoàn, COD, cảnh báo. |
| Doanh thu giao thành công | Kết quả đơn = trạng thái vận đơn VTP kết hợp Pancake (ORDER_OUTCOME) | Đúng khi (2) được cập nhật | Quy tắc “giao thành công nhưng COD = 0, cước < 10K = hoàn” là suy luận; cần đối chiếu định kỳ với danh sách VTP. |
| Giá vốn | Phiếu nhập ERP (giá nhập gần nhất) → Pancake | Cao nếu phiếu nhập đủ | Pancake không có giá vốn; mọi lô nhập phải có phiếu trên ERP. |
| Tồn kho ERP | Nhập − giao thật − đang giao (hoàn coi như về kho) | Cao nếu có kiểm kê đầu kỳ | Chưa có kiểm kê đầu kỳ cho đủ mẫu mã; cột “Tồn Pancake” để đối chiếu. Hàng hoàn chưa về kho thực tế vẫn bị tính là tồn. |
| Kế hoạch đặt hàng SX | Tồn ERP, đơn đã chốt, tốc độ bán ròng, giả định SX | Phụ thuộc (tồn kho) và (trạng thái vận đơn) | Chưa tính mùa vụ / khuyến mãi; tốc độ bán lấy trung bình cửa sổ. |
| Chi phí quảng cáo | Facebook Marketing API theo ngày × chiến dịch, ghép mã / marketer | Cao | Chiến dịch không nhận ra mã → chi phí test (đúng theo yêu cầu). Số đơn/doanh thu Facebook tự báo chỉ để tham khảo. |
| COD & dòng tiền | Bảng kê Viettel Post (dán tổng hợp / file chi tiết / danh sách vận đơn) + sao kê ngân hàng | Trung bình | Tổng hợp đã đúng theo bảng kê; ghép từng vận đơn cần file chi tiết. Chưa đối chiếu tự động bảng kê với tiền vào ngân hàng. |
| Chi phí vận hành | Nhập tay + nhập sao kê MB Bank (chỉ chi phí vận hành) | Cao | Phân loại tự động theo từ khoá, cần người kiểm tra. |
| Lợi nhuận danh nghĩa / ròng | Đơn lên × (1 − tỷ lệ hoàn ước tính) − giá vốn − vận chuyển − QC − vận hành phân bổ − rủi ro tồn kho | Là ước tính | Tỷ lệ hoàn ước tính từ lịch sử 90 ngày; cước bình quân. |
| Lương & hoa hồng | Lợi nhuận dòng tiền thực (mặc định) / danh nghĩa | Trung bình | LN cá nhân theo dòng tiền là quy đổi tỷ lệ; lương chưa được trừ khi tính LN tổng để chia (tránh vòng lặp). |
| Cảnh báo (chuông, Lark, Telegram) | Quy tắc trên đơn / vận đơn / case CSKH / tồn kho, 10 phút + sau webhook | Cao | Số “đơn chờ xử lý” bị thổi phồng khi Pancake không cập nhật trạng thái giao. |
| CSKH | Thẻ / ghi chú đơn, phiếu đổi trả, hội thoại chat Pancake (Pages API) | Trung bình | Nhận diện theo từ khoá → có nhầm; một số page không có gói API. |
| Phân quyền, nhật ký | ERP | Cao | Cần ít nhất 2 quản trị viên; đổi mật khẩu đã gửi qua chat. |

## 2. Các điểm đã phát hiện và đã sửa trong đợt này

- Giá vốn báo cáo = 0 vì đọc ảnh chụp Pancake → chuyển sang giá nhập ERP tính sống.
- Đơn / doanh thu quảng cáo bị nhân ba do cộng dồn nhiều loại sự kiện Facebook → chỉ lấy một loại; KPI đổi sang đơn đã xác nhận Pancake.
- Giao thành công chỉ theo Pancake → theo vận đơn Viettel Post kết hợp Pancake.
- Tiền COD về ngân hàng = 0 → bảng kê Viettel Post (tổng hợp + chi tiết + danh sách vận đơn).
- Chi phí vận hành trùng nhập hàng / quảng cáo → loại khỏi tính toán.
- Chiến dịch có chữ TEST hoặc không có mã → chi phí test.

## 3. Lộ trình hoàn thiện

### Giai đoạn 1 — Số liệu nền đúng (1–2 tuần, cần cả người vận hành)
1. Viettel Post: yêu cầu mở API đối tác cho mã khách GLMTQY (0862 235 888). Trong lúc chờ: mỗi sáng xuất danh sách vận đơn 7 ngày → nhập vào ERP (chọn nhiều tệp).
2. Kiểm kê đầu kỳ toàn bộ mẫu mã (Nhập hàng & kiểm kê → Điều chỉnh) và ghi giá nhập cho mọi lô.
3. Bảng kê Viettel Post: nhập chi tiết từng bảng kê để vận đơn có cước thật và trạng thái “đã về ngân hàng”.
4. Ghép nốt chiến dịch chưa gán marketer (VNX2_, W1_, vid.q2…) và bí danh mã hàng.
5. Cấu hình webhook Pancake; kiểm tra Lark nhận cảnh báo; khai báo nhân sự & cơ chế lương đầy đủ.

### Giai đoạn 2 — Tự động hoá & đối chiếu (2–4 tuần)
1. Khi có API Viettel Post: bật job tra cứu vận đơn + nhập bảng kê tự động; bỏ nhập tay.
2. Đối chiếu ba chiều mỗi ngày: Pancake (đơn) ↔ Viettel Post (vận đơn, COD) ↔ ngân hàng (tiền về) → báo cáo chênh lệch, danh sách vận đơn thiếu tiền.
3. Sao kê ngân hàng: nhập định kỳ; tự khớp tiền Viettel Post chuyển về với bảng kê.
4. Hoàn hàng: ghi nhận nhận hàng hoàn về kho (quét / đánh dấu) để tồn kho không tính hàng hoàn chưa về.
5. Tồn kho theo kho / lô; cảnh báo lệch tồn ERP – Pancake.

### Giai đoạn 3 — Quản trị & dự báo (4–8 tuần)
1. Dự báo bán theo mùa vụ / khuyến mãi cho kế hoạch sản xuất; theo dõi lịch sử đề xuất và thực đặt.
2. Bảng điều khiển theo vai trò: chủ shop (lợi nhuận ròng, dòng tiền, tồn), marketer (CPQC, đơn, LN cá nhân), vận đơn (cần xử lý), CSKH (case).
3. Phân tích hoàn hàng theo mẫu / tỉnh / bưu tá; khách hàng thân thiết; giá trị vòng đời.
4. Mục tiêu KPI và cảnh báo vượt ngưỡng (CPQC/đơn, tỷ lệ hoàn, thời gian xử lý case).

### Giai đoạn 4 — Củng cố kỹ thuật (song song)
1. Kiểm thử tự động cho từng báo cáo (số mẫu cố định → kết quả kỳ vọng), chạy trong CI trước khi deploy.
2. Tổng hợp theo ngày (bảng tổng hợp sẵn) để báo cáo nhanh khi dữ liệu lớn; chỉ mục CSDL.
3. Sao lưu tự động hằng đêm + kiểm tra phục hồi; giám sát uptime; cảnh báo lỗi đồng bộ qua Lark.
4. Bảo mật: đổi mật khẩu đã lộ, 2FA cho quản trị, xoay khoá API định kỳ, giới hạn IP SSH.

## 4. Quy ước để số liệu luôn đúng
- Mọi lô hàng về kho phải có phiếu nhập trên ERP trong ngày.
- Mỗi ngày nhập danh sách vận đơn Viettel Post (cho đến khi có API).
- Mỗi tuần nhập bảng kê COD chi tiết và sao kê ngân hàng.
- Không sửa trạng thái đơn trên Pancake bằng tay khi vận đơn Viettel Post chưa xác nhận.
- Chiến dịch quảng cáo mới phải có mã hàng và bí danh marketer trong tên.
