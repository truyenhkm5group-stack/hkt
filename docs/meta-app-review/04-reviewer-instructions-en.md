# 04 — Đoạn tiếng Anh dán vào form Meta

App nộp review: **ChotDonTuDong Messenger** (App ID `1794152675112502`). Dán nguyên văn; chỗ trong `<…>` chủ nền tảng điền
ngay trong form Meta (không ghi vào kho). Sửa 17/10/2026 theo kiểm toán [05](05-kiem-toan-ho-so-17-10.md): đúng tên thương
hiệu, đúng miền `app.chotdontudong.com`, đúng nhãn mà tài khoản vỏ Chốt Đơn thấy, link thẳng tới từng màn hình.

Trước khi dán §3: việc K4 (cửa hàng thử) và K8 (cờ `meta.direct-connect.open` mở cho mã cửa hàng thử) phải xong — không thì
người duyệt thấy ô «Nối thẳng Facebook — sắp mở» thay vì nút (05 §1.3).

## 1. App / use case description

> ChotDonTuDong ("Chốt Đơn Tự Động") is a product of VNXcommerce, a sales management platform for small online shops in
> Vietnam. A shop admin connects the shop's Facebook Page so that messages customers send to the Page arrive in the shop's
> inbox inside ChotDonTuDong. An AI assistant configured by the shop answers product questions, and shop staff can take over
> any conversation and reply as the Page. Messages are only sent as replies to customers who messaged the Page (standard
> 24-hour messaging window) or as one private reply to a comment on a Page post; we do not send promotional, broadcast or
> unsolicited messages. The shop can disconnect the Page at any time, which unsubscribes our app from the Page's webhooks.

## 2. Per-permission usage

Mỗi quyền tải video tương ứng ở 05 §2 (A · B · C · D).

**pages_show_list** — video A

> After the shop admin logs in with Facebook, we call GET /me/accounts to list the Pages they manage, so they can choose which
> Page to connect to ChotDonTuDong. Only the Pages the admin explicitly selects are stored. Without this permission the admin
> cannot pick a Page. Screencast: Facebook Login dialog → Page selection → the list of Pages inside ChotDonTuDong.

**pages_manage_metadata** — video B

> When the shop connects a Page we call POST /{page-id}/subscribed_apps to subscribe the Page to the messages,
> messaging_postbacks, message_echoes and feed webhook fields, so new customer messages and comments reach the shop's inbox.
> We call GET /{page-id}/subscribed_apps to show the shop whether the subscription is active ("Check again" button), and
> DELETE /{page-id}/subscribed_apps when the shop disconnects the Page. Screencast: subscription check → a customer message
> arriving in real time → disconnect → no further messages received.

**pages_messaging** — video C

> We use the Send API to reply to customers who message the connected Page. Replies are written by the shop's AI assistant
> (configured by the shop) or typed by shop staff in the ChotDonTuDong inbox. When a customer comments on a Page post, we send
> one private reply to that comment. We also read the Page's recent conversations (Conversations API) so staff see the
> context. Replies to messages use messaging_type RESPONSE inside the 24-hour window; a comment gets at most one private
> reply, addressed to that comment_id; no message tags, no broadcasts. Screencast:
> customer message → AI reply received in Messenger → staff take over and reply → customer receives it as the Page.

**pages_read_engagement** — video D

> When a customer comments on a Page post, we read the text of that post (GET /{post-id}?fields=message) so the assistant
> understands which product the customer is asking about before sending the private reply. Comments are often generic
> ("price?"), so without the post text the reply cannot name the right product. We also use it, together with
> pages_messaging, to read recent Page conversations for context in the inbox. We do not read or store any other Page content.
> Screencast: a post naming a product → a generic comment that does not name it → the private reply names the product from
> the post.

## 3. Reviewer instructions

> **Test credentials (ChotDonTuDong):** https://app.chotdontudong.com/login — email `<email người duyệt>` — password
> `<mật khẩu người duyệt>` — shop code `<mã cửa hàng thử>` (the shop code field can also be left empty).
> **Test Page:** `<tên page thử>` — `<link page>` (public, no country or age restriction). Its post `<link bài viết>` names a
> product, for step 7.
>
> The interface is in Vietnamese. Labels are given as "Vietnamese text" (English meaning). Every screencast has English
> captions.
>
> 1. Log in at https://app.chotdontudong.com/login with the credentials above.
> 2. Open https://app.chotdontudong.com/ai/sales-chatbot/messenger (Messenger connection settings). The test Page is already
>    connected and listed under "Page đang nối" (Connected Pages).
> 3. To see the Facebook Login flow yourself, click the blue button "Thêm / nối lại page" (Add / reconnect Page), log in with
>    a Facebook account that manages a Page, keep all requested permissions on, and select the Page. If your Facebook account
>    does not manage a Page, the pages_show_list screencast shows this step; you can continue with the pre-connected test Page.
> 4. In the box "Page có đang gửi tin về không" (Is the Page delivering messages) click "Kiểm tra lại" (Check again): the
>    Page row shows the webhook subscription is complete.
> 5. From any Facebook account, send a message to the test Page in Messenger.
> 6. Open https://app.chotdontudong.com/ai/sales-chatbot/inbox ("Hộp thư khách", Customer inbox): the message appears within
>    seconds; the AI assistant replies and the reply is delivered to you in Messenger.
> 7. Comment "price?" under the post linked above: you receive one private reply in Messenger that names the product from the
>    post.
> 8. In the inbox, open the conversation and click "Tiếp quản" (Take over), type a reply and send it: you receive it as the
>    Page. Click "Trả lại AI" (Return to AI) to hand it back.
> 9. To disconnect, go back to the Messenger settings page and click "Gỡ" (Remove) next to the Page, then confirm. Please
>    leave the test Page connected if other reviewers may test after you; we reconnect it if needed.

## 4. Data handling answers

> - **What data do you receive?** The list of Pages the admin manages, Page access tokens for the Pages they select, messages
>   sent to those Pages, new comments on Page posts and the text of the commented post.
> - **Where is it stored?** On our servers in Vietnam (VNPT data center), in a separate database per shop. Page access tokens
>   are encrypted (AES-256-GCM). The admin's user access token is not stored.
> - **Who can access it?** Only the shop's own staff accounts. Data is never sold or shared with other shops.
> - **Third parties / processors:** message text may be sent to the AI model provider used by the shop (e.g. Google Gemini)
>   only to generate the reply; encrypted backups are stored on Google Drive.
> - **Deletion:** shops disconnect the Page at any time; deletion requests follow
>   https://vnxcommerce.com/chinh-sach-bao-mat#xoa-du-lieu (completed within 30 days of verification).
