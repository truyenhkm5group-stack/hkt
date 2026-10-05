# Kênh nhắn tin — Pancake là MỘT kết nối, không phải điều kiện

> Đo trên nhánh `wt-master-mission`, 05/10/2026. Mô tả mã ĐANG CÓ; phần chưa làm ghi rõ ở §6. Kế hoạch chung:
> `docs/product-audit.md`.

## 1. Ba nhóm shop, ba lối — không lối nào hạng hai

| Shop | Lối | Tin tới bot | Cần gì |
|---|---|---|---|
| Không dùng phần mềm chat nào | **Nối thẳng Facebook** (`/api/connect/messenger/start` → chọn page) | Tức thì (webhook của Meta, nền tảng tự đăng ký) | Tài khoản quản trị page. Không Pancake, không dán URL |
| Đang dùng Pancake | **Pancake qua API** (Page ID + page access token) | Vài phút (ERP đọc qua API Pancake mỗi lượt job 5 phút) | Không cần Webhook của Pancake ⇒ **không tốn slot thuê bao** |
| — tuỳ chọn nâng cao | Webhook của Pancake | Tức thì | Tốn 2 slot Pancake — chỉ ai muốn |
| Dùng phần mềm khác | Nối thẳng Facebook song song (tắt trả lời tự động của phần mềm kia) · Zalo OA · ô chat website | Tức thì | Lối gửi yêu cầu kết nối qua Zalo hỗ trợ |

Ô «Vào việc ngay» (`components/onboarding/go-live-card.tsx`) hỏi bằng lời của chủ shop «Hiện bạn trả lời tin nhắn khách bằng
gì?» và chỉ hiện bước của lối đã chọn. Lối đang dùng SUY RA từ kết nối thật (`goLivePathOf`), không lưu lựa chọn. Mốc
onboarding (`onboardingStage`): ACCOUNT_CREATED → CHANNEL_CONNECTED → MESSAGING_READY → CATALOG_READY → AI_CONFIGURED →
TEST_PASSED → ACTIVATED — tới được ACTIVATED không cần Pancake.

## 2. Mô hình chung đã có (không dựng bản thứ hai)

```
Pancake webhook ─┐                         ┌─ Messenger webhook (Meta) ─┐
Pancake API ─────┤→ receiveFanpageEvent    │   receiveMessengerEvent ←──┘   Zalo → receiveZaloEvent   Web → chatTurn
                 └──────────┬──────────────┴──────────┬──────────────────────────┬──────────────────────┘
                     sales_chat_inbound (hàng chờ; UNIQUE message_id)            │
                            └────────────→ sales_chat_conversations ←────────────┘ (FANPAGE · ZALO · WEB · TEST)
                                                 │
                                    engine.ts `chatTurn` — KHÔNG biết tin tới từ đâu
                                                 │
                     sales_conversation_events · orders (origin, sales_conversation_id) · màn Hiệu quả
```

- Lõi bán hàng (`engine.ts`, `tools.ts`, `events*.ts`, chỉ số, quy kết) không có giả định Pancake nào (khảo sát 05/10/2026).
- Mã ngoài (page, PSID / mã hội thoại Pancake, mã tin) chỉ là địa chỉ trả lời + khoá chống trùng; danh tính nghiệp vụ là
  `sales_chat_conversations.id`, `customers.id`, `orders.id`.
- Chỉ số định nghĩa MỘT lần trên sổ sự kiện — Pancake, Messenger, Zalo, web đo cùng một công thức.

## 3. Chống trùng — một hành động của khách, tối đa một hành động bán hàng

| Nguy cơ | Chặn bằng |
|---|---|
| Webhook gửi lại / nhà cung cấp thử lại | `sales_chat_inbound.message_id` UNIQUE + `onConflictDoNothing` |
| Pancake webhook + Pancake API cùng thấy một tin | CÙNG mã tin của Pancake ⇒ cùng khoá ⇒ một dòng (bài kiểm: `self-service-journey`) |
| Đọc API lặp lại cùng kết quả | cùng khoá ⇒ 0 dòng mới; tin đã được trả lời không còn «chờ» trong luồng Pancake |
| **Meta trực tiếp + Pancake cùng một page** | **MỘT PAGE — MỘT ĐƯỜNG** (`lib/sales-chatbot/channel-ownership.ts`): lúc nối, mỗi đường từ chối page đường kia đang giữ; lúc chạy, Pancake đang bật thì THẮNG và đường Messenger bỏ qua MỌI gói tin của page đó (cả tiếng vọng). Không dựa vào việc mã tin Pancake có trùng `mid` của Meta — điều đó chưa được chứng minh ở đâu |
| Bot trả lời hai lần một lượt | hàng chờ giành dòng (claim) theo hội thoại; câu trả lời gắn với dòng đã giành |
| Tạo đơn hai lần | khoá idempotency của lõi đơn (`sales-chat:<hội thoại>:<lượt mua>`, form trong chat `chat:<hội thoại>:<requestKey>`) |
| Sự kiện bán hàng ghi hai lần | `sales_conversation_events.dedupe_key` UNIQUE |

