# Bàn giao: Bot chat bán hàng Pancake + AI → tích hợp vào ERP

> **Trạng thái thật (24/09/2026, commit `e56833eb`): KHÔNG port theo mục 13.** Chủ shop cần bot
> chạy 24/7 trên VPS và quản lý trong ERP; cách đã làm là chạy NGUYÊN mã bot (thư mục `chatbot/`,
> 23/23 selftest vẫn đạt) thành dịch vụ `chatbot` trong `docker-compose.prod.yml`, quản lý từ trang
> **Bot chat** (`/chatbot`) qua cửa duy nhất `/api/chatbot/[...path]` (quyền `cs:config`). Lý do:
> chín nhóm chốt chặn ở mục 7 mỗi nhóm là một sự cố thật, viết lại theo đặc tả là cách chắc nhất để
> chúng quay lại. Khoá (token fanpage, Gemini, POS) nằm ở volume `chatbot_data` trên VPS, không vào
> kho mã. Mục 13 giữ nguyên làm ghi chép phương án ban đầu; các mục còn lại vẫn là đặc tả hành vi
> của bot đang chạy.

> **Cách dùng tài liệu này:** đưa nguyên file cho Claude (hoặc lập trình viên) ở dự án ERP và nói:
> *"Đây là đặc tả bot chat bán hàng đang chạy thật. Hãy port sang ERP theo kiến trúc ở mục 13."*
> Mọi quy tắc trong tài liệu đều rút ra từ sự cố thật khi vận hành (có ghi ngày), **không phải lý thuyết** —
> port thiếu mục nào thì lỗi đó sẽ lặp lại.

- Phiên bản: 23/09/2026
- Hệ đang chạy: Node 20 ESM, không phụ thuộc thư viện ngoài, vỏ Electron cho máy Windows
- Quy mô thực tế: **10 page Facebook**, ~600–1.000 lượt bot trả lời/ngày, ~14 đơn/ngày tự ghi vào POS

---

## 1. Bot làm gì

Trả lời tin nhắn/bình luận khách trên Facebook (qua nền tảng **Pancake**) thay nhân viên bán hàng thời trang:

1. Khách nhắn → bot đọc lịch sử hội thoại → sinh câu trả lời bằng AI (Gemini hoặc OpenAI).
2. Tư vấn: báo giá, gửi ảnh sản phẩm đúng mã/màu, tra size theo cân nặng, trả giá theo nấc, xử lý từ chối.
3. Khách đưa đủ thông tin → bot **chốt đơn** và **tự ghi đơn nháp vào POS** (Pancake POS), chuẩn hoá địa chỉ hành chính.
4. Khi khách hỏi đơn đã đặt → bot tra trạng thái đơn thật trên POS để trả lời (đã gửi chưa, mã vận đơn...).
5. Gặp việc ngoài khả năng → gắn tag chuyển nhân viên (`[[HANDOFF]]`).

Ngoài luồng chat còn có: chăm sóc khách hàng loạt (broadcast), "bám" khách chưa chốt (sales agent),
đối chiếu địa chỉ đơn POS với nội dung chat, trợ lý AI điều khiển bot bằng tiếng Việt.

---

## 2. Luồng xử lý một tin nhắn (quan trọng nhất khi port)

