# Pancake + Gemini – Bot chat khách tự động

Bot nhận tin nhắn khách từ **Pancake (pages.fm)** (webhook hoặc poll), đưa lịch sử hội thoại + **danh mục sản phẩm đồng bộ từ Pancake POS** cho **Google Gemini** sinh câu trả lời, rồi gửi lại cho khách (kèm ảnh sản phẩm) bằng Pancake API. Chạy được nhiều page cùng lúc. Không cần cài thư viện ngoài (Node.js ≥ 18).

```
Khách nhắn FB/Zalo/IG ──► Pancake ──webhook──► bot (server.js)
                                                  │ 1. lấy 20 tin gần nhất (Pancake API)
                                                  │ 2. gọi Gemini (system prompt + lịch sử)
                                                  ▼
Khách nhận trả lời  ◄── Pancake ◄── POST reply_inbox
```

## 1. Cài đặt

```bash
cd pancake-gemini-bot
copy .env.example .env      # Windows (Linux/Mac: cp .env.example .env)
```

Mở `.env` và điền:

| Biến | Lấy ở đâu |
|---|---|
| `PANCAKE_PAGES_JSON` | `{"page_id":{"token":"...","name":"Tên shop"}, ...}`. Token lấy tại Pancake → Page → **Cài đặt → Công cụ → Page Access Token** (dạng `eyJ...`; token Facebook `EAA...` KHÔNG dùng được) |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| `POS_SHOP_ID`, `POS_API_KEY` | (tuỳ chọn) Pancake POS → Cài đặt → API. Có thì bot tự đồng bộ sản phẩm, giá, màu, size, tồn kho, ảnh |
| `HEALTHCHECK_URL` | (tuỳ chọn) URL hc-ping.com / healthchecks.io để biết bot còn sống |

Chỉ 1 page thì có thể dùng `PANCAKE_PAGE_ID` + `PANCAKE_PAGE_ACCESS_TOKEN` + `SHOP_NAME` thay cho JSON.

**Thêm page ngay trong app (không cần sửa `.env`, không cần khởi động lại):** ở sidebar bấm **＋ Thêm page** →
- *Cách 1*: dán **Page Access Token** của page (Pancake → page → Cài đặt → Công cụ → Page Access Token) + Page ID (app tự đọc từ token nếu được).
- *Cách 2*: dán **User Access Token** (Pancake → Cài đặt cá nhân → Access token) → app liệt kê các page tài khoản quản lý → tích chọn → app tự sinh Page Access Token cho từng page. User token không được lưu.

Token được kiểm tra với Pancake trước khi lưu vào `data/pages_tokens.json` (`{"<page_id>": {"token", "name", "addedAt"}}`; trùng id với `.env` thì token trong file này được ưu tiên). Bot ghi nhận các hội thoại hiện có lúc thêm nên chỉ trả lời tin **mới** từ đó. Trong tab Cài đặt của page có nút **Đổi token** và **Gỡ page khỏi bot** (chỉ gỡ được page thêm từ app; page trong `.env` phải sửa `.env`). API: `POST /api/pages {pageId, token, name}`, `POST /api/pages/lookup {userToken}`, `POST /api/pages/from-user {userToken, pageIds}`, `DELETE /api/pages/:id`.

Sau đó sửa **`prompts/system.md`**: giờ làm việc, hotline, phí ship, bảng size, chính sách đổi trả. Đây là "bộ não" của bot. Trong file có 2 chỗ tự điền: `{{SHOP_NAME}}` (tên page đang chat) và `{{CATALOG}}` (danh mục từ POS). Nếu không dùng POS, xoá `{{CATALOG}}` và tự liệt kê sản phẩm vào đó.

### Dùng ChatGPT (OpenAI) thay Gemini

Bot chạy được với cả hai; chọn bằng `AI_PROVIDER` trong `.env`:

1. Lấy API key tại https://platform.openai.com/api-keys (cần nạp tiền vào tài khoản OpenAI).
2. Trong `.env` điền `OPENAI_API_KEY=sk-...`, chọn `OPENAI_MODEL` (mặc định `gpt-4.1-mini` - nhanh, rẻ, xem được ảnh; `gpt-4.1` thông minh hơn; `gpt-5-mini` có "suy nghĩ", chậm hơn).
3. Chạy `node scripts/test-openai.js` để kiểm tra key + model.
4. Đổi `AI_PROVIDER=openai`, khởi động lại app. Log khởi động sẽ ghi `AI: openai | Model: ...`.

Model đã chọn riêng cho từng page (tên `gemini-...`) sẽ tự dùng `OPENAI_MODEL`; muốn page nào dùng model khác thì chọn lại trong Cài đặt page. `ASSISTANT_MODEL`/`VISION_MODEL` cũng vậy (đặt tên `gpt-...` nếu muốn khác mặc định). Đổi lại `AI_PROVIDER=gemini` là quay về Gemini, không mất cài đặt gì.

