# Kiến trúc đích (TO-BE) — AI Sales Agent trên nền ERP

> Đọc sau `CURRENT_STATE.md` và `TECH_DEBT.md`. Tài liệu này **không** thay `AGENTS.md`: mọi luật ở đó đứng
> trên nó. Nó cũng **không** đổi mô hình đa tổ chức: SILO (mỗi tổ chức một CSDL) và `getDb()` giữ nguyên —
> lý do ở `docs/platform/target-architecture.md` §2 vẫn đúng và còn mạnh hơn cho một sản phẩm bán hội thoại của
> khách (cô lập dữ liệu hội thoại là điều khoản hợp đồng, không phải tính năng).

## 1. Một câu

**Kênh nào cũng đổ vào một Conversation Platform chung; AI Sales Engine nói chuyện với khách và chỉ hành động
qua công cụ; công cụ chỉ gọi Commerce Core qua dịch vụ có luật ở máy chủ; mọi bước có ý nghĩa bán hàng để lại
một sự kiện append-only — và từ sự kiện đó, cùng với kết cục giao hàng thật, mới có Analytics, Benchmark, ROI.**

## 2. Nguyên tắc (mỗi cái nối về một luật đã có)

| # | Nguyên tắc | Nối với |
|---|---|---|
| T1 | **SILO giữ nguyên.** Không thêm `org_id` vào bảng nghiệp vụ. Mọi bảng mới của AI Sales nằm trong CSDL tổ chức | `docs/platform/target-architecture.md` P1 |
| T2 | **AI không bao giờ chạm CSDL trực tiếp.** Mọi đọc/ghi của agent đi qua công cụ → dịch vụ Commerce; luật giá/tồn/hạn mức ở dịch vụ, không ở công cụ | TD-01, TD-02 |
| T3 | **Giá và tồn không nằm trong lời nhắc.** Agent chỉ biết giá qua công cụ, lúc gọi | Đã đúng hôm nay (`platform-modules.ts` mô tả `ai_sales`) |
| T4 | **Kết cục bán hàng = `ORDER_OUTCOME`.** "AI bán được" nghĩa là đơn giao thành công theo đúng công thức chung, không phải "bot chốt" | AGENTS §0.2, §3.1 |
| T5 | **Chưa biết là `null`.** Chi phí AI chưa định giá, đơn chưa có kết cục, nhân viên không xác định ⇒ in `—` và in độ phủ | AGENTS §0.3, §42 |
| T6 | **Không chấm người bằng thứ họ không quyết.** Benchmark AI vs người đi theo nhóm hội thoại cùng điều kiện; mức cá nhân chỉ khi có `users.id` thật | AGENTS §24, §34, §35, §44 |
| T7 | **Một nguồn cho một khoản tiền.** Chi phí AI chỉ ở `platform_ai_usage` | AGENTS §15 |
| T8 | **Thêm trước, đổi sau, gỡ cuối.** Mỗi bước là THÊM có công tắc hoặc REFACTOR có lưới kiểm; không big-bang | Yêu cầu giai đoạn này |
| T9 | **Ngành là dữ liệu, không là mã.** Từ vựng đơn vị, ví dụ, luật khách sỉ, bảng size… là gói ngành gắn vào blueprint | TD-09, TD-26 |

## 3. Sơ đồ đích

