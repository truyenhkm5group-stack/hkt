# Nợ kỹ thuật dưới góc nhìn sản phẩm AI Sales Agent

> Ảnh chụp `origin/main` **7e2edfce** (04/10/2026). Chỉ đọc mã, chưa đo production.
> Mỗi mục có mã `TD-xx` để `MIGRATION_PLAN.md` trỏ tới. Số dòng (`tệp:dòng`) là của commit trên.
> Bản này **không** thay `docs/platform/tenant-readiness-audit.md` (nợ cô lập đa tổ chức) và
> `docs/platform/pilot-readiness.md` §4 (nợ pilot). Nó chỉ xếp lại nợ theo câu hỏi:
> **"cái gì chặn việc bán AI Sales Agent cho tenant thứ 2, 3…"**

## Cách đọc

| Cột | Nghĩa |
|---|---|
| **Mức** | `P0` chặn bán hoặc gây sai tiền/sai đơn khi mở rộng · `P1` chặn đo lường / chặn đóng gói · `P2` làm chậm, chưa chặn |
| **Rủi ro sửa** | Nguy cơ làm vỡ production nếu đụng vào: `THẤP` thêm mới thuần · `VỪA` đổi hành vi có thể kiểm bằng test · `CAO` đụng luật đã khoá bằng contract test, dữ liệu đã chốt kỳ, hoặc hành vi bot đang trả lời khách thật |
| **Hướng** | `KEEP` · `REFACTOR` · `EXTRACT` · `DEPRECATE` · `REWRITE` (định nghĩa ở `TARGET_ARCHITECTURE.md` §7) |

## Bảng tổng