## 2. Kiểm tra từng phần

```bash
npm run test:gemini
```
In danh sách model mà API key dùng được và trả lời thử 1 câu. Nếu báo `GEMINI_MODEL ... KHONG co trong danh sach` thì đổi `GEMINI_MODEL` trong `.env` sang một model trong danh sách (ví dụ `gemini-2.5-flash`, `gemini-3.5-flash`...).

```bash
npm run test:pancake
```
In danh sách **tag** (lấy id để điền `BOT_PAUSE_TAG_ID`), nhân viên, 5 hội thoại mới nhất và tin nhắn của hội thoại đầu. Chạy được là token Pancake đúng.

```bash
npm run test:pos
```
Đồng bộ sản phẩm từ POS và in ra đúng đoạn text bot sẽ "học". Kiểm tra giá, màu, size, tình trạng hàng có đúng không.

```bash
npm run selftest
```
Test offline toàn bộ luồng xử lý (giả lập Pancake + Gemini, không cần token). Phải in `TAT CA TEST PASS`.

```bash
npm run chat
```
Chat thử với bot ngay trong terminal (không đụng tới Pancake) để tinh chỉnh `prompts/system.md`. Gõ `/img duong/dan/anh.jpg mẫu này giá bao nhiêu` để test bot xem ảnh.

## 3. App quản lý trên máy tính

| File | Làm gì |
|---|---|
| **`Pancake Bot Manager.bat`** | Mở app quản lý (không có cửa sổ đen). Bot chạy bên trong app; đóng cửa sổ thì thu xuống khay, bot vẫn chạy. |
| **`Chay bot an (chi icon khay).vbs`** | Chạy bot hoàn toàn ẩn, chỉ có icon ở khay hệ thống. Bấm icon để mở app. |
| **`Bat tu chay khi mo may.bat`** | Bot tự chạy ẩn mỗi khi đăng nhập Windows (tạo shortcut trong Startup). `Tat tu chay khi mo may.bat` để bỏ. |
| **`Tat bot.bat`** | Tắt hẳn bot đang chạy ẩn. |
| `Mo trang quan ly (trinh duyet).bat` | Không dùng Electron: chạy bot ẩn bằng Node rồi mở `http://127.0.0.1:3456/admin` trong trình duyệt. |
| `Ket noi VPS.bat` / `Dung bot tren may nay.bat` | Chuyển app sang điều khiển bot trên VPS, hoặc quay về chạy bot trên máy này (xem mục "Chạy bot trên VPS"). |

Chuột phải icon ở khay: mở app, xem file log, khởi động lại bot, thoát. Log ghi ở `data/bot.log` (tự cắt khi quá 5 MB).

### 🤖 Trợ lý AI: ra lệnh cho bot bằng tiếng Việt

Mục đầu tiên ở thanh bên là **Trợ lý AI**. Bạn chat với nó như nhắn cho quản lý, nó tự đọc và sửa cài đặt bot qua các "công cụ" (function calling của Gemini). Ví dụ:

- "Tình hình các page hôm nay thế nào?" → đọc thống kê từng page.
- "Tắt bot cho page Moda Bella" / "Bật lại tất cả page".
- "Cho tất cả page xưng em, gọi khách là chị" → thêm vào hướng dẫn riêng của từng page.
- "Page Hoa Trà: khi khách hỏi địa chỉ thì trả lời 12 Nguyễn Trãi" → thêm dòng hướng dẫn cho đúng page đó.
- "Đổi phí ship thành 25k, miễn ship từ 400k" → tạo bản đề xuất sửa prompt chung, tóm tắt thay đổi và **hỏi bạn xác nhận** trước khi áp dụng.
- "Thử xem bot Linh Tây trả lời câu 'còn size L không' ra sao" → chạy thử bot và báo kết quả.
- "Đổi model tất cả page sang gemini-3.5-flash", "Đồng bộ lại sản phẩm", "Có lỗi gì trong nhật ký không?", "Tắt bot cho khách Hiền Phạm bên page Hoa Trà".

**Gửi ảnh cho trợ lý**: bấm 📎 Ảnh, dán Ctrl+V ảnh chụp màn hình, hoặc kéo thả ảnh vào khung chat. Ví dụ chụp màn hình đoạn bot trả lời sai với khách, trợ lý xem ảnh, chỉ ra lỗi, đề xuất cách khắc phục và (khi bạn đồng ý) tự thêm hướng dẫn cho page. Ảnh được thu nhỏ còn tối đa 1600px trước khi gửi.