```mermaid
flowchart TB
  subgraph CH["① Channel Adapters — lib/channels/*"]
    ch1["pancake-fanpage<br/>(rút từ fanpage.ts)"]
    ch2["web-chat<br/>(public.ts, /chat)"]
    ch3["messenger-direct · zalo-oa · instagram · tiktok<br/>(sau — mỗi cái là một adapter)"]
  end
  subgraph CP["② Conversation Platform — lib/conversations/*"]
    cp1["Hộp thư hợp nhất: conversations · messages · inbound (dedupe)"]
    cp2["Quyền điều khiển: AI_ACTIVE ⇄ HANDOFF_PENDING ⇄ HUMAN_ACTIVE → CLOSED"]
    cp3["Nhiều kênh / nhiều page mỗi tổ chức"]
  end
  subgraph AE["③ AI Sales Engine — lib/sales-chatbot/engine.ts"]
    ae1["Lời nhắc 4 tầng: luật lõi · gói ngành · hồ sơ shop · sổ tay + bài học"]
    ae2["Vòng công cụ ≤ N · provider (platform | BYOK) · hạn mức · công tắc"]
    ae3["Bộ hội thoại vàng (eval) chặn mọi thay đổi"]
  end
  subgraph SW["④ Sales Workflow"]
    sw1["Bước bán: QUOTE → CONSULT → INFO → UPSELL → CONFIRM"]
    sw2["Phản đối · upsell/cross-sell · follow-up · mua lại · chính sách handoff"]
    sw3["Ghi đơn hộ nhân viên (order-sync)"]
  end
  subgraph CC["⑤ Commerce Core — lib/commerce/* (mặt tiền trên lib/records)"]
    cc1["CatalogService"] --- cc2["PricingService"] --- cc3["CustomerService"] --- cc4["OrderService + OrderSink"]
  end
  subgraph EN["⑥ Thực thể — bảng hiện có"]
    en1["orders · order_items · customers · products · product_variants · price_lists · stock_receipts"]
  end
  subgraph FU["⑦ Shipping / Payment / Finance"]
    fu1["ShippingQuote (luật cấu hình → CarrierAdapter)"]
    fu2["PaymentService: order_payments · QR theo đơn · khớp SePay"]
    fu3["ORDER_OUTCOME (kết cục) · cost-engine (nhà)"]
  end
  CH --> CP --> AE --> SW --> CC --> EN --> FU

  subgraph OB["Song song — Đo lường"]
    ob1["Event Tracking<br/>sales_conversation_events (append-only)"]
    ob2["Sales Analytics<br/>METRIC_CATALOG + scorecard"]
    ob3["Human vs AI Benchmark<br/>theo nhóm hội thoại"]
    ob4["ROI Dashboard<br/>platform_ai_usage × doanh thu giao thành công"]
    ob1 --> ob2 --> ob3 --> ob4
  end
  CP -. ghi sự kiện .-> ob1
  AE -. ghi sự kiện .-> ob1
  SW -. ghi sự kiện .-> ob1
  CC -. order.* .-> ob1
  FU -. kết cục .-> ob4
```

## 4. Từng tầng: hợp đồng, nguồn tái dùng, việc phải làm

### ① Channel Adapters — `lib/channels/`

```ts
// Phác thảo hợp đồng — không phải mã đã có.
type InboundVoice = "CUSTOMER" | "BOT_ECHO" | "PAGE_HUMAN" | "PAGE_AUTOMATION";
interface InboundMessage {
  externalMessageId: string;     // khoá dedupe (UNIQUE) — như sales_chat_inbound.message_id hôm nay
  threadId: string;              // hội thoại phía kênh
  accountId: string;             // page / OA / tài khoản kênh — cho phép NHIỀU mỗi tổ chức
  customerExternalId: string | null;
  voice: InboundVoice;           // phân loại tiếng vọng / nhân viên / tự động — rút từ fanpage.ts:280-330
  kind: "TEXT" | "IMAGE" | "AUDIO" | "STICKER" | "COMMENT";
  text: string | null;
  mediaUrls: string[];
  at: Date;                      // mốc của KÊNH, không phải lúc ERP nhận
  staffUserId: string | null;    // chỉ khi kênh cho biết THẬT (Pancake: luôn null)
}
interface ChannelAdapter {
  key: "pancake-fanpage" | "web-chat" | string;
  capabilities: { media: boolean; privateReply: boolean; staffIdentity: boolean; window24h: boolean };
  resolveOrg(req: Request): Promise<{ orgCode: string; accountId: string } | null>; // URL_SECRET như hôm nay
  normalize(payload: unknown): InboundMessage[];
  send(to: { accountId: string; threadId: string }, msg: { text?: string; imageIds?: string[] }): Promise<{ externalMessageId: string | null }>;
}
```

- **Tái dùng:** `fanpage.ts` (nhận, gom, tiếng vọng, trả lời bình luận bằng tin riêng, tải ảnh), `public.ts`,
  `lib/platform/webhooks.ts` (URL_SECRET), `org_connections` (bí mật), `app/api/webhooks/pancake/fanpage/[token]`.
