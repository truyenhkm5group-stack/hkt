# Thay Pancake cho social commerce — đối chiếu khoảng trống

> Kế hoạch sống của lệnh «Replace Pancake» (nhánh `feat/pancake-replacement`, cây `wt-pancake-replacement`). Đo trên
> `origin/main` **5d5ee7fb** (06/10/2026) + các nhánh đang mở. Tệp này KHÔNG viết lại những gì đã có ở
> `docs/platform/messenger.md`, `docs/productization/MIGRATION_PLAN.md` (M8) và — khi nó vào `main` —
> `docs/messaging-providers.md` / `docs/product-audit.md` của nhánh `wt-master-mission`; nó trỏ tới đó.

## 0. Kết luận một đoạn

Phần lớn «thay Pancake» **đã có trên `main`**: Messenger + Instagram trực tiếp (OAuth của app nền tảng, webhook ký
`X-Hub-Signature-256`, định tuyến theo mã page, chống trùng theo `mid`), Hộp thư khách trong ERP (trả lời · ảnh · nhãn ·
ghi chú · nhận / giao hội thoại · tạo đơn trong khung chat), bot bán hàng đa kênh với bốn chế độ vận hành, đơn idempotent,
sổ sự kiện + màn «Hiệu quả» theo `ORDER_OUTCOME`, SILO một CSDL mỗi tổ chức kèm bài tấn công cô lập. Phần **nhiều page /
hộp thư chung lọc theo page / onboarding không bắt buộc Pancake** đã XONG trên nhánh `wt-master-mission` nhưng **chưa vào
`main`** ⇒ lệnh này KHÔNG làm lại, chỉ phụ thuộc. Khoảng trống thật còn lại tập trung ở: **kiểm soát AI ↔ người trên từng
hội thoại (có lỗ hổng trả lời đôi)**, **vận hành trên điện thoại**, **vòng đời token Meta**, **đồng bộ hội thoại cũ của
Messenger**, **truy vết page trên đơn**, **Customer 360 không thấy hội thoại**, và **Pancake chưa được đẩy về vị trí
«legacy / chuyển đổi»**.

## 1. Bản đồ công việc song song (đo 06/10/2026)