```
Pancake (webhook hoặc poll 5s)
   → hàng đợi theo hội thoại (gộp tin gửi liên tiếp, mỗi hội thoại xử lý tuần tự)
   → đọc 12 tin gần nhất + hồ sơ khách
   → LỌC SỚM (không tốn tiền AI):
        • hội thoại có tag "BOT OFF" → bỏ
        • nhân viên thật vừa trả lời → bỏ
        • tin cuối do page gửi → bỏ (trừ khi chỉ là lời chào tự động của quảng cáo)
        • khách chỉ gửi sticker/like → câu mẫu
        • khách nói lời kết sau khi chốt đơn → câu cảm ơn rồi dừng
        • khách khó chịu ("nói nhiều mệt") → xin lỗi 1 lần + chuyển nhân viên, sau đó im
   → DỰNG PROMPT: prompt chung + hướng dẫn riêng của page (+ bảng giá xả nếu hội thoại đang chạy xả)
        + kết quả TRA BẢNG SIZE bằng code + kết quả NHẬN DIỆN ẢNH + trạng thái ĐƠN POS của khách
   → GỌI AI (1 lần)
   → BỘ CHỐT CHẶN BẰNG CODE (mục 7) — sai thì bắt AI viết lại, vẫn sai thì dùng câu an toàn
   → tách [[IMG:mã]] → gửi ảnh; tách [[HANDOFF]] → gắn tag nhân viên
   → tách tin dài thành nhiều tin ngắn (nếu page bật) → gửi qua Pancake
   → nếu là bản tóm tắt chốt đơn → trích xuất đơn (AI + JSON schema) → ghi đơn nháp vào POS
```

**Nguyên tắc số 1 (rút ra sau 3 tuần vận hành):**
> Dặn AI trong prompt thì **không đáng tin**. Việc gì quan trọng (giá, size, mã sản phẩm, màu, chốt đơn,
> thông tin thanh toán) phải kiểm tra lại **bằng code** sau khi AI trả lời.

---

## 3. Cấu trúc mã nguồn hiện tại

| File | Vai trò |
|---|---|
| `src/bot.js` (86 KB) | Lõi: dựng prompt, xử lý hội thoại, **toàn bộ chốt chặn**, gửi tin |
| `src/ai.js` | Bộ chọn nhà cung cấp AI (`AI_PROVIDER=gemini\|openai`) |
| `src/gemini.js`, `src/openai.js` | Hai bộ điều hợp **cùng giao diện**: `generateReply`, `generateWithTools`, `listModels` |
| `src/pancake.js` | Gọi API Pancake (throttle 220ms/request, timeout 30s, retry 429/5xx) |
| `src/poller.js` | Quét hội thoại mới mỗi 5 giây (khi không dùng webhook) |
| `src/watchdog.js` | Lưới an toàn: khách chờ > 2 phút chưa ai trả lời → trả lời bù |
| `src/orders.js` | Trích xuất đơn, chuẩn hoá địa chỉ VN, ghi đơn vào POS |
| `src/catalog.js`, `src/pos.js` | Đồng bộ sản phẩm/biến thể/ảnh từ Pancake POS (10 phút/lần) |
| `src/sizechart.js` | Đọc số đo từ câu khách + tra bảng size **bằng code** |
| `src/vision.js` | Nhận diện ảnh khách gửi bằng cách so với ảnh POS |
| `src/settings.js` | Cài đặt chung + cài đặt riêng từng page (lưu `data/pages.json`) |
| `src/store.js` | Trạng thái: đã xử lý, tin của bot, lần cuối trả lời, thống kê (`data/state.json`) |
| `src/queue.js` | Hàng đợi gộp tin theo hội thoại |
| `src/admin.js` | HTTP API quản trị (127.0.0.1:3456) |
| `src/assistant.js` | Trợ lý AI điều khiển bot bằng tiếng Việt (function calling) |
| `src/broadcast.js`, `src/salesagent.js` | Chăm sóc khách hàng loạt / bám khách chưa chốt |
| `src/audit.js` | Đối chiếu địa chỉ đơn POS với nội dung chat, sửa đơn sai |
| `prompts/system.md` | Prompt chung (kịch bản bán hàng 7 bước) |
| `admin/index.html` | Giao diện quản trị (1 file, không framework) |
| `scripts/selftest.js` | **23 test offline** giả lập Pancake + AI, chạy trước mỗi lần deploy |

---

## 4. Mô hình dữ liệu

### 4.1 Cài đặt từng page (`data/pages.json`)