- **Việc:** rút nguyên logic `fanpage.ts` vào adapter **không đổi hành vi** (kiểm bằng hội thoại vàng); cho phép
  nhiều `accountId` mỗi tổ chức (TD-11); chuyển ảnh/voice từ "bỏ qua" sang "chuyển tiếp cho engine nếu engine
  khai năng lực" (vision/voice rút từ bot nhà).
- **Thứ tự kênh mới** là quyết định kinh doanh (AGENTS §7 — dịch vụ ngoài mới phải hỏi): Messenger trực tiếp
  (bỏ phụ thuộc Pancake) · Zalo OA · Instagram · TikTok. Mỗi kênh chỉ là thêm một adapter.

### ② Conversation Platform — `lib/conversations/`

- **Tái dùng nguyên bảng**: `sales_chat_conversations`, `sales_chat_messages`, `sales_chat_inbound`. Không đổi
  tên bảng (đổi tên = migration phá + rủi ro production, không mang lại gì).
- **Thêm** (thuần THÊM, nullable):
  - `sales_chat_conversations.channel_account_id` — page/OA nào.
  - `sales_chat_conversations.control` ∈ `AI_ACTIVE | HANDOFF_PENDING | HUMAN_ACTIVE | AI_PAUSED | CLOSED`
    (hôm nay `status` + `handoffReason` + nhường 30 phút gánh việc này một cách ngầm).
  - `sales_chat_conversations.assignee_user_id` — `users.id` (AGENTS §34), chỉ ghi khi người nhận trong ERP.
- **Hộp thư cho người** (sau): nhân viên trả lời từ ERP thay vì từ Pancake ⇒ có `users.id` cho từng câu trả lời
  của người ⇒ mới đo được thời gian phản hồi và kết quả theo NGƯỜI. Đây là điều kiện duy nhất mở khoá
  benchmark mức cá nhân (TD-07).
- **Hàng đợi `/work`**: thêm nguồn việc `SALES_HANDOFF` dạng **phép chiếu** (AGENTS §19) — đóng việc = trả hội
  thoại cho AI hoặc đóng hội thoại qua action của chính miền hội thoại, không có nút "đánh dấu xong".

### ③ AI Sales Engine — giữ `lib/sales-chatbot/engine.ts`

- **Lời nhắc 4 tầng:**

  | Tầng | Ở đâu | Ai sửa |
  |---|---|---|
  | Luật lõi (không bịa giá, chỉ chốt khi khách đồng ý nguyên văn, khi nào handoff, lọc suy luận nội bộ) | mã nguồn | kỹ thuật, qua PR + hội thoại vàng |
  | Gói ngành (`seafood`, `fashion`, `spa`, `generic`): từ vựng đơn vị, ví dụ, luật khách sỉ, stopword tìm kiếm | dữ liệu đi kèm blueprint | kỹ thuật/sản phẩm, có phiên bản |
  | Hồ sơ shop + chính sách | `settings['ai.salesChatbot']` | chủ shop |
  | Sổ tay + bài học | `settings[...playbook/lessons]` | chủ shop / máy học, chủ shop duyệt |

  Bước tách đầu tiên phải cho ra **lời nhắc giống hệt từng ký tự** với HSLC (gói `seafood` = nội dung hôm nay).
- **Bộ hội thoại vàng** (`tests/sales-agent-golden/*`): hội thoại thật đã che SĐT/tên (dùng cùng bộ che của
  `playbook.ts`), provider giả trả lời theo kịch bản, so (a) lời nhắc dựng ra, (b) chuỗi công cụ được gọi, (c)
  trạng thái cuối. Là điều kiện vào cho mọi bước đụng engine/kênh (TD-31).
- **Giữ**: vòng công cụ, tự lùi model khi model lỗi, trả lời mẫu 0 token, hạn mức + công tắc, lọc
  `customerFacingText`.

### ④ Sales Workflow

- **Tái dùng**: `stages.ts`, `followup*.ts`, `order-sync*.ts`, `lessons*.ts`, `playbook*.ts`, `returning.ts`,
  `lib/reorder/*` (nhắc mua lại theo nhịp mua thật), `quick-replies*`.
