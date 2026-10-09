# VISIBLE PRODUCT FINISH BOARD — bảng hoàn tất theo thứ chủ shop NHÌN THẤY

*Lập 10/10/2026 theo lệnh chủ shop. Ngắn có chủ đích. Đây là bảng KPI chính; số PR đã gộp không còn là KPI chính.*

## Definition of Done (từ 10/10/2026)

REQUIREMENT → CODE → TEST → MERGE → DEPLOY → **MỞ TRANG THẬT TRÊN PRODUCTION** → VERIFY → **ẢNH TRƯỚC / SAU** (cùng trang, cùng khổ màn hình).
Logic không nhìn thấy được ⇒ bằng chứng production (chạy ops) thay cho ảnh. Audit · tài liệu · bài kiểm · đã gộp · đã deploy mà chưa mở trang
**≠ DONE**. «Đã kiểm kê 207/207 trang» không phải bằng chứng hoàn tất.

**STATUS:** `NOT_STARTED` · `PARTIAL` · `PR_READY` · `DEPLOYED_NOT_VERIFIED` · `PRODUCTION_VERIFIED` · `DONE`.
Hiện **chưa bề mặt nào có ảnh trước / sau** ⇒ **không dòng nào PRODUCTION_VERIFIED / DONE**. Logic đã có run ops (vd `saas-acceptance` PASS 7/7,
run 37935922309: tạo khách · kích hoạt · đăng nhập · vỏ · chat → AI → đơn) chỉ nâng phần logic; phần nhìn thấy vẫn «chưa có ảnh» ⇒ tối đa
`DEPLOYED_NOT_VERIFIED`. Cột PR chỉ ghi PR đã gộp; «đã deploy» chưa được xác nhận bằng cách mở trang nên ghi `—` ở cột SHA.
Ảnh: `docs/product/evidence/<bề-mặt>/<before|after>-<khổ>.png` (sẽ thêm sau; khổ: 1366x768 · 390).

## Thứ tự ưu tiên
1 Inbox · 2 onboarding / dùng lần đầu · 3 cấu hình AI Sales · 4 xác nhận đơn / sự thật đơn · 5 sản phẩm / SKU · 6 quản lý khách (platform) ·
7 giá / mức dùng / thanh toán · 8 nhân viên / tài khoản · 9 website công khai · 10 ERP lưu lượng cao.

## Chuẩn một bề mặt sản phẩm
Thứ bậc rõ · người ít rành máy đọc hiểu · một nút chính · không chữ kỹ thuật · không lộ thông tin nội bộ · có trạng thái đang tải / rỗng / lỗi ·
dùng được trên điện thoại (390) · đủ ở 1366×768 · không cuộn ngang · nhất quán với các trang khác · nhanh · số liệu đúng · không nút chết ·
không điều khiển trùng lặp.

## Hai hành trình
- **Khách:** trang chủ → đăng ký → vào app → nối Messenger → thêm sản phẩm → bật AI → nhận tin ở Inbox → xác nhận đơn → xem mức dùng.
- **Admin:** đăng nhập /platform → tạo khách → gói / thuê bao → xem sức khoẻ → xử lý sự cố → xem thanh toán / mức dùng.

Cột: **Y/c** yêu cầu chủ shop · **Hiện tại** đang chạy (PR) · **Thiếu** · **Đổi nhìn thấy** · **PR** · **SHA** production · **Trước / Sau** ảnh.

## PUBLIC

