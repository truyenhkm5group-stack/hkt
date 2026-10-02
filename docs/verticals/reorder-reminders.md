# Nhắc mua lại + sổ liên hệ khách — Seafood OS · bước S3

> Migration `0189_customer_touchpoints`. Mã nằm ở 4 tệp:
> - `lib/constants/reorder.ts`: luật thuần.
> - `lib/queries/reorder.ts`: phần đọc.
> - `lib/records/touchpoints.ts`: phần ghi.
> - `/customers/reorder` và khung «Mua lại & liên hệ» trên trang khách: màn hình.
>
> Kiểm thử ở `tests/reorder-reminders.test.ts`. Tính năng chỉ chạy ở tổ chức tạo đơn tay; tổ chức nhà có màn CRM riêng.

## Vì sao

Nhiều khách mua theo nhịp: quán ăn lấy hải sản mỗi tuần, khách lẻ mua đồ khô mỗi tháng, khách spa đi liệu trình định kỳ.
Người bán cần gọi **trước** khi khách quen mua chỗ khác. Không có bảng «đến hạn»: tình trạng được tính lúc đọc, là hàm
của lịch sử đơn, chu kỳ và ngày hôm nay.

## Luật

- **Một lần mua** = một ngày (giờ VN) có đơn tạo tay ở trạng thái ĐÃ CHỐT hoặc ĐÃ GIAO. Hai đơn cùng ngày tính là một lần
  mua. Đơn Mới, Chờ hàng và Huỷ không tính.
- **Chu kỳ** lấy theo thứ tự ưu tiên:
  1. Của chính khách: trung vị khoảng cách giữa các lần mua, cần ít nhất 2 lần mua. Dùng trung vị để một lần khách nghỉ
     dài không kéo lệch nhịp.
  2. Mặc định của tổ chức: setting `crm.reorder`, chỉ người có `settings:manage` khai.
  3. Nếu chưa khai mặc định thì tình trạng là `UNKNOWN`. Mã nguồn **không có số mặc định** (luật 38).
- **Ngày dự kiến mua lại** = lần mua gần nhất + chu kỳ.
  - Đã qua hoặc đúng hôm nay ⇒ `DUE`.
  - Còn trong số ngày «nhắc trước» (khai được, 0–30, mặc định 3) ⇒ `DUE_SOON`.
  - Còn xa hơn ⇒ `NOT_DUE`.
- **Lượt liên hệ** chỉ hoãn khách khỏi danh sách gọi khi nó nói rõ:
  - **hẹn liên hệ lại** vào một ngày sau hôm nay ⇒ `SNOOZED` tới ngày đó;
  - **khách báo không mua nữa**, ghi SAU đơn gần nhất ⇒ `DECLINED`. Khách đặt đơn mới thì tự mở lại.
  - Một cuộc gọi không ai nghe **không** giấu khách đi.
- **Sổ liên hệ** (`customer_touchpoints`) chỉ thêm dòng, không sửa. Ghi liên hệ cần quyền `customers:write`. Người làm
  được lưu bằng khoá tài khoản kèm ảnh chụp tên, do máy chủ đọc (luật 34).

## Bước sau

- Đưa danh sách «Cần gọi» vào hàng đợi `/work` như một phép chiếu (luật 19), giao theo phòng Bán hàng.
- Gợi ý mặt hàng của lần mua gần nhất ngay trên dòng của khách.
- Nhắn mẫu qua Zalo OA / Messenger. Phải theo chính sách nhắn ngoài cửa sổ 24 giờ của từng kênh, nên cần quyết định riêng.