| Mã | Nợ | Nhóm | Mức | Rủi ro sửa | Hướng |
|---|---|---|---|---|---|
| TD-01 | Lõi đơn nhận đơn giá do người gọi truyền; giá/tồn chỉ kiểm ở lớp công cụ bot | Logic sai tầng | P0 | VỪA | EXTRACT |
| TD-02 | Kiểm tồn và hạn mức nợ nằm ngoài transaction ghi đơn; không giữ hàng | Logic sai tầng | P0 | VỪA | REFACTOR |
| TD-03 | Không có khoá idempotency khi agent tạo đơn | Logic sai tầng | P1 | THẤP | REFACTOR |
| TD-04 | Không có sổ sự kiện hội thoại — trạng thái phễu sống trong `state` jsonb bị ghi đè | Thiếu event tracking | P0 | THẤP | REWRITE (mới) |
| TD-05 | Đơn của bot nhận diện bằng chuỗi `orders.source`, không có khoá tới hội thoại | Thiếu event tracking | P1 | THẤP | REFACTOR |
| TD-06 | Sổ chi phí AI phân mảnh ≥ 4 nơi; tính năng trong sổ gộp quá thô | Duplicate source of truth | P1 | THẤP | REFACTOR |
| TD-07 | Không biết nhân viên nào trả lời trên Pancake ⇒ không có vế "người" để benchmark | Thiếu event tracking | P1 | — (giới hạn nguồn) | — |
| TD-08 | Hai bot bán hàng song song (`chatbot/` và `lib/sales-chatbot`) | Duplicate logic | P1 | CAO | DEPRECATE `chatbot/` |
| TD-09 | Lời nhắc lõi của bot mang ví dụ và luật ngành hải sản | Customer hard-code | P1 | CAO | REFACTOR |
| TD-10 | Kênh vào duy nhất là Pancake; gọi `pages.fm` bằng `fetch` nội tuyến, không có `ChannelAdapter` | Integration không qua abstraction | P1 | VỪA | EXTRACT |
| TD-11 | Mỗi tổ chức chỉ MỘT fanpage | Schema coupling | P1 | VỪA | REFACTOR |
| TD-12 | `ai_sales` phụ thuộc cứng 4 module ERP | Schema coupling | P1 | THẤP | REFACTOR |
| TD-13 | Định danh = id đối tác (Pancake); nguồn gốc đơn mã hoá bằng tiền tố `erp-` + CHECK CSDL | Schema coupling | P2 | CAO | REFACTOR (thêm cột, không đổi id) |
| TD-14 | Trạng thái đơn = enum Pancake; đơn ERP mượn mã số Pancake | Schema coupling | P2 | CAO | KEEP tạm |
| TD-15 | `ORDER_OUTCOME` và ngưỡng COD là hằng biên dịch của luật VTP/COD | Customer hard-code | P1 | CAO | REFACTOR (gói luật) |
| TD-16 | Gói & hạn mức đo theo Builder, không đo theo hội thoại / tin AI / đơn chốt | Thiếu đơn vị sản phẩm | P1 | THẤP | REFACTOR |
| TD-17 | Mặt phẳng điều khiển + nhận tiền thuê bao nằm trong CSDL kinh doanh của VNX | Schema coupling | P1 | CAO | EXTRACT (muộn) |
| TD-18 | Mọi ADMIN của tổ chức nhà là người vận hành nền tảng | Bảo mật / vai trò | P1 | VỪA | REFACTOR |
| TD-19 | Ngữ cảnh rỗng ⇒ rơi về tổ chức nhà (hỏng về phía RỘNG) | Bảo mật / cô lập | P1 | VỪA | REFACTOR |
| TD-20 | ~11 hàm chuẩn hoá SĐT; `customers.phone` không UNIQUE; tạo khách có cửa đua | Duplicate logic | P1 | VỪA | EXTRACT |
| TD-21 | Ba nguồn phí ship; không có dịch vụ báo phí vận chuyển | Duplicate logic | P2 | THẤP | EXTRACT |
| TD-22 | Ba nguồn tồn (sổ kho ERP một kho · `variant_stocks` · `inventory_histories`) | Duplicate source of truth | P2 | VỪA | KEEP sổ ERP, DEPRECATE số Pancake |
| TD-23 | Payment foundation P0.1 có bảng, không có đường ghi | Legacy | P2 | THẤP | DEPRECATE hoặc REWRITE |
| TD-24 | Bốn đường thông báo, hai bản client Lark/Telegram | Duplicate logic | P2 | VỪA | REFACTOR |
| TD-25 | Ba lớp bọc provider LLM; creative/video-scale gọi thẳng, không ghi sổ AI | Integration không qua abstraction | P2 | VỪA | REFACTOR |
| TD-26 | Ba bộ mẫu ngành (`ORG_TEMPLATES`, `BUSINESS_TYPE_SPEC`, `lib/blueprints`) | Duplicate | P2 | THẤP | DEPRECATE 2/3 |
| TD-27 | Truy vấn CSDL ngay trong `page.tsx` ở một số trang VNX | Business logic trong UI | P2 | THẤP | REFACTOR khi chạm |
| TD-28 | Nhiều "bảng hôm nay" cùng nói về việc cần làm | Duplicate UI | P2 | THẤP | KEEP cho nhà, ẩn với khách |
| TD-29 | Chống dò đăng nhập + đệm sổ tổ chức nằm trong bộ nhớ tiến trình | Scale | P2 | VỪA | REFACTOR khi có >1 instance |
| TD-30 | Một VPS 2 nhân, một tiến trình, bể kết nối mỗi tổ chức | Scale | P1 khi >15 khách | CAO | theo `docs/platform/scale-plan.md` |
| TD-31 | Lõi bot (`engine.ts`, `fanpage.ts`) chỉ có kiểm thử gián tiếp, không có bộ hội thoại mẫu để chạy lại | Thiếu kiểm thử | P0 cho mọi refactor bot | THẤP | REWRITE (mới) |
| TD-32 | "Tổ chức có đồng bộ đơn không" được trả lời hai cách: cấu hình (`orgHasSyncedSource`) và dữ liệu (`ORG_HAS_SYNCED_ORDERS`) | Duplicate source of truth | P1 | VỪA | REFACTOR |

---

## Chi tiết

