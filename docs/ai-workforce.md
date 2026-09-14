# Nền tảng nhân sự AI + Nhân viên bán hàng AI (V0/V1)

> Trạng thái: **chạy ngầm (SHADOW)**. Không một câu do AI soạn được gửi tới khách.
> Nhánh: `claude/ai-workforce-sales-v1` · chưa triển khai lên production.

## 1. Ranh giới không được xoá

ERP là **nguồn sự thật**. Nhân sự AI là **người làm việc** đọc ERP qua cổng công cụ, và không có
đường nào để nó trở thành nguồn của:

sản phẩm · mẫu mã · giá · khuyến mãi · tồn kho · cước · trạng thái đơn · trạng thái tiền/kế toán ·
kết quả giao vận.

Nền tảng AI sở hữu đúng phần của nó: nhân sự, bản nhân sự, việc, lượt chạy, trạng thái AI, định
tuyến mô hình, lời gọi công cụ, quyền, phiếu duyệt, nhật ký, chi phí token.

**Văn bản mô hình sinh ra KHÔNG BAO GIỜ là một quyết định nghiệp vụ.** Quyết định nằm ở hàm thuần
`decide()`; mô hình chỉ diễn đạt lại quyết định ấy thành câu chữ, và câu chữ đó còn bị soi lại lần
nữa trước khi ra khỏi hệ thống (xem §6).

## 2. Kiến trúc

```
Pancake (chat) ──webhook /api/webhooks/pancake-chat/<bí mật>──┐
               └─job ai-sales-ingest (Pages API, nạp bù)──────┤
                                                              ▼
                                                     sales_conversations
                                                      sales_messages
                                                              │ CUSTOMER_MESSAGE_RECEIVED
                                                              ▼
                                    ai_events ──▶ ai_tasks ──▶ DÂY CHUYỀN BÁN HÀNG
                                                                 │
   ┌─────────────────────────────────────────────────────────────┤
   │ 1. HIỂU      luật trước → mô hình sau, đầu ra qua zod        │
   │ 2. TRẠNG THÁI máy chủ KIỂM lại mọi thứ qua công cụ ERP       │
   │ 3. QUYẾT ĐỊNH hàm thuần — chỗ DUY NHẤT sinh ra hành động     │
   │ 4. DIỄN ĐẠT   mẫu câu; mô hình chỉ đổi CÁCH NÓI              │
   └─────────────────────────────────────────────────────────────┘
                                                                 ▼
                          ai_runs · ai_tool_calls · ai_model_calls · sales_suggestions
                                                                 ▼
                                                    Màn hình /ai (quan sát)
```

Tệp nền tảng (dùng chung cho MỌI nhân sự AI sau này, không có dòng nào nhắc tới bán hàng):

| Tệp | Việc |
|---|---|
| `lib/constants/ai.ts` | Nấc quyền hạn, trạng thái, nấc định tuyến, cờ tính năng |
| `lib/constants/ai-events.ts` | Hợp đồng sự kiện nội bộ |
| `lib/constants/ai-tools.ts` | Sổ đăng ký công cụ + danh sách việc BỊ CẤM |
| `lib/ai/config.ts` | Ba tầng cấu hình, mọi nhánh lỗi rơi về phía hẹp hơn |
| `lib/ai/registry.ts` | Sổ nhân sự + bản nhân sự |
| `lib/ai/events.ts` | Ghi sự kiện (chống trùng) → tạo việc → giành việc |
| `lib/ai/runs.ts` | Sổ lượt chạy, token, chi phí, che bí mật |
| `lib/ai/model-router.ts` | Leo nấc RULE → ECONOMY → STRONG → HUMAN |
| `lib/ai/providers/*` | Trừu tượng nhà cung cấp (`stub`, `anthropic`) |
| `lib/ai/tools/gateway.ts` | Cổng quyền — sáu chốt cho mỗi lời gọi |
| `lib/ai/tools/erp.ts` | 16 công cụ, mỗi công cụ bọc quanh logic ERP đang chạy |

Tệp miền bán hàng: `lib/constants/sales-agent.ts` + `lib/ai/agents/sales/*`.

## 3. Nấc quyền hạn

