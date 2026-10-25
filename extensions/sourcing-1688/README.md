# Tiện ích Chrome «Lưu mẫu từ 1688» — hướng dẫn cài cho chủ shop

Nút **Lưu mẫu vào ERP** trên trang chi tiết sản phẩm `detail.1688.com/offer/…`. Bấm một lần ⇒ ERP lưu mẫu vào **Tìm hàng nguồn ›
Kho mẫu**: tiêu đề gốc, ảnh, giá theo bậc số lượng, giá từng SKU (màu × size), MOQ, bảng size (đã quy 斤 ra kg), tên nhà cung cấp,
tỷ lệ khách quay lại, điểm dịch vụ, nơi gửi hàng, khối lượng. Mỗi lần bấm là **một lần chụp mới** — lần cũ vẫn giữ, giá đổi thì
đọc được.

Tiện ích **chỉ chạy khi bạn bấm**, chỉ trên trang đang mở. Không tự quét, không mở trang khác, không vượt CAPTCHA, **không gửi
cookie hay tài khoản 1688 của bạn** về ERP. Không bao giờ đặt hàng hay nhắn tin cho nhà cung cấp.

## 1. Tải tiện ích về máy

1. Đăng nhập ERP ⇒ **Tìm hàng nguồn** ⇒ nút **Tiện ích lưu mẫu 1688** ở đầu trang.
2. Bấm **Tải tiện ích (.zip)**. Tệp `VNX-Luu-mau-1688-v….zip` về thư mục **Tải xuống** (Downloads). Tệp không chứa token hay địa chỉ
   ERP nào — bạn tự dán ở bước 3.
3. Mở thư mục Tải xuống, **chuột phải** vào tệp ⇒ **Giải nén tất cả…** (Extract All) ⇒ chọn một nơi **CỐ ĐỊNH**, ví dụ thư mục
   **Tài liệu** (Documents) hoặc ổ **D:** ⇒ **Giải nén**.

   ⚠️ Đừng để trong Tải xuống rồi dọn đi: Chrome đọc tiện ích thẳng từ thư mục này — xoá hay đổi tên thư mục là tiện ích mất.

## 2. Nạp vào Chrome (một lần cho mỗi máy)

1. Mở Chrome, gõ `chrome://extensions` vào thanh địa chỉ (chỗ gõ trang web), bấm **Enter**.
2. Ở góc trên bên phải, bật công tắc **Chế độ dành cho nhà phát triển** (Developer mode).
3. Bấm nút **Tải tiện ích đã giải nén** (Load unpacked) vừa hiện ra ⇒ chọn thư mục `VNX-Luu-mau-1688-v…` đã giải nén (thư mục có tệp
   `manifest.json` bên trong) ⇒ **Chọn thư mục**.
4. Thấy thẻ «VNX ERP — Lưu mẫu từ 1688» là xong. Bấm biểu tượng **mảnh ghép** 🧩 cạnh thanh địa chỉ ⇒ bấm **ghim** 📌 cạnh tên tiện
   ích để biểu tượng luôn hiện.

## 3. Dán token và địa chỉ ERP

1. Trong ERP, trang **Tiện ích lưu mẫu 1688** ⇒ khung **Tạo token cho máy này**: đặt tên máy (vd «Chrome máy văn phòng»), bấm **Tạo
   token**, bấm **Chép**. Token chỉ hiện MỘT lần.
2. Bấm biểu tượng tiện ích vừa ghim trên Chrome ⇒ trang **Cài đặt** mở ra.
3. Dán **Địa chỉ ERP** (trang tải tiện ích in sẵn địa chỉ này ở bước 8 — hoặc phần `https://…` đầu thanh địa chỉ khi bạn mở ERP, tới
   trước dấu «/» đầu tiên) và dán **Token** ⇒ bấm **Lưu** ⇒ Chrome hỏi quyền gửi dữ liệu tới địa chỉ ERP đó ⇒ bấm **Cho phép**.

Mỗi máy một token. Mất máy / nghỉ việc ⇒ vào trang token trong ERP bấm **Thu hồi** — tiện ích trên máy đó bị từ chối ngay lượt sau.