- **Thêm**: phân loại **phản đối** (giá cao · ship đắt · chưa tin · để suy nghĩ · hỏi người nhà…) — ghi thành sự
  kiện `objection.raised` với nhãn, KHÔNG thêm công cụ mới cho tới khi có số đo cho thấy cần; **upsell có cấu
  trúc** — dòng hàng mang cờ `upsell = true` khi được thêm sau lời mời, để đo doanh thu upsell thật thay vì chỉ
  cờ "đã mời".
- **Chính sách handoff** là cấu hình (đã có lý do theo nhóm: khách sỉ · ngoài chính sách · khiếu nại · không xác
  định sản phẩm · giá/tồn bất thường · không hiểu ý) — chuẩn hoá thành mã lý do để đếm.

### ⑤ Commerce Core — `lib/commerce/` mặt tiền trên `lib/records/*`

```ts
// Phác thảo. Mọi hàm chạy trong ngữ cảnh tổ chức (getDb()), nhận Actor (AGENTS §34).
CatalogService.search(query, { limit }): CatalogHit[]               // từ sales-chatbot/catalog.ts
CatalogService.availability(variantIds): Map<id, { available: number | null; known: boolean }>
PricingService.quote({ customerId, lines, address }): Quote         // quoteUnitPrice + priceBooksFor + ship
CustomerService.findOrCreate({ phone, name, channelIdentity }, actor) // một hàm chuẩn hoá SĐT
OrderService.draft(input, actor, { idempotencyKey })                // giá tính Ở ĐÂY, không nhận từ người gọi
OrderService.confirm(orderId, { expectedTotal }, actor)              // tồn + hạn mức nợ TRONG transaction
OrderService.cancel(orderId, reason, actor)
interface OrderSink { create; update; confirm; cancel }              // ErpOrderSink (hôm nay) | PancakePosSink (cho nhà, M9)
```

- **Không viết lại lõi đơn.** `lib/records/order-create.ts` đã có zod → kiểm khách/mẫu mã → hạn mức nợ → một
  transaction (đơn + dòng + lịch sử + `order.*`) → audit → workflow. Mặt tiền chỉ kéo **giá** và **tồn** xuống
  dưới công cụ, và thêm khoá idempotency.
- **Tồn trong transaction:** khoá tư vấn theo mẫu mã (`pg_advisory_xact_lock`) rồi đọc `availableStockExpr`
  (`lib/queries/stock.ts:393`) trong cùng transaction ghi. Không bảng giữ hàng mới; công thức sổ kho (AGENTS
  §3.10) không đổi.
- **Thêm cột** `orders.origin` (`PANCAKE_POS | ERP_FORM | AI_AGENT | AI_ORDER_SYNC | IMPORT`) và
  `orders.sales_conversation_id`. Ghi từ nay về sau; dòng cũ để `NULL` (không đoán — AGENTS §35). Tiền tố `erp-`
  và CHECK hiện có giữ nguyên.

### ⑥ Thực thể — giữ bảng hiện có

`orders`, `order_items`, `customers`, `products`, `product_variants`, `price_lists*`, `customer_trade_terms`,
`stock_receipts*`, `customer_touchpoints`, `appointments`. Không đổi khoá, không đổi enum trạng thái đơn
(TD-13, TD-14). `ai_sales.dependsOn` bỏ `inventory` (tồn chưa biết đã là trạng thái hợp lệ).

### ⑦ Shipping / Payment / Finance

- **Phí ship**: `ShippingQuote` thay ba nguồn (TD-21) — hôm nay là luật cấu hình (phí cố định + miễn ship theo
  ngưỡng/khu vực, từ `sales-chatbot/shipping.ts`); khi có tenant cần báo phí thật thì thêm `CarrierAdapter`.
- **Thanh toán**: `order_payments` là sổ thanh toán đơn. Thêm **QR VietQR theo đơn** (mã đơn trong nội dung CK)
  để agent gửi khi khách chọn chuyển khoản; khớp tiền qua sao kê/SePay của **chính tổ chức** đó (connector
  PER_ORG mới — hỏi chủ shop vì là dịch vụ ngoài cho khách). Luật sổ ngân hàng AGENTS §17 áp nguyên vẹn: sao kê
  không tạo doanh thu, chỉ đối chiếu.
- **Kết cục**: `ORDER_OUTCOME` không đổi. Payment foundation P0.1 (`payment_*`, không có đường ghi) không dùng —
  quyết định gỡ hay hồi sinh là việc riêng (TD-23).
