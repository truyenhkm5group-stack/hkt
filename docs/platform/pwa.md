# Cài ERP lên điện thoại (PWA) và thông báo đẩy

## Người dùng làm gì

1. **Cài lên màn hình chính.**
   - Android / máy tính (Chrome, Edge): menu trình duyệt → **Cài đặt ứng dụng** / **Thêm vào màn hình chính**.
   - iPhone / iPad (Safari): **Chia sẻ** → **Thêm vào Màn hình chính**.
2. Mở ERP (trên iPhone phải mở từ biểu tượng vừa thêm), vào **Tài khoản của tôi** → **Thông báo trên điện thoại / máy tính**, rồi bấm **Bật thông báo trên máy này**. Bấm **Gửi thử** để kiểm tra.
3. Mỗi máy bật riêng. Đăng xuất không tự tắt thông báo: muốn tắt thì bấm **Tắt trên máy này**. Người khác đăng nhập trên cùng máy rồi bấm bật thì thông báo của máy đó chuyển sang họ.

## Thông báo nào được đẩy

Mọi tin vào **hộp thư cá nhân** (`user_messages`, ghi qua `lib/inbox/send.ts::sendInboxMessages`) đều được đẩy, ví dụ:

- khách cần nhân viên;
- khách đặt lịch;
- AI của chatbot hỏng;
- đơn từ fanpage;
- lương chờ duyệt, phiếu lương;
- khách sỉ;
- topic sản xuất.

Thông báo đẩy **không có đường thứ hai**: muốn thêm một loại thông báo thì gửi một tin hộp thư như các nơi khác vẫn làm.

Quy tắc gửi:

- Một người nhận nhiều tin trong cùng một lượt thì chỉ nhận **một** thông báo («… và N tin khác»).
- Tin trùng (cùng `dedupe_key`) không được đẩy lại.

## Kỹ thuật

| Phần | Ở đâu |
|---|---|
| Manifest + biểu tượng | `public/brand/vnx/site.webmanifest`, `public/brand/vnx/icon-*.png`; khai ở `app/layout.tsx` (thương hiệu VNX). ChotDon có manifest riêng. |
| Service worker | `public/sw.js`: nhận `push` → hiện thông báo; bấm → mở đúng `href`. Cố ý **không** lưu đệm trang, vì ERP là dữ liệu sống. Đường `/sw.js` công khai trong `middleware.ts`. |
| Mã hoá + ký | `lib/push/web-push.ts`: RFC 8291 (aes128gcm) và VAPID (RFC 8292), chỉ dùng `node:crypto`. Bài kiểm khớp véc-tơ mẫu của RFC. |
| Khoá VAPID | Dẫn xuất từ `AUTH_SECRET`, nên không cần biến môi trường mới. **Đổi `AUTH_SECRET` thì mọi máy phải bấm bật lại**: máy chủ đẩy trả 401/403 và ERP tự xoá đăng ký cũ. |
| Đăng ký | Bảng `push_subscriptions` (migration 0213, CSDL của từng tổ chức), mỗi `endpoint` một dòng. Lõi ở `lib/push/service.ts`, nút bấm ở `lib/actions/push.ts`. |
| Chặn SSRF | Chỉ nhận máy chủ đẩy của Google (`fcm.googleapis.com`), Mozilla, Apple và Microsoft (`PUSH_HOST_SUFFIXES`), qua HTTPS cổng 443. |
| Dọn đăng ký | 404/410/401/403 thì xoá đăng ký; lỗi tạm thì giữ lại và ghi `last_error`; gửi thành công thì ghi `last_ok_at`. |

Không gửi số tiền trong tiêu đề. Thông báo hiện trên màn hình khoá, nên quy ước của hộp thư vẫn áp dụng: số tiền nằm ở trang mà đường dẫn trỏ tới.
