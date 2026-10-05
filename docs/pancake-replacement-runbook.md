# Runbook — bán hàng qua Facebook không cần Pancake

> Cho người vận hành nền tảng và quản trị của tổ chức khách. Đo trên nhánh `feat/pancake-replacement` (06/10/2026). Tài liệu
> gốc từng phần: `docs/platform/messenger.md` (kênh Messenger), `docs/productization/MIGRATION_PLAN.md` M8 (Hộp thư khách),
> `docs/meta-production-readiness.md` (Meta), `docs/pancake-replacement-gap-analysis.md` (còn thiếu gì).

## 1. Kiến trúc

```
Meta (Messenger · Instagram · bình luận)
   │  webhook ký X-Hub-Signature-256            ▲ Send API (page token + appsecret_proof)
   ▼                                            │
/api/webhooks/messenger ── tổ chức theo MÃ PAGE (platform_messenger_pages, PAGE_INDEX — page lạ ⇒ bỏ, không rơi về nhà)
   │
   ▼  (CSDL riêng của tổ chức — SILO)
sales_chat_inbound (UNIQUE message_id = mid)  ──►  sales_chat_conversations (kênh FANPAGE · ZALO · WEB)
   │                                                     │  state.control = Tiếp quản / AI gợi ý (nếu có)
   ▼                                                     ▼
processMessengerThread ── replyGate(chế độ tổ chức) ∘ chế độ hội thoại ── chatTurn (AI bán hàng, giá / tồn từ ERP)
   │                                         │
   │                         botMaySend: người vừa trả lời / tiếp quản? ⇒ KHÔNG gửi
   ▼
Hộp thư khách /ai/sales-chatbot/inbox ── nhân viên trả lời (request_key chống gửi đôi) · nhãn · ghi chú · tạo đơn
   │
   ▼
orders (sales_conversation_id · origin) ── ORDER_OUTCOME ── màn «Hiệu quả» (AI vs người, doanh thu đã giao)
Pancake: kết nối RIÊNG «Fanpage qua Pancake» — chỉ cho shop đang dùng Pancake; một page chỉ một đường (không cả hai).
```

## 2. Cài đặt

### Nền tảng (một lần) — chi tiết ở `docs/meta-production-readiness.md` §3
1. Biến môi trường VPS: `FACEBOOK_LOGIN_APP_ID`, `FACEBOOK_LOGIN_APP_SECRET`, `FACEBOOK_API_VERSION` (≥ `v24.0`; mặc định
   trong mã `v21.0` hết hạn 21/01/2027), `PLATFORM_SECRETS_KEY` (mã hoá page token).
2. App Meta: Webhooks (Page + Instagram) → `https://<miền>/api/webhooks/messenger`, verify token lấy ở
   `/ai/sales-chatbot/messenger` (tổ chức nhà); redirect URI `/api/connect/messenger/callback` cho mỗi miền.
3. Business Verification + App Review (Advanced Access).

### Tổ chức khách
1. Đăng ký `/start` → tổ chức có module «AI bán hàng».
2. Chatbot bán hàng → Messenger → **Kết nối Facebook** → chọn page → bot nhận tin.
3. Sản phẩm / giá / chính sách → cấu hình chatbot → chế độ (Quan sát → Copilot → Tự động).
4. Nhân viên: quyền `ai_sales:view` (đọc) + `ai_sales:reply` (trả lời, tiếp quản).

## 3. Vận hành hằng ngày

| Việc | Ở đâu |
|---|---|
| Đọc / trả lời khách mọi kênh | `/ai/sales-chatbot/inbox` — trên điện thoại: chạm hội thoại, «Khách · Đơn» mở khách / đơn / ghi chú |
| Khách khó, khách sỉ, khiếu nại | Thanh trên khung chat → **Tiếp quản** (lý do tuỳ chọn) — AI im HẲN tới khi bấm **Trả lại AI** |
| Muốn AI soạn sẵn, người duyệt gửi | **AI gợi ý** trên đúng hội thoại đó (tổ chức đang Tự động) hoặc chế độ Copilot cho cả tổ chức |
| Tạo đơn trong lúc chat | «+ Tạo đơn cho khách này» — đơn gắn hội thoại, ghi là đơn của người, bấm hai lần không ra hai đơn |
| Xem khách đã nói chuyện ở đâu | Hồ sơ khách → khối «Hội thoại» (chỉ nối bằng khoá cứng) |
| Từ đơn mở lại hội thoại | Chi tiết đơn → «Hội thoại của đơn» |
| Hiệu quả AI vs người | `/ai/sales-chatbot/performance` |

## 4. Kiểm soát AI ↔ người

- **Chế độ tổ chức** (`ai.salesChatbot.mode`): Quan sát · Copilot · Thử nghiệm · Tự động — một cổng `replyGate` cho mọi kênh.
- **Chế độ hội thoại** (`state.control`): AUTO (theo tổ chức) · COPILOT · HUMAN. Chỉ THU HẸP: tổ chức Quan sát thì không
  hội thoại nào tự mở Tự động.
