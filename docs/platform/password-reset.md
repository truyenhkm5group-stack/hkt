# Đặt lại mật khẩu bằng liên kết dùng một lần

Khách quên mật khẩu là việc hỗ trợ đầu tiên của mọi phần mềm bán theo tháng. ERP chưa có bộ gửi thư (thêm một dịch vụ
ngoài cần chủ nền tảng duyệt — AGENTS.md mục 7), nên liên kết được **tạo trong ERP** rồi gửi tay qua kênh người dùng
đang dùng (Zalo, Messenger). Nút «Quên mật khẩu» tự phục vụ (mục dưới) đã gọi đúng lõi này qua mã OTP Zalo; khi có bộ gửi thư, nhánh «yêu cầu hỗ
trợ» chỉ cần gửi thư thay cho việc chờ quản trị.

## Ai tạo được

| Người tạo | Ở đâu | Cho ai | Điều kiện |
|---|---|---|---|
| Quản trị tổ chức (`users:manage`) | `/settings/users` → menu ⋯ → «Gửi liên kết đặt lại» | Một tài khoản ĐANG HOẠT ĐỘNG trong chính tổ chức của phiên | Nhật ký `PASSWORD_RESET_LINK` của tổ chức |
| Người vận hành nền tảng (tổ chức nhà + `platform:operate`) | `/platform/org/<mã>` → khung «Đặt lại mật khẩu cho khách» | Một tài khoản (theo email) của tổ chức KHÁCH đang hoạt động | Bắt buộc lý do ≥ 5 ký tự; nhật ký nền tảng ghi TRƯỚC khi liên kết hiện ra; tài khoản nhà không đặt qua đây |

Lối của người vận hành tồn tại cho đúng một tình huống: chính quản trị của khách quên mật khẩu, không còn ai trong tổ
chức có `users:manage`. **Chỉ gửi liên kết sau khi đã xác minh đúng người** (gọi lại số điện thoại đăng ký, nhắn từ
kênh đã biết) — liên kết là chìa khoá vào toàn bộ dữ liệu của tổ chức đó.

Lối cũ «Đặt lại mật khẩu» (quản trị gõ mật khẩu hộ) vẫn còn; khác biệt là ở lối mới không ai ngoài chủ tài khoản biết
mật khẩu.

## Luật của liên kết

- Mã 32 byte ngẫu nhiên (base64url); CSDL chỉ giữ `sha256` (bảng `password_reset_tokens`, migration 0191). Liên kết chỉ
  hiện MỘT lần, ngay sau khi tạo.
- Hết hạn sau **24 giờ**. Tạo liên kết mới cho cùng người ⇒ liên kết cũ chưa dùng bị thu hồi.
- **Mở trang không tiêu mã**: bot xem trước liên kết của Zalo / Messenger mở trang không làm hỏng liên kết. Mã chỉ bị
  tiêu khi bấm «Đặt mật khẩu mới» — câu `UPDATE … WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`
  chạy trong CÙNG giao dịch với lượt ghi mật khẩu, nên hai lượt bấm song song chỉ một lượt thắng.
- Đặt xong ⇒ thu hồi MỌI phiên của người đó (`PASSWORD_RESET`), không tự đăng nhập; người dùng về `/login` với câu
  «Đã đổi mật khẩu».
- Mọi lý do không dùng được (tổ chức không có, mã sai, hết hạn, đã dùng, bị thay) ra **cùng một câu** — nói riêng từng lý
  do là dựng một máy dò. Mỗi lượt sai đếm vào bộ chặn dò theo IP (cùng bộ đếm với màn đăng nhập, khoá `ip:reset:`).
- Trang công khai `/reset/<mã tổ chức>/<mã>` chạy trong `withOrganization(mã trong đường dẫn)` tường minh; mã của tổ chức
  A đem sang đường dẫn B không khớp gì.

## Tự phục vụ: «Quên mật khẩu?» (PUB-07)