### TD-01 · Giá do người gọi quyết · **P0**
- **Bằng chứng.** `lineZ.unitPrice: money("đơn giá")` (`lib/records/order-create.ts:117-121`): lõi chỉ kiểm
  đây là số nguyên không âm, không đối chiếu `product_variants.retail_price` hay bảng giá. Giá đúng chỉ được
  tính ở `priceLines()` của bot (`lib/sales-chatbot/tools.ts:302`) và `confirm_order` so lại
  (`tools.ts:571-576`). Form đơn tay tính giá ở **client** (`manual-order-form.tsx:89`).
- **Vì sao chặn sản phẩm.** Khi Commerce API mở cho AI (thêm công cụ, thêm kênh, thêm agent), mọi đường gọi
  `createOrderAsAgent` mới đều phải tự nhớ tính giá. Một công cụ quên là một đơn bán sai giá — đúng thứ
  khách hàng sẽ hỏi đầu tiên: "AI có tự giảm giá không?".
- **Hướng.** `PricingService.quote()` trong lõi; đường agent BẮT BUỘC đi qua nó, đơn giá truyền vào chỉ còn là
  giá *kỳ vọng* để phát hiện "giá vừa đổi". Đường người (form tay) giữ quyền gõ giá nhưng ghi lý do.
- **Rủi ro sửa.** VỪA: đổi hành vi của đường agent; có `tests/seafood-os.test.ts`, `self-service-journey.test.ts`
  làm lưới. Không đụng `ORDER_OUTCOME`.

### TD-02 · Tồn và hạn mức nợ ngoài transaction · **P0**
- **Bằng chứng.** `stockFor()` gọi ở `tools.ts:578-584`, rồi `updateOrderAsAgent()` mở transaction riêng
  (`order-create.ts:466`). `creditGate()` chạy ở `:380`, transaction ở `:385`. Sổ kho là **công thức suy ra**
  (`lib/queries/stock.ts:79,393`), không có bảng giữ hàng.
- **Hậu quả khi có nhiều hội thoại đồng thời.** Hai khách cùng chốt món cuối ⇒ cả hai đơn đều qua. Với một
  shop nhỏ ít đồng thời thì hiếm; với một tenant chạy quảng cáo, 10 hội thoại/phút là bình thường.
- **Hướng.** Kiểm tồn khả dụng + hạn mức nợ **bên trong** transaction ghi, khoá theo mẫu mã
  (`pg_advisory_xact_lock(hash(variant_id))`) — không cần bảng mới; luật sổ kho (AGENTS §3.10) giữ nguyên
  vì "đã chốt chưa xuất" đã trừ khả dụng. `stockKnown = false` vẫn đi qua với ghi chú, như hiện nay.

### TD-03 · Không có idempotency
- `createOrderAsAgent` không nhận khoá; chống trùng dựa vào `ChatState` và ghi chú đơn (`order-sync.ts`,
  phần đầu tệp). Webhook Pancake gửi lặp, bot thử lại khi lỗi mạng ⇒ cần khoá `(conversation_id, cycle)`
  hoặc `idempotency_key` UNIQUE trên đơn. Thêm cột mới, không đổi hành vi cũ.

### TD-04 · Không có sổ sự kiện hội thoại · **P0 cho đo lường**
- **Bằng chứng.** Bước bán (`stage`), `upsellSent`, `declined`, `confirmed`, `handoff` nằm trong
  `sales_chat_conversations.state` jsonb và **bị xoá khi sang lượt mua mới** (`engine.ts:552-555`).
  `domain_events` có 30 tên, không tên nào về hội thoại (`lib/constants/domain-events.ts`); `order.*` chỉ phát
  cho đơn `erp-` (`:217-229`).
- **Có sẵn.** `sales_chat_messages` (append-only, toàn văn gồm cả tool_use/tool_result), `sales_chat_inbound`
  (ba giọng KHÁCH / BOT_SENT / PAGE_REPLY), bộ đếm cộng dồn trên hội thoại, `platform_ai_usage` với
  `ref` = mã hội thoại.
- **Vì sao P0.** Không có mốc chuyển bước thì không trả lời được câu bán hàng nào của khách: "AI chốt bao
  nhiêu % hội thoại", "upsell mang thêm bao nhiêu tiền", "handoff mất bao lâu mới có người nhận". Đó là
  toàn bộ phần ROI của sản phẩm.
