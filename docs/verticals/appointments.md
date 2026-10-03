# Lịch hẹn & liệu trình — module `appointments` (ngành Spa / dịch vụ có lịch)

> Migration `0190_appointments`. Mã nằm ở 4 tệp:
> - `lib/constants/appointments.ts` — luật thuần;
> - `lib/records/appointments.ts` — đường ghi;
> - `lib/queries/appointments.ts` — đọc;
> - `lib/actions/appointments.ts` — vỏ Next.
>
> Màn hình: `/appointments` và khung «Lịch hẹn & liệu trình» trên trang khách. Kiểm thử ở `tests/appointments.test.ts`.
> Mẫu ngành: `spa-beauty`, chọn khi đăng ký `/start` bằng loại hình «Spa / làm đẹp».

## Vì sao là một module lõi, không phải đối tượng tuỳ biến

Hai việc mà đối tượng tuỳ biến làm không được:
- **Chặn trùng giờ trong giao dịch.** Hai lễ tân đặt cùng lúc cho cùng một kỹ thuật viên thì lượt sau phải thấy lượt trước.
- **Số buổi liệu trình đếm từ lịch thật.** Đối tượng tuỳ biến chỉ có giá trị jsonb tự do, không có trường tính và không có
  lượt ghi nguyên tử.

Spa, salon, phòng khám, gym và sửa xe đều cần đúng hai việc này. Vì vậy chúng thành **một module dùng chung**, bật / tắt
theo tổ chức như mọi module khác.

## Luật

- **Lịch hẹn** gồm: khách, dịch vụ (mẫu mã của module Sản phẩm, tên được chụp lại), kỹ thuật viên (khoá tài khoản), giờ bắt
  đầu và kết thúc theo khoảng `[bắt đầu, kết thúc)`, trạng thái, liệu trình (nếu có), ghi chú.
- **Trạng thái:** Đã đặt → Khách đã xác nhận → Khách đã tới → Đã làm xong. Hai lối ra: Khách không tới, hoặc Đã huỷ
  (bắt buộc lý do). Ba trạng thái cuối không đổi nữa; ghi nhầm thì đặt lịch mới.
- **Chặn trùng giờ:** một kỹ thuật viên không có hai lịch ĐANG HIỆU LỰC (đã đặt, đã xác nhận, đã tới) chồng giờ.
  - Lịch chạm mép không tính là chồng: lịch kết thúc 10:00 và lịch bắt đầu 10:00 đặt được.
  - Lịch đã huỷ hay khách không tới không chiếm giờ.
  - Phép kiểm chạy trong giao dịch, sau `pg_advisory_xact_lock` theo kỹ thuật viên.
- **Liệu trình:** gói N buổi khách trả trước. Lễ tân mở liệu trình sau khi khách trả tiền gói (thường qua một đơn tạo tay).
  - Số buổi **đã làm** và **đang giữ chỗ** không lưu ở đâu: đếm từ lịch gắn gói, theo hai luật:
    - lịch làm xong ⇒ trừ một buổi;
    - lịch không tới hoặc huỷ ⇒ nhả chỗ giữ, không trừ buổi nào.
  - Hết buổi, đã đóng, hay quá ngày hết hạn ⇒ không đặt thêm được.
  - Liệu trình không dùng chéo khách.
- **Quyền:** `appointments:view` / `appointments:write`, cả hai thuộc module `appointments`.
  - Vai trò CS (lễ tân) có cả hai theo mặc định.
  - Vai trò lưu sẵn trên production không tự nhận khoá mới: quản trị tổ chức cấp ở trang Người dùng.
- **Tổ chức nhà:** module TẮT (`homeOptIn` + dòng TẮT trong 0190). VNX không thấy menu và không có trang này.

## Chatbot đặt lịch

Bật ở Chatbot bán hàng → khung «Đặt lịch qua chat» (chỉ hiện khi tổ chức bật module Lịch hẹn). Mặc định TẮT.

- **Theo sức chứa, không theo người.** Shop khai giờ mở cửa, ngày nhận lịch, độ dài một lịch (cũng là bước chia giờ), «số
  khách phục vụ cùng lúc» (giường / ghế), đặt trước tối thiểu và nhận xa nhất bao nhiêu ngày (`lib/constants/booking.ts`).
  Một giờ còn nhận khi số lịch ĐANG HIỆU LỰC chồng lên nó — mọi lịch, kể cả lịch lễ tân đặt tay — còn dưới sức chứa.
- **Bot không chọn kỹ thuật viên.** Máy không biết hôm nay ai nghỉ; lịch bot đặt vào trang Lịch hẹn ở «— Chưa xếp —», lễ
  tân xếp người, và người xem được lịch hẹn nhận tin «Chatbot vừa đặt lịch hẹn» trong chuông.
- **Hai công cụ, chỉ khi bật + module bật:** `find_booking_slots` (giờ trống của một ngày, kèm ngày gần nhất còn chỗ) và
  `book_appointment`. Ghi khi và chỉ khi lời đồng ý của khách nằm NGUYÊN VĂN trong câu cuối của khách (như chốt đơn).
- **Sức chứa kiểm hai lần:** một lần ở lưới giờ bot đọc cho khách, một lần trong giao dịch sau khoá tư vấn chung của tổ
  chức (`createAppointmentAsAgent`) — hai khách chat cùng lúc không lấy được chỗ cuối cùng.
- **Khách đặt lịch không cần địa chỉ** (`createCustomerAsAgent(…, { addressOptional: true })`); SĐT đã có trong sổ ⇒ dùng
  lại khách đó. Mọi đường lên ĐƠN vẫn bắt buộc địa chỉ.
- **Một hội thoại một lịch.** Đổi / huỷ / chọn người / đặt cho nhiều người ⇒ bot chuyển nhân viên.
- Khung thử chỉ mô phỏng: không khách, không lịch, không tin báo.

## Nhắc lịch ngày mai

Khi xem lịch HÔM NAY, người có `appointments:write` thấy khung «Nhắc lịch ngày mai»: các lịch ngày mai còn ở «Đã đặt»
(khách chưa xác nhận), mỗi lịch một câu nhắc soạn sẵn (`reminderText` — giờ Việt Nam, không giá), nút «Sao chép câu
nhắc» và «Mở Zalo» (chỉ dựng từ số điện thoại hợp lệ). Khách đồng ý ⇒ bấm «Khách đã xác nhận» ngay trên dòng; lịch rời
khung. Lễ tân GỬI TAY — gửi tự động theo giờ cần lịch chạy mới và kênh gửi (Zalo OA), phải chủ nền tảng duyệt.

## Bước sau

- Bot đọc giờ trống theo từng kỹ thuật viên (cần lịch làm việc của người — chưa có).
- Gửi nhắc lịch TỰ ĐỘNG qua Zalo OA / tin nhắn. Hiện bộ máy luật chưa có trigger theo thời gian; lễ tân gửi tay từ khung «Nhắc lịch ngày mai».
- Lịch dạng lưới theo giờ × kỹ thuật viên. Hiện là danh sách theo người.
- Hoa hồng kỹ thuật viên theo buổi đã làm. Phải đi theo luật 16 (lương ≠ hoa hồng).
