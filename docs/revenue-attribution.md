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
| 1 | 08/10/2026 | Thêm lãi gộp + lãi sau chi phí AI theo NHÁNH THỬ NGHIỆM AI vs Người (mục 7) — không đổi định nghĩa nhãn; thử nghiệm đã dừng thì không in chênh lệch lãi (chưa có mốc dừng) |

## 7. AI vs Người theo nhánh thử nghiệm — lãi gộp và lãi sau chi phí AI (08/10/2026)

> Mã: `lib/sales-chatbot/experiment-shared.ts` (luật, hàm thuần: `armRaw` · `armStats` · `grossProfitLift` · `profitAfterAiLift`) ·
> `lib/sales-chatbot/experiment-report.ts` (đọc sổ) · `lib/ai-usage/conversation-cost.ts` (tiền AI theo hội thoại, dùng
> chung với khung «Chi phí AI & ROI») · màn `/ai/sales-chatbot/performance`, khối «AI vs Người — theo nhánh thử nghiệm».
> Bài kiểm: `tests/sales-experiment-report.test.ts`. Master Mission P0.5 «Conversation → Delivered Profit» + P1.7.

Câu hỏi: «nhánh AI hay nhánh người làm ra nhiều **lãi đã giao** hơn trên mỗi hội thoại — kể cả sau khi trả tiền AI?».
Hai nhánh chia NGẪU NHIÊN theo hội thoại (`operating-mode-shared.ts`) và đọc theo ý định điều trị như các dòng có sẵn của
khối: đơn gắn với hội thoại thuộc nhánh nào tính cho nhánh đó, toàn bộ thời gian thử nghiệm.

| Ô | Định nghĩa | Nguồn |
|---|---|---|
| Lãi gộp đã giao | Σ (doanh thu đã giao − giá vốn) trên đơn của nhánh **biết giá vốn** | Từng đơn đọc bằng ĐÚNG đường của bảng quy kết (`orderFactColumns` + `orderFactsOf`: `ORDER_OUTCOME` · `REVENUE_RECOGNIZED_ON_DELIVERY` · `orderCogsFast`), cộng bằng CÙNG hàm `orderRow` (mục 3) |
| Biên · đơn chưa có giá vốn | Biên trên đơn biết giá vốn; đơn giao có doanh thu mà giá vốn 0 đếm riêng (số đơn + doanh thu) | như trên |
| Lãi gộp / hội thoại | Lãi gộp ÷ hội thoại **đo được** (mẫu số của «Ra đơn / hội thoại») | — |
| Chi phí AI (ước tính) | Σ tiền AI của mọi hội thoại thuộc nhánh — lượt bot trả lời / đọc ảnh / follow-up (`ref` = mã hội thoại) **và** lượt AI ghi đơn hộ nhân viên (`ref` = `order-sync:<mã>`) | `platform_ai_usage` qua `aiUsageByRef` (lọc `org_code`), token × bảng giá model × tỷ giá `FACEBOOK_USD_VND` |
| Lãi sau chi phí AI · / hội thoại | Lãi gộp − chi phí AI của nhánh; ÷ hội thoại đo được | — |
| AI − người | `liftOrNull` của hai ô «/ hội thoại» (`grossProfitLift` · `profitAfterAiLift`) — CHỈ khi thử nghiệm đang chạy | — |

Luật (mỗi luật có bài kiểm):

- **Hoàn / huỷ không có doanh thu, không có lãi** — đúng `ORDER_OUTCOME`; hoàn vẫn vào mẫu số «tỷ lệ giao», huỷ thì không.
- **Đơn chưa có giá vốn KHÔNG cộng vào lãi với giá vốn 0** (cùng nghĩa `IS_MISSING_COGS`). Tổng lãi gộp vẫn in phần biết giá
  vốn (như bảng quy kết) kèm số đơn + doanh thu thiếu giá vốn; MỌI đơn đã giao đều thiếu ⇒ «—».
- **Lãi chưa đủ thì không chia, không trừ, không so**: còn đơn đã giao chưa có giá vốn ⇒ «lãi / hội thoại», «lãi sau AI» và
  chênh lệch đều «—» kèm lý do — nhánh thiếu giá vốn trông nghèo (hoặc giàu) hơn thật và bên kia «thắng» giả. Việc phải làm là
  nhập giá vốn (phiếu nhập), không phải đoán.
- **Dưới `AI_SALES_MIN_SAMPLE` (10) hội thoại đo được ⇒ mọi ô «/ hội thoại» «—»**; chênh lệch chỉ có khi CẢ HAI nhánh có số.
- **Thử nghiệm đã DỪNG ⇒ không so chênh lệch lãi**: hai ô «AI − người» của lãi in «—» kèm lý do (`STOPPED_LIFT_REASON`); số
  TỪNG nhánh vẫn in (xem «mốc cuối chưa có» bên dưới).