- **Hướng.** Bảng mới `sales_conversation_events` (append-only, trong CSDL tổ chức) + ghi kép ở đúng các
  điểm đang đổi `state`. Thuần THÊM, không đổi hành vi bot. Chi tiết: `TARGET_ARCHITECTURE.md` §5.

### TD-05 · Đơn bot nối về hội thoại bằng chuỗi
- `orders.source = "Chatbot fanpage" | "Chatbot web"` (`tools.ts:365`), "Fanpage (nhân viên chốt)"
  (`order-sync-shared.ts:36`), `raw.agent` (`order-create.ts:223`). Chiều ngược (hội thoại → đơn) có
  `sales_chat_conversations.order_id`, nhưng mỗi hội thoại chỉ giữ đơn của lượt mua hiện tại.
- **Hướng.** Cột `orders.sales_conversation_id` (nullable, không FK cứng vì hội thoại có thể bị dọn) + `orders.
  sales_actor` ∈ `AI | HUMAN_ASSISTED_BY_AI | HUMAN`. Thêm cột, không đổi dữ liệu cũ (AGENTS §35: không
  backfill đoán).

### TD-06 · Chi phí AI ở ≥ 4 sổ
- `platform_ai_usage` (CSDL nhà) · `ai_interactions` (copilot, creative, video-scale, cs semantic) ·
  `chatbot/src/aicost.js` (tệp JSON trong volume) · cột chi phí riêng của creative/video-scale. Chỉ copilot,
  ai-builder, sales-chatbot gọi `recordAiUsage`.
- Trong `platform_ai_usage`, follow-up và **ghi đơn từ hội thoại do NGƯỜI chốt** đều ghi
  `feature: "sales_chatbot"` (`followup.ts:160`, `order-sync.ts:414-417`) ⇒ "chi phí AI / đơn AI chốt"
  bị phồng bởi chi phí phục vụ đơn của người.
- **Hướng.** Tách `feature` (`sales_reply`, `sales_followup`, `sales_order_sync`, `sales_lessons`,
  `sales_playbook`); `ai_interactions` giữ nội dung, `platform_ai_usage` là sổ tiền duy nhất.

### TD-07 · Không có vế "người" ở mức người
- Pancake không gắn uid cho tin nhân viên (`fanpage.ts:310-313`); bot chỉ biết "có tin phía page mà không
  phải bot". `conversation_funnel.owner_name` của nhà là chữ, không phải `users.id`.
- **Đây là giới hạn nguồn, không phải lỗi mã.** Theo AGENTS §24/§37: chỉ số "AI vs từng nhân viên" phải
  khai `UNAVAILABLE` kèm lý do, không thay bằng truy vấn gần đúng. So sánh làm được ngay ở mức **nhóm**:
  hội thoại AI xử lý trọn vs hội thoại có người chạm (theo `PAGE_REPLY`). Mức người chỉ có khi nhân viên trả
  lời từ hộp thư ERP (xem `MIGRATION_PLAN.md` M7).

### TD-08 · Hai bot bán hàng · **rủi ro sửa CAO**
- `chatbot/` (9.761 dòng JS, container `erp-chatbot`, `docker-compose.prod.yml:88-118`): bot thời trang của
  tổ chức nhà, trạng thái ở `data/state.json`, provider riêng, client Pancake riêng, sổ chi phí riêng, ghi
  đơn **thẳng lên Pancake POS** (`chatbot/src/orders.js:778-781`, tự xác nhận `:907`). ERP chỉ thấy đơn sau
  lượt đồng bộ.
- `lib/sales-chatbot/*` (6.083 dòng TS): đa tổ chức, công cụ đóng, đơn qua lõi ERP.
- Chức năng trùng: provider AI, ba client Pancake, ba bộ bám khách (`salesagent.js`, `followup.ts`,
  `lib/outreach`), hai bộ gửi hàng loạt, nhận diện tin tự động Pancake (`fanpage.ts:61-67` học lại từ
  `bot.js`), trích đơn từ hội thoại.
