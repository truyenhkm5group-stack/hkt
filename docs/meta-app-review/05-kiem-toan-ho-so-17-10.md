# 05 — Kiểm toán hồ sơ đã nộp 07/10/2026 và bộ bằng chứng thay thế

App **ChotDonTuDong Messenger** · App ID `1794152675112502` (không phải bí mật). Hồ sơ App Review nộp 07/10/2026, đang xét 5
quyền. Tài liệu này KHÔNG chứa mật khẩu, token, verify token — kho PUBLIC.

Luật của tài liệu: chỗ nào **đo được** thì ghi nguồn đo; chỗ nào **chưa xem được** thì ghi CHƯA XÁC MINH, không suy ra từ ảnh
thu nhỏ.

---

## 1. Kết quả kiểm toán (17/10/2026)

### 1.1 Video gốc đã nộp — CHƯA XÁC MINH ĐƯỢC

| Nơi đã tìm | Kết quả |
|---|---|
| Máy làm việc (`Videos`, `Downloads`, `Desktop`, `Pictures`, thư mục Captures của Game Bar) | Không có tệp video nào tạo sau 09/08/2026 ⇒ video nộp ngày 07/10 không được dựng / lưu trên máy này |
| Google Drive của chủ shop | Không đọc được (kết nối Drive của phiên cần đăng nhập lại) |
| Kho mã | Không lưu video (đúng luật — kho PUBLIC) |

⇒ Chỉ chủ tài khoản Meta xem được video đã tải lên (§4 việc O1). **Ảnh thu nhỏ giống nhau KHÔNG đủ để kết luận** — Meta lấy
khung hình đầu của tệp, và một video bắt đầu bằng màn hình App Dashboard vẫn có thể có cảnh dùng app thật ở phía sau.

### 1.2 Chứng cứ gián tiếp — video gần như CHẮC CHẮN không thể hiện được luồng thật (suy luận, cần O1 xác nhận)

