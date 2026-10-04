# Gia nhập nhanh — đăng ký một màn hình, đăng nhập không cần mã tổ chức

> Migration `0193_quick_start_identities`. Mã chính:
> - `lib/onboarding/quick.ts`, `lib/onboarding/quick-shared.ts` — đăng ký nhanh;
> - `lib/auth/login.ts`, `lib/auth/identities.ts`, `lib/auth/identity-shared.ts` — đăng nhập, chỉ mục danh tính;
> - `lib/auth/oauth.ts`, `lib/auth/social.ts`, `app/login/oauth/*` — Google · Facebook;
> - `lib/ai-builder/provider.ts::platformChatAi` — chatbot dùng AI dùng chung.
>
> Kiểm thử: `tests/quick-start.test.ts`.

## 1. Trước và sau

| | Trước | Sau |
|---|---|---|
| Đăng ký | 7 bước, ~8 cú bấm, 6 ô (mã mời, tên + **mã tổ chức**, tên + email + mật khẩu + nhập lại, loại hình, mẫu, module, xem trước) | **1 màn hình**: tên cửa hàng · ngành hàng · SĐT · email · mật khẩu — hoặc nút Google / Facebook thay hai ô cuối |
| Đăng nhập | Phải biết **mã tổ chức** hoặc vào đúng tên miền con | Email **hoặc SĐT** + mật khẩu ở trang chung; hoặc Google / Facebook |
| Bot trả lời khách đầu tiên | Phải tự mua khoá AI (Anthropic / OpenAI / Gemini), khai, kiểm, bật | Mặc định dùng **AI dùng chung của nền tảng**, trừ vào credit AI của gói |

Đo trên PGlite (`tests/quick-start.test.ts`): dựng xong một cửa hàng trong khoảng 3,5 giây.

Trình hướng dẫn đầy đủ còn nguyên ở `/start?day-du=1` (tự chọn mẫu, module, xem trước), và vẫn là cửa của người vận
hành nền tảng.

## 2. Đăng ký nhanh

Máy tự quyết những thứ trước đây hỏi khách:

- **Mã tổ chức.** Lấy từ tên cửa hàng: bỏ dấu, gạch nối, tối đa 24 ký tự, bắt đầu bằng chữ, tránh mã dành riêng. Nếu
  trùng thì thử `-2` … `-9`, cuối cùng thêm đuôi ngẫu nhiên.
- **Mẫu và module.** Theo ngành hàng, giống bước «Loại hình» của trình hướng dẫn, và **luôn cộng thêm «AI bán hàng»**
  (kèm khách / sản phẩm / đơn / kho).
- **Tên quản trị.** Lấy tên từ Google / Facebook; không có thì đặt «Chủ cửa hàng».

Mọi thứ đi qua **đúng** lõi `createOrganizationFromSignup`: cờ đăng ký, mã mời, trần theo IP, xem trước kế hoạch, hạn
mức gói. Không có đường tạo tổ chức thứ hai.

Hai cách chặn tạo trùng:
- Email vừa tự tạo một cửa hàng (đang dựng hoặc đã xong) ⇒ báo «đã có cửa hàng — đăng nhập», không đẻ cửa hàng thứ hai.
  Cách này chặn bấm hai lần.
- Muốn mở thêm cửa hàng thì đi trình hướng dẫn đầy đủ.

## 3. Đăng nhập không cần mã tổ chức

Tài khoản sống trong CSDL của **từng** tổ chức (SILO). Bảng `platform_identities` ở CSDL nhà là **chỉ mục**: email /
SĐT / mã người dùng Google · Facebook ⇒ (tổ chức, tài khoản).

- **Ghi** mỗi lượt đăng nhập thành công (`verifyLogin` — màn đăng nhập, đăng ký, nhận lời mời), khi đăng ký nhanh, và
  khi đăng nhập bằng Google / Facebook. Không quét tổ chức nào lúc migrate.
  - Tài khoản cũ được ghi vào chỉ mục **ở lần đăng nhập đầu tiên** sau bản này (qua tên miền con / mã tổ chức như trước).