- **Vì sao không gộp ngay.** Bot nhà đang trả lời ~10 page, 600–1.000 lượt/ngày
  (`docs/ban-giao/BAN-GIAO-BOT-CHAT-CHO-ERP.md`), chín nhóm chốt chặn rút từ sự cố thật, có vision (so ảnh
  khách gửi với ảnh POS) và voice mà bot đa tổ chức chưa có. Và `lib/sales-chatbot` **không chạy được** cho
  tổ chức nhà vì nhà đồng bộ đơn từ Pancake (`order-create.ts:87`). Gộp đòi `OrderSink` POS trước.

### TD-09 · Lời nhắc lõi mang ngành hải sản
- `engine.ts:137-157`: "vd 1kg hay 2kg", "«1kí», «1 ký», «1 cân»", "chả cá thu", "từ 10kg" cho khách sỉ.
  Cũng ở `returning.ts:287`, `catalog.ts:92` (stopword `kg kgs gram lang`), regex kg ở
  `quick-replies-shared.ts:123`, trọng lượng đọc từ tên ở `shipping.ts`.
- **Vì sao rủi ro CAO.** Đổi lời nhắc là đổi hành vi với khách thật của HSLC ngay lập tức, và không có bộ
  hội thoại mẫu để so trước/sau (TD-31). Mọi lần vá lời nhắc trong tuần 01–03/10 đều đến từ một hội thoại
  thật hỏng.
- **Hướng.** Tách ba tầng: luật chung của agent (mã nguồn) · **gói ngành** (`seafood`, `fashion`, `spa`…:
  từ vựng đơn vị, ví dụ, luật khách sỉ) · cấu hình tổ chức (`settings['ai.salesChatbot']`). HSLC nhận gói
  `seafood` làm mặc định ⇒ lời nhắc ra **giống hệt từng ký tự**, kiểm bằng ảnh chụp lời nhắc.

### TD-10 · Kênh = Pancake, không có lớp kênh
- Vào: `app/api/webhooks/pancake/fanpage/[token]/route.ts` → `receiveFanpageEvent` (`fanpage.ts:272-344`).
  Ra: `fetch` thẳng `pages.fm …/messages {action:"reply_inbox"}` (`fanpage.ts:398-412`); `playbook.ts`,
  `returning.ts` cũng tự `fetch`. Ảnh / nhãn dán / ghi âm của khách bị bỏ qua ("để nhân viên xem",
  `fanpage.ts:337-340`).
- Kênh thứ hai là `/chat` trên tên miền con (`public.ts`, `app/chat/page.tsx`). Zalo trong sổ connector chỉ
  là gửi tin nhóm nội bộ (`lib/connectors/registry.ts:513-527`), không phải kênh khách.
- **Hướng.** `ChannelAdapter` (nhận · chuẩn hoá · gửi · tải ảnh · trả lời riêng bình luận · nhận diện tiếng
  vọng). Bản đầu tiên là **rút nguyên** logic `fanpage.ts` vào adapter, không đổi hành vi.

### TD-11 · Một fanpage mỗi tổ chức
- Connector `pancake-fanpage` có đúng một ô `pageId` (`registry.ts:541`), `receiveFanpageEvent` so
  `settings.pageId` (`fanpage.ts:275`). Shop social commerce thường có 2–10 page (bot nhà đang chạy 10).

### TD-12 · `ai_sales` kéo cả ERP theo
- `dependsOn: ["customers", "products", "orders", "inventory"]` (`lib/constants/platform-modules.ts:486`).
  Bot đã chịu được tồn chưa biết (`stockKnown = false` ⇒ `null`, `catalog.ts:137`), nên `inventory` là phụ
  thuộc **mềm** về mặt mã. Bán gói "chỉ AI Sales" cần `inventory` thành tuỳ chọn.

### TD-13 · Định danh là id Pancake
- `orders.id` text = id Pancake (`db/schema.ts:1219`); `order_items.id = <orderId>-<n>`; `products.id`,
  `product_variants.id`, `warehouses.id` cũng vậy. Nguồn gốc suy ra từ `startsWith("erp-")`
  (`control-tower.ts:151`, `manual-order-sql.ts:11`, `order-payments.ts:36`, `orders.ts:137`) và CHECK
  `LIKE 'erp-%'` trên `order_delivery_notes`, `order_payments`.