## 4. Đặt ngôn ngữ 1688 — QUAN TRỌNG cho bảng size

Đặt 1688 về **简体中文** (nút ngôn ngữ / tiền tệ ở đầu trang 1688).

Vì sao: khi tài khoản đặt **tiếng Việt / Global**, chính 1688 dịch dữ liệu trang ở máy chủ của họ, và bản dịch đổi **斤 thành kg**:
«M (khuyến nghị 90 ~ 100 kg)» thật ra là 90–100 斤 = **45–50 kg**. Khi đó ERP vẫn lưu được giá (số không bị dịch) nhưng **không đọc
bảng size** và gắn cờ «1688 trả dữ liệu đã dịch».

Bản dịch của 1688 còn hỏng cả TÊN SIZE và tên thuộc tính: đo 25/10/2026 trên 951023546393, size «L» bị dịch thành **«tôi»**, «S» thành
«S.», «尺码» thành «kích cỡ». ERP vẫn tách đúng màu với size (nhận cả tên thuộc tính đã dịch) và vẫn lưu giá, nhưng tên size bạn thấy
trong ERP là chữ 1688 đã dịch — đặt 1688 về 简体中文 rồi bấm lại để có tên gốc và bảng size quy kg.

Lưu ý của 1688: chọn tiếng Việt thì 1688 bắt bỏ «中国大陆» khỏi 主营国家. Đặt lại 简体中文 là đủ.

Muốn đọc trang bằng tiếng Việt: dùng **Dịch trang** của Chrome (chuột phải ⇒ Dịch sang tiếng Việt). Dịch của Chrome chỉ đổi chữ
hiển thị, **không** đổi dữ liệu tiện ích đọc — ERP vẫn lưu chữ Trung gốc.

## 5. Dùng

Mở **trang chi tiết của một sản phẩm** — địa chỉ dạng `detail.1688.com/offer/<mã>.html` — ⇒ bấm nút đỏ **Lưu mẫu vào ERP** ở góc
**dưới bên phải** ⇒ khung báo kết quả hiện ra, kèm link **Mở mẫu trong ERP**.

> **Không thấy nút?** Nút CHỈ hiện trên trang chi tiết sản phẩm (`detail.1688.com/offer/…`). Nút **KHÔNG** hiện ở trang tìm kiếm,
> trang chủ 1688 hay trang shop — bấm vào một sản phẩm để mở trang chi tiết của nó.

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
| Không thấy nút | Nút chỉ có ở trang chi tiết sản phẩm `detail.1688.com/offer/…` (không có ở trang tìm kiếm / trang chủ / trang shop); tải lại trang (F5); ở `chrome://extensions` kiểm tra tiện ích đang BẬT, bấm ⟳ tải lại |

## Rủi ro đã biết (Tech Lead chấp nhận 25/10/2026) — cho người bảo trì

- **Script của chính trang 1688 giả được câu trả lời của `main-world.js`.** `content.js` hỏi `main-world.js` bằng sự kiện
  `vnx-sourcing:request` mang một nonce; script của trang cũng nghe được sự kiện đó (thấy nonce) nên có thể trả về dữ liệu giả
  trước. Hậu quả TỐI ĐA: một mẫu bị lưu dữ liệu sai vào kho mẫu. Máy chủ vẫn lọc lại theo danh sách cho phép, đọc bằng bộ đọc thuần
  (`lib/sourcing/capture-1688.ts`), không chạm tiền / giá vốn / tồn kho / đơn hàng, và mỗi lần chụp đều có người bấm + nhật ký.
  Không có cách đọc `window.context` mà trang không nhìn thấy được; nếu một ngày cần chắc hơn, so dữ liệu chụp với lời gọi API
  chính thức (keywordQuery / chi tiết) khi đã có 采购服务商.
- **Trần tần suất theo token** (`SOURCING_CAPTURE_RATE`: bắn liền 30 lượt, rồi 1 lượt / 2 giây). Trần nằm trong bộ nhớ của tiến
  trình app — khởi động lại app thì xô đầy lại; đủ cho một máy chủ, chưa phải trần chung nhiều máy.