- **Đọc** ở trang chung:
  - các tổ chức chỉ mục có cho danh tính này, cộng tổ chức nhà;
  - với từng tổ chức đó, kiểm mật khẩu trong CSDL của nó.
  - Khớp **một** nơi ⇒ vào thẳng.
  - Khớp **nhiều** nơi ⇒ hỏi «vào cửa hàng nào». Danh sách chỉ hiện khi mật khẩu đã đúng ở mọi nơi trong đó, nên không
    lộ gì cho người không biết mật khẩu.
  - Không khớp nơi nào ⇒ cùng câu với sai mật khẩu.
- Chỉ mục **không mở phiên**. Mật khẩu, quyền, khoá tài khoản, tổ chức bị đình chỉ vẫn kiểm ở CSDL tổ chức mỗi lượt.
- **SĐT:** `users.phone` lưu dạng chuẩn hoá `84xxxxxxxxx`, chỉ nhận di động Việt Nam. Ô đăng nhập chấp nhận
  «0912 345 678», «+84 912…», «0912.345.678». Email có `@`, còn lại coi là SĐT.
- Ô «Mã tổ chức» vẫn còn, gập dưới «Đăng nhập bằng mã tổ chức».

## 4. Google · Facebook

- **Luồng:** authorization code, không thư viện ngoài.
  - `state` (+ PKCE với Google) cất trong cookie **ký** 10 phút.
  - Khoá ký dẫn xuất riêng từ `AUTH_SECRET`, mỗi luồng có `aud` riêng, nên không dùng được làm cookie phiên.
- **Hồ sơ chỉ được tin khi nó tới thẳng từ máy chủ nhà cung cấp:**
  - Google: kiểm `aud` / `iss` / hạn, và chỉ dùng email khi `email_verified`.
  - Facebook: gọi Graph kèm `appsecret_proof`; chỉ xin `email,public_profile`, nên **không cần App Review**.
- **Ai là ai**, theo thứ tự:
  1. đã từng dùng đúng nút này (danh tính `GOOGLE` / `FACEBOOK`);
  2. email đã xác minh khớp tài khoản;
  3. chưa có ⇒ sang `/start` với hồ sơ điền sẵn. Khi đó chỉ còn hỏi tên cửa hàng, ngành, SĐT; mật khẩu là ngẫu nhiên.
  - Khớp nhiều tổ chức ⇒ trang `/login/chon-cua-hang`.
- **Thiếu khoá** của một nhà cung cấp ⇒ nút của nó không hiện, và đường dẫn của nó trả về màn đăng nhập.

### Việc của chủ nền tảng (không cần sửa mã)

| Việc | Ở đâu |
|---|---|
| Google: tạo OAuth client (Web), redirect URI `https://erp.vnxcommerce.com/login/oauth/google/callback` | console.cloud.google.com → Credentials. Muốn hiện tên + logo trên màn đồng ý thì làm thêm brand verification (xác minh tên miền, trang chính sách quyền riêng tư) |
| Facebook: ứng dụng Facebook Login, redirect URI `…/login/oauth/facebook/callback`, chế độ **Live** | developers.facebook.com — chỉ `email` + `public_profile` |
| Khai khoá | GitHub → Variables: `GOOGLE_OAUTH_CLIENT_ID`, `FACEBOOK_LOGIN_APP_ID`; Secrets: `GOOGLE_OAUTH_CLIENT_SECRET`, `FACEBOOK_LOGIN_APP_SECRET` → chạy Deploy |
| Mở đăng ký cho mọi người | Variable `PLATFORM_SIGNUP_MODE=open` (trần) **và** `/platform` → «Đăng ký» → Mở. Trần theo IP / ngày vẫn chặn |

