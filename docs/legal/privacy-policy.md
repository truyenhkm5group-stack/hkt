# CHÍNH SÁCH BẢO VỆ DỮ LIỆU CÁ NHÂN — BẢN NHÁP

> NHÁP — chưa có hiệu lực, chưa qua luật sư. Xem `docs/legal/README.md`. Căn cứ pháp lý (Luật Bảo vệ dữ liệu cá nhân và
> văn bản hướng dẫn đang có hiệu lực) do luật sư xác định và trích dẫn; kỹ thuật không tự điền điều luật.

**Phiên bản:** nháp-01 · **Ngày soạn:** 03/10/2026

## 1. Phạm vi — hai nhóm dữ liệu, hai vai trò

| Nhóm dữ liệu | Ví dụ | Vai trò của Nền tảng |
|---|---|---|
| **A. Dữ liệu của Khách thuê và Người dùng** | họ tên, email, số điện thoại người đăng ký; tài khoản nhân viên; nhật ký đăng nhập, địa chỉ IP; thông tin thanh toán phí thuê bao | Bên kiểm soát và xử lý |
| **B. Dữ liệu khách hàng của Khách thuê** | tên, số điện thoại, địa chỉ giao hàng, lịch sử mua, hội thoại với chatbot / fanpage, công nợ, lịch hẹn | Bên xử lý, theo chỉ dẫn của Khách thuê |

Với nhóm B, Khách thuê quyết định thu thập gì và dùng làm gì, và phải có căn cứ hợp pháp (ví dụ sự đồng ý của khách
hàng) trước khi đưa dữ liệu vào phần mềm. Yêu cầu của khách hàng cuối (xem, sửa, xoá dữ liệu của họ) gửi tới Khách
thuê; Nền tảng hỗ trợ Khách thuê thực hiện.

## 2. Mục đích xử lý

- Nhóm A: tạo và quản lý tài khoản; xác thực đăng nhập; chống truy cập trái phép (ví dụ chặn dò mật khẩu theo IP);
  thu phí thuê bao và đối chiếu chuyển khoản; hỗ trợ kỹ thuật; thông báo về dịch vụ.
- Nhóm B: chỉ để thực hiện các tính năng Khách thuê dùng — lưu đơn, giao hàng, nhắc mua lại, trả lời khách qua
  chatbot, báo cáo. Nền tảng **không** dùng dữ liệu nhóm B cho mục đích riêng của mình, không bán, không chia sẻ cho
  tổ chức khác trên nền tảng.

## 3. Lưu trữ và bảo vệ

- Mỗi tổ chức có cơ sở dữ liệu riêng; phần mềm chặn truy cập chéo giữa các tổ chức ở nhiều lớp và có kiểm thử tự động
  cho việc đó.
- Mật khẩu chỉ lưu dạng băm; liên kết mời và liên kết đặt lại mật khẩu chỉ lưu dạng băm, dùng một lần, có hạn.
- Thông tin kết nối dịch vụ bên thứ ba (khoá API, token) được mã hoá trong cơ sở dữ liệu.
- Mọi thao tác quan trọng được ghi nhật ký kèm tài khoản thực hiện.
- Sao lưu định kỳ trên máy chủ và bản sao ngoài máy chủ (lưu trữ đám mây) ở dạng **đã mã hoá** — bên lưu trữ chỉ thấy
  dữ liệu mã hoá.
- Máy chủ đặt tại [nhà cung cấp hạ tầng, quốc gia]. [Luật sư xác định nghĩa vụ khi dữ liệu / bản sao lưu nằm ngoài
  lãnh thổ Việt Nam.]

## 4. Bên thứ ba xử lý dữ liệu

Chỉ khi Khách thuê bật tính năng hoặc kết nối tương ứng:

| Bên thứ ba | Dữ liệu đi qua | Khi nào |
|---|---|---|
| [Nhà cung cấp máy chủ] | toàn bộ dữ liệu (lưu trữ) | luôn luôn |
| [Dịch vụ lưu trữ đám mây cho bản sao lưu] | bản sao lưu đã mã hoá | luôn luôn |
| Nhà cung cấp mô hình AI (hiện là Google Gemini) | nội dung hội thoại, thông tin sản phẩm cần để trả lời | khi bật chatbot / tính năng AI |
| Pancake, Facebook | hội thoại, đơn hàng của fanpage | khi Khách thuê kết nối |
| Viettel Post | thông tin giao hàng của đơn | khi Khách thuê kết nối |
| Ngân hàng / dịch vụ đối soát chuyển khoản (SePay) | nội dung và số tiền giao dịch | khi đối soát thanh toán |

[Luật sư rà: điều khoản xử lý dữ liệu với từng bên, chuyển dữ liệu ra nước ngoài.]

## 5. Thời gian lưu

- Trong thời gian thuê: dữ liệu được giữ cho tới khi Khách thuê xoá.
- Sau khi ngừng thuê: [N] ngày (khớp Điều 5.4 Điều khoản sử dụng), sau đó xoá, trừ phần pháp luật buộc lưu (ví dụ
  chứng từ thanh toán phí thuê bao).
- Bản sao lưu cũ tự hết hạn theo lịch xoay vòng (tối đa khoảng [5] tuần).

## 6. Quyền của chủ thể dữ liệu

Người dùng (nhóm A) có quyền xem, sửa, yêu cầu xoá dữ liệu của mình, rút lại sự đồng ý, khiếu nại — liên hệ mục 8.
Khách hàng cuối (nhóm B) liên hệ Khách thuê; Nền tảng hỗ trợ Khách thuê trong [N] ngày làm việc kể từ khi nhận yêu cầu.

## 7. Sự cố dữ liệu

Khi phát hiện sự cố có thể làm lộ dữ liệu, Nền tảng thông báo cho Khách thuê bị ảnh hưởng và cơ quan có thẩm quyền
trong thời hạn pháp luật quy định [luật sư điền thời hạn], kèm mô tả sự cố và biện pháp khắc phục.

## 8. Liên hệ về dữ liệu cá nhân

[Họ tên / bộ phận phụ trách bảo vệ dữ liệu] · [Email] · [Địa chỉ].
