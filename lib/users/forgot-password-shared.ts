/**
 * ═══════════ «QUÊN MẬT KHẨU» — PHẦN THUẦN, CLIENT-SAFE (PUB-07 · docs/platform/password-reset.md §Tự phục vụ) ═══════════
 *
 * Form `/forgot` và lõi máy chủ (`lib/users/forgot-password.ts`) dùng CÙNG các câu ở đây. Không đọc CSDL, không đọc biến môi trường.
 *
 * CHỐNG DÒ TÀI KHOẢN: câu trả lời sau bước 1 chỉ phụ thuộc vào CÔNG TẮC OTP của nền tảng (thông tin công khai — trang đăng ký cũng
 * lộ nó), KHÔNG BAO GIỜ phụ thuộc vào việc tài khoản có tồn tại, có SĐT, hay đã gửi được mã. Bước 2 gộp mọi lý do mã không dùng được
 * (sai · hết hạn · quá số lần · không có tài khoản) thành MỘT câu.
 */

export const FORGOT_PATH = "/forgot";

/** Bước 1 khi OTP Zalo đang BẬT — hiện ô nhập mã cho MỌI lượt gửi hợp lệ, kể cả khi không có tài khoản nào khớp. */
export const FORGOT_SENT_OTP =
  "Nếu thông tin bạn nhập khớp một tài khoản có số điện thoại, mã xác minh 6 số vừa được gửi qua Zalo tới số đó (mã dùng được trong 5 phút). Nhập mã bên dưới để đặt mật khẩu mới.";

/** Bước 1 khi OTP Zalo đang TẮT, hoặc người dùng bấm «Không nhận được mã». */
export const FORGOT_SENT_SUPPORT =
  "Nếu thông tin bạn nhập khớp một tài khoản, yêu cầu đặt lại mật khẩu đã được chuyển tới người quản trị cửa hàng và bộ phận hỗ trợ. Họ sẽ gửi cho bạn một liên kết đặt lại dùng một lần qua Zalo hoặc Messenger.";

/** Bước 2: MỘT câu cho mọi lý do mã không dùng được. */
export const FORGOT_CODE_INVALID = "Mã không đúng, đã hết hạn hoặc đã nhập sai quá số lần. Kiểm tra lại mã trong Zalo, hoặc bấm «Gửi lại mã».";

export const FORGOT_THROTTLED = "Bạn đã thử quá nhiều lần. Đợi 15 phút rồi thử lại, hoặc nhắn Zalo hỗ trợ.";

export const FORGOT_BAD_IDENTIFIER = "Nhập email hoặc số điện thoại di động của tài khoản (vd ban@shop.vn hoặc 0912 345 678).";

export const FORGOT_OTP_OFF = "Đặt lại bằng mã Zalo hiện chưa bật — bấm «Gửi yêu cầu hỗ trợ».";
