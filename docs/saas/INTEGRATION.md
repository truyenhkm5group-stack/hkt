# Ranh giới tích hợp — nền tảng ↔ sản phẩm, ERP ↔ Chốt Đơn

## 1. Hợp đồng nền tảng v1 (`lib/saas/sdk.ts`)

Sản phẩm KHÔNG đọc thẳng bảng `platform_*`. Sáu hàm, workspace luôn lấy từ ngữ cảnh máy chủ (phiên đã ký hoặc
`withOrganization` của job):

| Hàm | Trả lời |
|---|---|
| `currentWorkspace()` | workspace + tài khoản + loại + cách lập chứng từ |
| `productContext(product)` | thuê bao, tình trạng hiệu lực, có cho dùng không |
| `hasProductFeature(product, feature)` | thuê bao cho dùng ∧ gói (+ ghi đè) có tính năng — không so tên gói |
| `recordProductUsage(product, metric, qty, { eventKey })` | ghi sổ dùng chung, idempotent theo khoá |
| `recordProductCost(product, …)` | khoản chi trực tiếp của workspace (vd hoá đơn API ngoài) |
| `emitAudit(product, …)` | nhật ký CỦA workspace (quản trị khách thấy) |

Phiên bản: `SAAS_CONTRACT_VERSION = "v1"`. Đổi hình dạng ⇒ v2 chạy song song tới khi mọi sản phẩm chuyển.

## 2. ERP ↔ Chốt Đơn

Hai sản phẩm chạy trong CÙNG một workspace (cùng CSDL) của cùng một mã nguồn, nên ranh giới là **lời gọi hàm có luật ở
máy chủ**, không phải HTTP. Không bản sao bảng ERP nào sang Chốt Đơn; không projection nào cần đồng bộ.

```
Messenger / fanpage / web chat → Chốt Đơn (lib/sales-chatbot: engine → tools)
   hỏi tồn / giá   → lib/sales-chatbot/catalog.ts → lib/queries/stock.ts (availableStockExpr) · lib/commerce/pricing.ts
   tạo / sửa đơn   → lib/records/order-create.ts::createOrderAsAgent / updateOrderAsAgent (khoá theo mẫu mã, một transaction)
   khách           → lib/records/customer-create.ts::createCustomerAsAgent
   ← mã đơn ERP + trạng thái → Chốt Đơn ghi sự kiện hội thoại (sales_conversation_events) = quy kết bán hàng AI
   kết cục giao hàng → ORDER_OUTCOME (lib/queries/return-rate.ts) — Chốt Đơn KHÔNG tự tính
```

- **Idempotent**: đơn của agent có khoá theo hội thoại; tin vào khử trùng ở `sales_chat_inbound.message_id`; sổ AI và sổ
  dùng chung có khoá sự kiện.
- **Mã tương quan**: id hội thoại đi theo đơn (`orders.sales_conversation_id` trong kế hoạch Commerce Core) và theo dòng
  `platform_ai_usage.conversation_id` (#612).
- **Không cần outbox**: cùng một transaction Postgres; outbox chỉ cần khi một sản phẩm tách ra CSDL / tiến trình khác.

## 3. Sản phẩm mới

Sản phẩm thứ ba dùng cùng sáu hàm; nếu nó cần lõi thương mại thì khai `needsCommerceCore` và gọi đúng các hàm ERP ở §2.
