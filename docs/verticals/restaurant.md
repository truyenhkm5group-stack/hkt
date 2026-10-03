# Nhà hàng / quán ăn — mẫu ngành `restaurant`

Mẫu cho nhà hàng, quán ăn, quán cà phê: nhận **đặt bàn**, bán **tại bàn / mang về / giao hàng**, nhận khách qua chat. Chọn
ở `/start` (loại hình «Nhà hàng / quán ăn») hoặc cài ở Mẫu cấu hình.

## Dựng trên module có sẵn — không module mới

| Việc của quán | Làm bằng |
|---|---|
| Thực đơn | Module Sản phẩm. Field «Nhóm món» (khai vị, món chính, lẩu / nướng, cơm / mì / bún, đồ uống, tráng miệng, combo) và «Khẩu phần». |
| Gọi món | Đơn tạo tay. Field «Hình thức» (tại bàn / mang về / giao hàng) và «Số bàn»; danh sách đơn hiện sẵn hai cột này. |
| Đặt bàn | Module Lịch hẹn. Tạo một sản phẩm nhóm «Đặt bàn (không bán)» làm «dịch vụ» của lịch. |
| Đặt bàn qua chat | Chatbot bán hàng → «Đặt lịch qua chat»: «Số khách phục vụ cùng lúc» = **số bàn nhận đặt trước**; «Mỗi lịch (phút)» = thời gian giữ bàn. Bot chỉ mời giờ còn bàn, xin tên + SĐT, chờ khách xác nhận rồi mới giữ chỗ. |
| Báo bếp | Luật «Đơn chốt ⇒ báo bếp» (NHÁP + CHẠY THỬ — quán tự bật, nối nhóm chat bếp nếu muốn). |
| Khách quen | Hồ sơ khách: «Dị ứng / kiêng», «Món hay gọi»; trang Nhắc mua lại. |

Vai trò mẫu: **Thu ngân / phục vụ** (lên đơn, đặt bàn, trả lời chat) và **Bếp** (xem đơn và thực đơn — không sửa đơn, không
xem tiền).

Mẫu KHÔNG khai giá, món hay số bàn nào — quyết định của từng quán (luật 38).

## Giới hạn hôm nay — nói thẳng với khách trước khi bán

- **Chưa có sơ đồ bàn / gọi món theo từng bàn.** Đơn tại bàn ghi «Số bàn» bằng chữ; thêm món vào đơn đang mở là sửa đơn.
- **Chưa có màn hình bếp.** Bếp xem danh sách đơn (lọc «Hình thức»), hoặc nhận tin qua nhóm chat khi bật luật báo bếp.
- **Chưa tách / gộp hoá đơn, chưa in hoá đơn nhiệt.**
- **Chưa trừ nguyên liệu theo định lượng món.** Kho trừ theo món bán, không theo nguyên liệu.
- Trang Lịch hẹn dùng nhãn chung «Kỹ thuật viên» cho người phụ trách — với quán ăn có thể để trống.
- **Số lượng trên đơn là số nguyên** (như mọi ngành).

## Bước sau (cần quán thử thật)

Sơ đồ bàn + phiên gọi món theo bàn, màn hình bếp theo món, tách / gộp hoá đơn, định lượng nguyên liệu. Thứ tự theo phản
hồi của quán thử đầu tiên — không dựng trước khi biết quán dùng thế nào.