- **Tài chính của nhà** (cost-engine, phân bổ, lương) không thuộc sản phẩm AI Sales; ẩn bằng module.

## 5. Đo lường song song

### 5.1 Event Tracking — `sales_conversation_events`

Bảng mới trong **CSDL tổ chức**, append-only (không UPDATE/DELETE trong mã; quét tĩnh như `product-notes`).

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | bigserial | |
| `conversation_id` | uuid | → `sales_chat_conversations` |
| `cycle` | int | lượt mua trong hội thoại (hôm nay bị xoá khỏi `state` khi sang lượt mới) |
| `type` | text + CHECK danh sách đóng | xem dưới |
| `actor_kind` | `CUSTOMER \| AI \| HUMAN \| SYSTEM` | |
| `actor_user_id` | uuid null | `users.id` — chỉ khi biết thật (AGENTS §34–35) |
| `channel`, `channel_account_id` | text | |
| `occurred_at` | timestamptz | mốc của KÊNH khi có, không phải lúc ghi |
| `order_id` | text null | |
| `amount_vnd` | bigint null | số nguyên VND; `null` = không áp dụng / chưa biết |
| `reason_code` | text null | mã lý do handoff / phản đối / từ chối |
| `payload` | jsonb | chi tiết, không bao giờ là đầu vào phép tính tiền |
| `dedupe_key` | text UNIQUE | chạy lại không đẻ dòng thứ hai |
| `schema_version` | int | đổi định nghĩa = phiên bản mới (AGENTS §40) |

**Danh sách loại đóng (v1):** `conversation.opened` · `message.received` · `ai.replied` · `quick_reply.sent` ·
`stage.changed` · `quote.given` · `objection.raised` · `upsell.offered` · `upsell.accepted` · `upsell.declined` ·
`customer.identified` (SĐT/địa chỉ thu được) · `order.drafted` · `order.confirmed` · `handoff.requested` ·
`handoff.accepted` · `ai.resumed` · `followup.sent` · `conversation.declined` · `conversation.closed`.

**Vì sao bảng riêng, không nhồi vào `domain_events`:** `domain_events` là cò súng của workflow (con trỏ
`workflow_cursors` quét nó); tin nhắn là luồng khối lượng lớn. Chỉ các **mốc nghiệp vụ** cần kích luật
(`sales.handoff_requested`, đơn đã có `order.*`) mới được phản chiếu sang `domain_events`.

**Ghi ở đâu:** đúng những điểm đang đổi `state`/bộ đếm hôm nay (`engine.ts` lúc chuyển bước, `tools.ts` lúc báo
giá/tạo/chốt đơn/handoff, `followup.ts`, `fanpage.ts` lúc nhận `PAGE_REPLY`). Ghi kép, không đọc lại để quyết
định ⇒ không đổi hành vi bot.

### 5.2 Sales Analytics

Thêm chỉ số vào **`METRIC_CATALOG`** (AGENTS §37 — mười hai trường, khoá không đổi được) thay vì viết báo cáo
riêng. Ví dụ khoá (đề xuất, chưa có):

| Khoá | Định nghĩa | Grain | Nguồn | Tin cậy |
|---|---|---|---|---|
| `ai_sales.conversations` | số hội thoại có `message.received` từ khách trong kỳ | hội thoại | events | MEASURED |
| `ai_sales.ai_resolution_rate` | hội thoại đi tới `order.confirmed` mà **không** có `handoff.requested` ÷ hội thoại | hội thoại | events | MEASURED |
| `ai_sales.handoff_rate` | có `handoff.requested` ÷ hội thoại, tách theo `reason_code` | hội thoại | events | MEASURED |
| `ai_sales.lead_capture_rate` | có `customer.identified` ÷ hội thoại | hội thoại | events | MEASURED |
| `ai_sales.first_response_seconds` | trung vị `ai.replied` − `message.received` đầu | hội thoại | events | MEASURED, mẫu tối thiểu |
| `ai_sales.upsell_attach_rate` | `upsell.accepted` ÷ `upsell.offered` | hội thoại | events | MEASURED |
| `ai_sales.upsell_revenue` | Σ dòng hàng cờ `upsell` của đơn **giao thành công** | đơn | orders + ORDER_OUTCOME | MEASURED khi kết cục đủ, kèm độ phủ |
| `ai_sales.delivered_revenue` | Σ doanh thu đơn `origin = AI_AGENT` có kết cục giao thành công | đơn | ORDER_OUTCOME | MEASURED + độ phủ kết cục |
| `ai_sales.ai_cost_per_delivered_order` | Σ chi phí `platform_ai_usage` (feature bán hàng) ÷ số đơn AI giao thành công | đơn | ai_usage + ORDER_OUTCOME | MEASURED; chi phí `null` ⇒ cận dưới, nói rõ |