| Mốc | Nguồn | Hệ quả cho video nộp 07/10 |
|---|---|---|
| Tới 10:21 sáng 07/10, hộp thoại «Kết nối Facebook Page» bị Meta từ chối **«Invalid Scopes»**, chủ shop không tới được màn đồng ý | commit `6c13fc7c1` (#628) | Trước mốc này KHÔNG quay được cảnh cấp quyền / chọn page / nhận tin |
| 08/10, sổ nhiệm vụ vẫn ghi việc còn lại là «thêm use case + 4 quyền; **bấm Kết nối Facebook Page một lần**» | `MASTER_MISSION_REGISTRY.md` mục `meta-messenger-access` | Tới 08/10 chưa có lượt nối page thành công nào được ghi nhận |
| 08/10, bản kiểm kê ghi trang chính sách **chưa** có mục Messenger | `HUONG_DAN_CHU_SHOP.md` C1 | Hồ sơ nộp 07/10 chắc chắn chưa có mục này |
| Hướng dẫn quay (03), câu tiếng Anh (04 bản sửa) và hướng dẫn chủ shop ra đời 08/10 | commit `5a776bdea` (#672) | Hồ sơ nộp TRƯỚC khi có kịch bản quay |

Nếu thumbnail là màn hình App Dashboard / **Graph API Explorer** thì đó đúng là kiểu video Meta hay trả về: người duyệt cần thấy
**trải nghiệm trong app của mình** (người dùng bấm, Facebook hỏi quyền, app dùng dữ liệu), không phải lời gọi API trong công cụ
của Meta.

### 1.3 Môi trường cho người duyệt — đo trên production 17/10/2026 (chỉ đọc, GET)

| Hạng mục | Đo được | Kết luận |
|---|---|---|
| `https://vnxcommerce.com/chinh-sach-bao-mat`, `https://chotdontudong.com/chinh-sach-bao-mat`, `https://app.chotdontudong.com/chinh-sach-bao-mat` | 200 | Truy cập được, không đòi đăng nhập |
| Nội dung chính sách đang chạy | Phiên bản **1.1**, **0** lần nhắc «Messenger», vẫn còn câu «không đọc … **tin nhắn cá nhân**» (mục 3) | **ĐỎ** — mâu thuẫn trực tiếp với `pages_messaging`. Đề xuất câu chữ đã có ở 01 §5 từ 06/10, chưa lên trang (việc K3) |
| `https://app.chotdontudong.com/login` | 200; ô email + mật khẩu + mã cửa hàng (bỏ trống được) | Người duyệt đăng nhập được nếu có tài khoản |
| `/api/webhooks/messenger` GET với verify token sai | 403 | Đúng — từ chối token sai |
| `/api/connect/messenger/start` chưa đăng nhập | 401 | Đúng — phải đăng nhập |
| `/api/health` | `ok: true`, commit `abcb7da97ba8` | Máy chủ sống |
| **Nút «Kết nối Facebook Page» với tài khoản KHÔNG phải người vận hành** | Mã từ 09/10 (#712): nút bị thay bằng ô tắt **«Nối thẳng Facebook — sắp mở»** trừ khi cờ `platform_settings['meta.direct-connect.open']` mở cho mã cửa hàng đó; **không có đường UI / ops nào bật cờ** (`MM-FU-712`); `set-setting` chỉ ghi `settings` của tổ chức nhà | **ĐỎ** — người duyệt đăng nhập tài khoản thử sẽ KHÔNG thấy nút mà 04 §3 bảo họ bấm ⇒ lý do từ chối kiểu «unable to test / feature not available» |
| Page thử cũng đang nối qua Pancake | `mutedByPancake`: đường Messenger trực tiếp tự nhường cho Pancake | **Rủi ro** — video sẽ quay ra luồng Pancake chứ không phải Messenger API. Page thử phải KHÔNG nối Pancake |
| Vỏ Chốt Đơn đổi nhãn | Khối «Webhook theo page» hiện là **«Page có đang gửi tin về không»** với tài khoản vỏ Chốt Đơn | Câu tiếng Anh phải gọi đúng nhãn người duyệt thấy |
| Hộp thư có hiện nội dung bài viết được bình luận không | **Không** — nội dung bài chỉ đi vào lời nhắc cho AI (`postContextPrompt`) | Cảnh `pages_read_engagement` phải chứng minh bằng câu trả lời riêng nhắc đúng sản phẩm CHỈ có trong bài (§2 video D) |

Không đo được từ đây (việc của chủ shop, §4): App ID mà production đang dùng có đúng `1794152675112502` không; Valid OAuth
Redirect URIs của app (`MM-REC-05`); số lượt gọi API mà Meta đã đếm cho từng quyền; quyền thứ 5 trong hồ sơ là quyền nào.

### 1.4 Quyền thứ 5

Hộp thoại kết nối hiện xin đúng `public_profile` + 4 quyền page (`META_CONNECT_SCOPES.FACEBOOK_MESSENGER`). `public_profile` là
quyền mặc định, không cần review. Nếu quyền thứ 5 trong hồ sơ là `business_management`, `instagram_basic` hoặc
`instagram_manage_messages` thì đó là **rủi ro**: tới sáng 07/10 hộp thoại còn xin các quyền này, nhưng mã hiện tại KHÔNG xin
nữa ⇒ người duyệt sẽ không thấy chúng được dùng (01 §3). Khi Meta cho sửa, rút quyền đó khỏi hồ sơ thay vì cố quay video cho nó.

---

## 2. Bộ video thay thế — mỗi quyền một video

Meta cho tải chung một video, nhưng **mỗi quyền một video ngắn** làm người duyệt thấy ngay quyền mình đang xét được dùng ở đâu,
và một quyền bị trả về không kéo theo ba quyền kia. Mỗi video 1–3 phút, MP4 ≥ 720p (khuyên 1080p), có phụ đề tiếng Anh dán
cứng lên hình, con trỏ chuột thấy rõ, không cắt giữa thao tác.

### 2.0 Chuẩn bị trước khi quay (tất cả phải ĐẠT)

| # | Điều kiện | Cách kiểm |
|---|---|---|
| P1 | Một **page thử** công khai, không giới hạn quốc gia / độ tuổi, **không nối Pancake**, có ít nhất một bài viết nêu rõ tên + giá một sản phẩm (ví dụ «Áo sơ mi linen trắng — 299.000đ») | Mở page bằng trình duyệt ẩn danh |
| P2 | Một **cửa hàng thử** trên `app.chotdontudong.com` (việc K4), bật AI bán hàng ở chế độ **AI tự trả lời** (không phải COPILOT), có sản phẩm trùng tên với bài viết P1 | Đăng nhập, mở `/ai/sales-chatbot` |
| P3 | Tài khoản cửa hàng thử **thấy nút «Kết nối Facebook Page»** (cần việc K8; tạm thời dùng lối tạm ở §3.2) | Mở `/ai/sales-chatbot/messenger` |
| P4 | Tài khoản Facebook quay phim (quản trị page thử) có vai trò **Administrator / Developer / Tester** trong app `1794152675112502` — quyền chưa duyệt chỉ chạy với người có vai trò | App Dashboard → App roles |
| P5 | Một tài khoản Facebook **thứ hai** đóng vai khách (điện thoại hoặc cửa sổ thứ hai) | Nhắn thử một tin |
| P6 | Trang chính sách đã có mục Messenger (K3) — video không cần, nhưng hồ sơ cần | Mở ẩn danh |
| P7 | Trình duyệt và Facebook để **English (US)** nếu được — hộp thoại cấp quyền bằng tiếng Anh giúp người duyệt đọc | Cài đặt ngôn ngữ Facebook |
| P8 | Màn hình KHÔNG có: trang `/platform`, khối «Người vận hành nền tảng», verify token, mật khẩu, App Secret, thông báo cá nhân | Xem lại trước khi xuất |

Bố cục khuyên dùng: chia đôi màn hình — trái là trình duyệt `app.chotdontudong.com`, phải là Messenger của tài khoản «khách».

### 2.1 Đoạn mở đầu dùng chung (đặt ở đầu CẢ BỐN video, ~40 giây)

| Cảnh | Thao tác | Phụ đề tiếng Anh |
|---|---|---|
| 0.1 | Mở `https://app.chotdontudong.com/login`, đăng nhập tài khoản cửa hàng thử | *ChotDonTuDong (a VNXcommerce product) — a shop admin logs in.* |
| 0.2 | Mở `/ai/sales-chatbot/messenger` | *The shop opens the Messenger connection settings.* |
| 0.3 | Bấm **«Kết nối Facebook Page»** | *The admin clicks "Connect Facebook Page".* |
| 0.4 | Hộp thoại Facebook: dừng **3 giây** trên màn có **tên app «ChotDonTuDong Messenger»** và danh sách quyền | *Facebook Login asks the admin to grant page permissions to ChotDonTuDong Messenger.* |
| 0.5 | Bước chọn page: tích page thử → Continue / Save | *The admin chooses which Page to connect.* |

Không cắt cảnh 0.4 — thiếu luồng đăng nhập là lý do từ chối thường gặp nhất.

### 2.2 Video A — `pages_show_list`

| Cảnh | Thao tác | Phụ đề |
|---|---|---|
| A1 | Đoạn mở đầu 0.1–0.5 | (như trên) |
| A2 | Về ERP: khối **«Chọn các page cho bot»** hiện danh sách page tài khoản này quản lý (nếu chỉ một page thì hiện thẳng dòng «Đã nối page …») | *pages_show_list: the app lists the Pages this admin manages (GET /me/accounts) so they can pick one.* |
| A3 | Tích page thử → **«Nối 1 page đã chọn»** → khối «Page đang nối (1)» hiện tên page | *Only the selected Page is connected and stored.* |

### 2.3 Video B — `pages_manage_metadata`

| Cảnh | Thao tác | Phụ đề |
|---|---|---|
| B1 | Đoạn mở đầu + A3 (rút gọn) | |
| B2 | Khối **«Webhook theo page»** (vỏ Chốt Đơn: **«Page có đang gửi tin về không»**) → **«Kiểm tra lại»** → dòng page thử báo đã đăng ký đủ | *pages_manage_metadata: on connect, the app subscribed this Page to the messages, messaging_postbacks, message_echoes and feed webhooks. "Check again" reads the subscription.* |
| B3 | Tài khoản khách nhắn «Hello shop, is this shirt available in size M?» → trong ~5 giây tin hiện ở `/ai/sales-chatbot/inbox` | *Because of the subscription, the customer's message reaches the shop's inbox in real time.* |
| B4 | Quay lại trang Messenger → **«Gỡ»** page → xác nhận → page biến khỏi danh sách | *The admin can disconnect at any time: the app unsubscribes the Page (DELETE /{page-id}/subscribed_apps).* |
| B5 | Khách nhắn tiếp → hộp thư KHÔNG nhận | *After disconnecting, no new messages are received.* |

Quay B4–B5 SAU CÙNG (sau cả video C, D) hoặc nối lại page sau khi quay.

### 2.4 Video C — `pages_messaging`

| Cảnh | Thao tác | Phụ đề |
|---|---|---|
| C1 | Đoạn mở đầu (rút gọn) + page đã nối | |
| C2 | Khách nhắn hỏi sản phẩm → tin hiện trong **Hộp thư khách** | *A customer messages the Page. The conversation appears in the shop inbox.* |
| C3 | AI trả lời; cửa sổ khách nhận câu trả lời trong Messenger (để thấy cả hai bên cùng lúc) | *pages_messaging: the shop's AI assistant replies as the Page via the Send API, inside the 24-hour window, in response to the customer.* |
| C4 | Nhân viên bấm **«Tiếp quản»**, gõ câu trả lời, gửi → khách nhận đúng một tin | *A staff member takes over and replies from the inbox; the customer receives it as the Page.* |
| C5 | Bấm **«Trả lại AI»** | *Staff hands the conversation back to the assistant.* |

### 2.5 Video D — `pages_read_engagement`

| Cảnh | Thao tác | Phụ đề |
|---|---|---|
| D1 | Đoạn mở đầu (rút gọn) + page đã nối | |
| D2 | Mở bài viết P1 trên page, dừng 3 giây cho thấy tên + giá sản phẩm trong bài | *This Page post mentions a specific product.* |
| D3 | Tài khoản khách bình luận câu chung chung: «price?» / «giá sao shop» (KHÔNG nêu tên sản phẩm) | *A customer comments a generic question without naming the product.* |
| D4 | Khách nhận **một tin riêng** trong Messenger nêu đúng sản phẩm trong bài; ERP hiện hội thoại của bình luận đó | *pages_read_engagement: the app reads the text of the commented post so the reply is about the right product. pages_messaging sends one private reply.* |

Vì hộp thư không hiện nội dung bài viết, chứng cứ duy nhất là **câu trả lời nêu đúng sản phẩm mà bình luận không hề nhắc**.
Dựng D2–D4 đúng như vậy; đừng để khách tự gõ tên sản phẩm.

### 2.6 (Tuỳ chọn) Video tổng E2E 3–5 phút

Ghép 0 → A → B2–B3 → C → D → B4–B5 thành một mạch liền, dùng làm video «tổng quan» ở ô mô tả app nếu Meta có chỗ tải.

---

## 3. Việc kỹ thuật phải xong TRƯỚC khi quay (không phải việc của chủ shop)

### 3.1 Danh sách

| # | Việc | Vì sao chặn | Trạng thái (17/10 chiều) |
|---|---|---|---|
| K3 | Mục «3a. Kết nối Facebook Page để nhắn tin (Messenger)» trên trang chính sách: dữ liệu nhận · mục đích · cách lưu · khung 24 giờ · gỡ kết nối · xoá; câu mục 3 thành «Khi **đăng nhập** …»; dòng Meta ở bảng bên thứ ba; câu xoá dữ liệu page ở mục 9; phiên bản **1.2** | Trang đang chạy mâu thuẫn trực tiếp với `pages_messaging` | **CÓ MÃ** (`components/legal/privacy-content.tsx`, băm ghim lại) — chờ deploy |
| K4 | Dựng cửa hàng demo cho người duyệt trên `app.chotdontudong.com` (§7) | Người duyệt cần đăng nhập thật | Việc của người vận hành SAU deploy — tạo dữ liệu production |
| K8 | Đường người vận hành đặt cờ `meta.direct-connect.open` theo **danh sách mã cửa hàng**, có nhật ký `FLAG_SET` — đóng `MM-FU-712`. Đặt `["<mã cửa hàng demo>"]`, KHÔNG đặt «Mở cho mọi cửa hàng» trước khi Meta duyệt | Không có nó, tài khoản người duyệt thấy «sắp mở» thay vì nút | **CÓ MÃ** (`/platform` → khung Webhook Messenger → «Nút Kết nối Facebook Page cho khách») — chờ deploy |
| K5 | Sửa chữ cũ: README + 01 §1 còn ghi «cùng app đăng nhập» | Tránh làm theo tài liệu sai | Xong |

### 3.2 Lối tạm khi K8 chưa xong (không cần sửa mã)

Route `/api/connect/messenger/start` KHÔNG bị cờ chặn, cờ chỉ quyết có vẽ nút hay không. Tài khoản có quyền Cài đặt của cửa
hàng thử, đã đăng nhập, mở thẳng `https://app.chotdontudong.com/api/connect/messenger/start` thì vẫn vào hộp thoại Facebook.
Đủ để **chủ shop quay video**; KHÔNG đủ cho **người duyệt** (họ vẫn thấy ô «sắp mở» trên trang, dễ ghi «feature not available»).

---

## 4. Việc chủ tài khoản Meta làm trực tiếp (agent không làm thay được)

**Không** huỷ hồ sơ đang xét, **không** tạo app mới, **không** bấm «Submit» lại khi hồ sơ đang In review.

| # | Việc | Ở đâu trên developers.facebook.com | Xong khi |
|---|---|---|---|
| O1 | Xem lại video ĐÃ NỘP cho từng quyền: có cảnh hộp thoại Facebook Login với tên app không? có cảnh app dùng quyền không? hay chỉ là App Dashboard / Graph API Explorer? Nếu còn tệp gốc ở máy / Drive khác thì gửi tên tệp + nơi lưu (không gửi lên kho) | App `1794152675112502` → **App Review → Requests** → mở yêu cầu đang In review → từng quyền | Trả lời được: video quyền nào có / thiếu cảnh nào |
| O2 | Ghi lại **quyền thứ 5** đang xét là quyền nào | Cùng trang | Biết tên quyền (xem §1.4) |
| O3 | Đối chiếu App ID production: ERP `/platform` → khung Webhook Messenger → dòng «App Messenger riêng» phải ghi `1794152675112502`, và «Nối page dùng app» phải là «App Messenger riêng» | ERP `/platform` (đừng quay / chụp khung này) | Hai số trùng |
| O4 | Kiểm **Valid OAuth Redirect URIs** có đủ dòng `https://app.chotdontudong.com/api/connect/messenger/callback` (và miền ERP nếu dùng) — đóng `MM-REC-05` | Use case Facebook Login (for Business) → Settings | Đủ dòng, đã lưu |
| O5 | Kiểm Meta đã đếm **lượt gọi API thành công** cho từng quyền (không còn «0 of 1 API call(s)») | Use case Messenger → Permissions and features | Cả 4 quyền có lượt gọi |
| O6 | Thêm tài khoản Facebook quay phim làm Tester nếu chưa có vai trò (P4) | App roles → Roles | Người đó đã Accept |
| O7 | Đọc lại mục 3a của chính sách (bản 1.2, trong PR) trước khi deploy — sửa văn bản pháp lý là quyết định của chủ shop | PR trên GitHub | Đồng ý hoặc sửa câu |
| O8 | Quay 4 video theo §2 sau khi K3, K4, K8 xong | Máy của chủ shop | 4 tệp MP4 |
| O9 | Khi Meta **hỏi thêm / cho bổ sung / trả về**: tải 4 video mới vào đúng quyền, dán câu ở 04, **Resubmit** | App Review → Requests | Trạng thái lại In review |
| O10 | Trong lúc chờ: giữ nguyên page thử, cửa hàng thử, tài khoản người duyệt, không đổi mật khẩu | — | — |

Về O9: hồ sơ đang In review thường không sửa được video; Meta chỉ mở lại khi họ hỏi thêm hoặc trả về. Bộ video §2 là để sẵn
sàng cho lúc đó, nộp lại trong ngày thay vì mất thêm một vòng.

---

## 5. Rà soát quyền — giữ / bỏ (KHÔNG đổi hồ sơ đang xét)

Đối chiếu mã thật: hộp thoại xin `META_CONNECT_SCOPES.FACEBOOK_MESSENGER`; quyền chặn nối page là `MESSENGER_REQUIRED_PERMISSIONS`
(`lib/integrations/messenger/graph.ts`).

| Quyền | Lời gọi thật trong mã | Kết luận |
|---|---|---|
| `public_profile` | Mặc định của Facebook Login, không qua App Review | Giữ (không thuộc hồ sơ) |
| `pages_show_list` | `GET /me/accounts` (`pagesFromCode`) — liệt kê page để chọn | **Giữ** — thiếu thì 0 page |
| `pages_manage_metadata` | `POST / GET / DELETE /{page}/subscribed_apps` (`subscribePage`, `checkPageWebhook`, `unsubscribePage`) | **Giữ** — thiếu thì không tin nào tới |
| `pages_messaging` | Send API `POST /me/messages` (chữ + ảnh, `messaging_type: RESPONSE`), Private Replies `recipient.comment_id`, Conversations API | **Giữ** — chức năng chính |
| `pages_read_engagement` | `GET /{post-id}?fields=message` (`postMessage`) cho trả lời bình luận; Conversations API | **Giữ** — nhưng là quyền dễ bị hỏi «vì sao cần» nhất; video D phải dựng đúng như §2.5 |
| `business_management` | Chỉ đường dự phòng khi `/me/accounts` rỗng VÀ quyền đã được cấp; hộp thoại KHÔNG xin | **Đề xuất bỏ** nếu đang nằm trong hồ sơ |
| `instagram_basic`, `instagram_manage_messages` | Không thuộc luồng Messenger; hộp thoại KHÔNG xin từ #628 | **Đề xuất bỏ** khỏi hồ sơ này — Instagram DM là một lần nộp riêng |
| `email` | App Messenger không dùng (đăng nhập ERP đi app khác) | Không cần |

Webhook fields `messages · messaging_postbacks · message_echoes · feed`: `feed` cần cho bình luận (Private Reply);
`message_echoes` để nhận ra tin của nhân viên / của bot (tránh bot trả lời đè người). Không trường nào thừa.

Nếu quyền thứ 5 (O2) là một trong các quyền «đề xuất bỏ»: KHÔNG rút giữa lúc In review. Khi Meta trả hồ sơ / cho sửa: bỏ quyền đó,
nộp lại 4 quyền.

---

## 6. Kiểm tra kỹ thuật — đã kiểm được gì, CHƯA kiểm được gì

### 6.1 Đã kiểm (17/10/2026)

| Mắt xích | Cách kiểm | Kết quả |
|---|---|---|
| Bắt đầu OAuth | GET production `/api/connect/messenger/start` không phiên | 401 — đúng (chỉ người có quyền Cài đặt) |
| `state` / callback | Đọc `app/api/connect/messenger/callback/route.ts` | `state` ký trong cookie, khớp `state` + tổ chức + người bấm; sai ⇒ `loi=state`; cookie bị xoá ngay |
| Bộ quyền hộp thoại xin | `META_CONNECT_SCOPES.FACEBOOK_MESSENGER` + `/platform` «Quyền hộp thoại … xin» | Đúng 5: `public_profile` + 4 quyền page |
| Webhook xác minh | GET production verify token sai | 403 — đúng |
| Webhook chữ ký / page lạ / trùng `mid` | `tests/messenger-webhook-secrets.test.ts`, `tests/messenger.test.ts` | Đạt (Graph giả lập) |
| Chẩn đoán 7 lý do nối page | `tests/messenger-discovery.test.ts` | Đạt |
| Nối / gỡ / nhiều page / sức khoẻ webhook | `tests/messenger-lifecycle.test.ts`, `-multipage`, `-health` | Đạt |
| Cờ nối thẳng — đọc + đường ghi mới | `tests/direct-connect-gate.test.ts` (`testDirectConnectGate`, `testDirectConnectWrite`) | Đạt; kiểm đột biến: bỏ dòng chặn người vận hành ⇒ bài kiểm ĐỎ |
| Chính sách 1.2 | `tests/legal-registers.test.ts` (băm ghim, trang dựng đúng cây được băm) | Đạt |

### 6.2 CHƯA kiểm được — cần tài khoản Meta có vai trò trong app + page thử

Mọi lời gọi Graph trong bài kiểm là GIẢ LẬP. Gửi / nhận tin THẬT qua Messenger API chỉ kiểm được bằng một tài khoản Facebook có vai
trò trong app `1794152675112502` và một page thử — agent không có cả hai. Lượt smoke dưới đây cũng chính là lượt tạo «lượt gọi API
thành công» Meta đòi (O5), làm SAU deploy và SAU §7:

| Bước | Thao tác | Dấu hiệu ĐẠT |
|---|---|---|
| S1 | Đăng nhập cửa hàng demo → `/ai/sales-chatbot/messenger` | Thấy nút xanh «Kết nối Facebook Page» (không phải «sắp mở») |
| S2 | Bấm, cấp đủ quyền, chọn page thử | Dòng «Đã nối page …»; log máy chủ `[messenger-connect] org=<mã demo> reason=OK … missing=- … eligible=1` |
| S3 | «Kiểm tra lại» ở khối webhook theo page | Báo đã đăng ký đủ |
| S4 | Tài khoản thứ hai nhắn page | Tin hiện ở `/ai/sales-chatbot/inbox`; KHÔNG có `messenger_webhook_rejected` trong log |
| S5 | AI trả lời | Tài khoản thứ hai nhận tin trong Messenger |
| S6 | «Tiếp quản» → gõ → gửi | Nhận đúng một tin |
| S7 | Bình luận «price?» dưới bài nêu sản phẩm | Nhận một tin riêng nêu đúng sản phẩm |
| S8 | Cửa hàng khác (không trong cờ) mở cùng trang | Vẫn thấy «Nối thẳng Facebook — sắp mở» |

---

## 7. Dựng cửa hàng demo cho người duyệt (K4 — SAU deploy, người vận hành làm)

Mục tiêu: người duyệt tự đăng nhập, tự bấm kết nối, tự nhắn thử — mà không có quyền người vận hành, không thấy dữ liệu cửa hàng khác.

1. Tạo một cửa hàng MỚI, riêng cho việc duyệt (đề xuất mã `meta-review-demo`), thương hiệu Chốt Đơn — qua mã mời ở `/platform` rồi
   đăng ký ở `https://app.chotdontudong.com/start`. KHÔNG dùng cửa hàng của khách thật hay HSLC.
2. Trong cửa hàng đó: bật module AI bán hàng, chế độ **AI tự trả lời** (không COPILOT), thêm 2–3 sản phẩm khớp bài viết của page thử.
   **Không** nối Pancake cho page thử (`mutedByPancake` sẽ đẩy tin sang đường Pancake).
3. Tạo tài khoản người duyệt trong CHÍNH cửa hàng đó, vai trò Quản trị (có `settings:manage` — route `/api/connect/messenger/start`
   đòi quyền này). Mật khẩu chỉ ghi trong form Meta.
4. `/platform` → khung «Webhook Messenger / Instagram» → «Nút Kết nối Facebook Page cho khách» → **Chỉ các cửa hàng được liệt kê**
   → `meta-review-demo` → lý do «Cửa hàng cho người duyệt Meta App Review» → Đặt. Lượt đổi vào nhật ký nền tảng (`FLAG_SET`).
5. Nối sẵn page thử (smoke §6.2) để người duyệt vào là thấy page đang nối; họ vẫn tự bấm «Thêm / nối lại page» được.

Ranh giới bảo vệ (đã có sẵn, không phải viết thêm):
- Mỗi cửa hàng một cơ sở dữ liệu riêng; tài khoản người duyệt chỉ đăng nhập được vào cửa hàng demo.
- Quản trị của cửa hàng không phải nhà KHÔNG có quyền người vận hành, kể cả mang khoá `platform:operate` (`platformOperatorDenial`;
  bài kiểm `testDirectConnectWrite` khoá đúng trường hợp này) — không tự mở cờ cho cửa hàng khác, không thấy `/platform`.
- Cờ danh sách so khớp mã cửa hàng CHÍNH XÁC; mở cho `meta-review-demo` không mở cho cửa hàng nào khác.
- Webhook định tuyến theo MÃ PAGE; page chưa nối vào cửa hàng nào thì bị bỏ qua, không rơi vào tổ chức nào.
- Khi Meta duyệt xong: đổi cờ sang «Mở cho mọi cửa hàng» (một lượt, có nhật ký), rồi đình chỉ hoặc giữ cửa hàng demo cho lần duyệt sau.