`OFF` → `SHADOW` → `COPILOT` → `AUTO`. Trần hiện hành là **SHADOW**
(`lib/constants/ai.ts::MAX_ALLOWED_MODE`): khai cao hơn ở env hay ở `settings` cũng bị kẹp xuống,
và điều đó được kiểm thử khoá lại.

- Nhân sự mới sinh ra ở nấc `SHADOW`, `ensureAgents()` **không bao giờ** tự nâng/hạ nấc của dòng đã có.
- Tắt tổng (`ai.config.enabled = false`) → mọi nhân sự thành `OFF`, tin nhắn vẫn được GHI nhưng
  không sinh việc nào.

## 4. Máy trạng thái bán hàng

16 giai đoạn: `NEW_LEAD` `PRODUCT_IDENTIFIED` `QUALIFIED` `VARIANT_SELECTION` `SIZE_SELECTION`
`PURCHASE_INTENT` `CONTACT_COLLECTION` `ADDRESS_COLLECTION` `ORDER_REVIEW` `AWAITING_CONFIRMATION`
`CONFIRMED` `ORDER_CREATED` `OBJECTION` `FOLLOW_UP` `HUMAN_TAKEOVER` `LOST`.

`nextStage(current, facts)` là **hàm thuần** — không đọc CSDL, không gọi mô hình, không đọc đồng hồ.
Bảng cạnh được **dựng từ ba luật** chứ không chép tay, nên luật nặng nhất đúng theo kiến trúc:

1. Giai đoạn đang làm việc đi được tới mọi giai đoạn đang làm việc khác (tin đầu của khách thường
   mang sẵn cả mẫu mã, SĐT lẫn địa chỉ). Điều kiện thật nằm ở **dữ kiện**, không nằm ở hình bảng.
2. Từ đâu cũng rẽ được sang: băn khoăn · hẹn lại · chuyển người · không mua · đã lên đơn.
3. **`CONFIRMED` chỉ tới được từ `AWAITING_CONFIRMATION`.** Không ngoại lệ.

`HUMAN_TAKEOVER` không có lối đi tự động nào ra — chỉ một hành động của NGƯỜI mới trả hội thoại về máy.

Kiểm thử quét 9.376 tổ hợp (giai đoạn × dữ kiện) và bắt lỗi nếu có cạnh nào không khai báo.

## 5. Xác nhận có ngữ cảnh — chữ "ok" không tạo đơn

`checkContextualConfirmation()` đòi **đủ sáu** điều, thiếu một là không xác nhận:

1. Có bản chốt đơn ĐÃ GỬI (`state.pending`).
2. Tin của khách đến **sau** lúc gửi bản chốt.
3. Bản chốt còn hạn (24 giờ).
4. Bản chốt còn **nguyên**: dấu vân tay `mẫu mã | số lượng | SĐT | địa chỉ | tỉnh | tổng tiền` chưa đổi.
5. Câu trả lời là đồng ý thật — không phải câu hỏi chứa chữ "ok", không phải phủ định.
   (Tiểu từ cuối câu đọc trên chữ CÓ DẤU: "vâng ạ" là đồng ý, "ok à?" là hỏi.)
6. Đơn đủ điều kiện máy chủ: mẫu mã hợp lệ · số lượng · SĐT dùng được · địa chỉ ĐVVC định tuyến
   được (`addressIssue()`) · **giá do máy chủ tính**.

Khách đổi size ở giữa ⇒ vân tay đổi ⇒ bản chốt cũ vô hiệu ⇒ chữ "ok" sau đó **không** dính vào đơn mới.

## 6. Chặn số tiền mô hình bịa

`guardGeneratedText()` soi câu mô hình viết trước khi nó đi đâu: mọi số tiền trong câu phải nằm
trong tập đóng các con số máy chủ đã tính cho lượt đó. Lệch một đồng ⇒ **vứt bản mô hình**, dùng
mẫu câu, và ghi lý do vào `ai_errors`. Không sửa chữa, không làm tròn cho gần đúng.

Cũng chặn: câu hứa mốc giao hàng mà ERP không kiểm được.

## 7. Cổng công cụ

16 công cụ. Mỗi lời gọi qua **sáu chốt**: có trong sổ · bản nhân sự được cấp · đủ nấc quyền hạn ·
tham số đúng lược đồ · trần thời gian · **ghi sổ kể cả khi bị từ chối**.