Vì sao Pancake thắng: shop Pancake đang chạy thật phải giữ nguyên hành vi (đọc lại hội thoại bị rơi, ghi đơn hộ nhân viên,
hồ sơ khách cũ — những thứ đường Messenger chưa có).

## 4. Pancake qua API — lịch đồng bộ (`lib/sales-chatbot/pancake-poll-shared.ts`)

Chạy trong job `sales-followup` (5 phút, `catchUpFanpage`) cho mọi tổ chức bật Pancake; dùng đúng API công khai mà kết nối
đã kiểm (`/v2/pages/<page>/conversations?order_by=updated_at` → `/v1/pages/<page>/conversations/<id>/messages`).

- **Mốc đồng bộ** theo tổ chức + page trong `settings['ai.salesChatbot.pancakePoll']` (CSDL tổ chức) — sống qua khởi động lại,
  không mang bí mật. Lượt sau chỉ đọc hội thoại cập nhật sau mốc (trừ 2 phút chồng lấn), không quá 30 phút.
- Mốc **không vượt** «bây giờ − 60 giây» (tin quá mới để webhook lo, lượt sau phải còn thấy) và **không vượt** hội thoại chưa
  kịp đọc vì hết ngân sách. Đọc CŨ TRƯỚC ⇒ không bỏ đói khách chờ lâu.
- **Ngân sách**: webhook có tin trong 2 giờ ⇒ lưới an toàn (5 hội thoại / lượt, như trước); không ⇒ chế độ API (25).
- **Lỗi / 429** ⇒ lùi 5 → 10 → 20 → 40 → 60 phút (trần), trong lúc lùi không gọi Pancake; lượt đạt ⇒ xoá bộ đếm.
- **Page yên** (không hội thoại nào cập nhật trong 6 giờ) ⇒ 15 phút mới hỏi một lần.
- Webhook Pancake (nếu có) ghi mốc «đang chạy» tối đa 5 phút một lần (`markPancakeWebhook`), trong `after()` nên vẫn trả 200 nhanh.

## 5. Ranh giới nhà cung cấp

| Vai | Hôm nay |
|---|---|
| NHẮN TIN (nhận / gửi) | Pancake fanpage · Messenger trực tiếp (+ Instagram) · Zalo OA · chat web |
| SẢN PHẨM / GIÁ / TỒN | ERP (sổ kho, bảng giá) — bot chỉ đọc từ đây, không từ nhà cung cấp nhắn tin |
| ĐƠN | Lõi đơn ERP; Pancake POS là nguồn đồng bộ RIÊNG (`orgHasSyncedSource`), không gắn với Pancake nhắn tin |

## 6. Chưa làm — và vì sao

| Việc | Vì sao chưa | Điều kiện để làm |
|---|---|---|
| Nhịp đọc API nhanh hơn 5 phút | Đổi lịch scheduler là việc chủ shop quyết (AGENTS §7) | Chủ shop duyệt một job riêng (vd 1 phút, chỉ tổ chức không có webhook) |
| Lai Meta trực tiếp (tin) + Pancake API (lịch sử / hồ sơ khách) cho CÙNG page | Phải nối PSID của Meta với mã hội thoại / khách của Pancake; chưa có bằng chứng ánh xạ ⇒ gộp danh tính là đoán | Đo trên dữ liệu thật: Pancake trả PSID / `fb_id` cho hội thoại Messenger? Nếu có ⇒ chế độ Pancake «chỉ đọc» (không nhận tin, không gửi) |
| Nhập lịch sử hội thoại Pancake vào ERP | Đường đã có là HỌC CÓ KIỂM DUYỆT: sổ tay học từ lịch sử (che SĐT + tên trước khi tới AI, chủ shop duyệt bản xuất bản — `playbook.ts`) và hồ sơ khách cũ đọc lúc chat (`returning.ts`). Không huấn luyện thẳng trên hội thoại thô | Nhu cầu báo cáo lùi kỳ cụ thể |
| `ChannelAdapter` chung (TD-10) | Bốn đường đang chạy thật, mỗi đường có bài kiểm; rút thành một giao diện là thay đổi lớn ở mã đổi hằng ngày | Kênh thứ năm (TikTok / Shopee chat) |
| Nhiều page mỗi tổ chức (TD-11) | Một kết nối mỗi loại mỗi tổ chức | Khách thứ hai cần nhiều page |