- **Không đổi id.** Đổi sơ đồ id là đụng migration + CHECK + mọi `LIKE` + `ORDER_OUTCOME`. Hướng an toàn:
  THÊM `origin` (`PANCAKE_POS | ERP | AGENT | IMPORT`) + `external_ref`, đọc tiền tố dần thay bằng cột.

### TD-14 · Enum trạng thái đơn của Pancake
- `orderStageEnum` có `WAITING / PAID / PARTIAL_RETURN / DELETED`; đơn ERP mượn mã số Pancake
  (`MANUAL_ORDER_STATUS_CODE` trong `lib/constants/manual-orders.ts`). Chấp nhận được trong giai đoạn này —
  agent chỉ cần `NEW → CONFIRMED → (giao) → kết cục`. Ghi lại để không ai thêm trạng thái thứ ba song song.

### TD-15 · Kết cục đơn là luật VTP/COD
- `ORDER_OUTCOME` (`lib/queries/return-rate.ts:227`, 25 nhánh) và `RETURN_RULE` (`lib/constants/returns.ts`)
  là luật của VNX; đã có nhánh riêng cho đơn `erp-` không vận đơn (`return-rate.ts:235`) và phiếu giao ký
  nhận (`ORDER_OUTCOME.md` mục 11). **Contract test khoá** (`tests/contract-order-outcome.test.ts`).
- ROI của AI Sales phải tính trên doanh thu **giao thành công**, không trên đơn bot chốt. Với tenant không có
  VTP, nhánh `erp-` đang là định nghĩa duy nhất.
- **Hướng.** Không sửa công thức. Analytics của AI Sales **dùng lại** `ORDER_OUTCOME` (AGENTS §0.2) và in độ
  phủ: bao nhiêu đơn của AI đã có kết cục, bao nhiêu còn `UNKNOWN`.

### TD-16 · Gói đo theo Builder
- Hạn mức: `users, pages, objects, records, workflows, aiDraftsPerDay, storageMb` (`lib/entitlements/kinds.ts:10`)
  + `ai.*` (yêu cầu/ngày, trần USD, `platformCreditUsdPerMonth`). Gói không quyết định module.
- Thiếu đơn vị của sản phẩm AI Sales: hội thoại AI xử lý / tháng, số kênh (page), đơn AI chốt.

### TD-17 · Mặt phẳng điều khiển trong CSDL VNX
- `platform_*` sinh từ cùng `schema.ts`, tạo trong mọi CSDL rồi bị xoá ở CSDL tổ chức (`db/migrate.ts:64-81`).
  Đối soát tiền thuê bao quét `bank_transactions` **của CSDL nhà** để tìm mã `ERPHD…`
  (`lib/billing/service.ts:515-571`) ⇒ doanh thu nền tảng đi chung sổ, chung luật kế toán ngân hàng (AGENTS
  §17) với shop thời trang.
- **Rủi ro sửa CAO**, và chưa cần cho 2–5 tenant. Xếp cuối (`MIGRATION_PLAN.md` M8).

### TD-18 · ADMIN nhà = người vận hành nền tảng
- ADMIN nhận `ALL_PERMISSIONS` (`lib/auth/permissions.ts:379`); `platform:operate` chỉ bị chặn **ngoài** tổ
  chức nhà (`:446-451`). Mọi ADMIN của shop VNX thấy mọi khách và sửa được billing. Với khách trả tiền, đây là
  câu hỏi hợp đồng (ai của nhà cung cấp được xem hội thoại của tôi?).

### TD-19 · Ngữ cảnh rỗng rơi về nhà
- `currentOrganization()` không có ALS và không có claim ⇒ `homeContext("HOME_DEFAULT")`
  (`lib/platform/context.ts:90`). Một `after()`, timer, script quên `withOrganization` sẽ ghi vào CSDL VNX.
  Có máy quét tĩnh (`tests/platform-isolation-static.test.ts`) nhưng nguyên tắc vẫn là hỏng về phía rộng,
  ngược AGENTS §31 ("mọi nhánh lỗi phải rơi về phía HẸP HƠN").