Mỗi câu trả lời kèm các "chip" xanh/đỏ cho biết công cụ nào đã chạy. Việc rủi ro (ghi đè prompt chung, gửi tin cho khách thật) luôn phải bạn đồng ý rõ ràng ("ok", "áp dụng") rồi trợ lý mới làm. Model cho trợ lý đặt ở `ASSISTANT_MODEL` (mặc định `gemini-3.5-flash`). Có thể chat với trợ lý ngay trong terminal bằng `node scripts/test-assistant.js`.

Trong app, mỗi page có các tab:

| Tab | Làm gì |
|---|---|
| **Cài đặt** | Tên hiển thị (mặc định lấy tên thật của page từ Pancake khi khởi động; có thể đặt tên riêng), bật/tắt bot cho page, dry run riêng, trả lời comment, gửi ảnh; **Hướng dẫn riêng cho page** (xưng hô, địa chỉ, ưu đãi, mẫu chủ lực); model và temperature riêng; số phút nhường nhân viên. Lưu là có hiệu lực ngay. |
| **🤖 Trò chuyện với AI** | Cuộc hội thoại giữa bạn và AI về page này. Hỏi "bot đang chat với khách thế nào?" → AI đọc hội thoại gần đây và nhận xét; bảo "xưng em gọi chị", "ngắn gọn hơn", "khi khách hỏi địa chỉ thì trả lời X" → AI sửa hướng dẫn riêng của page ngay và thử lại cho bạn xem. Cùng trợ lý với mục Trợ lý AI nhưng đã biết bạn đang nói về page nào. |
| **Chat thử** | Chat với bot của page y như khách, dùng đúng prompt + sản phẩm POS hiện tại, không đụng Pancake. |
| **Hội thoại** | Xem 30 hội thoại mới nhất trên Pancake, đọc tin, tắt/bật bot cho từng khách (gắn tag "BOT OFF"), nhân viên gửi trả lời thủ công. |
| **📥 Trả lời nốt tin bỏ sót** | Ở tab "Hội thoại" của mỗi page: chọn khoảng thời gian (3–48 giờ), bấm "Đếm thử" để biết còn bao nhiêu khách chưa được trả lời, bấm "Cho bot trả lời nốt" để bot xử lý hết. Dùng khi bot từng bị lỗi, hết credit Gemini hoặc vừa bật lại. Chỉ lấy hội thoại mà tin cuối là của khách, bỏ qua hội thoại có tag BOT OFF; page đang tắt bot thì chỉ đếm chứ không trả lời. |
| **🧾 Đối chiếu đơn POS** | Soát địa chỉ đơn trên POS: chọn trạng thái (mặc định "Đã xác nhận"), số ngày, page. Với mỗi đơn, so tỉnh/huyện/xã đang chọn với địa chỉ ghi trong đơn và với địa chỉ khách nhắn trong Messenger. Chỉ báo lệch ở cấp tỉnh/huyện/xã; hai đơn vị cũ đã gộp thành một xã mới (sáp nhập 2025) thì không tính là lệch. Bấm "Sửa đơn này" hoặc "Sửa tất cả đơn lệch" để ghi địa chỉ đúng vào POS, có ghi chú lại địa chỉ cũ trong ô Ghi chú của đơn và đọc lại để chắc chắn POS đã nhận. Chạy được cả khi không có Gemini (dò theo danh mục địa chỉ Pancake). |
| **💌 Chăm sóc khách** | Gửi hàng loạt cho khách chưa mua: quét hội thoại theo số ngày (24h → 60 ngày) hoặc **chọn từ ngày đến ngày** (theo giờ Việt Nam, giống cột thời gian trên Pancake; chọn ngược cũng tự đảo lại), lọc thêm theo **từ khóa** trong tin cuối/tên khách, lọc "chưa có số điện thoại" / "khách nhắn cuối", chọn khách, nhập tin mẫu (`{name}` = tên khách, có thể kèm `[[IMG:…]]`), gửi thử 1 khách rồi gửi cả danh sách theo tốc độ 10–40 tin/phút, có tiến độ và nút dừng. Bot tự bỏ qua khách có tag BOT OFF, khách Pancake báo không nhắn được, và khách đã nhận tin hàng loạt trong 14 ngày. Tôn trọng chế độ Chỉ log. |
| **🎯 Bám khách** | Bám khách chưa chốt: quét và phân loại từng hội thoại (có SĐT chưa chốt / chê giá / đã cho số đo / đã báo giá / xem ảnh rồi im), AI soạn tin bám riêng cho từng khách, có nút "Xem thử" đọc trước khi gửi. Đặt số lần bám tối đa, mốc giờ im lặng, giờ yên tĩnh, hạn mức tin/ngày. Xem mục "Bám khách chưa chốt" bên dưới. |
| **Lịch sử bot** | 30 lần bot xử lý gần nhất: khách hỏi gì, bot trả lời gì, có chuyển nhân viên không. |