| Công cụ | Loại | Nấc tối thiểu |
|---|---|---|
| `product.search` `product.get` `product.get_variants` | ĐỌC | SHADOW |
| `pricing.get` `promotion.get` `inventory.check` `size.recommend` | ĐỌC | SHADOW |
| `shipping.policy` `shipping.calculate` `customer.get` | ĐỌC | SHADOW |
| `conversation.tag` `conversation.handoff` `followup.schedule` | GHI (nội bộ ERP) | SHADOW |
| `customer.update` `order.create_draft` | GHI | **COPILOT** |
| `order.confirm` | GHI | **AUTO** |

**Không có** công cụ nào sửa giá, sửa tồn, xoá đơn, đánh dấu vận đơn đã giao, hay đụng vào COD /
thanh toán / kế toán / lương. `tests/ai-platform.test.ts` quét sổ ở mức TÊN và bắt lỗi nếu một công
cụ như thế xuất hiện.

Công cụ nào cũng bọc quanh logic ERP đang chạy, không viết lại: tồn qua `lib/queries/stock.ts`,
phí ship qua `landingShippingFee()`, địa chỉ qua `addressIssue()`, tạo đơn qua `PancakeClient.createOrder()`.

## 8. Định tuyến mô hình & chi phí

`RULE` → `ECONOMY` → `STRONG` → `HUMAN`. Hết nấc mà không có kết quả hợp lệ ⇒ **chuyển người**,
không phải "trả về giá trị mặc định".

Leo nấc khi: luật không đủ chắc · mô hình sai lược đồ · độ tin dưới ngưỡng · mô hình lỗi · quá hạn.

Chi phí ước tính theo `ai.config.pricing` (`"<nhà cung cấp>:<mô hình>"` → VND cho một triệu token).
**Chưa khai đơn giá ⇒ chi phí là `null` = CHƯA BIẾT**, màn hình in dấu gạch, không in `0 ₫`.
Lượt chạy không gọi mô hình lần nào thì chi phí bằng 0 **thật**.

Tên mô hình không ghi cứng ở đâu trong logic — đọc từ `AI_MODEL_ECONOMY` / `AI_MODEL_STRONG` hoặc
`routing.models` của bản nhân sự.

## 9. Cổng gửi tin

`lib/ai/agents/sales/outbound.ts` là **nơi duy nhất** trong mã nguồn gọi API gửi tin của Pancake
cho nhân sự AI. Đọc một tệp là kiểm chứng được lời khẳng định "SHADOW không gửi gì".

- Nấc `SHADOW`/`OFF`: câu do AI soạn **không bao giờ** được gửi.
- Nấc `COPILOT`: phải có phiếu duyệt của người.
- Người đã cầm hội thoại: im lặng ở **mọi** nấc.
- Ngoại lệ duy nhất: hội thoại trong `ai.config.testConversationIds` nhận được **một chuỗi cố định**
  (`ROUNDTRIP_TEST_MESSAGE`) để kiểm chứng đường truyền hai chiều. Đó không phải câu của mô hình,
  và danh sách trắng **không** mở cửa cho câu AI.

## 10. Chống trùng & chống vòng lặp

| Rủi ro | Chốt chặn |
|---|---|
| Webhook gửi lại | `webhook_events.dedupe_key` (mã hội thoại + mã tin nhắn) |
| Tin nhắn nhân đôi | khoá duy nhất `sales_messages(conversation_id, external_id)` |
| Sự kiện nhân đôi | khoá duy nhất `ai_events.dedupe_key` |
| Việc nhân đôi | khoá duy nhất `ai_tasks.dedupe_key` = `<nhân sự>|<sự kiện>` |
| Hai tiến trình giành một việc | `UPDATE ... WHERE status = 'PENDING'` |
| Bot tự nói chuyện với chính nó | tin `from_page` **không bao giờ** sinh sự kiện |
| Vòng lặp tốn tiền | trần `ai.config.maxRunsPerHour` (mặc định 600/giờ) |
| Đơn nhân đôi | `sales_conversations.order_id` đã có ⇒ `order.create_draft` trả `duplicate` |