## 7. Nhiều page một tổ chức (`org_channel_pages`, migration `0217`)

```
Tổ chức ─ org_connections['facebook-messenger']  («nhà cung cấp đã bật» — trang Kết nối, bộ kiểm đọc hàng này)
             └─ org_channel_pages  (MỖI page / Instagram một hàng: token mã hoá riêng · trạng thái · bật/tắt AI · sức khoẻ)
                   └─ sales_chat_conversations.page_id  →  sales_chat_inbound / tin nhắn
Nền tảng ─ platform_messenger_pages (page_id → tổ chức) — định tuyến webhook theo TỪNG page (đã có từ 0207)
```

- **Nối**: một lần đăng nhập Facebook → `/me/accounts` (tối đa 100 page) → màn chọn nhiều page (tìm kiếm, chọn tất cả). Danh
  sách + token chờ chọn lưu NIÊM PHONG ở máy chủ (JWE, 10 phút, gắn tổ chức + người) — không còn ở cookie (4 KB ⇒ cắt im lặng
  ở ~12 page). Page này hỏng (thuộc cửa hàng khác · đang chạy qua Pancake · Meta từ chối) không chặn page kia. Nối thêm là THÊM.
- **Token**: AAD gắn tổ chức + kết nối + page — bản mã chép sang hàng page khác không giải được (bài kiểm). Chỉ
  `lib/connectors/service.ts` chạm bản mã; xoay `PLATFORM_SECRETS_KEY` mã hoá lại cả token page.
- **Nhận / gửi**: tin vào đúng page; bot và nhân viên gửi bằng token của ĐÚNG page của hội thoại.
- **AI theo page**: tạm dừng AI ở một page ⇒ như chế độ «quan sát» cho page đó (hội thoại vẫn mở, tin vẫn ở Hộp thư, bot im).
  Bật / tạm dừng hàng loạt; Instagram đi theo page của nó.
- **Sức khoẻ theo page**: mốc tin gần nhất + lỗi gửi gần nhất của TỪNG page (lỗi page A không đụng page B). Gỡ từng page.
- **Tổ chức nối trước 0217**: không có hàng page nào ⇒ page của hàng kết nối đơn vẫn nhận / gửi như cũ (không backfill). Bật /
  tắt AI cho page đó ⇒ dựng một hàng KHÔNG token (token vẫn đọc ở hàng cũ).

### Hộp thư và chỉ số theo page (MP-2)

- **Hộp thư chung**: mọi page trong MỘT danh sách, mỗi hội thoại mang tên page (danh sách + đầu khung chat). Chọn một page là
  LỌC trên cùng hội thoại (`listInbox({ page })`), không phải hộp thư thứ hai. Bộ chọn page chỉ hiện khi có hơn một page.
- **Chỉ số theo page**: `onPage(pageId)` (`events-sql.ts`) là chiều lọc DUY NHẤT cho màn «Hiệu quả», quy kết từng đơn, lý do
  mất khách, bán chéo, chi phí AI (theo `ref` = hội thoại). Cùng công thức ⇒ «mọi page» = cộng các page (bài kiểm).

### Còn lại

| Việc | Ghi chú |
|---|---|
| Cấu hình AI theo page (persona · giờ · danh mục · giá) đè lên mặc định tổ chức | `loadSalesChatbotConfig()` đang là MỘT cấu hình tổ chức; cần quyết định trường nào được đè |
| Drill-down (danh sách hội thoại theo chỉ số) giữ bộ lọc page | `DrillFilter` chưa có `page` |
| Instagram quy về page cha khi lọc | hôm nay lọc đúng mã tài khoản (page HOẶC Instagram) |
| Nhiều page Pancake | Pancake vẫn một page mỗi tổ chức (TD-11 phía Pancake) |