- **Nhân viên gửi một câu** ⇒ hội thoại nhường 30 phút (lý do «Nhân viên đang trả lời…»), bot tự nhận lại sau đó.
- **Tiếp quản** ⇒ lý do «Nhân viên tiếp quản hội thoại» — KHÔNG tự hết hạn.
- **Chống trả lời đôi**: ảnh chụp hội thoại lúc bắt đầu lượt AI; trước mỗi câu / ảnh / tin riêng bot đọc lại — HANDOFF, chế độ
  người / copilot, hoặc `last_staff_at` tăng ⇒ không gửi (ghi chú dòng tin: «Người vừa trả lời hoặc tiếp quản…»).
- **Nhật ký**: `audit_logs` action `SALES_CHAT_CONTROL_SET` (người, lúc, chế độ trước → sau, lý do); sổ sự kiện
  `human.took_over` (`STAFF_TOOK_OVER`) / `ai.resumed` mang `users.id`.

## 5. Token và nối lại

- Triệu chứng: chuông đỏ «Messenger trực tiếp cần nối lại»; trang Messenger báo kết nối ở Nháp kèm câu lỗi của Meta.
- Nguyên nhân: Meta trả 190 / 102 (token hết hiệu lực) hoặc 200–299 / 10 (mất quyền). Máy đã tự chuyển kết nối về Nháp
  (`ORG_CONNECTION_AUTO_DRAFT` trong nhật ký) — bot và hộp thư ngừng gửi qua Messenger để không đốt lượt AI vô ích.
- Sửa: chủ page (vẫn là quản trị page) vào Chatbot bán hàng → Messenger → **Đổi page** → đăng nhập Facebook → chọn lại page.
  Lượt nối kiểm tra token rồi bật lại.
- KHÔNG làm: bật lại kết nối bằng tay khi chưa nối lại — lần gửi kế tiếp sẽ lại hỏng.
- Lỗi «ngoài 24 giờ» / «khách không nhận tin» / «giới hạn lời gọi» KHÔNG làm kết nối về Nháp.

## 6. Gỡ lỗi webhook

| Triệu chứng | Kiểm tra |
|---|---|
| Không tin nào vào | App Meta còn đăng ký trường `messages` cho page? (`POST /{page}/subscribed_apps` lúc nối) · Callback URL đúng miền · log `POST /api/webhooks/messenger` trả 401 = sai app secret (`FACEBOOK_LOGIN_APP_SECRET`) |
| 401 liên tục | App secret trên VPS khác app đang gửi webhook |
| 200 nhưng không vào hộp thư | Page chưa có trong `platform_messenger_pages` (nối lại) · page đang chạy qua Pancake (một page một đường — Pancake thắng) |
| Tin vào, bot im | Chế độ tổ chức Quan sát · hội thoại đang Tiếp quản / nhường · module AI tắt · bot tắt · ngoài giờ làm việc |
| Bình luận không được trả lời | Page nối trước 05/10/2026 chưa đăng ký `feed` ⇒ «Đổi page» một lần; trường `feed` trong app Meta |
| Tin trùng | Không thể: `sales_chat_inbound.message_id` UNIQUE theo `mid` |

Truy vấn production chỉ đọc qua ops `db-query` (kết quả mã hoá — `AGENTS.md` §4), ví dụ: số tin Messenger 24 giờ qua theo page
`select page_id, count(*) from sales_chat_inbound where created_at > now() - interval '24 hours' group by 1`.

## 7. Chuyển shop từ Pancake sang Facebook trực tiếp

1. Shop đang chạy «Fanpage qua Pancake» — giữ nguyên trong lúc chuẩn bị.
2. Kiểm hộp thư ERP đang thấy hội thoại Pancake bình thường (nhân viên quen thao tác trong ERP).
3. Tắt kết nối «Fanpage qua Pancake» cho page đó (một page chỉ một đường).
4. Chatbot bán hàng → Messenger → Kết nối Facebook → chọn page.
5. Nhắn thử từ tài khoản tester → tin vào hộp thư; bot trả lời; «Tiếp quản» chạy.
6. Tắt trả lời tự động của Pancake nếu còn (tránh khách nhận hai câu).
7. Lịch sử hội thoại Pancake cũ: nhập qua «Đồng bộ lịch sử» (nhánh `claude/hop-thu-lich-su`, khi vào main). Lịch sử Messenger
   trực tiếp trước ngày nối: Meta chỉ trả 20 tin gần nhất mỗi hội thoại — chưa làm.
8. Pancake POS (đồng bộ đơn) là kết nối khác, không liên quan nhắn tin — giữ hay bỏ tuỳ shop.

## 8. Triển khai và quay lui

- Triển khai: PR vào `main` (cổng bắt buộc `gates / gates`) → workflow **Deploy ERP to VPS** (`workflow_dispatch` trên `main`).
- Không migration nào trong các thay đổi của lệnh này (chế độ hội thoại nằm trong `state` jsonb sẵn có) ⇒ quay lui = deploy lại
  SHA trước. Dữ liệu `state.control` còn lại trên hội thoại sau khi quay lui KHÔNG gây hại: mã cũ không đọc nó, nhưng hội thoại
  đã tiếp quản vẫn ở HANDOFF với lý do không tự hết hạn ⇒ người bấm «Trả lại cho AI» như trước.
- Kết nối bị máy chuyển về Nháp không tự bật lại sau quay lui — nối lại page như §5.
