# Xác minh số điện thoại khi đăng ký — mã OTP qua Zalo ZNS

## Vì sao

Khi đăng ký nhanh ở `/start`, số điện thoại người đăng ký trở thành **danh tính đăng nhập** (`platform_identities`, loại `PHONE`). Nếu không xác minh, ai cũng có thể đăng ký bằng số của người khác. Mã OTP gửi qua Zalo ZNS chứng minh người đăng ký đang cầm máy có số đó.

## Người vận hành bật thế nào

1. **Nối Zalo OA cho tổ chức nhà**: Kết nối dữ liệu → Zalo OA. Đây là cùng kết nối mà chatbot dùng cho kênh Zalo: token được mã hoá và tự làm mới. Không có khoá thứ hai ở biến môi trường.
2. **Đăng ký mẫu ZNS loại OTP** trên ZCA (Zalo Cloud Account), chờ Zalo duyệt, rồi nạp tiền ZNS. Mẫu có **một** tham số chứa mã, thường tên là `otp`.
3. Vào `/platform`, mục **C · Xác minh SĐT qua Zalo khi đăng ký**:
   1. nhập mã mẫu và tên tham số;
   2. bấm **Gửi thử** tới số của chính mình; mã thử không ghi vào bảng mã và không mở đường đăng ký;
   3. bấm **Bật**.

Mặc định là **TẮT**. Hệ thống không cho bật khi chưa có mã mẫu, hoặc khi tổ chức nhà chưa nối Zalo OA.

## Khách thấy gì

- Đăng ký nhanh có thêm một bước. Bấm **Gửi mã xác minh qua Zalo**, nhập 6 số nhận được, rồi bấm **Tạo cửa hàng**.
- Có nút **Gửi lại mã**, mở lại sau 60 giây.
- Người vận hành tạo hộ khách (`/start?day-du=1` khi đang đăng nhập nhà) không cần mã.
- Trình hướng dẫn đầy đủ không nhận SĐT, nên không có bước mã.

## Luật

| Luật | Giá trị (`PHONE_OTP_LIMITS`) |
|---|---|
| Mã | 6 số, sống 5 phút, chỉ lưu **băm** có khoá (`AUTH_SECRET`) |
| Sai mã | tối đa 5 lần cho một mã; sai hết lượt thì phải xin mã mới |
| Chờ giữa hai lần gửi | 60 giây cho mỗi số |
| Trần theo số | 3 mã/giờ |
| Trần theo máy (IP lưu băm) | 5 mã/giờ |
| Trần toàn nền tảng | 300 mã/ngày, vì mỗi tin ZNS là tiền thật |

- Các trần **đếm từ bảng** `platform_phone_otps` (migration 0214), không đếm trong bộ nhớ, nên vẫn đúng khi chạy nhiều tiến trình hay khởi động lại. Lượt Zalo từ chối (`FAILED`) vẫn được tính vào trần.
- Mã đúng **chưa bị tiêu** ngay khi kiểm. Mã chỉ bị tiêu sau khi tạo cửa hàng xong, nên một lần tạo hỏng (ví dụ email đã có cửa hàng) không bắt khách xin mã lại.
- Đã bật thì **bắt buộc**. Khi Zalo hỏng phía nền tảng (token hết hạn, hết tiền ZNS…), khách thấy «thử lại sau ít phút». Người vận hành xem số mã đã gửi, số lần Zalo từ chối và lỗi gần nhất ở `/platform`. Đường thoát là bấm **Tắt**; hệ thống không tự lùi về «bỏ qua mã».
- Lỗi thuộc về **số điện thoại** (số không dùng Zalo, chặn tin: mã lỗi −108/−118/−119/−139) được báo riêng cho khách: «số có dùng Zalo không?».

## Mã nguồn

- Lõi: `lib/onboarding/phone-otp.ts`.
- Gửi ZNS: `lib/integrations/zalo/oa.ts::zaloSendZnsTemplate`.
- Đăng ký nhanh: `lib/onboarding/quick.ts`.
- Màn hình: `components/onboarding/quick-start.tsx` và `components/onboarding/phone-otp-control.tsx`.
- Kiểm thử: `tests/phone-otp.test.ts` và `tests/quick-start.test.ts` (khách B đi qua bước mã).