- **Nhánh người chỉ đo được khi «AI ghi đơn hộ nhân viên» BẬT** (fanpage). Tắt ⇒ lãi nhánh người «chưa đo», không phải 0 ⇒
  không chênh lệch nào. Chi phí AI của nhánh vẫn in (nó là số đo của sổ AI, không phụ thuộc đường ghi đơn).
- **Chi phí AI là ƯỚC TÍNH và có thể là CẬN DƯỚI**: còn lượt chưa định giá (model lạ, lượt lỗi) ⇒ chi phí là cận dưới, lãi
  sau AI là CẬN TRÊN — in ra cạnh ô. Chênh lệch «lãi sau AI / hội thoại» khi đó có CHIỀU: chỉ nhánh AI cận dưới ⇒ cận trên;
  chỉ nhánh người ⇒ cận dưới; cả hai ⇒ «—». Chưa lượt nào định giá ⇒ chi phí «—» (CHƯA BIẾT, luật 42), không bao giờ 0 — và
  ô «—» không ghi «cận dưới» (`aiCostNote`), chỉ ghi số lượt chưa định giá.
- **Tiền AI là số NỘI BỘ**: chỉ người cấu hình bot ở workspace nhà (`aiPerformanceWithMoney`) thấy; người khác ⇒ mọi ô tiền
  AI `null`, máy chủ KHÔNG đọc sổ AI, đoạn giải thích về token / bảng giá không dựng.
- **Chưa trừ** chi phí nhân sự (xem «tiết kiệm nhân sự» ở khung «Chi phí AI & ROI» — chủ shop tự khai), cước, quảng cáo,
  hoàn hàng. Đây là lãi GỘP đã giao, không phải lợi nhuận ròng.

Mốc gán nhánh và giới hạn đã biết:

- **Mốc gán nhánh** = `state.experiment.at`, ghi bởi `pinArm` (`operating-mode.ts`) ở tin khách ĐẦU TIÊN qua cổng chế độ
  (fanpage `fanpage.ts`, Messenger, Zalo) dưới khoá thử nghiệm hiện hành — NGAY TRƯỚC mọi bước tốn tiền AI của lượt đó. Nhánh
  NGƯỜI là chế độ quan sát: bot không gọi AI; tiền AI của nhánh người gần như chỉ là lượt ghi đơn hộ.
- **Tiền AI chỉ tính từ NGÀY (giờ VN) của mốc gán nhánh** của từng hội thoại; sổ đọc từ mốc sớm nhất của khoá. Sổ AI gom theo
  (ngày × `ref`) nên mốc cắt ở **đầu ngày**, không cắt giữa ngày: lượt AI cùng ngày mà TRƯỚC mốc (lời nhắc follow-up, lượt
  ghi đơn hộ chạy trước tin khách đầu tiên của thử nghiệm) vẫn bị tính. Hướng sai luôn là chi phí CAO hơn thật (lãi sau AI
  thấp hơn thật), không bao giờ ngược lại.
- **Đơn KHÔNG cắt theo mốc** (hành vi có sẵn của khối, giữ nguyên số cũ): đơn gắn với hội thoại của nhánh tính cho nhánh kể
  cả đơn lên TRƯỚC khi hội thoại được ghim (hội thoại có từ trước khi bật thử nghiệm). Với hội thoại như vậy, lãi có thể gồm
  đơn cũ trong khi chi phí AI cũ không vào — lệch về phía lãi sau AI CAO hơn thật ở cả hai nhánh.
- **Đơn nhiều lần gửi**: mỗi đơn đúng một dòng (`PRIMARY_ATTEMPT`); kết cục và giá vốn đã chốt đọc theo lần gửi quyết định.
- **Mốc cuối chưa có**: ERP chưa lưu lúc DỪNG thử nghiệm (`stoppedAt`). Dừng = chế độ rời EXPERIMENT mà khoá giữ nguyên:
  `replyGate` thôi chia nhánh (bot trả lời cả hội thoại từng thuộc nhánh người), nhưng đơn (không có mốc trên) và tiền AI
  (`aiCostOfConversationSets` chỉ có mốc dưới) về sau của các hội thoại đã ghim vẫn cộng vào nhánh. Hai nhóm khi ấy không còn
  là hai nhóm chia ngẫu nhiên, nên khi `running = false` khối KHÔNG in chênh lệch lãi; số từng nhánh đọc như số mô tả, không
  phải kết quả so sánh. Muốn so sau khi dừng thì phải lưu mốc dừng và cắt cả đơn lẫn tiền AI theo nó — chưa làm.

Đối chứng: khung «Chi phí AI & ROI» (`performance.ts`) đọc sổ bằng CHÍNH `conversationOfRef` + `addUsdAsVnd` — bài kiểm dựng
sổ biết trước và khẳng định đúng số (kể cả lọc theo page), xanh trên cả mã trước và sau khi tách hàm chung.