## 5. Bot chạy ngay — AI dùng chung của nền tảng

- Shop mới mặc định `connectorKey = "platform"`.
- Bot dùng AI dùng chung khi **đủ ba điều**:
  1. nền tảng bật `PLATFORM_AI_ENABLED=1` với khoá **riêng** (khác mọi khoá của nhà, kể cả `GEMINI_API_KEY`);
  2. gói có `platformCreditUsdPerMonth > 0` (bảng giá 0194);
  3. còn credit trong tháng.
  - Thiếu một điều ⇒ bot không bật được và nói rõ vì sao.
  - Shop vẫn có thể chọn khoá riêng (BYOK) ở trang chatbot.
- **Sổ AI:** ghi nguồn `PLATFORM` hay `BYOK` theo đúng lựa chọn. Hạn mức kiểm đúng nguồn đó.
- **Nhà cung cấp:** `PLATFORM_AI_PROVIDER=gemini` (khuyên dùng — rẻ nhất cho chat) hoặc `anthropic` (mặc định cũ).
  - `PLATFORM_AI_MODEL` để trống ⇒ `gemini-3.5-flash-lite`.
  - Credit tính bằng USD nên **đổi model chỉ đổi số hội thoại, không đổi trần chi phí**.
- **Khai:** Secret `PLATFORM_AI_API_KEY`; Variables `PLATFORM_AI_ENABLED=1`, `PLATFORM_AI_PROVIDER`, `PLATFORM_AI_MODEL`.
- **Tắt:** xoá Variable `PLATFORM_AI_ENABLED` rồi deploy (launch-gates mục D).

## 6. «Vào việc ngay» trên trang Bắt đầu

`lib/onboarding/go-live.ts` · `components/onboarding/go-live-card.tsx`. Ô chỉ hiện khi tổ chức có module «AI bán hàng»
và người xem có quyền. Ba bước, mỗi bước một nút, tự đánh dấu xong theo dữ liệu thật:

1. **Kết nối fanpage.** Dán Page ID + page access token của Pancake → một nút làm cả Lưu → Kiểm tra → Bật (đúng lõi
   `saveConnection` / `testOrgConnection` / `setConnectionStatus`). Kiểm tra hỏng thì dừng, kết nối không bật.
2. **Dán URL webhook vào Pancake.** Có nút chép URL. Bước này xong khi ERP nhận được tin đầu tiên từ fanpage.
3. **Bật chatbot.** Đi qua `saveSalesChatbotConfig`. AI dùng chung chưa sẵn sàng thì nói rõ lý do.

Trước đây cùng việc đó phải qua trang Kết nối (4 thao tác) rồi sang trang Chatbot.

## 7. Fanpage

Kênh Fanpage vẫn đi qua **Pancake**: dán page token, rồi dán URL webhook của ERP vào Pancake.

Kết nối thẳng Facebook Messenger cần quyền `pages_messaging` / `pages_manage_metadata` ở mức **Advanced Access**:
- phải qua Business Verification và App Review cho từng quyền;
- Meta nói thường 2–3 ngày, thực tế có lúc tới vài tuần.

Đó là việc của chủ nền tảng trước khi có thể làm.

## 8. Bot đọc ảnh khách gửi (0195)

Trước: tin chỉ có ảnh («còn mẫu này không shop» kèm ảnh chụp) bị bỏ qua «để nhân viên xem» — bot im, khách chờ.

Sau:
- Webhook giữ địa chỉ ảnh của tin khách (`sales_chat_inbound.image_urls`). Nhãn dán, ghi âm, video vẫn bỏ qua như cũ.
- Tới lượt trả lời, máy chủ tải tối đa 3 ảnh và nhờ CHÍNH AI của bot mô tả ngắn: cùng khoá, cùng hạn mức gói, ghi cùng sổ
  chi phí `sales_chatbot`. Mô tả vào lượt thành một dòng «[Khách gửi ảnh: …]».