Webhook và job nạp bù chạy song song vô hại vì chống trùng nằm ở **tầng dữ liệu**, không ở tầng gọi.

## 11. Quan sát một lượt chạy

`/ai` — tổng hợp 7 ngày, nhân sự đã đăng ký, hội thoại theo giai đoạn, lỗi gần nhất, và bảng lượt
chạy đặt **câu máy gợi ý cạnh câu nhân viên thật sự trả lời**. Đó là toàn bộ giá trị của nấc chạy ngầm.

`/ai/<id>` — mười khối: tin nhắn vào · ý định & thực thể · trạng thái trước · trạng thái sau ·
quyết định · công cụ đã gọi (kèm lần bị chặn) · lần gọi mô hình (token, chi phí, độ trễ, lỗi) ·
câu máy gợi ý · câu nhân viên trả lời · 12 tin gần nhất.

Quyền: `ai:view` (xem) · `ai:manage` (cấu hình).

Đọc thẳng CSDL khi cần:

```sql
select r.started_at, r.status, r.tier, r.cost_vnd, r.suggested_reply, s.human_reply
from ai_runs r left join sales_suggestions s on s.run_id = r.id
order by r.started_at desc limit 50;

-- Lần gọi công cụ BỊ CHẶN — "máy đã ĐỊNH làm gì"
select tool, count(*) from ai_tool_calls where outcome = 'DENIED' group by 1 order by 2 desc;
```

## 12. Cấu hình

Biến môi trường: xem khối "Nhân sự AI" trong `.env.example`.

Cấu hình động trong bảng `settings`, khoá `ai.config`:

```json
{
  "enabled": true,
  "modelCallsEnabled": false,
  "ingestEnabled": true,
  "maxRunsPerHour": 600,
  "modes": { "sales": "SHADOW" },
  "testConversationIds": [],
  "pricing": { "anthropic:<tên-mô-hình>": { "inputVndPerMillion": 0, "outputVndPerMillion": 0 } }
}
```

Bảng size cho `size.recommend` nằm ở khoá `ai.sizeChart`. **Chưa khai thì công cụ nói thẳng là chưa
có căn cứ** và hội thoại chuyển người — không đoán size trên người thật.

## 13. Điều đang còn thiếu (blocker)

1. **Khoá mô hình + tên mô hình** (`AI_API_KEY`, `AI_MODEL_ECONOMY`, `AI_MODEL_STRONG`): chưa có thì
   nấc luật vẫn chạy, phần cần mô hình chuyển người. Không phải lỗi, nhưng chưa đo được chất lượng
   diễn đạt.
2. **Đơn giá mô hình** (`ai.config.pricing`): chưa khai thì mọi chi phí là CHƯA BIẾT.
3. **Bí mật webhook hội thoại** (`PANCAKE_CHAT_WEBHOOK_SECRET`) và khai báo URL bên Pancake. Chưa có
   thì dùng job nạp bù.
4. **Bảng size** (`ai.sizeChart`): chưa có thì mọi câu hỏi size đều chuyển người.
5. **Pancake POS không có API cập nhật đơn** — `order.confirm` chỉ ghi được trong ERP; nhân viên vẫn
   phải bấm chốt trên POS. Đây là giới hạn của Pancake, không phải của ERP.
6. **Lịch chạy job** `ai-sales-ingest` đang để chú thích trong `scripts/scheduler.mjs`: đổi lịch là
   việc phải hỏi chủ shop.

## 14. Triển khai & quay lui

Migration `0035_ai_workforce_foundation.sql` **thuần bổ sung**: 13 bảng mới, không câu lệnh nào đụng
tới bảng đang chạy. Chạy ngược lại không cần thiết — muốn tắt thì đặt `ai.config.enabled = false`,
mọi thứ dừng ngay mà không mất dữ liệu.

Ba mức quay lui, nhanh nhất trước:

1. `set-setting ai.config '{"enabled":false}'` — dừng toàn bộ nhân sự AI tức thì.
2. Xoá `PANCAKE_CHAT_WEBHOOK_SECRET` — webhook trả 401, không tin nhắn nào vào nữa.
3. Quay lại commit trước trên nhánh — 13 bảng mới nằm lại trong CSDL và vô hại vì không code nào đọc.