`/login` có liên kết «Quên mật khẩu?» tới `/forgot` (mọi thương hiệu — trang chọn thương hiệu và ô «Mã cửa hàng» y như
`/login`; tên miền con của một tổ chức gắn cứng tổ chức đó). Người dùng nhập email hoặc SĐT (+ mã cửa hàng nếu trang hiện
ô đó). Tài khoản được tra bằng ĐÚNG luật của màn đăng nhập (`findUserByIdentifier` + `loginCandidates`).

| Tình huống | Điều xảy ra |
|---|---|
| OTP Zalo BẬT (`/platform`, mặc định TẮT) và tài khoản có đúng một SĐT | Gửi mã qua lõi đăng ký (`issuePhoneOtp` — cùng chờ 60 giây, cùng ba trần, mã chỉ lưu băm). Nhập đúng mã ⇒ `issueSelfResetAfterPhoneOtp` phát phiếu qua CÙNG lõi ở trên (thu hồi phiếu cũ, dùng một lần, sống **30 phút**) ⇒ chuyển thẳng tới `/reset/<tổ chức>/<mã>`. Nhật ký `PASSWORD_RESET_LINK` với người thao tác = chính người dùng, `via: SELF_PHONE_OTP`. Một SĐT có tài khoản ở nhiều cửa hàng ⇒ hỏi chọn cửa hàng SAU khi mã đúng. |
| OTP TẮT · tài khoản không có SĐT · Zalo không gửi được / chạm trần · người dùng bấm «Không nhận được mã» | Ghi MỘT **yêu cầu hỗ trợ**, tối đa một mỗi tài khoản mỗi ngày (giờ VN): chuông của chính tổ chức (mở `/settings/users`, nơi quản trị bấm «Gửi liên kết đặt lại») + nhật ký tổ chức + nhật ký nền tảng `PASSWORD_RESET_REQUEST` (hiện ở khung «Nhật ký» của `/platform/customers/<mã>` — lối ra khi người quên là chính quản trị). Không phát phiếu nào. Người gửi CHƯA xác minh: `userId = null`, `actor = null`. |

Chống dò tài khoản: câu trả lời bước 1 chỉ phụ thuộc công tắc OTP (công khai) và nút người dùng bấm — giống hệt nhau
cho tài khoản có / không tồn tại, có / không SĐT, gửi được mã hay không. Bước nhập mã gộp mọi lý do (sai · hết hạn · quá
số lần · không có tài khoản) thành một câu. Bộ chặn dò `lib/auth/login-throttle.ts` với khoá riêng `pair:forgot:` /
`ip:forgot:`: mỗi lượt gửi và mỗi mã sai đều đếm (5 / định danh + máy, 30 / máy mỗi 15 phút), kể cả khi không có tài
khoản. Sổ lỗi đăng nhập ghi dưới luồng `RESET_LINK` (không có tài khoản / tổ chức · bị chặn dò); mã sai không có lý do
riêng trong danh sách đóng (thêm là một migration).

Không migration: cột `password_reset_tokens.created_via` có CHECK đóng (`ORG_ADMIN`,`PLATFORM`), nên phiếu tự phục vụ
được lưu `PLATFORM` kèm `created_by_email = self:phone-otp` và `created_by_user_id` = chính người dùng.

## Tệp

- Lõi: `lib/users/password-reset.ts` (chỉ máy chủ) · phần thuần dùng chung với form: `lib/users/password-reset-shared.ts`
- Server action: `lib/actions/password-reset.ts`
- Giao diện: `app/(dashboard)/settings/users/reset-link-dialog.tsx` · `components/platform/operator-reset-link.tsx` ·
  `app/reset/[org]/[token]/`
- Tự phục vụ: `lib/users/forgot-password.ts` · `lib/users/forgot-password-shared.ts` · `lib/actions/forgot-password.ts` · `app/forgot/`
- Kiểm thử: `tests/password-reset.test.ts` · `tests/forgot-password.test.ts`

## Chưa làm (cần chủ nền tảng quyết)

- Gửi liên kết đặt lại / mã xác nhận qua **email** (khi OTP Zalo tắt hoặc tài khoản không có SĐT) và email xác nhận khi đăng ký —
  cần một bộ gửi thư (dịch vụ ngoài mới). Tới lúc đó nhánh này là yêu cầu hỗ trợ ở trên.