Phần chung: sửa **Prompt chung** (bản cũ lưu ở `data/system.md.bak`), xem **Sản phẩm POS** và bấm đồng bộ ngay, xem **Nhật ký bot** trực tiếp.

Cài đặt từng page lưu ở `data/pages.json`. App chỉ mở được từ chính máy chạy bot; muốn mở từ máy khác thì đặt `ADMIN_TOKEN` trong `.env` và vào `http://<ip>:3456/admin?token=...`.

### Chạy bot trên VPS, điều khiển từ máy bạn

Bot chạy 24/7 trên VPS, app trên Windows chỉ kết nối tới để quản lý (mọi cài đặt, hội thoại, trợ lý AI đều hoạt động như cũ).

1. **Upload thư mục** `pancake-gemini-bot` lên VPS Ubuntu vào `/opt/pancake-bot` (WinSCP/FileZilla; bỏ `desktop/node_modules`, giữ `.env` và `prompts/`).
2. **Cài và chạy** (SSH vào VPS):
   ```bash
   sudo bash /opt/pancake-bot/deploy/setup-vps.sh
   ```
   Script cài Node 20 + pm2, chạy bot nền, tự khởi động lại khi VPS reboot, in ra địa chỉ và `ADMIN_TOKEN`.
3. **Trên Windows**: chạy `Ket noi VPS.bat`, nhập địa chỉ (`http://IP:3456` hoặc `https://bot.tenmien.com`) và `ADMIN_TOKEN` (trong `.env` trên VPS). Mở `Pancake Bot Manager.bat`: tiêu đề app có chữ "– VPS", bot trên máy bạn không chạy nữa. Chuột phải icon khay để chuyển qua lại giữa bot trên máy này và bot trên VPS.
4. **Nên bật HTTPS** để token không đi qua mạng dạng chữ thường: trỏ một tên miền về IP VPS, cài Caddy và dùng `deploy/Caddyfile`. Có tên miền HTTPS thì cũng bật được **webhook Pancake** (`https://bot.tenmien.com/webhook/pancake?secret=...`) thay cho poll, bot trả lời nhanh hơn.
5. **Cập nhật code** sau này: upload bản mới đè lên (giữ `.env`, `data/`), rồi `sudo bash /opt/pancake-bot/deploy/update-vps.sh`.

Dữ liệu (cài đặt page, lịch sử, log) nằm trên VPS. Không có token thì API từ xa trả 403; từ chính VPS (localhost) không cần token.

## 4. Chạy bot (không dùng app)

```bash
npm start
```

Server lắng nghe tại `http://localhost:3456` với webhook path `/webhook/pancake`.

### 3a. Đưa webhook ra Internet

Pancake phải gọi được vào máy bạn, nên cần URL công khai. Cách nhanh nhất khi test:

```bash
npx ngrok http 3456
```
hoặc `cloudflared tunnel --url http://localhost:3456`. Bạn sẽ được URL kiểu `https://abc123.ngrok-free.app`.

Khi chạy thật, đưa bot lên VPS (Ubuntu + `pm2 start src/server.js --name pancake-bot`) và trỏ domain vào.

### 3b. Bật webhook trong Pancake

1. Gửi `page_id` cho **Pancake support** để bật tính năng Webhook cho page (theo tài liệu Pancake, tính năng này phải được kích hoạt và tốn 1 connection slot trong gói).
2. Pancake → Page → **Cài đặt → Công cụ → Webhook**: dán URL
   `https://<domain>/webhook/pancake?secret=<WEBHOOK_SECRET>` (nếu bạn đặt `WEBHOOK_SECRET`).
3. Bấm verify. Bot trả 200 cho mọi GET/POST tới path này nên sẽ qua.

### 3c. Chưa được bật webhook? Dùng chế độ poll

Trong `.env` đặt `POLL_ENABLED=true`. Bot sẽ tự hỏi Pancake mỗi 15 giây (`POLL_INTERVAL_SEC`) xem có hội thoại nào khách vừa nhắn thì trả lời. Không cần URL công khai. Lần chạy đầu bot chỉ ghi nhận trạng thái, không trả lời tin cũ.

## 5. Test an toàn trước khi cho bot gửi thật

`DRY_RUN=true` trong `.env` là giá trị khởi đầu. Trong app có nút **⏸ Chỉ log / 🟢 Đang gửi thật** ở góc trên bên trái để bật/tắt ngay, không cần khởi động lại (lưu ở `data/global.json`, ưu tiên hơn `.env`). Trợ lý AI cũng bật/tắt được sau khi bạn xác nhận. Khi chỉ log, bot làm mọi thứ nhưng chỉ **log** câu trả lời, không gửi cho khách.

