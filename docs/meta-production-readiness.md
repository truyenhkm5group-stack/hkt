# Meta (Facebook / Instagram) — sẵn sàng production cho đường «không Pancake»

> Đo 06/10/2026 trên `origin/main` 5d5ee7fb + nhánh `feat/pancake-replacement`. Mã: `lib/integrations/messenger/graph.ts`,
> `app/api/connect/messenger/*`, `app/api/webhooks/messenger/route.ts`, `lib/sales-chatbot/messenger.ts`. Cách vận hành một lần
> cho mọi cửa hàng nằm ở `docs/platform/messenger.md` §3 — tệp này KHÔNG chép lại, chỉ phân loại cái gì đã sẵn sàng và cái gì
> còn chờ ai.

Phân loại: **READY** · **NEEDS CONFIG** · **NEEDS APP REVIEW** · **NEEDS OWNER ACTION** · **NOT SUPPORTED**.

## 1. Tóm tắt

| Hạng mục | Trạng thái | Ghi chú |
|---|---|---|
| Mã OAuth, nối page, webhook ký, gửi / nhận tin, bình luận → tin riêng, Instagram DM | **READY** | Có bài kiểm Graph giả (`tests/messenger.test.ts`, `tests/conversation-control.test.ts`) |
| Biến môi trường app Facebook của nền tảng | **NEEDS CONFIG** | `FACEBOOK_LOGIN_APP_ID`, `FACEBOOK_LOGIN_APP_SECRET` trên VPS (cùng app «Đăng nhập bằng Facebook») |
| Phiên bản Graph API | **NEEDS CONFIG** | Mã mặc định `v21.0` — **hết hạn 21/01/2027** (bảng phiên bản của Meta). Đặt `FACEBOOK_API_VERSION=v24.0` (hạn 18/02/2028) hoặc mới hơn sau khi chạy lại bài kiểm trên phiên bản đó |
| Khai webhook + redirect URI trong app Meta | **NEEDS OWNER ACTION** | §3 dưới |
| Quyền nhắn tin với khách KHÔNG có vai trò trong app | **NEEDS APP REVIEW** | Advanced Access + Business Verification |
| Gửi tin ngoài 24 giờ (nhân viên trả lời muộn) | **NEEDS APP REVIEW** + mã | Thẻ `HUMAN_AGENT` (7 ngày, chỉ tin NGƯỜI soạn) — mã hiện chỉ gửi `RESPONSE`; xem §4 |
| Trả lời bình luận CÔNG KHAI | **NOT SUPPORTED** (cố ý) | Chỉ tin riêng (Private Replies, một tin / bình luận / 7 ngày) — quyết định sản phẩm, không phải giới hạn Meta |
| Nhập hội thoại cũ của page | **READY** (cần Advanced Access) | `messenger-history.ts`: Conversations API, tối đa **20 tin gần nhất** mỗi hội thoại (giới hạn Meta), 200 hội thoại / page; «Tin nhắn chờ» không hoạt động 30 ngày không trả về |
| Shop quản > 100 page | **READY** | `/me/accounts` phân trang bằng con trỏ `after`, tối đa 500 page |
| Gỡ page | **READY** | `DELETE /{page}/subscribed_apps` trước khi gỡ phía ERP |

## 2. Quyền xin lúc nối page (`MESSENGER_SCOPES`)

| Quyền | Dùng để | App Review |
|---|---|---|
| `pages_show_list` | Liệt kê page người dùng quản lý (`/me/accounts`) | Advanced Access |
| `pages_messaging` | Nhận / gửi tin Messenger; đọc Conversations API | Advanced Access — bắt buộc cho khách thật |
| `pages_manage_metadata` | `POST /{page}/subscribed_apps` (đăng ký webhook cho page); Conversations API | Advanced Access |
| `pages_read_engagement` | Đọc nội dung bài viết khách bình luận dưới; Conversations API | Advanced Access |
| `business_management` | Page thuộc Business Manager | Advanced Access |
| `instagram_basic`, `instagram_manage_messages` | Instagram DM qua cùng page token | Advanced Access; chủ shop bật «Cho phép truy cập tin nhắn» trong Instagram |
| *(chưa xin)* Human Agent | Tin người soạn trong 7 ngày sau tin cuối của khách | Mục App Review riêng |

Trước App Review chỉ người có vai trò trong app (admin / developer / tester) nối được page và nhắn được với page — đủ để quay
video nộp duyệt.

## 3. Việc chủ nền tảng phải làm (một lần, cho mọi cửa hàng)

