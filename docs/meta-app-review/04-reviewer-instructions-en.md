# 04 — Đoạn tiếng Anh dán vào form Meta

Dán nguyên văn; chỗ trong `<…>` chủ nền tảng điền ngay trong form Meta (không ghi vào kho).

## 1. App / use case description

> VNXcommerce is a sales management platform for small online shops in Vietnam. Shop owners connect their Facebook Page so
> that customer messages sent to the Page arrive in the shop's inbox inside VNXcommerce. An AI assistant configured by the
> shop answers product questions, and shop staff can take over any conversation and reply as the Page. Messages are only
> sent as replies to customers who contacted the Page (standard 24-hour messaging window); we do not send promotional or
> unsolicited messages. The shop can disconnect the Page at any time, which unsubscribes our app from the Page's webhooks.

## 2. Per-permission usage

**pages_show_list**

> After the shop admin logs in with Facebook, we call GET /me/accounts to list the Pages they manage, so they can choose which
> Page to connect to VNXcommerce. Only Pages the user explicitly selected are stored. Without this permission the user cannot
> pick a Page.

**pages_messaging**

> We use the Send API to reply to customers who message the connected Page: replies are written by the shop's AI assistant
> (configured by the shop) or typed by shop staff in the VNXcommerce inbox. When a customer comments on a Page post, we send
> one private reply to that comment. We also read recent conversations of the Page (Conversations API) so staff see the
> context. All messages use messaging_type RESPONSE inside the 24-hour window; no message tags, no broadcasts.

**pages_manage_metadata**

> When the shop connects a Page we call POST /{page-id}/subscribed_apps to subscribe the Page to the messages,
> messaging_postbacks, message_echoes and feed webhook fields, so new customer messages and comments reach VNXcommerce. We read
> GET /{page-id}/subscribed_apps to show the shop whether the subscription is active, and call DELETE when the shop
> disconnects the Page.

**pages_read_engagement**

> When a customer comments on a Page post, we read the text of that post so the assistant understands which product the
> customer is asking about before sending the private reply. We also use it, together with pages_messaging, to read recent
> Page conversations for context in the inbox. We do not read or store any other Page content.

## 3. Reviewer instructions

> **Test credentials (VNXcommerce):** URL `<https://erp.vnxcommerce.com/login hoặc miền phần mềm>` — organization code
> `<mã tổ chức thử>` — email `<email reviewer>` — password `<mật khẩu reviewer>`.
> **Test Page:** `<tên page thử>` (public, no country or age restriction).
>
> Steps:
> 1. Log in to VNXcommerce with the credentials above.
> 2. Open "AI · Chatbot bán hàng" → "Messenger trực tiếp" (direct link: `/ai/sales-chatbot/messenger`).
> 3. Click the blue button "Kết nối Facebook Page" (Connect Facebook Page), log in with your Facebook account, keep all
>    requested permissions on, and select a Page you manage (or ask us to add you to the test Page).
> 4. Back in VNXcommerce, the connected Page appears in the list. In the box "Webhook theo page" (Page webhook) click
>    "Kiểm tra lại" (Check again): it shows "Webhook đã đăng ký đủ" (webhook subscribed).
> 5. From another Facebook account, send a message to the Page in Messenger.
> 6. Open "Hộp thư khách" (Customer inbox, `/ai/sales-chatbot/inbox`): the message appears; the assistant replies and the
>    reply is delivered in Messenger.
> 7. Click "Tiếp quản" (Take over) on the conversation, type a reply and send it: the customer receives it as the Page.
> 8. Comment on a post of the Page: the commenter receives one private reply in Messenger.
> 9. To disconnect, click "Gỡ" (Remove) next to the Page on the Messenger settings page.
>
> The interface is in Vietnamese; the screencast has English captions for every step.

## 4. Data handling answers

> - **What data do you receive?** The list of Pages the user manages, Page access tokens for the Pages they select, messages
>   sent to those Pages, new comments on Page posts and the text of the commented post.
> - **Where is it stored?** On our servers in Vietnam (VNPT data center), in a separate database per shop. Page access tokens
>   are encrypted (AES-256-GCM). The user access token is not stored.
> - **Who can access it?** Only the shop's own staff accounts in VNXcommerce. Data is never sold or shared with other shops.
> - **Third parties:** message text may be sent to the AI model provider chosen by the shop (e.g. Google Gemini) only to
>   generate the reply.
> - **Deletion:** shops disconnect the Page at any time; deletion requests follow
>   https://vnxcommerce.com/chinh-sach-bao-mat#xoa-du-lieu (completed within 30 days of verification).