| Bề mặt | Y/c | Hiện tại | Thiếu | Đổi nhìn thấy | PR | SHA | Trước | Sau | STATUS |
|---|---|---|---|---|---|---|---|---|---|
| chotdontudong.com landing | Nói đúng sản phẩm, một CTA rõ | #706 sửa claim, bỏ Pancake-chính, bỏ «Chi phí AI hiện rõ» | CTA đăng ký chờ D2 (`PLATFORM_SIGNUP_MODE`); chưa đối chiếu ảnh | Landing 1366 + 390, CTA chính | #706 | — | chưa có | chưa có | PARTIAL |
| Bảng giá | Giá V1 rõ, số ngày dùng thử đúng | PRICING_V1 (#627); 7 vs 14 ngày chờ D17 | Chưa mở trang giá | Trang giá đúng 7/14 | — | — | chưa có | chưa có | NOT_STARTED |
| Đăng ký / đăng nhập / quên mật khẩu | Không trang trắng, đúng thương hiệu | #700; saas-acceptance 7/7 chứng minh logic | Ảnh 3 màn | 3 màn ở 390 | #700 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |

## ADMIN (/platform)

| Bề mặt | Y/c | Hiện tại | Thiếu | Đổi nhìn thấy | PR | SHA | Trước | Sau | STATUS |
|---|---|---|---|---|---|---|---|---|---|
| Dashboard | Việc hằng ngày lên đầu | #714 (tổ chức & sức khoẻ, công tắc khẩn lên đầu) | «9 nút không tên» chưa xác nhận trên DOM | Dashboard trước / sau | #714 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Danh sách khách | Biết «khách này có chạy không» < 30 giây | #683 (Messenger · AI · đăng nhập · đơn · hạn mức) | Ảnh | Cột sức khoẻ | #683 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Chi tiết khách | Chẩn đoán 8 loại sự cố | #692; O2–O5 · O7 · O8 chưa chứng minh phát hiện | Ảnh; drill | Khối sự cố | #692 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Tạo khách | Đúng mặc định, nút không khoá im lặng | #682; logic PASS 7/7 (run 37935922309) | Ảnh form | Form trước / sau | #682 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Gói / thuê bao | Gói đang bán, «còn N ngày» | #682; MM-BILL-00 | Ảnh | Khối gói | #682 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Sức khoẻ / chẩn đoán | Tự xử lý sự cố | #692 #710 (9 tổ chức × 8 tín hiệu tính được) | Ảnh | Bảng tín hiệu | #692 #710 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Thanh toán / mức dùng | Doanh thu · biên Số dư AI | mission ai-balance-economics | Ảnh; D4 chặn giao dịch thật | Bảng trước / sau | — | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |

## CUSTOMER (app khách)

| Bề mặt | Y/c | Hiện tại | Thiếu | Đổi nhìn thấy | PR | SHA | Trước | Sau | STATUS |
|---|---|---|---|---|---|---|---|---|---|
| Trang chủ / dashboard | Một việc nên làm tiếp | Vỏ 8 mục; #743 bỏ chữ kỹ thuật | Ảnh | Trước / sau | #743 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Onboarding / dùng lần đầu | Tự cài xong không cần hỏi | `/start` + trợ giúp | Chưa đo luồng đến Inbox | Từng bước | — | — | chưa có | chưa có | PARTIAL |
| Nối Messenger | Nói đúng «sắp mở» / nối thẳng | #712 (cờ); Meta chưa cấp quyền Page | Phụ thuộc Meta | Trang kết nối | #712 | — | chưa có | chưa có | PARTIAL |
| Inbox | Lọc gọn, chưa đọc lên đầu, mật độ, bong bóng, câu nhanh; khung tóm tắt đơn, trạng thái trường, xác nhận | ĐANG LÀM: INBOX-V2-A (lọc gọn · chưa đọc · mật độ · bề mặt · bong bóng · câu nhanh) và INBOX-V2-B (khung đơn · trạng thái trường · xác nhận) | Chưa gộp; ảnh TRƯỚC chờ chủ shop đăng nhập cửa sổ Chrome thử | Hộp thư mới 1366 + 390 | V2-A · V2-B (mở) | — | chờ chủ shop đăng nhập | chưa có | PARTIAL |
| Cài chatbot | Câu mẫu dễ dùng | #737 #739 (công tắc có nhãn, hàng loạt, tự nạp) | Ảnh | Màn câu mẫu | #739 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Sản phẩm / SKU | «Thêm mẫu mã»; giá vốn chưa biết ≠ 0 | #685 #716 | Ảnh | Trang sản phẩm | #716 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Đơn hàng | Đơn đúng sự thật, xác nhận được | #725 #731 | Ảnh; E2E UI chờ D19 | Chi tiết đơn | #725 #731 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Nhân viên | Chỉ vai trò bán hàng hợp lệ | #735 #741 | Ảnh; D10 | Trang nhân viên | #735 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Mức dùng / hạn mức | Hiểu «còn bao nhiêu» | mission ai-balance-v1 + MM-BILL-00 | Ảnh | Khối mức dùng | — | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Trợ giúp / hướng dẫn | Chỉ hướng dẫn kênh đang chạy | #712 | Ảnh | Trang trợ giúp | #712 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Tài khoản / cài đặt | Không chữ kỹ thuật | #743 | Ảnh | Cài đặt | #743 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |

## ERP LƯU LƯỢNG CAO

| Bề mặt | Y/c | Hiện tại | Thiếu | Đổi nhìn thấy | PR | SHA | Trước | Sau | STATUS |
|---|---|---|---|---|---|---|---|---|---|
| Đơn hàng | Số thật, không bộ đếm Pancake | #715 #722 #731 | Ảnh | Danh sách đơn | #722 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Khách | Giao thành công theo ĐVVC | #715 #722 | Ảnh | Danh sách + chi tiết | #715 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Vận chuyển | COD 0 không điền sai | #717 | Ảnh | Form sửa đơn VTP | #717 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Tồn kho | — | Chưa có yêu cầu nhìn thấy | Chưa lập yêu cầu | — | — | — | chưa có | chưa có | NOT_STARTED |
| Lương | — | /payroll không tràn ngang 390 (#708) | Ảnh | /payroll 390 | #708 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| Marketing / báo cáo | Ước tính ≠ số đo | #166 (thang bậc tỷ lệ GTC) | Ảnh | Báo cáo | — | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
| /work | Nhanh | #734 (chậm 3,1–4,7 s từ ef9b302a); #738 giữ ấm 3 nguồn | Chưa đo lại bằng trình duyệt | Số đo + ảnh | #734 #738 | — | chưa có | chưa có | DEPLOYED_NOT_VERIFIED |
