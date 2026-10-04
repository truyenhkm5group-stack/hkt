# Homestay / Airbnb — mẫu ngành `homestay` + module `stays`

Lộ trình chung: `docs/verticals/ROADMAP.md` (Phần B). Lưu trú ngắn ngày KHÔNG dùng lại chuỗi đơn → kho → vận chuyển: thứ được
bán là ĐÊM của một PHÒNG, trên nhiều kênh cùng lúc.

## Nỗi đau (giả thuyết, cần khách thử xác nhận)

- **Trùng phòng (overbooking)**: một phòng bán trên Airbnb, Booking, Agoda và khách quen nhắn Zalo. Kênh nào cũng chỉ biết lịch của
  mình; lễ tân đối chiếu bằng mắt ⇒ hai khách cùng tới một phòng.
- **Dọn phòng**: khách trả sáng, khách mới nhận chiều — buồng phòng không biết phòng nào gấp, phòng nào đã dọn.
- **Báo cáo chủ nhà**: đơn vị vận hành hộ nhiều chủ nhà phải gom tay từng kênh để báo đêm bán, lấp đầy, doanh thu mỗi tháng.
- Kênh KHÔNG cấp API cho chủ nhỏ (Airbnb chỉ mở API cho channel manager được duyệt). Thứ mọi kênh đều có là **lịch .ics**.

## Module `stays` (0198)

- **Phòng** (`stay_units`): mã (duy nhất, không phân biệt hoa thường), tên, sức chứa, địa chỉ, chủ nhà, đang cho thuê / ngưng.
- **Lượt đặt** (`stay_bookings`): khoảng NỬA MỞ [ngày nhận, ngày trả) — trả sáng ngày 5, nhận chiều ngày 5 KHÔNG trùng. Ba trạng
  thái: Đã đặt · Khoá ngày · Đã huỷ (bắt buộc lý do). Hai nguồn: `MANUAL` (gõ trong ERP) và `ICAL` (nhập từ lịch kênh, khoá tự
  nhiên phòng + kênh + UID của kênh). Tiền, tên khách, SĐT bổ sung được cho mọi lượt; tiền trống = CHƯA BIẾT (luật 42).
- **Đặt tay trùng ⇒ CHẶN** (giao dịch + khoá tư vấn theo phòng; hai lễ tân bấm cùng lúc chỉ một người được). **Nhập lịch kênh
  KHÔNG chặn**: kênh đã bán thật, nuốt mất lượt đó là để khách đến nơi mới biết — trùng phòng hiện ĐỎ đầu trang.
- **Vọng lịch**: ERP phát lịch cho Airbnb, Airbnb xuất lại chính những ngày đó dưới dạng «Not available». Ngày KHOÁ nhập từ kênh
  không tính trùng phòng, không chặn đặt tay (chỉ nhắc), không phát lại ra lịch của ERP; vẫn làm đêm ấy «không bán được» khi
  tính lấp đầy. Đặt phòng thật (mọi kênh) và ngày chủ khoá TRONG ERP luôn tính.
- **Nhập lịch** (`importStayIcsCore`): dán nội dung hoặc chọn tệp `.ics`; CHẠY THỬ trước (cùng hàm kế hoạch `planIcsImport` với
  lượt ghi). Sự kiện mới ⇒ tạo; đổi ngày / đổi loại ⇒ cập nhật; kênh ghi CANCELLED ⇒ huỷ; lượt iCal sắp tới / đang ở mà tệp
  không còn ⇒ huỷ («Không còn trong lịch của kênh»); lượt đã trả phòng KHÔNG đụng (lịch kênh tự rụng lượt cũ). Nhập lại cùng
  tệp không nhân bản. Mọi lượt (kể cả chạy thử) vào sổ `stay_ical_imports` kèm checksum nội dung. Lượt của kênh không huỷ tay
  được — huỷ trên kênh rồi nhập lại.
- **Đường dẫn lịch công khai** `GET /api/ical/<mã tổ chức>.<token phòng>.ics[?kenh=airbnb]`: không phiên, token phòng 24 byte
  ngẫu nhiên đổi được («Đổi đường dẫn»). Sai token / tổ chức không hoạt động / module tắt / phòng ngưng ⇒ cùng một 404. Nội dung
  chỉ có ngày và chữ «Đã đặt» / «Khoá ngày» — không tên, SĐT, tiền. `?kenh=` bỏ lượt của chính kênh đó. Không gọi ra ngoài,
  không ghi gì.
- **Dọn phòng** (`stay_turnovers`): phòng có khách trả hôm nay / ngày mai; phòng có khách nhận cùng ngày lên đầu. «Dọn xong» một
  lần cho (phòng, ngày), bỏ đánh dấu được; người dọn đi bằng khoá tài khoản.
- **Báo cáo chủ nhà** (thẻ «Chủ nhà», theo tháng): lượt, đêm bán, đêm khoá, lấp đầy = đêm bán / (đêm trong tháng − đêm khoá),
  tính THEO TỪNG ĐÊM (hai bản ghi chồng nhau không đếm hai lần; không còn đêm bán được ⇒ «—», không phải 0%); doanh thu theo
  ngày nhận phòng chỉ cộng lượt đã ghi tiền, lượt chưa ghi tiền đếm riêng.
- **Quyền**: `stays:view` / `stays:write` (vai trò CS mặc định có cả hai). Module TẮT ở tổ chức nhà.

## Mẫu `homestay`

Module: lõi · công việc · khách · chăm sóc khách · tài chính · lưu trú. Vai trò «Lễ tân / quản lý đặt phòng» và «Buồng phòng»
(cần `stays:write` để bấm «Dọn xong» — nghĩa là cũng đặt / huỷ được lượt tay; tách quyền dọn phòng riêng khi khách thử cần).
Field khách: trong / ngoài nước (khai báo tạm trú), đánh giá khách (Tốt · Cần lưu ý · Không nhận lại), sở thích khi ở. Luật NHÁP:
khách chuyển «Cần lưu ý» ⇒ việc cho lễ tân ghi rõ sự việc. Không khai giá phòng / tỷ lệ chia chủ nhà mặc định (luật 38).

## Chưa làm — cần chủ shop quyết

- **Tự tải lịch kênh định kỳ** (ERP gọi URL .ics của Airbnb / Booking mỗi 15–30 phút): là gọi ra dịch vụ bên ngoài + thêm lịch
  scheduler ⇒ AGENTS.md mục 7. Bản đầu cho dán / tải tệp tay; kênh vẫn tự tải lịch ERP phát ra nên chiều ERP → kênh đã tự động.
- Lượt khách trực tiếp ↔ hồ sơ khách (`customers`), cọc / thanh toán, chia doanh thu chủ nhà theo hợp đồng, khai báo tạm trú.