Ngưỡng tô màu không hard-code — đích ở `metric_targets` (AGENTS §38). `canConclude = false` ⇒ in số, không tô
màu, không xếp hạng (AGENTS §44).

### 5.3 Human vs AI Benchmark

| Nhóm | Định nghĩa từ sự kiện | Đo được hôm nay? |
|---|---|---|
| `AI_ONLY` | không có `handoff.requested` và không có tin `PAGE_HUMAN` trước kết cục | Có (inbound có giọng PAGE_REPLY) |
| `AI_THEN_HUMAN` | có `handoff.requested` | Có |
| `HUMAN_ONLY` | bot tắt / ngoài giờ / hội thoại do `order-sync` ghi đơn | Có ở mức nhóm |
| Theo **từng nhân viên** | cần `actor_user_id` của câu trả lời người | **UNAVAILABLE** — Pancake không gửi uid; mở khi người trả lời từ hộp thư ERP |

Cùng chỉ số cho mọi nhóm: tỷ lệ ra đơn · tỷ lệ giao thành công (ORDER_OUTCOME) · giá trị đơn · thời gian phản
hồi đầu · thời gian tới đơn · upsell. Màn hình phải in **thiên lệch chọn mẫu**: hội thoại khó bị chuyển cho
người, nên `AI_THEN_HUMAN` kém hơn `AI_ONLY` không có nghĩa người làm kém (AGENTS §39: phân biệt LÀM KÉM với
KHÁC ĐIỀU KIỆN). Không xếp hạng nhân viên, không gắn nhãn.

### 5.4 ROI Dashboard

```
ROI kỳ = (doanh thu GIAO THÀNH CÔNG của đơn AI_ONLY)           ← đo được
        + [phần trợ giúp: doanh thu AI_THEN_HUMAN — in RIÊNG, không cộng gộp]
        − (chi phí AI kỳ: platform_ai_usage, feature bán hàng)  ← đo được; null = cận dưới
        − (phí thuê bao nền tảng)                               ← đo được
  Đối chiếu: công nhân viên tiết kiệm = số hội thoại AI_ONLY × chi phí/hội thoại của người
             ← chủ shop KHAI (MANUAL, nhãn ESTIMATED) — ERP không có chi phí người theo kênh chat
```

Hai con số không bao giờ gộp thành một ô (doanh thu AI tự làm vs AI có người giúp), và "tiết kiệm nhân sự" luôn
mang nhãn ước tính kèm người khai + lý do.

## 6. Tái sử dụng — cái gì đã có, dùng ngay được

| Cần cho sản phẩm | Đã có | Mức sẵn sàng |
|---|---|---|
| Cô lập dữ liệu từng khách | SILO + `getDb()` + máy quét cô lập 243 mặt | Sẵn |
| Đăng ký tự phục vụ, tên miền con, mời người, đặt lại mật khẩu, OAuth | `lib/onboarding`, `lib/platform/host*`, `lib/users`, `lib/auth` | Sẵn |
| Bí mật kết nối theo khách | `org_connections` AES-GCM | Sẵn |
| Agent bán hàng có công cụ | `lib/sales-chatbot` (16 công cụ, 5 bước, follow-up, tự học, khách cũ) | Chạy thật với HSLC |
| Tạo đơn qua lõi chung | `lib/records/order-create.ts` | Sẵn — thiếu giá/tồn ở lõi |
| Bảng giá sỉ + công nợ | `lib/constants/price-lists.ts`, `lib/records/trade.ts` | Sẵn |
| Đặt lịch (spa/dịch vụ) | `lib/records/appointments.ts` + 2 công cụ | Sẵn |
| Báo nhân viên | `lib/messaging` (Lark/Telegram/Zalo nhóm, đúng-một-lần) | Sẵn |
| Sổ AI + hạn mức + công tắc khẩn | `lib/ai-usage` | Sẵn — tách feature |
| Billing + VietQR thuê bao | `lib/billing` | Sẵn — đối soát còn đọc sổ VNX |
| Sổ chỉ số + đích + thẻ điểm + mức tin cậy | `metric-catalog`, `metric_targets`, `scorecard.ts` | Sẵn — chưa có chỉ số AI Sales |
| Kết cục đơn thật | `ORDER_OUTCOME` | Sẵn (contract test) |
| Hàng đợi việc dạng phép chiếu | `lib/work` | Sẵn — thêm nguồn `SALES_HANDOFF` |
| Vision / voice / persona theo quảng cáo | `chatbot/src/*` | Có ở bot nhà — phải rút ra |
| Chi tiêu quảng cáo theo tổ chức | `meta-ads-org` + job `ads-spend-org` | Có — chưa nối quảng cáo → hội thoại |