Tin do trợ lý hoặc nhân viên gửi cho khách (qua trợ lý AI hay tab Hội thoại) đi qua đúng bộ xử lý của bot: `[[IMG:Q004:Đỏ]]` thành ảnh thật, markdown bị bỏ, tin dài tự cắt. Chạy `npm start`, rồi ở terminal khác:

```bash
node scripts/simulate-webhook.js <conversation_id> "shop ơi áo này còn size M không"
```
`conversation_id` lấy từ `npm run test:pancake`. Xem log server để thấy bot trả lời gì. Ưng rồi thì đặt `DRY_RUN=false`.

## 6. Bot và nhân viên phối hợp

| Tình huống | Bot làm gì |
|---|---|
| Nhân viên đã trả lời tin mới nhất của khách | Bot bỏ qua tin đó (không trả lời chồng). `HUMAN_TAKEOVER_MINUTES=0` (mặc định): ngoài ra bot luôn trả lời; đặt N > 0 nếu muốn bot im N phút sau khi nhân viên thật nhắn |
| Hội thoại được gắn tag tên `BOT_PAUSE_TAG_NAME` (mặc định "BOT OFF") | Bot bỏ qua hoàn toàn. Nhân viên gỡ tag là bot chạy lại |
| Gemini thấy cần người thật (chốt đơn xong, khiếu nại, hỏi đơn hàng, đòi gặp nhân viên...) | Bot trả lời 1 câu lịch sự, tự gắn tag "BOT OFF" để nhân viên thấy và tiếp nhận |
| Khách gửi nhiều tin liên tiếp | Bot đợi 4 giây (`DEBOUNCE_MS`) rồi trả lời 1 lần |
| Pancake đã bật "trả lời tự động tin đầu tiên" (gửi ảnh, báo giá) | Đặt `MIN_CUSTOMER_MESSAGES=2` (chung) hoặc ô "Bot bắt đầu trả lời từ tin thứ mấy" trong Cài đặt page: bot im ở tin đầu của khách, để Pancake tự trả lời; từ tin thứ 2 bot mới vào, và đã đọc cả tin tự động của Pancake trong lịch sử nên nối tiếp mạch chuyện, không đè lên nhau |
| Tin cuối cùng là của page | Không trả lời (tránh nói 2 lần) |
| Khách nói "chị nhắn rồi / gửi rồi / sao hỏi lại" | Bot tải lại lịch sử dài hơn (tới `HISTORY_LIMIT_RECHECK`=60 tin, kể cả ảnh cũ), xin lỗi, nhắc lại thông tin khách đã cho và tư vấn tiếp, không hỏi lại |
| Khách gửi ảnh (sản phẩm, bảng size, hàng lỗi...) | Bot tải ảnh và đưa cho Gemini **xem** rồi tư vấn (`VISION_ENABLED=true`, tối đa `VISION_MAX_IMAGES` ảnh gần nhất). Ảnh tải lỗi thì bot nhờ khách gửi lại |
| Bình luận dưới bài viết | `COMMENT_MODE` (chung) hoặc chọn trong Cài đặt page: **off** không trả lời · **public** trả lời công khai 1–2 câu, mời inbox · **inbox** (đang dùng): bot trả lời công khai "Dạ em chào chị (tên) ❤️ Shop đã gửi báo giá và ảnh mẫu vào tin nhắn…" và gửi vào Messenger khách khối báo giá + ảnh + xin chiều cao cân nặng theo kịch bản (Private Reply của Facebook). Khách trả lời trong inbox thì bot tiếp tục ngay, không chờ "tin thứ 2". Câu công khai sửa ở `COMMENT_PUBLIC_TEXT` (`{name}` = tên khách) |

**Phải tạo tag tên "BOT OFF" trên TỪNG page** trong Pancake: mở page → Cài đặt → Thẻ hội thoại → thêm thẻ tên đúng `BOT OFF` (API Pancake không cho tạo thẻ nên phải làm tay). Tạo xong, trong app bấm **↻ Làm mới** để bot tra lại id thẻ, không cần khởi động lại; bot cũng tự tra lại mỗi 10 phút. Trong app, page nào chưa có thẻ sẽ hiện nhãn vàng "chưa có tag" ở góc trên.

Phân biệt hai cách tắt bot:
- **Tắt cho cả page**: công tắc "Bot trả lời trên page này" trong Cài đặt, hoặc nhắn trợ lý AI "tắt bot page Hoa Trà" / "bật lại". Không cần thẻ.
- **Tắt cho một khách**: gắn thẻ BOT OFF lên hội thoại (nhân viên gắn trong Pancake, hoặc nút ⏸ trong tab Hội thoại của app, hoặc nhắn trợ lý "tắt bot cho khách Hiền Phạm"). Cần thẻ. Muốn đổi tên tag thì sửa `BOT_PAUSE_TAG_NAME`; chạy 1 page thì có thể dùng `BOT_PAUSE_TAG_ID` thay thế.

