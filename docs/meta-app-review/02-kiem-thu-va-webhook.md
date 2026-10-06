# 02 — Luồng thử trên ERP, tài khoản thử, webhook, chẩn đoán

## 1. Luồng thử từng bước (cũng là kịch bản quay video)

Chuẩn bị: một **page thử** của chủ shop (không dùng page đang bán thật để khách không nhận tin thử); một tài khoản Facebook
**quản trị page** đó có vai trò **Tester** (hoặc Admin/Developer) trong app; một tài khoản Facebook **thứ hai** đóng vai khách;
một tổ chức ERP thử đã bật module «AI bán hàng», người đăng nhập có quyền Cài đặt.

1. Đăng nhập ERP → **AI · Chatbot bán hàng → Messenger trực tiếp** (`/ai/sales-chatbot/messenger`).
2. Bấm **«Kết nối Facebook Page»** → hộp thoại Facebook hiện danh sách quyền (pages_show_list, pages_messaging,
   pages_manage_metadata, pages_read_engagement …) → **Tiếp tục** → ở bước **Chọn trang** tích page thử → **Lưu / Xong**.
3. ERP quay về:
   - một page ⇒ nối ngay, dòng xanh «Đã nối page …»;
   - nhiều page ⇒ khối **«Chọn các page cho bot»** → tích page thử → **«Nối 1 page đã chọn»**.
4. Khối **«Webhook theo page»** → bấm **«Kiểm tra lại»** ⇒ dòng page thử báo **«Webhook đã đăng ký đủ»** (đọc
   `GET /{page}/subscribed_apps`, chỉ đọc).
5. Từ tài khoản «khách», mở Messenger nhắn vào page thử: «Shop ơi áo này còn size M không?».
6. ERP → **Hộp thư khách** (`/ai/sales-chatbot/inbox`) ⇒ hội thoại mới của page thử hiện tin của khách.
7. Bot trả lời (chế độ «AI tự trả lời») ⇒ khách nhận tin trên Messenger.
8. Nhân viên bấm **«Tiếp quản»** trên hội thoại, gõ câu trả lời, gửi ⇒ khách nhận ĐÚNG MỘT tin của người; bot im.
9. Bấm **«Trả lại AI»** → khách nhắn tiếp → bot trả lời lại.
10. Khách bình luận dưới một bài viết của page thử ⇒ khách nhận một tin riêng trong Messenger (Private Reply), nội dung bám theo
    bài viết (bot đọc nội dung bài bằng `pages_read_engagement`).
11. (Tuỳ chọn) **Gỡ** page thử ở danh sách page ⇒ ERP gọi `DELETE /{page}/subscribed_apps`; khách nhắn tiếp thì ERP không nhận.

## 2. Tài khoản và page thử

- **Page thử**: page của chủ shop dùng riêng cho thử nghiệm và review. Ghi tên page vào form Meta, không ghi vào kho.
- **Tester**: App Dashboard → **App roles → Roles → Add People → Tester** → người đó chấp nhận ở
  `developers.facebook.com/requests`. Trước khi được duyệt, chỉ tài khoản có vai trò mới nối được page (ERP sẽ in
  `PERMISSION_NEEDS_APP_REVIEW` cho người không có vai trò — đúng như mong đợi).
- **Tài khoản ERP cho reviewer**: chủ nền tảng tạo một người dùng trong tổ chức ERP thử (quyền Cài đặt + AI bán hàng), đặt
  mật khẩu riêng, và chỉ điền vào ô Reviewer instructions của Meta. **Không** ghi mật khẩu vào kho, Lark hay commit.
- Reviewer dùng tài khoản Facebook của chính họ để nhắn vào page thử; page thử phải ở chế độ công khai, không giới hạn quốc
  gia / độ tuổi để reviewer nhắn được.

## 3. Webhook — cách ERP xác minh (đọc từ `app/api/webhooks/messenger/route.ts`)

- **Một URL cho mọi cửa hàng**: `https://<miền phần mềm>/api/webhooks/messenger` (Meta chỉ nhận một Callback URL mỗi object).
- **Xác minh khi khai (GET)**: Meta gọi `?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`. ERP so `hub.verify_token`
  với `messengerVerifyToken()` — HMAC-SHA256 của `AUTH_SECRET` (nhãn `messenger-webhook-verify/v1`), lấy 32 ký tự đầu, KHÔNG
  phải biến môi trường riêng. Khớp ⇒ trả nguyên `hub.challenge` (text/plain, 200); sai ⇒ 403 và một dòng log
  `messenger_webhook_rejected reason=VERIFY_TOKEN`. Giá trị verify token xem ở ERP (tổ chức nhà) — không chép vào tài liệu.
