# Tiện ích Chrome «Lưu mẫu từ 1688» — hướng dẫn cài cho chủ shop

Nút **Lưu mẫu vào ERP** trên trang chi tiết sản phẩm `detail.1688.com/offer/…`. Bấm một lần ⇒ ERP lưu mẫu vào **Tìm hàng nguồn ›
Kho mẫu**: tiêu đề gốc, ảnh, giá theo bậc số lượng, giá từng SKU (màu × size), MOQ, bảng size (đã quy 斤 ra kg), tên nhà cung cấp,
tỷ lệ khách quay lại, điểm dịch vụ, nơi gửi hàng, khối lượng. Mỗi lần bấm là **một lần chụp mới** — lần cũ vẫn giữ, giá đổi thì
đọc được.

Tiện ích **chỉ chạy khi bạn bấm**, chỉ trên trang đang mở. Không tự quét, không mở trang khác, không vượt CAPTCHA, **không gửi
cookie hay tài khoản 1688 của bạn** về ERP. Không bao giờ đặt hàng hay nhắn tin cho nhà cung cấp.

## 1. Lấy thư mục tiện ích

Người vận hành gửi tệp nén `sourcing-1688.zip`. Giải nén vào một thư mục **cố định** (vd `D:\VNX\sourcing-1688`). Xoá hay đổi tên
thư mục này là tiện ích mất — Chrome đọc thẳng từ đó.

## 2. Nạp vào Chrome (một lần cho mỗi máy)

1. Mở Chrome, gõ `chrome://extensions` vào thanh địa chỉ, Enter.
2. Bật **Chế độ dành cho nhà phát triển** (Developer mode) ở góc trên bên phải.
3. Bấm **Tải tiện ích đã giải nén** (Load unpacked) ⇒ chọn thư mục `sourcing-1688` ở bước 1.
4. Thấy thẻ «VNX ERP — Lưu mẫu từ 1688» là xong. Bấm biểu tượng ghim (📌) cạnh thanh địa chỉ để tiện ích luôn hiện.

## 3. Dán token

1. Trong ERP: **Tìm hàng nguồn › Tiện ích lưu mẫu 1688 › Tạo token cho máy này**, đặt tên máy (vd «Chrome máy văn phòng»), bấm
   **Tạo token**, bấm **Chép**. Token chỉ hiện MỘT lần.
2. Bấm biểu tượng tiện ích trên Chrome ⇒ trang **Cài đặt** mở ra.
3. Dán **Địa chỉ ERP** (phần `https://…` đầu thanh địa chỉ khi bạn mở ERP, tới trước dấu «/» đầu tiên) và **Token**, bấm **Lưu**. Chrome hỏi quyền gửi dữ liệu tới địa chỉ ERP đó ⇒
   bấm **Cho phép**.

Mỗi máy một token. Mất máy / nghỉ việc ⇒ vào trang token trong ERP bấm **Thu hồi** — tiện ích trên máy đó bị từ chối ngay lượt sau.

## 4. Đặt ngôn ngữ 1688 — QUAN TRỌNG cho bảng size

Đặt 1688 về **简体中文** (nút ngôn ngữ / tiền tệ ở đầu trang 1688).

Vì sao: khi tài khoản đặt **tiếng Việt / Global**, chính 1688 dịch dữ liệu trang ở máy chủ của họ, và bản dịch đổi **斤 thành kg**:
«M (khuyến nghị 90 ~ 100 kg)» thật ra là 90–100 斤 = **45–50 kg**. Khi đó ERP vẫn lưu được giá (số không bị dịch) nhưng **không đọc
bảng size** và gắn cờ «1688 trả dữ liệu đã dịch».

Lưu ý của 1688: chọn tiếng Việt thì 1688 bắt bỏ «中国大陆» khỏi 主营国家. Đặt lại 简体中文 là đủ.

Muốn đọc trang bằng tiếng Việt: dùng **Dịch trang** của Chrome (chuột phải ⇒ Dịch sang tiếng Việt). Dịch của Chrome chỉ đổi chữ
hiển thị, **không** đổi dữ liệu tiện ích đọc — ERP vẫn lưu chữ Trung gốc.

## 5. Dùng

Mở một trang `detail.1688.com/offer/<mã>.html` ⇒ bấm nút đỏ **Lưu mẫu vào ERP** ở góc dưới bên phải ⇒ khung báo kết quả hiện ra,
kèm link **Mở mẫu trong ERP**.

Khung báo có thể kèm các dòng «•» — đó là chỗ ERP **không kết luận được và để trống**, không phải lỗi:

- «Không đọc được giá ở trang chi tiết» ⇒ giá về Việt Nam CHƯA BIẾT.
- «Trang có giá khuyến mãi / giá khách mới — đã BỎ QUA»: giá thẻ tìm kiếm và 新人价 (giá khách mới) **không phải giá mua**. Ví dụ đo
  thật: thẻ ¥11.28, giá đặt hàng ¥17.28. ERP chỉ dùng giá đặt hàng của trang chi tiết.
- «Mỗi màu × size một giá» ⇒ xem giá từng SKU trong ERP.
- «Trang không ghi khối lượng» ⇒ cước Trung Quốc → Việt Nam CHƯA BIẾT (khai tay ở trang mẫu).

## Gỡ lỗi nhanh

| Báo | Làm gì |
|---|---|
| «Chưa cài đặt địa chỉ ERP / token» | Làm lại bước 3 |
| «Token không hợp lệ hoặc đã thu hồi» | Tạo token mới trong ERP, dán lại |
| «Không đọc được dữ liệu gốc của trang» | Tải lại trang 1688 (F5), đợi trang hiện giá rồi bấm lại |
| «Tài khoản của token không còn quyền…» | Nhờ quản trị cấp quyền «Tìm hàng: lưu & sửa mẫu» |
| Không thấy nút | Kiểm tra đúng trang `detail.1688.com/offer/…`; ở `chrome://extensions` bấm ⟳ tải lại tiện ích |