### Đồng bộ sản phẩm từ Pancake POS + tư vấn nhiều mẫu

- Bot gọi POS API mỗi `POS_SYNC_MINUTES` phút (mặc định 10), lấy toàn bộ sản phẩm, biến thể (màu/size), giá bán, tồn kho và ảnh. Kết quả cache ở `data/catalog.json` nên khởi động lại không mất.
- Danh mục được đưa vào system prompt ở chỗ `{{CATALOG}}`, nên Gemini trả lời được câu hỏi về nhiều mẫu cùng lúc ("có mẫu nào tầm 500k", "Q003 với Q004 khác gì"), so ảnh khách gửi với mẫu của shop, và tư vấn size theo bảng size.
- Tồn kho: `POS_STOCK_MODE=order` (mặc định) coi mọi biến thể đều đặt được vì shop cho bán âm. Đổi sang `strict` nếu muốn bot chỉ báo còn hàng khi tồn kho > 0.
- **Gửi ảnh sản phẩm theo màu**: khi Gemini thêm `[[IMG:Q004]]` (tất cả màu), `[[IMG:Q004:Đỏ]]` (đúng một màu, không phân biệt dấu/hoa thường) hoặc `[[IMG:Q004DOM]]` (SKU) vào câu trả lời, bot tải ảnh từ POS, upload lên page qua `upload_contents` rồi gửi bằng `content_ids` (một tin riêng sau tin chữ). Với mã sản phẩm, bot gửi 1 ảnh cho mỗi màu; `[[IMG:ALL]]` gửi tổng hợp mọi mẫu trên POS (1 ảnh/màu, không giới hạn) khi khách hỏi mẫu shop không có. Ảnh theo mẫu tối đa `MAX_PRODUCT_IMAGES` (12) mỗi lượt, tự chia thành nhiều tin, mỗi tin `IMAGES_PER_MESSAGE` (6) ảnh. Tắt bằng `SEND_PRODUCT_IMAGES=false`.
- Muốn bot tư vấn hay hơn, điền mô tả (chất liệu, form dáng, dịp mặc) vào ô **Ghi chú** của sản phẩm trong POS; bot đọc trường đó.

### Tự ghi đơn nháp vào POS khi chốt đơn

Khi bot gửi bản tóm tắt chốt đơn và chuyển nhân viên (`ORDER_SYNC=true`, tắt được từng page):
1. Gemini trích xuất đơn từ hội thoại thành dữ liệu có cấu trúc: mẫu, màu, size, số lượng, tên, SĐT, địa chỉ, tổng đã chốt. Chưa đủ thông tin thì không ghi.
2. Map mẫu/màu/size sang đúng biến thể trong POS.
3. Chuẩn hoá địa chỉ theo danh mục tỉnh/huyện/xã của Pancake (sửa chính tả, viết tắt như "q1 hcm", thiếu cấp thì tự tìm xã trong tỉnh). Không chắc thì ghi chú "⚠ nhân viên kiểm tra".
4. Tìm đơn nháp (trạng thái Mới) đã gắn với hội thoại: có thì cập nhật, chưa có thì tạo. Ghi giảm giá bằng chênh lệch giữa giá POS và tổng đã chốt (ví dụ combo 2 đầm 849.000đ), miễn ship theo thoả thuận, ghi chú "🤖 Bot chốt từ chat…". **Không bao giờ xác nhận đơn**, nhân viên vẫn duyệt.

### Xem ảnh sản phẩm

Khi khách gửi ảnh, bot lấy URL ảnh từ `attachments` của tin nhắn Pancake, tải về, mã hóa base64 và gửi kèm vào Gemini (`inline_data`). Gemini nhìn thấy ảnh thật nên có thể nhận diện mẫu, so với mục "Sản phẩm & giá" trong `prompts/system.md`, tư vấn size từ ảnh số đo, hoặc chuyển nhân viên khi là ảnh hàng lỗi/chuyển khoản. Để bot nhận diện đúng sản phẩm của shop, hãy mô tả kỹ từng mẫu trong prompt (màu, kiểu dáng, chi tiết đặc trưng, logo...).

Nhận diện mẫu và màu bằng ảnh thật: khi khách gửi ảnh, bot được kèm thêm ảnh tham chiếu của từng mẫu/màu trong POS (`VISION_REFERENCE_IMAGES`, mặc định 12 ảnh) để so sánh trực tiếp kiểu dáng và màu, rồi gửi lại đúng ảnh màu đó và xác nhận "đây là mẫu … màu … ạ". Trước khi soạn trả lời, bot chạy một bước nhận diện riêng (model `VISION_MODEL`, mặc định `gemini-2.5-flash` vì flash-lite hay nhầm) và đưa kết luận "khớp mẫu X màu Y" hoặc "không khớp mẫu nào" vào lượt trả lời; không khớp thì bot nói shop không có mẫu đó và gửi tổng hợp mọi mẫu (`[[IMG:ALL]]`). Trong app, trợ lý AI có công cụ nhận diện tương tự: gửi ảnh và hỏi "đây là mẫu gì" nó sẽ so với POS và nêu độ tin cậy.

