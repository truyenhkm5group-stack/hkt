# Quy kết doanh thu cho AI bán hàng

> Mã: `lib/sales-chatbot/attribution-shared.ts` (luật, hàm thuần) · `lib/sales-chatbot/attribution.ts` (đọc sổ) ·
> `lib/sales-chatbot/events-sql.ts` (hai vị ngữ dùng chung). Bài kiểm: `tests/order-attribution.test.ts`,
> `tests/chat-order.test.ts`. Phiên bản định nghĩa: `ATTRIBUTION_VERSION = 1`. Đổi định nghĩa ⇒ tăng số và ghi vào đây;
> hai kỳ khác phiên bản không vẽ xu hướng (AGENTS §40).

## 1. Câu hỏi và phạm vi

«Đơn này có bao nhiêu phần là công của AI?» — trả lời cho đơn **gắn với một hội thoại** (`orders.sales_conversation_id`) và
có `order.confirmed` trong kỳ. Đơn lên tay trên POS / Pancake không qua hội thoại nào **nằm ngoài** phép này (không phải
«người bán»): ERP không biết khách đó có từng chat với bot hay không.

Đơn bot lên nháp mà nhân viên chốt ở trang Đơn hàng (không qua hội thoại) không có `order.confirmed` trong sổ ⇒ cũng nằm
ngoài. Hướng sai là **đếm thiếu cho AI**, không bao giờ đếm thừa.

## 2. Ba nhãn

| Nhãn | Định nghĩa |
|---|---|
| `AI_ONLY` — AI tự bán | Đơn chốt trong lượt của bot (khách đồng ý với bot) và **trước mốc chốt** không ai chạm vào lượt mua đó |
| `AI_ASSISTED` — AI góp công | Có người chạm vào, **và** AI đã góp một việc bán hàng thật trong cùng lượt mua trước mốc lên đơn |
| `HUMAN_ONLY` — Người bán | Người lên / chốt đơn và AI không góp việc bán hàng nào |

- **«Người chạm vào»** = `handoff.requested` · `human.took_over` · `human.replied`, hoặc đơn do NGƯỜI lên / chốt.
- **«Việc bán hàng thật của AI»** = `quote.given` (báo giá bằng công cụ giá) · `order.drafted` do AI · `upsell.offered` ·
  `customer.identified` (khách để SĐT trong lượt bot). **Một câu trả lời (`ai.replied`) không phải góp công.**
- **Cửa sổ** = cùng lượt mua (`sales_conversation_events.cycle`), trước mốc lên đơn đầu tiên của chính đơn đó. Công của lượt
  mua trước không chảy sang lượt mua sau; người chạm vào SAU mốc chốt không làm mất «AI tự bán».
- Đơn «AI ghi hộ nhân viên» (order-sync) là **người bán**: AI chép lại cuộc bán của nhân viên, không bán.
- Không có sự kiện lên / chốt nào của chính đơn ⇒ **chưa quy kết** (`unattributed`), in riêng, không gộp vào «người bán».

Ba nhãn **không bao giờ gộp thành một ô** (`TARGET_ARCHITECTURE.md` §5.4). Lệnh Master Mission có nhắc «tổng doanh thu có AI
tham gia» — không in ô ấy: cộng «AI tự bán» với «AI góp công» là cách dễ nhất để con số AI trông to hơn sự thật.

## 3. Doanh thu

Doanh thu của mọi nhãn = `orders.total_price_after_discount` của đơn có `ORDER_OUTCOME = 'DELIVERED'` và
`REVENUE_RECOGNIZED_ON_DELIVERY` — cùng biểu thức với màn «Hiệu quả». «Đặt» (giá trị đơn chốt) in cạnh, không thay.

**Lãi gộp đã giao** (Master Mission P0.5 «Conversation → Delivered Profit», 08/10/2026) = doanh thu đã giao − giá vốn, theo
từng nhãn. Giá vốn đọc qua `orderCogsFast()` (lib/queries/cogs.ts) — ĐÚNG đường của Báo cáo lợi nhuận: giá vốn đã chốt lúc
giao, nên phiếu nhập mới không viết lại lãi của kỳ cũ (docs/cogs-recognition-contract.md §6). Đơn có doanh thu mà giá vốn 0
(cả ba nguồn đều trống — cùng nghĩa `IS_MISSING_COGS`) là CHƯA BIẾT: đếm riêng (`cogsUnknown` + doanh thu của chúng), KHÔNG
cộng vào lãi với giá vốn 0; biên gộp chỉ tính trên đơn biết giá vốn, chưa đơn nào biết ⇒ «—». Chưa trừ chi phí AI (khung «Chi
phí AI & ROI» đứng riêng), cước, quảng cáo.

## 4. Follow-up thu hồi

- **Khách trả lời** = có `message.received` SAU một `followup.sent` trong cùng lượt mua.
- **Đơn thu hồi** = đơn có `order.confirmed` mà mốc lên đơn đầu tiên nằm SAU tin trả lời ấy, cùng lượt mua. Khách tự quay
  lại không qua lời nhắc nào ⇒ không phải thu hồi; đơn lên trước tin trả lời ⇒ không phải thu hồi.
- Thu hồi là thuộc tính RIÊNG, đứng cạnh nhãn (một đơn thu hồi vẫn là AI tự bán / góp công / người bán).
- Chỉ đếm đơn có mốc chốt trong kỳ.

## 5. Vì sao `order.confirmed` của bot mang tác nhân CUSTOMER

Sự kiện chốt của bot sinh ra khi KHÁCH đồng ý trong lượt bot (`events-shared.ts`). Đơn nhân viên tạo trong khung chat mang
tác nhân HUMAN. Vì vậy «đơn bot chốt» = `order.confirmed` **không do người chốt** (`BOT_CONFIRMED`) — lọc `actor = 'AI'` là
sai và xoá sạch đơn bot (bài kiểm đột biến ở `tests/chat-order.test.ts` bắt cả hai chiều).

## 6. Lịch sử định nghĩa

| Phiên bản | Ngày | Thay đổi |
|---|---|---|
| 1 | 05/10/2026 | Bản đầu |
| 1 | 08/10/2026 | Thêm lãi gộp đã giao theo nhãn (không đổi định nghĩa nhãn — phiên bản quy kết giữ nguyên) |