1. **developers.facebook.com → app đăng nhập của nền tảng → Messenger → Webhooks (object Page):**
   - Callback URL: `https://<miền>/api/webhooks/messenger` — miền thật: `erp.vnxcommerce.com` và/hoặc `app.chotdontudong.com`
     (Meta chỉ nhận MỘT URL mỗi object; cả hai miền chạy cùng mã, chọn một).
   - Verify token: lấy ở `/ai/sales-chatbot/messenger` khi đăng nhập tổ chức nhà (dẫn xuất từ `AUTH_SECRET`).
   - Trường: `messages`, `messaging_postbacks`, `message_echoes`, `feed`.
2. **Instagram → Webhooks (object Instagram):** cùng URL / verify token; trường `messages`, `messaging_postbacks`.
3. **Facebook Login → Valid OAuth Redirect URIs:** `https://erp.vnxcommerce.com/api/connect/messenger/callback` và
   `https://app.chotdontudong.com/api/connect/messenger/callback` (redirect URI đi theo miền của yêu cầu — `appOriginForHost`).
4. **Business Verification** cho doanh nghiệp sở hữu app.
5. **App Review**: xin Advanced Access cho các quyền ở §2. Video: đăng nhập → Kết nối Facebook → chọn page → nhắn vào page →
   bot trả lời → nhân viên bấm «Tiếp quản» trong Hộp thư và trả lời → khách nhận tin của người.
6. **Biến môi trường VPS:** `FACEBOOK_LOGIN_APP_ID`, `FACEBOOK_LOGIN_APP_SECRET`, `FACEBOOK_API_VERSION` (§1), sau đó chạy
   workflow «Deploy ERP to VPS».

## 4. Giới hạn nhắn tin của Meta và cách mã xử lý

| Luật Meta | Mã hôm nay |
|---|---|
| Trả lời tự do trong **24 giờ** kể từ tin cuối của khách (`messaging_type: RESPONSE`) | Bot và nhân viên đều gửi `RESPONSE`; hộp thư cảnh báo khi quá 24 giờ, không tự chặn (đường Pancake có thể còn gửi được) |
| Ngoài 24 giờ: chỉ thẻ tin; từ 27/04/2026 các thẻ `EVENT_UPDATE` · `ACCOUNT_UPDATE` · `POST_PURCHASE_UPDATE` trả lỗi | Không dùng thẻ nào — follow-up của bot chỉ chạy trong 24 giờ (`MESSAGING_WINDOW_MS`) |
| `HUMAN_AGENT`: một tin NGƯỜI soạn trong **7 ngày**; cấm dùng cho tin tự động | Chưa làm — cần duyệt trước. Khi có duyệt: chỉ đường gửi của HỘP THƯ (nhân viên) được gắn thẻ, KHÔNG BAO GIỜ đường bot |
| Private Replies: một tin riêng / bình luận, trong 7 ngày | `sendPrivateReply`; nhiều câu bot gộp thành một tin |
| Webhook phải trả 200 nhanh; Meta gửi lại khi lỗi | Ghi tin rồi trả 200; AI + gửi chạy trong `after()`; chống trùng theo `mid` |
| `appsecret_proof` | Kèm mọi lời gọi bằng page token |

## 5. Token

- Token người dùng đổi sang **dài hạn** lúc nối và KHÔNG lưu; page token lấy từ token dài hạn (không tự hết hạn theo thời gian,
  nhưng mất hiệu lực khi người cấp đổi mật khẩu, gỡ quyền app, mất vai trò quản trị page, hoặc Meta thu hồi).
- Page token lưu mã hoá AES-256-GCM, AAD gắn tổ chức + kết nối (`lib/connectors/secrets.ts`).
- Lỗi `190` / mất quyền khi gửi được nhận ra (`graph-errors.ts`): page có token riêng ⇒ báo đúng page (page khác chạy tiếp); page
  cũ dùng token kết nối đơn ⇒ kết nối về Nháp + báo. Lỗi ngoài 24 giờ / khách chặn / chạm trần KHÔNG đụng kết nối. Sửa: nối lại page.

## 6. Kiểm tra trước khi bật cho khách thật

1. Đăng nhập tổ chức thử bằng tài khoản có vai trò trong app Meta → Kết nối Facebook → chọn page.
2. Từ tài khoản tester nhắn vào page → tin hiện trong Hộp thư ERP, đúng page.
3. Bot trả lời (chế độ Tự động) → khách nhận.
4. Nhân viên bấm «Tiếp quản», trả lời → khách nhận ĐÚNG MỘT tin; bot im.
5. «Trả lại AI» → khách nhắn → bot trả lời.
6. Bình luận dưới một bài của page → khách nhận một tin riêng.
7. Gỡ quyền app trong cài đặt Facebook của người cấp → lần gửi sau báo lỗi (khoảng trống §5).
