# Messenger trực tiếp — bot fanpage không cần Pancake (0207)

> Mã: `lib/integrations/messenger/` (Graph API, cookie kết nối) · `lib/sales-chatbot/messenger.ts` (nối page, nhận tin, xử lý
> lượt) · `app/api/webhooks/messenger/route.ts` · `app/api/connect/messenger/{start,callback}` · trang
> `/ai/sales-chatbot/messenger`. Kiểm thử: `tests/messenger.test.ts`.

## 1. Vì sao

Bot fanpage trước đây chỉ nhận tin qua Pancake, nên shop không dùng Pancake thì không có bot. Đối thủ (botbanhang) nối thẳng
Facebook. Đường này dùng app Facebook CỦA NỀN TẢNG (cùng app «Đăng nhập bằng Facebook»): chủ page cấp quyền nhắn tin một lần,
Meta gửi tin thẳng về ERP.

## 2. Cách chạy

1. Chủ page (quyền Cài đặt của cửa hàng) bấm **Kết nối Facebook Page** ⇒ hộp thoại Facebook xin `pages_show_list`,
   `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `business_management`.
2. Callback: `state` khớp ĐÚNG tổ chức + ĐÚNG người bấm ⇒ đổi `code` lấy token người dùng DÀI HẠN ⇒ danh sách page.
   - Một page ⇒ nối luôn. Nhiều page ⇒ danh sách cất trong cookie MÃ HOÁ (A256GCM, 10 phút), người bấm chọn.
   - Token người dùng KHÔNG được lưu ở đâu.
3. Nối page:
   - chỉ mục `platform_messenger_pages` (page ⇒ tổ chức; page của tổ chức khác ⇒ TỪ CHỐI);
   - lưu page token qua lõi kết nối (AES-256-GCM, nhật ký);
   - `POST /{page}/subscribed_apps` (messages · messaging_postbacks · message_echoes);
   - kiểm tra (`GET /me` bằng page token) ⇒ bật.
4. Webhook `/api/webhooks/messenger`:
   - kiểm chữ ký `X-Hub-Signature-256` bằng app secret;
   - mỗi sự kiện ⇒ tổ chức theo MÃ PAGE (`WEBHOOK_BINDINGS.MESSENGER`, chế độ `PAGE_INDEX`);
   - page chưa nối ⇒ bỏ qua, không bao giờ rơi về nhà.
5. Lượt trả lời: CÙNG lõi với đường Pancake (hàng chờ `sales_chat_inbound`, hội thoại kênh `FANPAGE`, đợi khách gõ xong, đọc
   ảnh, chuyển người ⇒ im, follow-up). Gửi bằng Send API (`messaging_type: RESPONSE`), kèm `appsecret_proof`.
6. Người gửi phân biệt bằng **tiếng vọng** của Meta:
   - `app_id` = app nền tảng ⇒ tin của chính bot;
   - khác ⇒ người trong Hộp thư Meta Business Suite (bot nhường 30 phút) hoặc trả lời tự động đầu hội thoại.

## 3. Việc của người vận hành (một lần cho mọi cửa hàng)

Ở developers.facebook.com → app đăng nhập của nền tảng:

1. Thêm sản phẩm **Messenger**. Phần **Webhooks**: Callback URL và Verify token lấy ở `/ai/sales-chatbot/messenger` khi đăng
   nhập tổ chức nhà (verify token dẫn xuất từ `AUTH_SECRET`, không phải biến môi trường mới). Đăng ký trường `messages`,
   `messaging_postbacks`, `message_echoes`.
2. **Facebook Login → Valid OAuth Redirect URIs**: thêm `https://erp.vnxcommerce.com/api/connect/messenger/callback`.
3. Trước App Review: chỉ page do người có vai trò trong app (admin / developer / tester) quản lý mới nối được — đủ để quay
   video cho Meta.
4. **App Review**: xin Advanced Access cho `pages_messaging`, `pages_manage_metadata`, `pages_show_list`,
   `pages_read_engagement`, `business_management`; cần Business Verification. Kèm video: bấm Kết nối → chọn page → nhắn vào
   page → bot trả lời.

## 4. Instagram DM (cùng đường)

- Kết nối page xin thêm `instagram_basic`, `instagram_manage_messages`. Page gắn tài khoản Instagram doanh nghiệp ⇒ nối LUÔN
  trong cùng lượt: `GET /{page}?fields=instagram_business_account{id,username}`, chỉ mục thêm một dòng (mã Instagram ⇒ tổ
  chức). Instagram đã thuộc tổ chức khác ⇒ không nối, nói rõ.
- Webhook: CÙNG URL, gói `object = "instagram"`, cùng khuôn `messaging`; tổ chức theo mã Instagram (PAGE_INDEX).
- Gửi: CÙNG page token, CÙNG Send API (`/me/messages`, người nhận = IGSID).
- Tiếng vọng Instagram KHÔNG mang mã app ⇒ tin của bot nhận ra bằng MÃ TIN đã ghi lúc gửi.
- Người vận hành: trong app Meta thêm sản phẩm Instagram, Webhooks → object Instagram → trường `messages`,
  `messaging_postbacks` (cùng Callback URL / verify token). App Review thêm `instagram_basic`, `instagram_manage_messages`.
  Chủ shop phải bật «Cho phép truy cập tin nhắn» trong cài đặt Instagram (Quyền riêng tư → Tin nhắn → Công cụ kết nối).

## 5. Giới hạn hôm nay

- Ảnh của câu trả lời mẫu: gửi qua Send API (tải tệp kèm) ngay sau chữ của câu mẫu — như đường Pancake.
- Bình luận dưới bài viết (trường `feed` của page): bot trả lời bằng MỘT tin riêng (Private Replies) có đọc nội dung bài;
  không bao giờ trả lời công khai. Page nối TRƯỚC bản này chưa đăng ký `feed` ⇒ bấm «Đổi page» một lần. Người vận hành thêm
  trường `feed` ở Webhooks → Page của app Meta. Ảnh câu mẫu không đi kèm tin riêng được (Meta chỉ cho một tin).
- Không có lượt quét danh sách hội thoại như Pancake; tin chờ quá 1 phút (máy khởi động lại) được trả lời bù trong 30 phút
  (`sweepStaleMessengerThreads`, sau mỗi webhook và trong job `sales-followup`).
- Không dùng song song «Fanpage qua Pancake» cho CÙNG một page — khách nhận hai câu trả lời.