- **Hướng.** Danh sách trắng tuyến được phép rơi về nhà (scheduler của nhà, webhook VNX); mọi nơi khác ném lỗi.
  Rủi ro VỪA: đổi hành vi ở tuyến chưa liệt kê ⇒ chạy chế độ chỉ-ghi-log trước một tuần.

### TD-20 · Chuẩn hoá SĐT ×11, khách không UNIQUE theo SĐT
- `customer-create.ts:172`, `returning.ts:56`, `constants/landing.ts:173`, `order-duplicate.ts:157`,
  `return-match.ts:146`, `phone-reputation.ts:80`, `fanpage-attribution.ts:181`, `integrations/http.ts:223`,
  `auth/identity-shared.ts:19`, `viettelpost/statement-db.ts:206`, `chatbot/src/orders.js:103`.
- `customers.phone` chỉ có index (`schema.ts:1069`); `createCustomerAsAgent` select-rồi-insert
  (`customer-create.ts:200-202`) ⇒ hai hội thoại cùng SĐT tạo hai khách.
- Với AI Sales, "khách cũ quay lại" là tính năng bán được (`returning.ts`) — nó chỉ đúng khi định danh đúng.

### TD-21 · Phí ship ba nguồn
- Landing 25K + miễn ship ≥ 2 SP gõ cứng (`constants/landing.ts:64-68`); bot `shippingFee` + `freeShipping`
  (`sales-chatbot/config.ts:117-122`); `orders.manualDeliveryFee` (HSLC 40K). Không có báo phí từ ĐVVC
  (VTP client không có API báo phí — `viettelpost/client.ts:223-280`).

### TD-22 · Ba nguồn tồn
- Sổ kho ERP (một kho, suy ra) là nguồn theo AGENTS §3.10; nhưng màn Sản phẩm vẫn lọc theo `variant_stocks`
  của Pancake (`lib/queries/products.ts:79`). Không có `warehouse_id` trên phiếu kho.

### TD-23 · Payment foundation P0.1 không có đường ghi
- `payment_transactions`, `payment_evidence`, `payment_reviews` có bảng + CHECK + trigger; chỉ
  `lib/queries/entity-timeline.ts:95` đọc. Thanh toán đơn ERP thật nằm ở `order_payments`. QR VietQR chỉ có
  cho **billing nền tảng** (`lib/billing/service.ts:842`), chưa có QR theo đơn — thứ AI Sales cần để "chốt
  đơn chuyển khoản".

### TD-24 · Bốn đường thông báo
- `notifications` trong app · `lib/alerts/notification-delivery.ts` (env của nhà) · `sendLark` trực tiếp không
  sổ (`morning-brief.ts:113`, `escalation-run.ts:69`, `owner-decision-digest.ts:174`, `creative/notify.ts:45`,
  `marketing/digest.ts:345`, `payroll/autopilot.ts:140`) · `lib/messaging` (theo tổ chức, đúng-một-lần,
  `messaging_deliveries`) với client Lark/Telegram **thứ hai** (`lib/messaging/providers.ts:76,107`).
- AI Sales dùng `lib/messaging` (đúng hướng). Phần còn lại là việc của nhà.

### TD-25 · Ba lớp bọc LLM
- `lib/ai/provider.ts` + `router.ts` (copilot, agent CTO) · `lib/ai-builder/providers.ts` (BYOK + `platform`,
  dùng bởi sales-chatbot) · `chatbot/src/ai.js` (Gemini/OpenAI REST). `lib/creative/vision.ts:30`,
  `lib/video-scale/tts.ts:15` gọi OpenAI trực tiếp.

### TD-26 · Ba bộ mẫu ngành
- `ORG_TEMPLATES` (`platform-modules.ts:529-532`, chỉ còn làm nhãn), `BUSINESS_TYPE_SPEC`
  (`lib/onboarding/shared.ts:83-93`), `lib/blueprints/templates` (9 mẫu). Gói ngành của AI Sales (TD-09) nên
  là một trường của blueprint, không phải bộ thứ tư.