Giới hạn: chỉ ảnh của khách được đưa vào (ảnh do page gửi bị bỏ qua), tối đa 4 ảnh gần nhất, mỗi ảnh ≤ 5 MB. Video và sticker chỉ được mô tả bằng chữ.

### 🎯 Bám khách chưa chốt (sales agent)

Tab **"🎯 Bám khách"** của từng page. Khác với tab "Chăm sóc khách" (gửi cùng một tin mẫu cho nhiều người), agent này đọc lại **từng hội thoại**, phân loại khách đang dừng ở bước nào, rồi nhờ AI soạn **một tin riêng** cho đúng ngữ cảnh khách đó.

Phân loại làm **bằng code**, không hỏi AI (bài học: dặn AI trong prompt thì không đáng tin):

| Giai đoạn | Nghĩa là | Có bám không |
|---|---|---|
| Có SĐT, chưa chốt | khách đã để lại số điện thoại rồi im | ✅ ưu tiên cao nhất |
| Chê giá / cân nhắc | khách nói đắt, để suy nghĩ | ✅ |
| Đã cho số đo, chưa SĐT | đã nói chiều cao cân nặng | ✅ |
| Đã báo giá, chưa SĐT | shop đã báo giá, khách im | ✅ |
| Xem ảnh rồi im | shop gửi ảnh, khách không trả lời | ✅ |
| Chỉ hỏi qua | hỏi một câu rồi thôi | ✅ |
| Khách từ chối / đã chốt đơn / đang chờ shop trả lời | | ❌ không bao giờ bám |

Điều kiện được nhắn (cũng bằng code): shop phải là người nhắn cuối, khách im đủ lâu theo **mốc giờ** của từng lần (mặc định 20h → 72h → 168h), chưa bám quá **số lần tối đa** (mặc định 3), ngoài **giờ yên tĩnh** (mặc định 21h–8h), chưa chạm **hạn mức tin/ngày** (mặc định 50), hội thoại không bị gắn tag tắt bot.

Sau khi AI soạn xong, tin còn phải qua các chốt chặn: giá phải nằm trong bảng giá (dùng chung `findDisallowedPrices` với bot), không được tự chốt đơn, không được đưa số tài khoản/đòi cọc, không trùng gần như nguyên văn tin shop đã gửi, không dài quá. Vi phạm thì viết lại một lần, vẫn sai thì **bỏ qua khách đó** chứ không gửi bừa.

Cách dùng lần đầu: bật **"Chỉ log"** ở góc trên bên trái → vào tab, bật "Cho phép bám khách page này" → Lưu → Quét → bấm **"Xem thử"** ở vài khách để đọc tin agent định gửi → ưng thì tắt "Chỉ log" và bấm "Bám tất cả khách đã chọn". Muốn chạy hẳn tự động thì đặt `FOLLOWUP_INTERVAL_MIN` trong `.env` (ví dụ 60) **và** tick "Tự động bám theo lịch" cho page đó.

## 7. Cấu trúc code

```
src/server.js     HTTP server nhận webhook (+ bật poller)
src/bot.js        Logic chính: lọc tin, lấy lịch sử, gọi Gemini, gửi trả lời, handoff
src/pancake.js    Client Pancake Public API (conversations, messages, tags, upload ảnh...)
src/pos.js        Client Pancake POS API + chuẩn hoá sản phẩm
src/catalog.js    Cache danh mục, format cho prompt, tìm ảnh theo mã/SKU
src/prompt.js     Ghép system prompt ({{SHOP_NAME}}, {{CATALOG}}, hướng dẫn riêng page, ngữ cảnh)
src/settings.js   Cài đặt riêng từng page (data/pages.json)
src/salesagent.js Bám khách chưa chốt: phân loại giai đoạn + soạn tin bám riêng + chốt chặn
src/admin.js      API cho app quản lý (/admin, /api/...)
src/assistant.js  Trợ lý AI quản trị: bộ công cụ + vòng lặp function calling
admin/index.html  Giao diện app quản lý
desktop/main.cjs  Vỏ Electron: chạy bot + mở cửa sổ + icon khay
src/gemini.js     Gọi Gemini generateContent (REST, không cần SDK)
src/poller.js     Chế độ poll thay webhook
src/queue.js      Gom tin theo hội thoại + xử lý tuần tự
src/store.js      Lưu data/state.json: tin đã xử lý, tin do bot gửi, ...
src/config.js     Đọc .env
prompts/system.md Persona + kiến thức shop (SỬA FILE NÀY)
scripts/          Công cụ test
```

