# 01 — Use case, quyền và điều kiện tiên quyết

## 1. Use case

**Engage with customers on Messenger from Meta** (App Dashboard → Use cases). Đây là use case cấp các quyền Messenger cho page
và phần cấu hình webhook của object Page. App hiện có sẵn use case đăng nhập (Facebook Login: `public_profile`, `email`) cho nút
«Tiếp tục với Facebook» — giữ nguyên, use case Messenger là use case THÊM.

Nếu App Dashboard không cho thêm use case này (app loại Consumer cũ), cần đổi loại app sang Business hoặc tạo app Business mới —
khi đó phải khai lại `FACEBOOK_LOGIN_APP_ID/SECRET` và OAuth redirect URI. Kiểm trước khi làm, đây là việc ảnh hưởng cả đăng nhập.

## 2. Checklist 4 quyền bắt buộc

Danh sách này là `MESSENGER_REQUIRED_PERMISSIONS` trong `lib/integrations/messenger/graph.ts` — ERP chặn nối page khi thiếu bất kỳ
quyền nào và in đúng quyền thiếu.

| Quyền | ERP dùng để làm gì (mã thật) | Không có thì | Mức cần |
|---|---|---|---|
| `pages_show_list` | `GET /me/accounts` liệt kê page người bấm quản lý (kèm page token, `tasks`), để họ chọn page nối với bot — `pagesFromCode` | ERP không thấy page nào | Advanced |
| `pages_messaging` | Gửi tin trả lời khách qua Send API `POST /me/messages` (`sendMessengerText`, `sendMessengerImage`); trả lời riêng một bình luận (`sendPrivateReply`); đọc hội thoại gần đây (Conversations API, `pageConversations`) | Bot / nhân viên không gửi được tin | Advanced |
| `pages_manage_metadata` | `POST /{page}/subscribed_apps` đăng ký webhook cho page lúc nối (`subscribePage`), `GET` để kiểm (`checkPageWebhook`), `DELETE` khi gỡ page (`unsubscribePage`) | Tin khách nhắn không bao giờ tới ERP | Advanced |
| `pages_read_engagement` | Đọc nội dung bài viết mà khách bình luận dưới (`postMessage`) để bot hiểu khách hỏi món nào; Conversations API | Bot trả lời bình luận không đúng ngữ cảnh; không nhập được hội thoại gần đây | Advanced |

**Standard vs Advanced Access.** Mọi quyền thêm vào app đều có Standard Access ngay, nhưng Standard chỉ có hiệu lực với người có
vai trò trong app (Administrator / Developer / Tester; «Insights user» không đủ). Khách thuê của nền tảng không có vai trò ⇒
cả 4 quyền phải có **Advanced Access**, tức phải qua App Review + Business Verification. Trước khi duyệt, nối thử bằng tài
khoản Tester là đúng và đủ để quay video.

## 3. KHÔNG nộp đợt đầu

| Quyền | Vì sao không nộp lúc này |
|---|---|
| `business_management` | Chỉ dùng cho đường dự phòng: tìm page CHỈ được giao qua Business Portfolio (`/me/businesses` → `owned_pages` / `client_pages`) khi `/me/accounts` rỗng. Phần lớn chủ page thấy page qua `/me/accounts`. Đây là quyền rộng (đọc tài sản doanh nghiệp) — Meta soát kỹ, nộp chung dễ kéo cả đợt bị trả về. ERP chỉ gọi đường này khi quyền đã được cấp, nên thiếu nó không làm hỏng luồng chính. |
| `instagram_basic`, `instagram_manage_messages` | Instagram DM là use case khác («Manage messaging & content on Instagram»), cần tài khoản Instagram doanh nghiệp gắn page và một video riêng. Tách ra đợt sau để đợt đầu chỉ có một câu chuyện: Messenger. |
| Human Agent (thẻ `HUMAN_AGENT`) | Mã chưa dùng (docs/meta-production-readiness.md §4). |

**Đã xảy ra và đã sửa (07/10/2026):** hộp thoại OAuth từng xin kèm `business_management` và `instagram_*`, và Facebook báo
«Invalid Scopes» cho `instagram_basic` / `instagram_manage_messages` — chủ shop không tới được màn đồng ý. Theo quyết định riêng của
chủ shop, hộp thoại «Kết nối Facebook Page» nay CHỈ xin `public_profile`, `pages_show_list`, `pages_messaging`,
`pages_manage_metadata`, `pages_read_engagement` (`META_CONNECT_SCOPES.FACEBOOK_MESSENGER` trong `lib/integrations/messenger/graph.ts`).
Instagram DM là khả năng RIÊNG (`META_CONNECT_SCOPES.INSTAGRAM_MESSAGING`) cho một luồng kết nối sau này — không thêm lại vào luồng
Messenger. `/platform` → khung Webhook Messenger in đúng bộ quyền hộp thoại đang xin và báo thiếu / thừa / quyền của luồng khác.