### TD-27 · Truy vấn trong page
- `marketing/fanpages/page.tsx:55-80`, `my-payslip/page.tsx:48`, `marketing/video-scale/page.tsx:78,232`, bảy
  tab `marketing/creatives/*`, `work/settings/page.tsx`, `inventory/receipts/page.tsx`, `orders/[id]/page.tsx:75`.
  Đều là trang của nhà; trang AI Sales (`app/(dashboard)/ai/sales-chatbot/**`) sạch.

### TD-28 · Nhiều bảng "hôm nay"
- `/`, `/alerts`, `/work/today`, `/cockpit`, `/operations`, `/data-quality` cùng chiếu một số nguồn việc
  (`lib/constants/work-sources.ts:104-455`, `owner-decisions.ts:56-65`). Không ảnh hưởng sản phẩm nếu tenant
  AI Sales không bật các module này.

### TD-29, TD-30 · Giới hạn một tiến trình
- `lib/auth/login-throttle.ts:47` (Map trong bộ nhớ); sổ tổ chức đệm 10 s. Bể Postgres `max 2`/tổ chức
  (`db/index.ts:302`); `scale-plan.md`: gãy kết nối ở ~15–46 khách đồng thời, fan-out tuần tự gãy ở ~60–250
  khách. Đăng ký tự phục vụ chạy `CREATE DATABASE` đồng bộ, trần 50 tổ chức/ngày (`onboarding/rate.ts:17-24`).

### TD-31 · Không có bộ hội thoại mẫu · **P0 cho mọi refactor bot**
- `chatTurn` chỉ được gọi trong `tests/self-service-journey.test.ts` (13 chỗ) và `sales-order-sync.test.ts`;
  `fanpage.ts` (1.011 dòng heuristic tiếng vọng / nhân viên / tự động) không có tệp kiểm riêng.
- Mọi bước TD-08, TD-09, TD-10 đều đổi đường đi của một tin nhắn khách thật. Cần một bộ **hội thoại vàng**
  (lấy từ `sales_chat_messages` đã che SĐT/tên — cùng cách `playbook.ts` đang che) chạy với provider giả lập
  trả lời theo kịch bản, so **lời nhắc dựng ra** và **chuỗi công cụ được gọi** trước/sau.

### TD-32 · Chế độ tổ chức quyết bằng hai cách
- **Cấu hình:** `orgHasSyncedSource("orders")` (`lib/platform/capabilities.ts:130`) — module `connector_pancake`
  bật hay không. Dùng để CHẶN tạo đơn tay/agent (`order-create.ts:87`).
- **Dữ liệu:** `ORG_HAS_SYNCED_ORDERS` (`lib/queries/manual-order-sql.ts`) — CSDL có đơn nào không mang tiền tố
  `erp-` không. Dùng để quyết đơn `erp-` có vào báo cáo doanh thu (`IN_SALES_REPORTS`,
  `REVENUE_RECOGNIZED_ON_DELIVERY`) hay không.
- **Hậu quả với AI Sales:** một tenant nhập dù MỘT đơn từ nguồn ngoài (tệp, Pancake) với id không `erp-` sẽ làm
  **mọi đơn AI và đơn tay của nó rời khỏi báo cáo doanh thu** trong khi bot vẫn tạo đơn bình thường. Lộ ra khi
  chạy `testPilotOrders` tách khỏi bộ fixture (baseline 04/10/2026, `CURRENT_STATE.md` §7). Ghi nhớ dự án đã
  nêu rủi ro này ở PR #500.
- **Hướng.** Một câu trả lời: cột `orders.origin` (M2) + cấu hình tổ chức quyết; câu SQL đọc cấu hình đã phân
  giải (tham số) thay vì đoán từ dữ liệu. Rủi ro VỪA: chạm biểu thức nằm trong báo cáo của nhà — luật 3.9 phải
  giữ nguyên, `tests/pilot-orders.test.ts` là lưới.
