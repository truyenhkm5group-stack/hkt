# 03 — Kịch bản quay màn hình và bằng chứng

Meta xem video để thấy từng quyền được DÙNG ở đâu trong app. Giao diện ERP là tiếng Việt ⇒ **thêm phụ đề / chú thích tiếng Anh**
cho từng cảnh (hoặc lời đọc tiếng Anh). Quay liền một mạch, độ phân giải ≥ 720p, MP4, không cắt giữa thao tác; con trỏ chuột
thấy rõ. Che mọi mật khẩu, token, verify token trên màn hình (khối «Người vận hành nền tảng» KHÔNG được xuất hiện).

## 1. Danh sách cảnh — cảnh nào chứng minh quyền nào

| # | Cảnh (chú thích tiếng Anh gợi ý) | Chứng minh |
|---|---|---|
| 1 | Đăng nhập ERP bằng tài khoản thử → mở «Messenger trực tiếp». *"Shop admin opens the Messenger settings page in VNXcommerce."* | Bối cảnh |
| 2 | Bấm «Kết nối Facebook Page» → hộp thoại Facebook hiện TÊN APP và danh sách quyền → Tiếp tục. *"Facebook Login dialog asks for page permissions."* | Luồng cấp quyền (mọi quyền) |
| 3 | Bước «Chọn trang» của Facebook → tích page thử. Quay lại ERP: danh sách page để chọn / dòng «Đã nối page». *"The app lists the pages this user manages so they can pick one."* | `pages_show_list` |
| 4 | Khối «Webhook theo page» → «Kiểm tra lại» → «Webhook đã đăng ký đủ». *"The app subscribed the page to messaging webhooks."* | `pages_manage_metadata` |
| 5 | Điện thoại / cửa sổ thứ hai: tài khoản khách nhắn vào page thử. ERP «Hộp thư khách» hiện tin ngay. *"A customer message arrives in the shop's inbox inside VNXcommerce."* | `pages_messaging` (nhận) + `pages_manage_metadata` (webhook) |
| 6 | Bot trả lời; cửa sổ khách nhận câu trả lời. *"The assistant replies on behalf of the page."* | `pages_messaging` (gửi) |
| 7 | Nhân viên bấm «Tiếp quản», gõ và gửi; khách nhận đúng một tin. *"A human agent takes over and replies from VNXcommerce."* | `pages_messaging` (gửi bởi người) |
| 8 | Khách bình luận dưới một bài của page → khách nhận một tin riêng trên Messenger; trong ERP thấy hội thoại của bình luận đó. *"The app reads the post the customer commented on and sends one private reply."* | `pages_read_engagement` + `pages_messaging` (Private Reply) |
| 9 | (Tuỳ chọn) Trang Chatbot bán hàng → «Nhập hội thoại gần đây» → hội thoại cũ của page hiện trong Hộp thư. *"Recent page conversations are imported for context."* | `pages_read_engagement` + `pages_messaging` (Conversations API) |
| 10 | Bấm «Gỡ» page → xác nhận. *"The shop can disconnect the page at any time; the app unsubscribes the webhook."* | Kiểm soát của người dùng / dữ liệu |

Một video chung cho cả 4 quyền là đủ nếu mỗi cảnh có chú thích quyền tương ứng; Meta cho tải cùng một tệp vào từng quyền.

## 2. Bằng chứng / log cần giữ (để trả lời nếu Meta hỏi lại)

Không dán token, app secret, verify token, mã người dùng vào ảnh hay tài liệu.

1. **Dòng log nối page** (log máy chủ khi bấm kết nối bằng tài khoản Tester, sau khi đã thêm quyền vào app):
   ```
   [messenger-connect] org=<mã tổ chức thử> reason=OK granted=…,pages_show_list,pages_messaging,pages_manage_metadata,pages_read_engagement declined=- missing=- appRole=- userToken=- accounts=1 … eligible=1
   ```
   Trước khi thêm quyền vào app, cùng tài khoản phải ra `reason=PERMISSION_NOT_IN_APP … appRole=has:testers` — chụp lại làm
   bằng chứng «trước / sau».
2. **Webhook OK**: ảnh khối «Webhook theo page» báo «Webhook đã đăng ký đủ», kèm mốc giờ «Kiểm lúc …».
3. **Tin nhắn hai chiều**: ảnh Hộp thư ERP có tin khách + tin bot + tin nhân viên của cùng hội thoại, và ảnh Messenger phía
   khách thấy đủ các tin đó.
4. **Không lỗi webhook**: trong log máy chủ không có `messenger_webhook_rejected` với `reason=SIGNATURE` trong lúc quay
   (chỉ số đếm + mã page, không nội dung tin — `lib/sales-chatbot/messenger-observability.ts`).
5. Bản chẩn đoán đã lưu (`settings.messenger.lastConnectDiagnostic` của tổ chức thử) — hiện trên trang Messenger, không chứa
   token.
