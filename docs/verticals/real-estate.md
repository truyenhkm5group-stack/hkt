# Bất động sản — mẫu ngành `real-estate-agency` + module `real_estate`

Lộ trình chung: `docs/verticals/ROADMAP.md` (Phần B, dòng «Bất động sản»). Ngành bán CĂN — mỗi căn bán đúng một lần, cho nhiều
sale cùng lúc; không kho số lượng, không vận chuyển.

## Nỗi đau (giả thuyết, cần khách thử xác nhận)

- **Hai sale giữ cùng một căn**: bảng hàng là tệp Excel / nhóm Zalo, cập nhật chậm ⇒ khách đã cọc mới biết căn có người.
- Giữ chỗ không có hạn rõ ⇒ căn «treo» nhiều ngày, sale khác mất khách.
- Cọc, hoàn cọc, khách bỏ cọc không có dấu vết; chủ đầu tư rút căn mà sale không biết.
- Hoa hồng chia nhiều tầng (sale · trưởng nhóm · sàn) — CHƯA làm ở bản này (xem «Chưa làm»).

## Module `real_estate` (0201)

- **Dự án** (`re_projects`): mã, tên, **số giờ giữ chỗ tối đa — BẮT BUỘC khai** (chính sách của chủ đầu tư / sàn, luật 38: không
  có mặc định).
- **Căn** (`re_units`): mã (duy nhất trong dự án), toà / khu, tầng, diện tích, giá niêm yết — trống = chưa công bố, không phải 0.
  Thêm hàng loạt bằng dán danh sách «mã | toà | tầng | diện tích | giá» (diện tích «68,5», giá «3.250.000.000»); dòng hỏng / mã
  trùng ⇒ KHÔNG thêm gì, báo theo dòng.
- **Trạng thái căn KHÔNG lưu cột** (`unitState`, tính lúc đọc): Đã bán > Chủ đầu tư khoá > Đã cọc > Đang giữ chỗ > Còn trống.
- **Giữ chỗ** (`re_holds`): sale giữ cho MỘT khách tới hạn = lúc giữ + số giờ của dự án. **Mỗi căn nhiều nhất MỘT giữ chỗ còn
  hiệu lực**: kiểm trong giao dịch sau khoá tư vấn theo căn, và chỉ mục duy nhất có điều kiện của CSDL chặn lần cuối. Quá hạn
  là tự hết — bảng hàng hiện «còn trống» ngay; dòng quá hạn được chuyển EXPIRED khi có lượt giữ mới. Sale nhả giữ chỗ của mình
  không cần lý do; quản lý nhả hộ cần lý do.
- **Cọc** (`re_deposits`): mỗi căn nhiều nhất MỘT khoản cọc còn hiệu lực. Căn mình đang giữ ⇒ chuyển thành cọc (khách của lượt
  giữ); căn còn trống ⇒ cọc thẳng (cần tên khách); căn người khác đang giữ ⇒ CHẶN — khách của lượt giữ là của sale giữ. Hoàn cọc
  / khách bỏ cọc: quản lý, bắt buộc lý do, căn trở lại còn trống.
- **Ký bán**: quản lý, cần cọc đang hiệu lực + số hợp đồng; cọc chuyển «đã ký bán», căn «đã bán» không đổi nữa.
- **Khoá căn** (chủ đầu tư rút): quản lý, bắt buộc lý do, căn không đang có người giữ / cọc.
- **Riêng tư**: khách của một lượt giữ / cọc chỉ hiện cho CHÍNH sale đó và quản lý; sale khác chỉ thấy ai đang giữ và tới bao giờ.
- **Quyền**: `real_estate:view` · `real_estate:hold` (sale — vai trò CS mặc định có view + hold) · `real_estate:manage` (quản lý
  sàn). Module TẮT ở tổ chức nhà.
- **Màn hình** `/real-estate`: «Căn tôi đang giữ» (sắp hết hạn trước), chọn dự án, lọc theo trạng thái kèm số đếm, sơ đồ căn
  theo màu, danh sách căn với nút đúng trạng thái + quyền, thêm căn, tạo dự án.

## Mẫu `real-estate-agency`

Module: lõi · công việc · khách · CSKH · tài chính · bảng hàng. Vai trò «Sale bất động sản» và «Quản lý sàn». Field khách: giai
đoạn (mới → đã tư vấn → đã xem nhà mẫu → đã cọc / ngừng), ngân sách, nhu cầu; trang «Khách tiềm năng» dạng kanban. Luật NHÁP:
khách «Đã xem nhà mẫu» ⇒ việc gọi lại trong 48 giờ. Không khai giờ giữ chỗ / mức cọc / hoa hồng mặc định.

## Chưa làm

- **Hoa hồng nhiều tầng** (sale · trưởng nhóm · sàn, theo tiến độ thanh toán của khách) — cần chủ shop / khách thử chốt cơ sở
  tính (AGENTS.md mục 16: hoa hồng đi theo ĐƠN, không đoán cơ sở).
- Hàng chờ giữ chỗ (khách thứ hai xếp hàng khi căn đang giữ), tiến độ thanh toán theo đợt sau ký bán, phiếu đặt cọc in được.
- Nhắc sale khi giữ chỗ sắp hết hạn — cần lịch chạy (chủ shop quyết).