## 7. Bảng quyết định tổng (chi tiết từng dòng ở `DOMAIN_MAP.md`)

| Quyết định | Thành phần |
|---|---|
| **KEEP** | SILO/`getDb`/context/credentials/connectors · RBAC · onboarding/host/users/auth · `engine.ts` (vòng công cụ, provider, hạn mức) · `stages`, `followup`, `order-sync`, `lessons`, `playbook`, `returning`, `quick-replies`, `alerts`, `cost-report` · `lib/records/*` · `price-lists`, `trade`, `appointments`, `reorder` · công thức sổ kho · `ORDER_OUTCOME` · `lib/messaging` · `lib/ai-usage` · sổ chỉ số/đích/scorecard · `lib/work` · `domain_events` · module VNX (ẩn với khách AI Sales) |
| **REFACTOR** | lời nhắc engine → 4 tầng · `ai_sales.dependsOn` · `context.ts` mặc định hẹp · `platform:operate` tách khỏi ADMIN nhà · `entitlements` thêm đơn vị AI Sales · `billing` khớp tiền ngoài sổ VNX · `platform_ai_usage.feature` chi tiết hơn · `customers` định danh SĐT · `lib/outreach` vào chiến dịch của agent · `lib/alerts/rules.ts` theo module |
| **EXTRACT** | `lib/channels` (từ `fanpage.ts`, `public.ts`) · `lib/commerce` (từ `tools.ts`, `catalog.ts`, `shipping.ts`, `lib/records`) · `OrderSink` · chuẩn hoá SĐT một hàm · vision/voice/persona từ `chatbot/` · (rất muộn) mặt phẳng điều khiển ra CSDL riêng, `tech_*` ra khỏi CSDL shop |
| **DEPRECATE** | `chatbot/` (sau M9) và cầu nối `/api/chatbot`, `/chatbot` · `chatbot/src/aicost.js` · `variant_stocks` trong mọi con số · `ORG_TEMPLATES`, `BUSINESS_TYPE_SPEC` · client Lark/Telegram cũ trong `lib/alerts` · payment foundation P0.1 (nếu không hồi sinh) |
| **REWRITE (mới hẳn)** | `sales_conversation_events` + bộ ghi · bộ hội thoại vàng · màn Sales Analytics / Benchmark / ROI (trên scorecard có sẵn) |

## 8. Thứ KHÔNG làm

- Không chuyển sang mô hình `org_id` / pool. Không đổi tên bảng `sales_chat_*`.
- Không đổi id đơn, enum trạng thái đơn, `ORDER_OUTCOME`, `RETURN_RULE`, công thức sổ kho.
- Không đưa thêm luật ngành vào `engine.ts`; mọi ví dụ mới vào gói ngành.
- Không viết báo cáo AI Sales tự tính KPI ngoài `METRIC_CATALOG` + `ORDER_OUTCOME`.
- Không backfill sự kiện cho hội thoại cũ bằng suy đoán từ `state` (AGENTS §8.8, §35); lịch sử trước ngày bật
  sổ sự kiện in "chưa đo", không in 0.
- Không gỡ bot nhà khi bot đa tổ chức chưa có vision/voice và `PancakePosSink`.