| Nhánh / cây | Trạng thái | Liên quan | Quy tắc cho lệnh này |
|---|---|---|---|
| `wt-master-mission` (18 commit, chưa PR) | Đang làm, commit cuối 06/10 | P9 onboarding hỏi «bạn trả lời tin bằng gì» · P10 Pancake qua API · **P12 nhiều page** (`org_channel_pages`, migration 0217) · **P13 hộp thư chung + lọc page, chỉ số theo page** · P14 cấu hình AI theo page · P1–P8 quy kết đơn AI/người, lý do mất khách, rà lỗi AI, bảng sẵn sàng | **IN_PROGRESS_ELSEWHERE** — không chạm `org_channel_pages`, bộ chọn page, `go-live-card`, quy kết đơn. Sửa tối thiểu ở `messenger.ts` / `inbox.ts` (hai tệp nó sửa nhiều) |
| `claude/hop-thu-lich-su` (1 commit) | Đang làm | Nhập lịch sử hội thoại **Pancake** vào hộp thư (migration 0216, `history.ts`) — ghi rõ «Messenger trực tiếp CHƯA nhập lịch sử» | Không làm lịch sử Pancake. Lịch sử **Messenger** là khoảng trống — làm SAU khi nhánh này vào `main` để dùng lại khung con trỏ / cột `imported_at` |
| `ai-tech-room` (PR #592) | Mở | Công cụ điều phối agent | Không liên quan sản phẩm |
| Lưu ý migration | `wt-master-mission` và `hop-thu-lich-su` cùng dùng số **0216** | — | Lệnh này cố tránh migration mới; nếu cần thì đánh số sau cùng bằng `npm run migration:renumber` |

### 1.1 Theo dõi dependency — chủ shop chốt 06/10/2026: TẠM DỪNG mọi việc có thể trùng

Không tạo thêm domain / schema / hộp thư mới, không thêm phụ thuộc vào Pancake, cho tới khi CẢ HAI vào `origin/main`. Trong lúc
chờ chỉ audit chỉ-đọc và cập nhật tệp này. Khi cả hai đã vào: fetch → gộp main mới nhất vào `feat/pancake-replacement` →
audit lại TOÀN BỘ P0 (EXISTS ⇒ REUSE/SKIP · PARTIAL ⇒ EXTEND · MISSING ⇒ BUILD) → tiếp tục lệnh.

| Dependency | Đo lúc 06/10/2026 (main `95d07577`) | Dấu hiệu đã vào main (đo theo NỘI DUNG — merge squash không giữ tên nhánh) |
|---|---|---|
| D1 · `wt-master-mission` (nhiều page · hộp thư lọc page · onboarding không Pancake · quy kết đơn) | Chưa PR. Nhánh đi trước main 18 commit, sau main 8; cây làm việc của phiên đó có 89 thay đổi chưa commit (đang gộp main) | `origin/main` có `lib/sales-chatbot/channel-ownership.ts` + `lib/sales-chatbot/page-config-shared.ts` + bảng `org_channel_pages` trong `db/schema.ts` |
| D2 · `claude/hop-thu-lich-su` (lịch sử hội thoại Pancake) — chỉ khi đạt gates | Chưa PR. Phiên đó đã rebase lên main mới nhất ở nhánh local `claude/hop-thu-lich-su-moi` (đi trước origin 9 commit, chưa push) | `origin/main` có `lib/sales-chatbot/history-shared.ts` + `lib/sales-chatbot/history.ts` |

### 1.2 Audit chỉ-đọc trong lúc chờ (06/10/2026)

- **Tiêu chí 29 «Pancake không tham gia runtime»** với shop CHỈ nối Facebook trực tiếp — đọc mã:
  - Nhận tin (webhook Meta) · lượt bot (`processMessengerThread`) · nhân viên gửi (`sendBotText` thử Pancake trước nhưng không có
    kết nối Pancake thì `sendFanpageText` trả «chưa bật» TRƯỚC mọi lời gọi mạng) · follow-up · tạo đơn trong chat: KHÔNG gọi
    Pancake. Chưa có bài kiểm chứng minh bằng số lời gọi mạng = 0 — ghi vào việc kế tiếp.
  - **Ghi đơn từ hội thoại** (`lib/sales-chatbot/order-sync.ts::runFanpageOrderSync`) **CHỈ chạy với kết nối Pancake**: không có
    `pancake-fanpage` ⇒ dừng ngay («kết nối fanpage chưa bật»), và nó đọc lại hội thoại qua API Pancake. Shop chỉ nối Facebook
    trực tiếp mà nhân viên chat tay (bot tắt / Quan sát / Tiếp quản) ⇒ KHÔNG được ghi đơn tự động — trong khi ERP đã có ĐỦ tin
    của khách lẫn tiếng vọng của page trong `sales_chat_inbound`. → **PARTIAL (chỉ Pancake)**.
  - Các nhánh khác từng chạm `order-sync.ts` đều đã merge (#585 · #588 · #590…); `hop-thu-lich-su` chỉ sửa 4 dòng (loại tin lịch
    sử khỏi ứng viên). Không phiên nào đang mở rộng job này sang Messenger trực tiếp.

### 1.3 NEXT MISSING GAP (không trùng D1 / D2) — làm SAU khi D1 + D2 vào main

| # | Gap | Trạng thái | Vì sao không trùng | Phạm vi được phép |
|---|---|---|---|---|
| N1 | Ghi đơn từ hội thoại cho Messenger trực tiếp: đọc tin từ `sales_chat_inbound` (không qua Pancake), CÙNG luật chốt / chống trùng / sổ `state.orderSync` của job hiện có | PARTIAL ⇒ EXTEND | D1 không chạm `order-sync.ts`; D2 chỉ lọc tin lịch sử | Mở rộng job sẵn có — không domain / schema / hộp thư mới, không thêm lời gọi Pancake |
| N2 | Bài kiểm «Pancake không tham gia runtime»: tổ chức chỉ nối Facebook trực tiếp chạy trọn nhận tin → bot → nhân viên → tạo đơn với `fetch` giả ĐẾM host — 0 lời gọi `pages.fm` | MISSING (chỉ kiểm thử) | Chỉ thêm bài kiểm | Bài kiểm mới |
| N3 | Phủ cô lập tổ chức cho các lõi mới của nhánh (`setConversationControlCore`, `customerConversations`, `orderChatThreads`, `markConnectionBrokenBySystem`) trong bộ tấn công chéo tổ chức | MISSING (chỉ kiểm thử) | Chỉ thêm bài kiểm (D1 cũng sửa `ai-sales-isolation.test.ts` ⇒ làm sau D1 để khỏi xung đột) | Bài kiểm |

## 2. Ma trận

Trạng thái: **EXISTS** · **PARTIAL** · **MISSING** · **IN_PROGRESS_ELSEWHERE** · **BLOCKED_EXTERNAL**.

| Tính năng | Trạng thái | Hiện có | Tệp / module | Nhánh / PR đang làm | Dùng lại | Khoảng trống | Hành động |
|---|---|---|---|---|---|---|---|
| OAuth Facebook (state chống CSRF, token dài hạn) | EXISTS | JWT `state` gắn tổ chức + người, cookie httpOnly 10 phút; đổi token dài hạn; token người dùng không lưu | `app/api/connect/messenger/*`, `lib/integrations/messenger/{graph,connect}.ts` | — | Giữ nguyên | — | REUSE |
| Liệt kê page, chọn NHIỀU page | IN_PROGRESS_ELSEWHERE | `main`: một page mỗi tổ chức, tối đa 12 page trong cookie | `connect.ts`, `messenger.ts` | `wt-master-mission` P12 (JWE máy chủ, 100 page, `org_channel_pages`) | — | `/me/accounts` chưa phân trang (> 100 page) | Chờ P12; phân trang ghi vào việc kế tiếp sau P12 |
| Lưu token an toàn | EXISTS | AES-256-GCM, AAD tổ chức + kết nối; `appsecret_proof` mọi lời gọi; `scrub` lỗi | `lib/connectors/secrets.ts`, `graph.ts` | P12 thêm AAD theo page | — | — | REUSE |
| Đăng ký webhook cho page | EXISTS | `POST /{page}/subscribed_apps` (messages · postbacks · echoes · feed) | `graph.ts::subscribePage` | — | — | Ngắt kết nối không gọi `DELETE subscribed_apps` | MISSING (nhỏ) — slice «vòng đời token» |
| Vòng đời token / sức khoẻ kết nối | PARTIAL | Kiểm tra tay (`GET /me`), thất bại ⇒ DRAFT; P12 ghi lỗi gần nhất theo page | `lib/connectors/testers.ts`, `service.ts` | P12 (sức khoẻ theo page) | Mã lỗi Graph đã trả về từ `graph()` | Lỗi **190 / token bị thu hồi** không được nhận ra; không có kiểm định kỳ; không báo «cần nối lại» | BUILD (slice 3) |
| Webhook: xác minh, chữ ký, định tuyến tổ chức, idempotent | EXISTS | `hub.challenge`; HMAC thân gốc, so thời gian hằng; `PAGE_INDEX` không bao giờ rơi về nhà; `sales_chat_inbound.message_id` UNIQUE | `app/api/webhooks/messenger/route.ts`, `lib/platform/webhooks.ts` | — | — | — | REUSE |
| Quan sát webhook Meta (nhận / hỏng / trùng) | PARTIAL | `sync_runs` của job `sales-followup` ghi số «trả lời bù» | `lib/sync/jobs.ts` | — | `lib/queries/webhook-health.ts` (khuôn ba đường) | Không có đếm gói Meta nhận / chữ ký sai / trùng; không có đèn sức khoẻ Messenger | BUILD (slice 5) |
| Mô hình kênh / hội thoại / tin | EXISTS (một phần) | `sales_chat_conversations` (FANPAGE · ZALO · WEB · TEST), `sales_chat_inbound`, `sales_chat_messages`, `sales_conversation_events` | `db/schema.ts` | `ChannelAdapter` chung (TD-10) cố ý hoãn | Giữ — KHÔNG dựng mô hình thứ hai | — | REUSE |
| Bình luận → tin riêng | EXISTS | Trường `feed`; bot trả lời bằng MỘT tin riêng; không bao giờ công khai | `messenger.ts`, `graph.ts::sendPrivateReply` | — | — | Không truy vết ad / campaign của bài | REUSE |
| Hộp thư chung mọi page + lọc page | IN_PROGRESS_ELSEWHERE | `main`: một danh sách mọi kênh, chưa có tên / lọc page | `lib/sales-chatbot/inbox.ts` | `wt-master-mission` P13 | — | — | Chờ P13 |
| Bộ lọc hộp thư AI / người, phân trang | PARTIAL | Lọc: tất cả · chưa đọc · chờ trả lời · cần người · của tôi · chưa ai nhận · kênh · nhãn · tìm | `inbox.ts`, `inbox-shared.ts` | — | — | Trần cứng 100 hội thoại, không «tải thêm»; không lọc «AI đang xử lý» / «người đang xử lý» | BUILD (slice 4) |
| Chat trực tiếp từ ERP | EXISTS | Gửi qua đúng hàm của kênh, `request_key` chống gửi đôi, SENDING / SENT / FAILED, gửi lại phần ảnh | `inbox.ts::sendStaffReplyCore` | — | — | Không có giao diện lạc quan (chờ máy chủ) — chấp nhận | REUSE |
| Tin ngoài 24 giờ Messenger (HUMAN_AGENT) | BLOCKED_EXTERNAL | Chỉ `RESPONSE`; quá 24 giờ chỉ cảnh báo | `graph.ts` | — | — | Cần quyền **Human Agent** qua App Review | Ghi ở `meta-production-readiness.md`; làm khi có duyệt |
| Chế độ AI theo hội thoại (HUMAN / COPILOT / AUTO), Tiếp quản / Trả lại AI, nhật ký | PARTIAL | Chế độ cấp TỔ CHỨC (quan sát · copilot · thử nghiệm · tự động); hội thoại chỉ có `HANDOFF` (nhân viên trả lời ⇒ nhường 30 phút) và «Trả lại cho AI» | `operating-mode*.ts`, `engine.ts::resumeConversationToAi`, `inbox.ts::handBackToAiCore` | — | `replyGate` (một cổng), sổ sự kiện, `audit()` | Không có nút **Tiếp quản** bền vững; không có Copilot cho MỘT hội thoại; nhật ký không ghi chế độ trước / sau + lý do | BUILD (slice 1) |
| Chống AI và người cùng trả lời | **PARTIAL — LỖI** | Giành dòng tin, khoá lượt theo `seq`, kiểm «page đã trả lời» TRƯỚC lời gọi AI | `fanpage.ts`, `messenger.ts`, `zalo.ts` | — | — | Sau khi AI soạn xong, bot GỬI mà **không đọc lại** hội thoại: nhân viên gửi / tiếp quản trong lúc AI đang nghĩ ⇒ khách nhận cả hai câu | **FIX (slice 1)** |
| AI Sales Agent | EXISTS | `engine.ts` + `tools.ts` (giá / tồn từ ERP, chiết khấu cứng 0, đơn idempotent), bước bán `stages.ts`, sổ tay, follow-up | `lib/sales-chatbot/*` | `wt-master-mission` (cấu hình theo page) | Giữ — KHÔNG dựng bot thứ hai | — | REUSE |
| Upsell / cross-sell + đo | EXISTS | Mẫu câu upsell do shop chọn; đo bán chéo đã giao (`ORDER_OUTCOME`) | `basket.ts`, `performance*.ts` | — | — | — | REUSE |
| Customer 360 | PARTIAL | `/customers/[id]`: đơn, giao thành công, hoàn, chi tiêu, AOV, địa chỉ, `fb_id` | `app/(dashboard)/customers/[id]/page.tsx` | — | `sales_chat_conversations.customer_id` | Hồ sơ khách **không thấy hội thoại** (kênh, page, lần cuối, AI / người); không có bảng danh tính mạng xã hội (cố ý — nhận diện thận trọng ba mức `returning.ts`) | BUILD (slice 6) |
| Đơn từ hội thoại | EXISTS | Người: `chat:<hội thoại>:<requestKey>`; AI: `sales-chat:<hội thoại>:<lượt>` + khoá advisory; `orders.sales_conversation_id`, `origin` | `lib/records/chat-order.ts`, `tools.ts`, `order-create.ts` | — | — | `orders.page_id` có cột nhưng đơn chat / AI **không ghi** ⇒ không truy về page | BUILD (slice 6) |
| Ghi đơn từ hội thoại (nhân viên chat tay, khách gửi SĐT + địa chỉ ⇒ máy lên đơn) | PARTIAL | Chỉ với kết nối «Fanpage qua Pancake»; đọc lại hội thoại qua API Pancake | `lib/sales-chatbot/order-sync.ts` | — (D2 sửa 4 dòng) | Luật chốt, chống trùng, sổ `state.orderSync` | Shop chỉ nối Facebook trực tiếp không được ghi đơn tự động | EXTEND sau D1 + D2 (N1, mục 1.3) |
| Analytics AI vs người, doanh thu đã giao | EXISTS | 16 chỉ số đo được, cohort AI_ONLY / AI_THEN_HUMAN, thử nghiệm ngẫu nhiên | `performance*.ts`, `experiment-*.ts` | `wt-master-mission` P1–P5 (quy kết từng đơn, AOV, theo page) | — | — | REUSE / chờ |
| Onboarding không Pancake | IN_PROGRESS_ELSEWHERE | `main`: «Vào việc ngay» chỉ có Pancake; Messenger trực tiếp nằm ở `/ai/sales-chatbot` | `components/onboarding/go-live-card.tsx` | `wt-master-mission` P9 | — | — | Chờ P9 |
| Pancake về vị trí legacy / chuyển đổi | MISSING | Pancake hiện như kết nối hạng nhất («Fanpage qua Pancake», «Pancake POS của tổ chức» đứng đầu trang Kết nối); không chỗ nào ghi «legacy» | `lib/connectors/registry.ts`, `app/(dashboard)/settings/connections/page.tsx` | (P9 chỉ đổi ô onboarding) | — | Khách mới vẫn thấy Pancake trước; không có hướng dẫn chuyển đổi Pancake → Messenger trực tiếp | BUILD (slice 7) |
| Đồng bộ hội thoại cũ Messenger trực tiếp | MISSING | Không có; Pancake đang được làm ở `hop-thu-lich-su` | — | phụ thuộc `hop-thu-lich-su` | Khung con trỏ của `history.ts` | Conversations API chỉ trả **20 tin gần nhất** mỗi hội thoại | BUILD sau khi `hop-thu-lich-su` vào `main` |
| Vận hành trên điện thoại | PARTIAL | Danh sách ↔ hội thoại bật tắt dưới `lg` | `inbox/page.tsx`, `thread-view.tsx` | `wt-master-mission` (hàng lọc xuống dòng) | — | Cột khách / đơn / ghi chú **`hidden xl:block`** ⇒ dưới 1280 px không tạo đơn, không ghi chú được | BUILD (slice 2) |
| Đa tổ chức | EXISTS | SILO + `tenant-attack`, `ai-sales-isolation`, `platform-isolation*` | `db/index.ts`, `lib/platform/context.ts` | — | Mọi bài mới chạy trong khuôn này | — | REUSE |
| Phiên bản Graph API | NEEDS CONFIG | Mặc định `v21.0`, ghi đè `FACEBOOK_API_VERSION` | `graph.ts::graphBase` | — | — | `v21.0` hết hạn **21/01/2027** | Ghi ở `meta-production-readiness.md` |

## 3. Thứ tự làm (cập nhật mỗi slice)

| # | Slice | Vì sao đứng đây | Trạng thái |
|---|---|---|---|
| 1 | **Kiểm soát AI ↔ người trên hội thoại**: chặn bot gửi câu đã soạn khi người vừa trả lời / tiếp quản; chế độ hội thoại HUMAN · COPILOT · AUTO; Tiếp quản / Trả lại AI; nhật ký trước → sau + lý do | Tiêu chí nghiệm thu 14–17 («không double reply»), là lỗi thật đang chạy trên mọi kênh | XONG (nhánh) — kèm sửa `bump` xoá mất `state.control` giữa lượt AI |
| 2 | Hộp thư dùng được trên điện thoại (cột khách / đơn / ghi chú) | Tiêu chí 27; tệp `thread-view.tsx` không nhánh nào đang sửa | XONG (nhánh) — đo trên Chrome 390 px; hàng lọc danh sách tràn ngang thuộc P13 của `wt-master-mission` |
| 3 | Vòng đời token Meta: nhận lỗi 190 / thu hồi ⇒ kết nối «cần nối lại», báo người; ngắt kết nối gỡ đăng ký | §4 lệnh | XONG phần một kết nối (nhánh). Còn: ghi theo TỪNG page khi P12 vào main; gỡ đăng ký webhook lúc ngắt |
| 4 | Hộp thư: «tải thêm», lọc AI / người | §7 lệnh | «Xem thêm» + lọc SĐT / level / thời gian / nhân viên do #595 (đã vào main); lọc «AI đang trả lời / Người đang xử lý»: XONG (nhánh) |
| 5 | Sức khoẻ webhook Meta | §22 lệnh | XONG (nhánh) — log có cấu trúc; chưa có màn hình sức khoẻ theo page (chờ P12) |
| 6 | Đơn / khách truy về hội thoại; Customer 360 thấy hội thoại | §12, §14 lệnh | XONG (nhánh). KHÔNG ghi `orders.page_id` (đi vào quy kết marketer / hoa hồng — chủ shop quyết); đơn truy về page qua hội thoại |
| 7 | Pancake về «Legacy / chuyển đổi» + hướng dẫn chuyển | §17 lệnh; sau P9 để không đụng `go-live-card` | XONG phần trang Kết nối (nhánh); ô onboarding là P9 của `wt-master-mission` |
| 8 | Đồng bộ hội thoại cũ Messenger | Sau `hop-thu-lich-su` | CHỜ |

## 4. Nhật ký quyết định

- **06/10/2026 — Không dựng `ChannelAdapter` / mô hình hội thoại mới.** Bốn kênh đang chạy thật trên CÙNG
  `sales_chat_conversations` + `sales_chat_inbound`; lệnh cấm mô hình hội thoại thứ hai. Kênh mới đi theo khuôn có sẵn.
- **06/10/2026 — Chế độ hội thoại lưu trong `state.control` (jsonb sẵn có), không thêm cột.** Tránh migration trùng số với
  hai nhánh đang mở (cả hai dùng 0216); lọc được bằng `state->'control'->>'mode'`. Chế độ hội thoại chỉ THU HẸP chế độ của
  tổ chức (HUMAN ⇒ bot im; COPILOT ⇒ chỉ soạn gợi ý), không bao giờ mở rộng — tổ chức đang Quan sát thì một hội thoại
  không thể tự bật Tự động.
- **06/10/2026 — Không làm nhiều page / hộp thư lọc page / onboarding** vì `wt-master-mission` đã làm xong trên nhánh;
  làm lại là đúng thứ lệnh cấm.
- **06/10/2026 — Theo `AGENTS.md` §6.6:** commit không ghi tên model AI.