- Bot dùng mô tả để tìm mẫu gần nhất rồi HỎI KHÁCH XÁC NHẬN. Ảnh chuyển khoản ⇒ chuyển nhân viên kiểm tra.
- Không đọc được (tên miền lạ, tệp hỏng, AI lỗi, hết hạn mức) ⇒ dòng «bot chưa xem được ảnh»: bot nhờ khách gõ tên mẫu, không
  đoán nội dung ảnh.
- An toàn: chỉ tải từ CDN ảnh của Facebook / Messenger / Instagram và Pancake (kể cả sau chuyển hướng), trần 5 MB, kiểu ảnh
  nhận bằng chữ ký tệp.
- Chi phí: Gemini 3.5 Flash-Lite đọc một ảnh khoảng 500 token vào + 100 token ra, cỡ 10 đồng mỗi ảnh.

Mã: `lib/sales-chatbot/vision.ts` · `lib/ai/images.ts` · `describeCustomerImages` trong `lib/sales-chatbot/engine.ts`.
## 9. Ô chat nhúng website của shop

Shop có website riêng (Haravan, Sapo Web, WordPress, tự làm…) dán MỘT dòng — lấy ở trang Chatbot bán hàng, mục «Gắn ô chat
vào website của shop»:

```html
<script src="https://<slug>.<miền ERP>/chat/widget.js" async></script>
```

- Góc màn hình hiện nút chat; bấm là mở khung `/chat/embed` (cùng lõi với trang `/chat`): giá / tồn đọc từ ERP, lên đơn,
  chuyển nhân viên như mọi kênh.
- Tuỳ chọn trên thẻ script: `data-color` (mã hex), `data-position="left"`, `data-label` (chữ cạnh nút).
- Chỉ tổ chức ĐÃ XUẤT BẢN có bot đang bật mới hiện nút; còn lại script rỗng, không lỗi trên website.
- An toàn:
  - Caddy chỉ cho đúng `/chat/embed` nằm trong khung trang khác (`frame-ancestors *`); mọi đường khác giữ SAMEORIGIN.
  - Script không đặt cookie, không gọi API trên website của shop; màu / chữ tuỳ chọn không chèn được mã.
  - Cookie khách chat là `SameSite=None; Partitioned` (CHIPS): dùng được trong khung, nhưng khoá theo website đang nhúng.

Mã: `lib/sales-chatbot/widget.ts` · `app/chat/widget.js/route.ts` · `app/chat/embed/page.tsx`.

## 10. Nhập sản phẩm từ link website

Ở `/products/import`, ngoài chọn tệp còn ô «Hoặc lấy từ website của shop»: dán link ⇒ máy chủ đọc sản phẩm ⇒ dựng tệp CSV đúng
khuôn tệp mẫu ⇒ đi tiếp ĐÚNG các bước của trình nhập tệp (xem trước, ghép cột tự động, kiểm, nhập). Không có đường ghi thứ hai.

Ba nguồn, thử theo thứ tự, KHÔNG gọi AI:
1. `/products.json` — chuẩn Shopify (Haravan và nhiều nền tảng học theo): mỗi biến thể một dòng.
2. WooCommerce Store API `/wp-json/wc/store/v1/products`.
3. JSON-LD `schema.org/Product` trong chính trang được dán.

Giá không đọc rõ ⇒ ô trống (chưa khai), không phải 0 đ. Không nguồn nào có ⇒ nói thẳng và gợi ý dùng tệp mẫu.

An toàn (`lib/net/public-url.ts`): chỉ http / https cổng mặc định; tên miền phân giải ra địa chỉ riêng / nội bộ / siêu dữ liệu
đám mây ⇒ từ chối TRƯỚC khi gửi request; chuyển hướng kiểm lại từng đích; trần 12 giây, 3 MB. Cùng cổng quyền với trình nhập
tệp (`productCreateGate`).