## 8. Tài liệu API đã dùng

- Pancake API: https://developer.pancake.biz/ (OpenAPI: `/openapi/openapi.yaml`)
  - `GET  https://pages.fm/api/public_api/v2/pages/{page_id}/conversations?page_access_token=...`
  - `GET  https://pages.fm/api/public_api/v1/pages/{page_id}/conversations/{id}/messages?page_access_token=...`
  - `POST ...conversations/{id}/messages` body `{"action":"reply_inbox","message":"..."}`
  - `POST ...conversations/{id}/tags` body `{"action":"add","tag_id":"..."}`
  - Giới hạn 5 request/giây/page (bot đã tự throttle)
- Pancake Webhook: https://developer.pancake.biz/webhook (event `messaging`, payload `{page_id, event_type, data:{conversation, message, post}}`)
- Pancake POS: `GET https://pos.pages.fm/api/v1/shops/{shop_id}/products?api_key=...&page_size=100&page_number=N`
- Gemini: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` header `x-goog-api-key`

## Chi phí Gemini và cách đã tối ưu

Đo thật với kịch bản bán hàng (5 lượt bot trả lời cho 1 khách mua): ~15.000 token vào, ~500 token ra. Ước tính 8 khách hỏi ra 1 đơn (1 khách mua + 7 khách hỏi rồi thôi):

| Model bot trả lời khách | Giá (trả phí, /1M token vào · ra) | Chi phí / đơn (8 khách) | 1.000 đơn/tháng |
|---|---|---|---|
| `gemini-2.5-flash-lite` (đang dùng) | 0,10 · 0,40 USD | ~0,007 USD ≈ 180đ | ~7 USD |
| `gemini-2.5-flash` | 0,30 · 2,50 USD | ~0,03 USD ≈ 800đ | ~30 USD |

Đã làm để rẻ: dùng flash-lite (test kịch bản và nhận diện ảnh cho kết quả tương đương flash), tắt "suy nghĩ" (`GEMINI_THINKING_BUDGET=0`), chỉ gửi 12 tin gần nhất (`HISTORY_LIMIT`), giờ trong prompt làm tròn theo giờ để Gemini cache phần prompt lặp lại (giảm tới 75% giá phần cache), tin chỉ có sticker/emoji trả lời mẫu không gọi Gemini, ảnh tham chiếu chỉ 1 ảnh/màu. Trợ lý AI trong app dùng `ASSISTANT_MODEL` (3.5-flash, đắt hơn) nhưng chỉ chạy khi bạn chat với nó. Xem chi phí thực tế tại aistudio.google.com → Usage.

## Tốc độ và số tin xử lý cùng lúc

- **Thời gian trả lời một khách**: `DEBOUNCE_MS=0` (trả lời ngay, không chờ gom tin), Pancake lấy lịch sử (~0,5 giây), Gemini sinh câu trả lời (1–2 giây với `gemini-2.5-flash` khi `GEMINI_THINKING_BUDGET=0`), gửi lại (~0,5 giây). Khoảng **3–4 giây** sau tin của khách khi dùng webhook. Chế độ poll cộng thêm tối đa `POLL_INTERVAL_SEC` (5 giây), tức **4–10 giây**. Muốn nhanh nhất thì bật webhook (cần VPS + HTTPS).
- **Nhiều khách cùng lúc**: mỗi hội thoại xử lý tuần tự, các hội thoại khác nhau xử lý song song. Giới hạn thực tế:
  - Pancake: 5 request/giây/page, bot tự giãn 220 ms mỗi request → khoảng **100 câu trả lời/phút/page**.
  - Gemini: `GEMINI_MAX_CONCURRENT` request song song (mặc định 4), tự chờ và thử lại khi bị 429. Key miễn phí của Google chỉ cho ~10–15 request/phút → tối đa **~10 khách/phút** trên toàn bộ page. Nâng lên gói trả phí (pay-as-you-go) thì giới hạn là hàng nghìn request/phút, khi đó tăng `GEMINI_MAX_CONCURRENT` lên 10–20.
- Tin khách gửi trong lúc bot đang xử lý không bị mất: chúng vào hàng đợi của hội thoại đó và được gom vào lần trả lời sau.

## Lưu ý

- Pancake webhook **không ký payload**, nên hãy đặt `WEBHOOK_SECRET` và dùng HTTPS.
- Nếu endpoint lỗi > 80% trong 30 phút, Pancake tự tắt webhook; vào Webhook Settings bật lại.
- Facebook chỉ cho page nhắn trong cửa sổ 24h kể từ tin cuối của khách; ngoài cửa sổ bot sẽ log `ngoai cua so nhan tin` và bỏ qua.