```jsonc
{
  "<page_id>": {
    "displayName": "Linh Tây Luxury",
    "enabled": true,                 // bật/tắt bot
    "dryRun": false,                 // chỉ ghi log, không gửi cho khách
    "extraPrompt": "...",            // HƯỚNG DẪN RIÊNG của page (quan trọng nhất)
    "defaultProduct": "Q002",        // MÃ MẪU CHỦ LỰC — xem mục 7.4
    "model": "gemini-2.5-flash",     // model AI riêng (trống = mặc định)
    "temperature": 0.4,
    "minCustomerMessages": 1,        // bot vào từ tin thứ mấy của khách
    "humanTakeoverMinutes": 0,       // im lặng sau khi nhân viên thật trả lời
    "commentMode": "inbox",          // off | public | inbox
    "orderSync": true,               // tự ghi đơn vào POS
    "sendProductImages": true,
    "splitMessages": true,           // tách thành nhiều tin ngắn như nhân viên
    "customerTitle": "chị",          // xưng hô (page đồ nam dùng "anh")
    "ownPrompt": false,              // true = dùng khung prompt riêng, bỏ kịch bản đầm
    "afterOrderText": "...",         // tin gửi thêm sau khi chốt đơn
    "sizeChart": "[{\"h\":[0,999],\"w\":[[30,49,\"M\"],[50,55,\"L\"],[56,63,\"XL\"],[64,71,\"2XL\"],[72,79,\"2XL\"],[80,200,\"HẾT SIZE\"]]}]",
    "sizeNote": "Đây là size theo bảng cân nặng của shop, dùng đúng size này.",
    // --- xả kho ---
    "saleEnabled": true,
    "saleTrigger": "xả kho|giá xả|299.000|299k|giảm giá chỉ còn|deal siêu hời",
    "salePrompt": "...",             // THAY HẲN extraPrompt khi hội thoại đang chạy xả
    "saleModels": "Q002",            // mã được áp giá xả (trống = mọi mẫu)
    // --- bám khách chưa chốt ---
    "followupEnabled": false, "followupAuto": false, "followupMaxTouches": 3,
    "followupDelays": "...", "followupQuietFrom": 22, "followupQuietTo": 7,
    "followupDailyLimit": 50, "followupStages": "..."
  }
}
```

**Bảng size**: mảng dòng `{h:[minCm,maxCm], w:[[minKg,maxKg,"size"], ...]}`.
Một dòng duy nhất với `h:[0,999]` = tra **chỉ theo cân nặng** (shop đang dùng cách này).

### 4.2 Trạng thái (`data/state.json`)
`processed` (id tin đã xử lý), `botMessages` (id tin do bot gửi — để phân biệt với nhân viên),
`lastHandled` (hội thoại → id tin khách đã trả lời), `convUpdatedAt`, `unreachable` (khách Facebook chặn),
`lastAlive` (nhịp sống của bot), `stats`, `recent`.

### 4.3 Danh mục (`data/catalog.json`)
Đồng bộ từ POS: `code` (Q001…Q006), `name`, `variations[]` với `fields.Màu`, `fields.Size`, `price`, `images[]`.
**Mọi quyết định về màu/giá phải đối chiếu file này, không tin prompt** (xem sự cố 7.5).

---

## 5. Biến môi trường (`.env`)