- **Nhận sự kiện (POST)**:
  1. thân gói bị chặn trần kích thước (`MESSENGER_WEBHOOK_MAX_BODY_BYTES`) ⇒ quá trần trả 413;
  2. chữ ký `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256 của THÂN GỐC bằng app secret, so thời gian hằng
     (`verifyMessengerSignature`) ⇒ sai trả 401, không đọc gì;
  3. mỗi sự kiện tìm tổ chức theo MÃ PAGE; page chưa nối ⇒ bỏ qua, không rơi về tổ chức nào;
  4. ghi tin rồi trả 200 ngay; gọi AI + Send API chạy sau phản hồi (`after()`); chống trùng theo `mid` vì Meta gửi lại.
- **Đăng ký page**: lúc nối, ERP gọi `POST /{page}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_echoes,feed`
  bằng page token + `appsecret_proof`. Kiểm lại bằng nút «Kiểm tra lại» (`GET`, chỉ đọc).

## 4. Chẩn đoán trên ERP — bảng lý do

Sau hộp thoại Facebook, ERP ghi một dòng log và lưu bản chẩn đoán (không token) ở `settings.messenger.lastConnectDiagnostic`;
trang Messenger hiện **danh sách quyền đã cấp / bị bỏ chọn / còn thiếu**, vai trò của người bấm và hướng xử lý. Thứ tự ưu tiên:
token → quyền → page.

| # | Lý do | Cách phát hiện | Hướng xử lý |
|---|---|---|---|
| 7 | `TOKEN_EXPIRED` | `/me/permissions` lỗi ⇒ `GET /debug_token` (app token + appsecret_proof): `is_valid=false`, `expires_at` đã qua, hoặc token của app khác | Chủ page kết nối lại từ đầu |
| 1 | `PERMISSION_DECLINED` | `/me/permissions` có quyền bắt buộc `status=declined` | Chủ page kết nối lại, giữ BẬT mọi quyền |
| 2 | `PERMISSION_NOT_IN_APP` | Thiếu quyền (không do bỏ chọn) + `/me?fields=id` trùng một dòng `GET /{app-id}/roles` có vai trò administrators / developers / testers | Chủ nền tảng: Use cases → Messenger → Customize → Add 4 quyền |
| 3 | `PERMISSION_NEEDS_APP_REVIEW` | Thiếu quyền + người bấm không có vai trò (hoặc chỉ «insights users») | Chủ nền tảng: thêm Tester (tạm) hoặc App Review (lâu dài) |
| – | `PERMISSION_NOT_GRANTED` | Thiếu quyền nhưng gọi `/roles` hoặc `/me` lỗi ⇒ không kết luận | Chủ nền tảng kiểm cả 2 và 3 |
| 4 | `NO_MESSAGING_TASK` | Page có token nhưng `tasks` không có MESSAGING / MANAGE / MODERATE | Chủ page cấp quyền Tin nhắn / Toàn quyền trên page |
| 5 | `NO_PAGES` | Đủ quyền, `/me/accounts` (và Business Portfolio nếu có quyền) trả 0 page | Chủ page thêm tài khoản vào page rồi kết nối lại |
| – | `NO_PAGE_TOKEN` | Page về mà không có `access_token` | Chủ page tích page ở bước «Chọn trang» |
| 6 | Webhook (theo page) `NOT_SUBSCRIBED` / `MISSING_FIELDS` | `GET /{page}/subscribed_apps`: không có app của nền tảng / thiếu trường | Chủ page nối lại page; vẫn thiếu ⇒ chủ nền tảng kiểm quyền |
| 7 | Webhook `TOKEN_EXPIRED` | `debug_token` của page token, hoặc Meta trả mã 190 | Chủ page nối lại page |

Mã: `lib/integrations/messenger/graph.ts` (`diagnosePageDiscovery`, `appRoleOf`, `inspectToken`, `checkPageWebhook`), câu hướng
dẫn: `lib/integrations/messenger/permission-guide.ts`, kiểm thử: `tests/messenger-discovery.test.ts`. Không có vòng thử lại
tự động nào — mỗi lần chẩn đoán là một lượt hỏi Meta.
