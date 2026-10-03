# Đặt lại mật khẩu bằng liên kết dùng một lần

Khách quên mật khẩu là việc hỗ trợ đầu tiên của mọi phần mềm bán theo tháng. ERP chưa có bộ gửi thư (thêm một dịch vụ
ngoài cần chủ nền tảng duyệt — AGENTS.md mục 7), nên liên kết được **tạo trong ERP** rồi gửi tay qua kênh người dùng
đang dùng (Zalo, Messenger). Khi có bộ gửi thư, nút «Quên mật khẩu» tự phục vụ chỉ cần gọi đúng lõi này rồi gửi thư
thay cho việc hiện liên kết.

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

## Tệp

- Lõi: `lib/users/password-reset.ts` (chỉ máy chủ) · phần thuần dùng chung với form: `lib/users/password-reset-shared.ts`
- Server action: `lib/actions/password-reset.ts`
- Giao diện: `app/(dashboard)/settings/users/reset-link-dialog.tsx` · `components/platform/operator-reset-link.tsx` ·
  `app/reset/[org]/[token]/`
- Kiểm thử: `tests/password-reset.test.ts`

## Chưa làm (cần chủ nền tảng quyết)

- Nút «Quên mật khẩu» tự phục vụ ở `/login` và email xác nhận khi đăng ký — cần một bộ gửi thư (dịch vụ ngoài mới).