| Nhóm | Biến |
|---|---|
| AI | `AI_PROVIDER` (gemini/openai), `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_TEMPERATURE`, `GEMINI_MAX_OUTPUT_TOKENS`, `GEMINI_MAX_CONCURRENT`, `GEMINI_THINKING_BUDGET`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_MAX_CONCURRENT`, `OPENAI_REASONING`, `ASSISTANT_MODEL`, `VISION_MODEL`, `VISION_ENABLED` |
| Pancake | `PANCAKE_PAGES_JSON` (danh sách page + token), `WEBHOOK_PATH`, `WEBHOOK_SECRET`, `BOT_PAUSE_TAG_NAME` (mặc định "BOT OFF"), `BOT_SENDER_ID` |
| POS | `POS_SHOP_ID`, `POS_API_KEY`, `POS_SYNC_MINUTES`, `POS_WAREHOUSE_ID`, `ORDER_SYNC` |
| Nhịp quét | `POLL_ENABLED=true`, `POLL_INTERVAL_SEC=5`, `POLL_MAX_AGE_MIN=10`, `AUTO_CATCHUP_MINUTES=2`, `DEBOUNCE_MS=0` |
| Hội thoại | `HISTORY_LIMIT=12`, `HISTORY_LIMIT_RECHECK=60`, `MIN_CUSTOMER_MESSAGES`, `HUMAN_TAKEOVER_MINUTES`, `COMMENT_MODE`, `COMMENT_PUBLIC_TEXT` |
| Ảnh | `MAX_PRODUCT_IMAGES=12`, `IMAGES_PER_MESSAGE=6`, `VISION_MAX_IMAGES`, `VISION_MAX_IMAGE_MB` |
| Khác | `PORT=3456`, `ADMIN_TOKEN`, `DRY_RUN`, `DATA_DIR`, `LOG_LEVEL`, `HEALTHCHECK_URL` |

---

## 6. Tích hợp ngoài

### 6.1 Pancake (chat)
- `GET  /api/public_api/v2/pages/{pageId}/conversations` — danh sách hội thoại (`type=INBOX|COMMENT`, `order_by=updated_at`, phân trang bằng `last_conversation_id`), **mỗi trang tối đa 60**.
- `GET  /api/public_api/v1/pages/{pageId}/conversations/{convId}/messages` — tin nhắn (mới→cũ, tham số `current_count` để lấy thêm).
- `POST .../messages` — gửi tin (ảnh gửi qua `upload_contents` trước).
- `POST .../tags`, `GET /pages/{pageId}/tags` — gắn tag (dùng cho "BOT OFF"/handoff).
- Giới hạn: ~5 request/giây/page, hay trả **429** và lỗi "An error occurred" khi shop bắn tin hàng loạt → **bắt buộc** throttle + retry + timeout.
- Phân biệt người gửi: tin của page **không có** `from.uid`/`from.admin_id` là **automation của Facebook**
  (lời chào quảng cáo), **không phải** nhân viên trả lời (sự cố 14/09: 23 khách bị bỏ quên vì hiểu nhầm chỗ này).

### 6.2 Pancake POS (đơn hàng)
- `GET /shops/{shopId}/products` — danh mục, biến thể, ảnh.
- `GET /shops/{shopId}/orders?search=<SĐT>` / `?status=&page_size=&page_number=` — tìm đơn.
- `POST /shops/{shopId}/orders` — tạo đơn nháp (status 0).
- `PUT /shops/{shopId}/orders/{id}` — cập nhật (`shipping_address`, `items`, `note`, `discount`, `shipping_fee`...).
- `GET /geo/provinces|districts|communes` — danh mục hành chính (có `new_id` cho đợt sáp nhập 2025).
- Trạng thái đơn: 0 Mới, 1 Đã xác nhận, 2 Đã gửi hàng, 3 Đang giao, 4 Đã nhận, 6 Đã hủy, 7/8 Hoàn, 16 Giao không thành công.

---

## 7. BỘ CHỐT CHẶN BẰNG CODE (phần bắt buộc phải port)

Mỗi mục dưới đây = một sự cố thật đã xảy ra. Tất cả đều chạy **sau khi AI trả lời**, trước khi gửi cho khách.

### 7.1 Chặn sai giá — `findDisallowedPrices(reply, systemPrompt)`
- Lấy mọi con số tiền trong câu trả lời; hợp lệ = giá trong prompt + giá trong danh mục POS + (giá × số lượng) + (giá + phí ship 20k/25k/30k) + tổng 2 sản phẩm.
- Sai → bắt AI viết lại kèm cảnh báo; vẫn sai → câu an toàn + chuyển nhân viên.
- ⚠️ **Bẫy chết người (19/09):** câu **cấm** trong prompt mà có ghi số (*"tuyệt đối không nói 349.000đ"*) sẽ
  **vô tình whitelist** đúng số đó (vì guard lấy mọi số trong prompt làm giá hợp lệ) **và** làm model bốc nhầm số đó.
  → **Không bao giờ viết con số trong câu cấm.** Chỉ viết câu khẳng định: *"CHỈ được nói đúng 4 con số: …"*.
- Khi hội thoại đang chạy xả kho: **xoá hẳn** mục "chiến lược giảm giá bậc thang" của prompt chung khỏi prompt,
  nếu không các mức 480k/470k/450k vừa lọt vào đầu model vừa được guard coi là hợp lệ.

### 7.2 Tra size bằng code — `sizechart.parseBody()` + `fixSizeReply()`
- Đọc số đo từ câu khách: `1m58`, `m72`, `m8`, `1,70cm`, `170cm`, `cao 165`, `nặng 55`, `65 ký`, `cân 53`…
- **Phải bỏ đoạn chiều cao ra trước khi đọc cân nặng**: `"1m68 cân 53"` từng bị đọc thành **68kg** (mẫu `(\d{2,3}) cân` bắt trúng "68" của 1m68) → tư vấn 2XL thay vì L (sự cố 19/09).
- Kết quả tra bảng được **chèn vào prompt**; nếu câu trả lời không nhắc đúng size vừa tra → thay bằng câu chuẩn.
- Câu chuẩn "size … **form US**" chỉ dùng cho page đồ nam (`ownPrompt`), page đầm dùng câu thường.

### 7.3 Chặn chốt đơn thiếu thông tin — `missingOrderFields(reply)`
Bản tóm tắt chốt đơn mà trống SĐT/địa chỉ/người nhận → bắt hỏi xin, không gửi bản tóm tắt rỗng.
Số điện thoại trong đơn **phải thực sự xuất hiện trong hội thoại** (chống AI bịa số — sự cố đơn #3843).

### 7.4 Chặn sai mã sản phẩm — `wrongModelInReply()` + `defaultProduct`
- Mã `QXXX` trong câu trả lời mà **không phải mẫu chủ lực của page**, **chưa từng xuất hiện trong hội thoại**,
  và **không phải mã nhận diện từ ảnh khách gửi** → bắt viết lại; vẫn sai thì thay thẳng bằng mã chủ lực.
- Tương tự ở bước ghi đơn POS: mã không có trong hội thoại → dùng `defaultProduct`.
- Sự cố: page chủ lực Q002, khách chỉ nói "cho màu đỏ đô" → bot chốt "Đầm Q004"; page Hoa Trà (chưa cấu hình) → chốt Q005.

### 7.5 Chặn từ chối màu có thật — `wrongColorRefusal()`
Bot nói *"shop chưa có màu Đen"* trong khi **POS có** màu đó cho mẫu đang tư vấn → bắt viết lại, xác nhận có màu.
(Sự cố 22/09: prompt ghi "Bảng màu: Nâu & đỏ đô" trong khi POS có đủ Đỏ/Nâu/Đen → mất đơn.)

### 7.6 Chặn lộ thông tin thanh toán — `isPaymentInfoReply()`
Câu trả lời có "số tài khoản / STK / chủ tài khoản / đặt cọc" kèm dãy số dài → **không gửi**,
thay bằng "nhân viên sẽ hỗ trợ" + chuyển nhân viên. Mặc định bán COD, bot không được đòi cọc.

### 7.7 Sau khi đơn đã chốt — `orderClosedIn()`, `stripAskWhenClosed()`, `isLoiKet()`
- Không hỏi lại số đo/SĐT/địa chỉ, không hỏi "cần hỗ trợ thêm gì" lặp đi lặp lại.
- Khách chê phí ship **sau khi chốt** → `freeShipReplyIfComplaint()`: miễn ship ngay, nêu lại tổng, cập nhật đơn POS; **không** hỏi "giữ đơn hay lên combo", **không** đề nghị hủy.
- Khách hỏi "gửi hàng chưa / bao giờ nhận" → nạp **trạng thái đơn thật từ POS** vào prompt (mã vận đơn, ngày lấy hàng, tiền thu hộ) thay vì trả lời chung chung.

### 7.8 Luôn kết thúc bằng câu hỏi — `ensureEndsWithQuestion()`
Trừ khi đơn đã chốt hoặc khách đang khó chịu.

### 7.9 Khác
- `ensureQuoteImage()`: khối báo giá thiếu `[[IMG:mã]]` → tự gắn ảnh đúng mẫu.
- `isAnnoyed()`: khách bực ("nói nhiều mệt", "lôi thôi") → xin lỗi 1 câu, chuyển nhân viên, sau đó im.
- Lỗi Facebook `(#551) Người này hiện không có mặt` → ghi nhớ hội thoại không gửi được, **ngừng soạn lại mỗi phút** (trước đó đốt ~7k token/phút/khách).
- Gửi tin hỏng giữa chừng → giữ phần đã gửi, **không soạn lại từ đầu** (tránh khách nhận 2–3 tin gần giống nhau).

---

## 8. Quy tắc kinh doanh đang áp dụng

- **Giá**: mỗi page có mẫu chủ lực riêng (Q001…Q006). Đầm 449k–499k + 25k ship; 2 đầm 749k–849k miễn ship; set đồ nam 699k + 30k ship.
- **Trả giá**: miễn ship trước → giảm từng nấc 20k → giá sàn. Không nhảy thẳng xuống sàn.
- **Xả kho**: chỉ áp cho hội thoại **shop đã nhắn tin xả** (khớp `saleTrigger`), và chỉ cho **mẫu được chỉ định** (`saleModels`); mẫu khác giữ giá thường. Bảng giá xả **thay hẳn** bảng giá thường (không ghép chung — ghép là bot lẫn 2 bảng giá).
- **Size**: tra theo cân nặng (30–49 M, 50–55 L, 56–63 XL, 64–71 2XL, 72–79 2XL, ≥80 hết size). Chỉ nhích size khi **chính khách** yêu cầu.
- **Địa chỉ**: đủ tới xã/phường + huyện/quận + tỉnh là chốt, **không đòi thêm số nhà**.
- **Chốt đơn**: chỉ khi đủ mẫu + màu + size + số lượng + tên + SĐT + địa chỉ; bản tóm tắt **phải ghi rõ mã mẫu**.

---

## 9. Chống bỏ sót tin (3 lớp)

1. **Poll 5 giây** — đọc hội thoại vừa đổi trạng thái. Chỉ nhận tin mới hơn `POLL_MAX_AGE_MIN=10` phút.
   Khi shop bắn tin hàng loạt, >60 hội thoại đổi trong một nhịp → **phải lật trang tiếp** (tối đa 5 trang × 60),
   nếu không khách vừa nhắn bị đẩy xuống dưới vị trí 60 và không ai thấy (sự cố 19/09: khách chờ 13–17 phút).
2. **Lưới an toàn (watchdog) mỗi phút** — hội thoại khách nhắn > 2 phút chưa ai trả lời → đẩy vào hàng đợi.
   Quét 8 trang × 60 mỗi page, **song song các page**, có bộ nhớ tạm để không gọi lại API cho hội thoại đã kiểm tra.
   Ghi `lastAlive` mỗi phút: bot tắt 1 tiếng rồi bật lại thì **trả lời bù đúng khoảng bị tắt**, không đào lại tin cũ hơn.
3. **Quét bù thủ công** (`POST /api/catchup`) — quét sâu tới 40 trang theo số giờ chỉ định.

Chống trả lời trùng: trước khi trả lời bù luôn đọc lại tin nhắn để chắc chắn **chưa ai** (bot/nhân viên) trả lời đúng tin đó.

---

## 10. API quản trị (127.0.0.1:3456)

Nhóm chính: `GET /api/state`, `GET|PUT /api/pages/:id/settings`, `POST /api/pages` (thêm page bằng token),
`POST /api/pages/:id/test-chat` (chat thử — **có đủ chốt chặn như chat thật**), `POST /api/catchup`,
`POST /api/pages/:id/conversations/:cid/{send,reply-now,sync-order,pause}`,
`GET|PUT /api/prompt`, `GET /api/models`, `POST /api/catalog/refresh`,
`POST /api/assistant/chat` (trợ lý AI), nhóm `broadcast/*`, `followup/*`, `audit/*`, `GET /api/logs`, `GET /api/events` (SSE).

---

## 11. Chi phí AI thực đo (mỗi câu trả lời ~7.500–10.000 token vào, ~150 token ra)

| Model | ≈1 câu | ≈1 đơn (52 câu) | Chất lượng (8 tình huống khó ×2) |
|---|---|---|---|
| Gemini 2.5 Flash-Lite | 16đ | ~830đ | 15/16 |
| Gemini 2.5 Flash | 25–70đ | 1.3–3.6k | 14/16 |
| gpt-5.4-mini | 55đ | ~2.900đ | 14/16 |
| gpt-5.4 | 180đ | ~9.400đ | **15/16** |
| gpt-4.1 | 200đ | ~10.400đ | 14/16 |

Tối ưu đang dùng: tắt "suy nghĩ", chỉ gửi 12 tin gần nhất, sticker/lời kết trả lời bằng câu mẫu (không gọi AI),
tận dụng cache prompt (~90% token đầu vào được cache).

---

## 12. Bẫy đã gặp khi vận hành (đọc kỹ trước khi port)

1. **Câu cấm có số = whitelist số đó** (mục 7.1).
2. **Prompt sai dữ liệu → mất đơn**: luôn sinh danh sách màu/giá **từ danh mục POS**, đừng gõ tay vào prompt.
3. **Thứ tự sửa cấu hình**: thêm trường mới vào code **rồi khởi động lại** mới ghi cài đặt; ghi trước khi restart sẽ bị bản cũ loại bỏ âm thầm.
4. **Bảng giá xả phải thay hẳn bảng thường**, không ghép.
5. **Page mới bật bot mà chưa cấu hình** → bot tự bốc mẫu trong danh mục và chốt sai (xem checklist mục 14).
6. Tin page không có `uid`/`admin_id` = automation Facebook, không phải nhân viên.
7. Địa chỉ: khớp **nguyên văn** tên xã/huyện trước, fuzzy sau ("Lý Sơn" từng khớp nhầm "Sơn Tịnh"); bỏ 1 lần tên tỉnh trước khi dò huyện.
8. Máy chạy bot phải **tự khởi động lại** khi tiến trình chết/treo và khi máy reboot (đã từng chết âm thầm 3 tiếng).

---

## 13. Gợi ý kiến trúc khi đưa lên ERP

> *Phương án ban đầu, KHÔNG được chọn — xem khối trạng thái đầu tệp (`e56833eb`).*

### 13.1 Tách thành dịch vụ
```
ERP (hiện có)
 ├── chat-gateway      : nhận webhook Pancake/Facebook, chuẩn hoá thành Message
 ├── conversation-svc  : hàng đợi theo hội thoại, lịch sử, trạng thái (poller + watchdog)
 ├── ai-orchestrator   : dựng prompt + gọi AI + CHẠY BỘ CHỐT CHẶN (port nguyên mục 7)
 ├── catalog-svc       : sản phẩm/biến thể/giá/ảnh/tồn (nguồn sự thật cho giá & màu)
 ├── order-svc         : trích xuất đơn, chuẩn hoá địa chỉ, tạo/cập nhật đơn trong ERP
 └── admin-ui          : cấu hình page, chat thử, theo dõi khách đang chờ
```

### 13.2 Bảng dữ liệu tối thiểu
- `channel_page` (id, platform, page_id, token, shop_id, trạng thái)
- `page_setting` (page_id, **toàn bộ trường ở mục 4.1** — nên tách `sale_*` ra bảng `sale_campaign`)
- `conversation` (id, page_id, customer_id, last_customer_msg_id, last_handled_msg_id, updated_at, unreachable_at, tags)
- `message` (id, conversation_id, direction, sender_type: customer|bot|staff|automation, text, attachments, created_at)
- `product`, `product_variant` (code, color, size, price, image_url, stock) ← nguồn sự thật cho guard giá/màu
- `size_chart` (page_id hoặc product_id, min_kg, max_kg, min_cm, max_cm, size)
- `sale_campaign` (page_id, trigger_keywords, applies_to_codes, price_table, valid_from/to)
- `bot_reply_log` (conversation_id, prompt_tokens, completion_tokens, model, guard_hits[], latency_ms)
- `order_draft` (conversation_id, product_variant_id, qty, customer_name, phone, address chuẩn hoá, agreed_total, ship_fee, source='bot')

### 13.3 Việc nên làm khác đi khi lên ERP
- **Sinh prompt từ dữ liệu**, không lưu prompt viết tay: khối báo giá, danh sách màu, bảng size đều render từ `product_variant` + `sale_campaign` → hết hẳn lớp lỗi "prompt lệch dữ liệu" (mục 7.5).
- **Guard là middleware**: mỗi guard là một hàm `(reply, context) => {ok, fixedReply, reason}` chạy theo chuỗi, ghi log `guard_hits` để theo dõi model nào hay sai.
- **Đa kênh**: trừu tượng hoá `ChannelAdapter` (Pancake, Facebook trực tiếp, Zalo, TikTok) với giao diện `listConversations/getMessages/sendMessage/addTag`.
- **Đa nhà cung cấp AI**: giữ nguyên cách làm hiện tại (2 file cùng giao diện) — đã đổi Gemini ↔ OpenAI nhiều lần không phải sửa chỗ khác.
- **Hàng đợi bền** (Redis/DB) thay vì hàng đợi trong RAM, để restart không mất tin.
- **Chạy nhiều tiến trình**: khoá theo `conversation_id` để 2 worker không trả lời cùng một khách.

### 13.4 Thứ tự port đề xuất
1. Adapter kênh + hàng đợi + lưu tin (chưa cần AI) → đo chắc chắn không sót tin.
2. Catalog + size chart + sinh prompt từ dữ liệu.
3. Gọi AI + **toàn bộ guard mục 7** + chat thử.
4. Ghi đơn vào ERP + chuẩn hoá địa chỉ.
5. Trạng thái đơn trả lời khách, broadcast, follow-up, đối chiếu đơn.

---

## 14. Checklist bật bot cho page mới (bắt buộc)

1. Dán Page Access Token → thêm page.
2. Đặt **mẫu chủ lực** (`defaultProduct`).
3. Viết `extraPrompt` theo khung: **"MẪU CHỦ LỰC LÀ … (ĐỌC TRƯỚC TIÊN)"** → khối báo giá nguyên văn kèm `[[IMG:mã]]` → giá các mẫu khác → quy trình trả giá → quy tắc size/icon/bình luận.
4. Gán `sizeChart` + `sizeNote`.
5. Chọn `commentMode`, `minCustomerMessages`, `orderSync`, `sendProductImages`, `customerTitle`.
6. Chat thử tối thiểu 6 tình huống: hỏi giá · hỏi màu · cho số đo · chê đắt · đổi mẫu khác · chốt đơn đủ thông tin.
7. Chạy `npm run selftest` (23 test) rồi mới bật `enabled`.

---

## 15. Kiểm thử

- `npm run selftest` — 23 test offline (giả lập Pancake + AI), bắt buộc xanh trước khi deploy.
  Bao phủ: debounce, chặn giá, chặn thiếu thông tin đơn, tra size, gửi ảnh, nhận diện ảnh, ghi đơn POS,
  gửi hỏng giữa chừng, đối chiếu địa chỉ, tách tin, xả kho.
- `scripts/test-pancake.js`, `test-pos.js`, `test-gemini.js`, `test-openai.js` — kiểm tra từng kết nối.
- `POST /api/pages/:id/test-chat` — chat thử **đi qua đúng bộ chốt chặn như chat thật** (rất quan trọng: nếu chat thử bỏ qua guard thì test sẽ cho kết quả sai lệch).

---

*Hết. Mọi con số và quy tắc trong tài liệu lấy từ hệ thống đang chạy thật ngày 23/09/2026.*