## 4. Điều kiện tiên quyết

| Mục | Ở đâu | Giá trị / việc |
|---|---|---|
| Business Verification | business.facebook.com → Business settings → Security Center (hoặc App Dashboard nhắc) | Doanh nghiệp sở hữu app phải ở trạng thái **Verified** — bắt buộc cho Advanced Access. Chuẩn bị giấy phép kinh doanh, tên + địa chỉ khớp với `lib/constants/company.ts`. |
| App Mode = Live | Thanh trên cùng App Dashboard | Chỉ app Live mới phục vụ người không có vai trò. Bật Live đòi đủ các ô bên dưới. |
| Privacy Policy URL | App settings → Basic | `https://vnxcommerce.com/chinh-sach-bao-mat` |
| User data deletion | App settings → Basic → User data deletion | Chọn **Data deletion instructions URL**: `https://vnxcommerce.com/chinh-sach-bao-mat#xoa-du-lieu` (mục 9 của trang). Meta chấp nhận URL hướng dẫn thay cho callback, nên **KHÔNG cần** viết route callback xoá dữ liệu. |
| App icon 1024×1024, Category, Contact email | App settings → Basic | Theo thương hiệu nền tảng. |
| OAuth redirect URI | Use case Facebook Login → Settings → Valid OAuth Redirect URIs | Lấy ở ERP `/ai/sales-chatbot/messenger` khối «Người vận hành nền tảng» (một dòng cho mỗi miền phần mềm). |

## 5. Việc cần làm — trang chính sách quyền riêng tư (KHÔNG tự sửa trang pháp lý)

Đọc `app/chinh-sach-bao-mat/page.tsx` (06/10/2026): mục 3 chỉ nói về dữ liệu ĐĂNG NHẬP bằng Facebook, và còn ghi «chúng tôi
không … đọc tin nhắn cá nhân» — đúng cho đăng nhập nhưng reviewer đọc cạnh yêu cầu `pages_messaging` sẽ thấy mâu thuẫn. Mục 6
chỉ có một dòng chung «Pancake, Facebook (fanpage)». Mục 9 hướng dẫn xoá dữ liệu nhận từ Facebook *đăng nhập* (mã định danh, họ
tên, email), chưa nói tới dữ liệu Messenger của page. **Thiếu một đoạn riêng về dữ liệu Messenger.**

Việc của chủ nền tảng (sửa trang pháp lý là quyết định của chủ, cùng lúc cập nhật `PRIVACY_POLICY.version`): thêm một mục, đề
xuất nội dung:

> **Kết nối Facebook Page để nhắn tin (Messenger).** Khi quản trị cửa hàng bấm «Kết nối Facebook Page», chúng tôi nhận từ
> Facebook: danh sách page người đó quản lý và mã truy cập của các page được chọn. Mã truy cập page được mã hoá trong cơ sở dữ
> liệu của cửa hàng; mã truy cập của tài khoản cá nhân không được lưu. Sau khi kết nối, chúng tôi nhận các tin nhắn khách gửi
> tới page, các bình luận mới dưới bài viết của page và nội dung bài viết được bình luận, chỉ để chatbot và nhân viên của cửa
> hàng trả lời khách ngay trong phần mềm. Dữ liệu này thuộc nhóm B (mục 2): chúng tôi không dùng cho mục đích riêng, không bán,
> không chia sẻ cho cửa hàng khác. Quản trị cửa hàng gỡ kết nối bất kỳ lúc nào ở «Chatbot bán hàng → Messenger» (phần mềm huỷ
> đăng ký nhận tin của page ở Facebook) hoặc trong cài đặt page trên Facebook. Yêu cầu xoá hội thoại đã lưu gửi theo mục 9;
> khách hàng của cửa hàng gửi yêu cầu tới chính cửa hàng.

Và sửa câu ở mục 3 cho rõ phạm vi: «Khi **đăng nhập**, chúng tôi không …». Thêm vào mục 9 một câu: «Dữ liệu Messenger của page
đã kết nối được xoá theo cùng quy trình, theo yêu cầu của quản trị cửa hàng.»
