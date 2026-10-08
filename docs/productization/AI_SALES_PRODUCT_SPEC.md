# Đặc tả sản phẩm — AI Sales Agent for Social Commerce

> Bản 0.1 · 04/10/2026 · nền `origin/main` 7e2edfce. Mỗi năng lực ghi rõ **đã có / một phần / chưa có** và trỏ
> tới mã thật — để không bán thứ chưa làm. Kiến trúc: `TARGET_ARCHITECTURE.md`; lộ trình: `MIGRATION_PLAN.md`.

## 1. Sản phẩm trong một câu

Shop bán qua mạng xã hội kết nối fanpage (và sau đó các kênh chat khác); **AI trả lời khách 24/7 bằng giá và
tồn kho thật của shop, xác định đúng món, báo giá, xử lý phản đối, lấy SĐT/địa chỉ, mời mua thêm, chốt và lên
đơn** — và chuyển cho nhân viên đúng lúc, với đủ ngữ cảnh. Chủ shop thấy được AI mang lại bao nhiêu **đơn giao
thành công**, tốn bao nhiêu tiền AI, và so với nhân viên ra sao.

ERP phía dưới (đơn, khách, sản phẩm, giá, tồn, thanh toán, vận chuyển) là hạ tầng; khách chỉ thấy phần họ cần.

## 2. Ai dùng

| Vai | Họ cần gì | Hôm nay ở đâu |
|---|---|---|
| **Chủ shop** | bật bot nhanh, tin rằng bot không bịa giá, thấy số bán ra nhờ AI, sửa được cách bot nói | `/start`, `/ai/sales-chatbot` (cấu hình · trả lời mẫu · bài học · chi phí) |
| **Nhân viên bán hàng / CSKH** | nhận hội thoại bot chuyển sang kèm lý do, không phải đọc lại từ đầu; bot im khi mình đang nói | Thông báo trong ERP + nhóm Lark/Telegram; trả lời trong Pancake |
| **Khách của shop** | được trả lời ngay, đúng giá, không bị hỏi lại điều vừa nói, chốt đơn dễ | Messenger qua Pancake · `<shop>.<miền>/chat` |
| **Người vận hành nền tảng** | cấp tổ chức, theo dõi sức khoẻ, hạn mức, tạm dừng khẩn | `/platform`, `/platform/org/[code]` |

## 3. Năng lực — đối chiếu với mã

| # | Năng lực | Trạng thái | Ở đâu / còn thiếu |
|---|---|---|---|
| 1 | **Tư vấn & xác định đúng món** | Đã có | `search_products`, `get_product`; hỏi lại quy cách trước khi báo giá (`engine.ts` B1). Tìm bằng điểm từ khoá trong bộ nhớ, trần 2.000 mẫu mã (`catalog.ts`) |
| 2 | **Báo giá đúng giá thật** | Đã có | `get_current_price`, `calculate_cart`; giá lẻ `product_variants.retail_price`, giá sỉ theo bảng giá + bậc số lượng khi shop bật (`price-lists.ts`). **Lõi đơn chưa tự ép giá** (TD-01 → M3) |
| 3 | **Kiểm tồn** | Đã có | `check_inventory`; tồn chưa biết ⇒ không khẳng định. **Chưa giữ hàng nguyên tử** (TD-02 → M3) |
| 4 | **Phí ship / miễn ship** | Một phần | Luật cấu hình (`shipping.ts`, `freeShipping` mặc định tắt). Không báo phí từ hãng vận chuyển |
| 5 | **Xử lý phản đối** | Một phần | Có luật trong lời nhắc ("cảm ơn" sau báo giá = lưng chừng, hỏi một câu chốt dễ; chê giá khách sỉ ⇒ người). **Chưa phân loại / đo phản đối** (M2 sự kiện `objection.raised`) |
| 6 | **Thu thông tin khách** | Đã có | `create_customer`, `lookup_customer`; bước INFO. Định danh theo SĐT có cửa đua (TD-20 → M3) |
| 7 | **Nhận khách cũ** | Đã có | `returning.ts` — 3 mức tin (THREAD / FB_ID / PHONE), dùng lại địa chỉ đã lưu, chỉ **gợi ý** (AGENTS §3.12) |
| 8 | **Upsell / cross-sell** | Một phần | Bước UPSELL, câu mời phải gửi trước khi chốt. **Chưa đánh dấu dòng hàng upsell, chưa đo doanh thu upsell** (M2) |
| 9 | **Chốt đơn an toàn** | Đã có | `confirm_order` chặn khi khách chưa thấy tóm tắt, chưa có lời đồng ý nguyên văn, giá vừa đổi, hết hàng (`tools.ts:557-600`) |
| 10 | **Tạo đơn trong ERP** | Đã có | `create_draft_order` / `update_draft_order` / `confirm_order` → `createOrderAsAgent` → `orders` + `order.*`. Không có idempotency (TD-03) |
| 11 | **Handoff cho người** | Đã có | `handoff_to_human` với lý do theo nhóm; báo trong ERP + nhóm chat; nhân viên trả lời ⇒ bot nhường 30 phút; trả lại AI bằng nút. **Hộp thư khách trong ERP (M8, 05/10/2026)**: `/ai/sales-chatbot/inbox` — nhân viên trả lời Facebook / Instagram / Zalo / chat web, mỗi tin mang `users.id` |
| 12 | **Nhắc khách im lặng** | Đã có | `followup.ts` 1h / 6h / 22h trong khung 24 giờ; thôi khi nhân viên đã nói hoặc khách gửi 👍 |
| 13 | **Ghi đơn hộ nhân viên** | Đã có (mặc định tắt) | `order-sync.ts`: hội thoại người chốt yên 10 phút ⇒ AI đọc ⇒ đơn "Mới" |
| 14 | **Nhắc mua lại** | Đã có | `lib/reorder/*` + tin sáng khách đến hạn vào nhóm |
| 15 | **Đặt lịch (dịch vụ)** | Đã có | `find_booking_slots`, `book_appointment` theo sức chứa |
| 16 | **Bot tự học** | Đã có | `lessons.ts` mỗi 6 giờ từ hội thoại đã xong; chủ shop sửa/xoá; `playbook.ts` học từ lịch sử (che số + tên trước khi tới AI); bài AI rút ra (tự học · góp ý) mà nhắc tới tiền / tài khoản / liên kết KHÔNG tự áp — chủ shop tự viết nếu cần (`screenAiLessons`) |
| 17 | **Trả lời mẫu 0 token** | Đã có | `quick-replies*`, ô `{{giá:SKU}}` lấy giá sống |
| 18 | **Trả lời bình luận bằng tin riêng** | Đã có | `fanpage.ts`, đọc nội dung bài viết |
| 19 | **Hiểu ảnh / ghi âm khách gửi** | Chưa (bot đa tổ chức) | Có ở bot nhà (`chatbot/src/vision.js`, `voice*.js`) — rút ra ở M6c / M10 |
| 20 | **Nhiều fanpage mỗi shop** | Chưa | Một `pageId` mỗi tổ chức (TD-11 → M6) |
| 21 | **Kênh ngoài Pancake** | Đang làm | Web chat + ô chat nhúng website (#515, đã có); **Messenger trực tiếp qua Meta Graph** (phiên khác, nhánh `claude/messenger-truc-tiep`, PR mở 04/10); Zalo OA / Instagram còn chờ (M11) |
| 22 | **Persona theo quảng cáo** | Chưa (bot đa tổ chức) | Có ở bot nhà (`adpersona.js`) |
| 23 | **Thanh toán chuyển khoản theo đơn (QR)** | Chưa | QR chỉ có cho thuê bao nền tảng (TD-23) |
| 24 | **Đo hiệu quả: phễu, handoff, AI vs người, ROI** | Một phần | `cost-report.ts` (₫ AI / đơn chốt, / SĐT). Không có sổ sự kiện (TD-04 → M2, M4) |
| 25 | **Công tắc khẩn + hạn mức AI** | Đã có | `aiKillSwitchDenial`, `checkAiQuota`, giờ làm việc, trần lượt |
| 26 | **Cô lập dữ liệu từng shop** | Đã có | SILO, bí mật mã hoá theo tổ chức |

## 4. Hành vi không thương lượng (guardrails)

Đây là lời hứa với chủ shop; mỗi cái phải có bài kiểm (phần lớn đã có trong lời nhắc + công cụ, M1 khoá lại).

1. **Không bịa giá, không bịa tồn, không tự giảm giá.** Giá chỉ từ công cụ; ngoài bảng ⇒ chuyển người.
2. **Chỉ chốt khi khách đã thấy tóm tắt và đồng ý bằng lời.** Giá đổi giữa chừng ⇒ đọc lại, hỏi lại.
3. **Không lộ suy luận nội bộ, tên công cụ, markdown** ra khách (`customerFacingText`).
4. **Biết khi nào dừng.** Khiếu nại, ngoài chính sách, khách sỉ đòi giá riêng, không hiểu sau 2 lần ⇒ chuyển
   người kèm lý do. Chuyển người là lối cuối, không phải lối tắt.
5. **Nhường người.** Nhân viên vừa trả lời ⇒ bot im 30 phút; hội thoại đang HANDOFF ⇒ bot không chen.
6. **Không tự điền dữ liệu khách cũ vào đơn mà không hỏi** (AGENTS §3.12).
7. **Chi phí có trần.** Hạn mức theo gói + công tắc khẩn của shop và của nền tảng; vượt ⇒ chuyển người có lý do,
   không im lặng với khách.
8. **Dữ liệu hội thoại của shop chỉ nằm trong CSDL của shop**; nhà vận hành xem được gì phải ghi trong hợp đồng
   (liên quan TD-18).

## 5. Design partner: Hải Sản Làng Chài (HSLC)

**Đang dùng (theo mã + ghi nhớ dự án, chưa đo production):** bot fanpage qua kết nối Pancake, đơn tạo trong ERP,
bảng giá sỉ (mặc định tắt), nhóm Telegram "Đơn hàng HSLC", ghi đơn từ hội thoại (mặc định tắt), tự học, đơn tay
có phí giao 40K và doanh thu khi đã giao (`ORDER_OUTCOME.md` §11).

**Tiêu chí thành công của pilot** — chỉ đo được sau M2 (sự kiện) và M4 (màn hình):

| Tiêu chí | Đo bằng | Đích |
|---|---|---|
| AI tự xử lý trọn | `ai_sales.ai_resolution_rate` | **Chủ shop HSLC đặt** (AGENTS §38 — không có ngưỡng mặc định) |
| Không bán sai giá | số đơn AI có đơn giá ≠ bảng giá | 0 (sau M3, kiểm bằng máy) |
| Không trả lời trùng / chen ngang | sự kiện `ai.replied` trong 30 phút sau `PAGE_HUMAN` | 0 |
| Doanh thu giao thành công từ AI | `ai_sales.delivered_revenue` + độ phủ | in số, không đặt đích hộ |
| Chi phí AI / đơn giao thành công | `ai_sales.ai_cost_per_delivered_order` | in số, so với chi phí người do chủ shop khai |
| Thời gian từ handoff tới khi có người | `handoff.accepted − handoff.requested` | chỉ đo được sau M8 |

**Cần từ HSLC:** cho phép dùng hội thoại đã che làm bộ hội thoại vàng (M1); một nhân viên dùng thử hộp thư ERP
(M8); khai chi phí một hội thoại do người làm (M4, tuỳ chọn); phản hồi mỗi tuần về câu bot nói sai.

## 6. Phạm vi bản bán được đầu tiên (v1)

**Trong:** kênh Pancake fanpage (nhiều page) + web chat · 16 công cụ hiện có · lời nhắc theo gói ngành (seafood,
generic, sau đó fashion) · đơn trong ERP với giá/tồn ép ở lõi · handoff + báo nhóm · follow-up · khách cũ · màn
Hiệu quả (phễu, handoff, nhóm AI/người, ROI có độ phủ) · gói "chỉ AI Sales" với menu gọn · đăng ký tự phục vụ.

**Ngoài (v1):** kênh không qua Pancake · báo phí vận chuyển từ hãng · QR thanh toán theo đơn · benchmark theo
từng nhân viên (cần M8) · bán theo cân lẻ (số lượng đơn là số nguyên) · đồng bộ đơn ngược vào Pancake POS cho
khách (chỉ nhà, M10) · mọi module vận hành VNX (lương, sản xuất, care, COD, creative, video).

**Phụ thuộc Pancake:** chủ shop quyết 04/10/2026 (Q3) — **khách KHÔNG dùng Pancake vẫn phải dùng được bot**. Lối
không-Pancake: ô chat nhúng website (#515), trang `/chat`, và Messenger trực tiếp qua Meta Graph (đang gộp). Pancake
trở thành MỘT adapter trong số nhiều, không phải điều kiện tiên quyết.

## 7. Chỉ số sản phẩm

Định nghĩa đầy đủ ở `TARGET_ARCHITECTURE.md` §5.2. Ba luật đọc số:

- **"AI bán được" = đơn giao thành công** theo `ORDER_OUTCOME`, không phải "bot chốt". Hai số luôn in cạnh nhau,
  kèm tỷ lệ đơn đã có kết cục.
- **AI tự làm** và **AI có người giúp** là hai cột, không cộng gộp.
- **Chi phí AI chưa định giá** in "cận dưới", không in 0; **tiết kiệm nhân sự** luôn mang nhãn ước tính do chủ
  shop khai.

## 8. Đóng gói và tính phí — đề xuất để chủ shop quyết

Hôm nay: gói 249k / 499k / 999k / 1,99tr mỗi tháng có credit AI theo gói (`docs/platform/pricing.md`), hạn mức đo
theo Builder (trang, đối tượng, bản ghi, luật). **Không có đơn vị nào của AI Sales** (TD-16).

| Đơn vị có thể tính | Ưu | Nhược | Đo được từ |
|---|---|---|---|
| Hội thoại AI xử lý / tháng | dễ hiểu, gắn giá trị | khách hỏi rồi đi cũng tính | `conversation.opened` có `ai.replied` (M2) |
| Số kênh / fanpage | khớp cách shop nghĩ | không gắn khối lượng | connector (M6) |
| Credit AI (tiền token) | khớp chi phí thật | khách khó dự đoán | `platform_ai_usage` (đã có) |
| % doanh thu đơn AI giao thành công | gắn kết quả | cần kết cục đáng tin, tranh chấp quy kết | `ORDER_OUTCOME` (M4) |

Khuyến nghị kỹ thuật (không phải quyết định giá): **thuê bao theo số kênh + hạn mức hội thoại AI**, credit AI là
trần an toàn chi phí chứ không phải đơn vị bán; tính theo % doanh thu để sau khi số kết cục đã được chứng minh
với HSLC.

## 9. Quyết định cần chủ shop (HUMAN GATE)

| # | Câu hỏi | Vì sao cần người quyết | Chặn bước |
|---|---|---|---|
| Q1 | ~~Tạm dừng mở rộng nhiều ngành để dồn sức cho AI Sales?~~ **ĐÃ QUYẾT 04/10/2026: CÓ — dồn sức cho AI Sales.** Spa / Nhà hàng / sàn chỉ làm phần phục vụ AI Sales | — | — |
| Q2 | Đơn vị tính phí và giá gói AI Sales | Quyết định kinh doanh | M7 |
| Q3 | ~~Pancake là điều kiện tiên quyết?~~ **ĐÃ QUYẾT 04/10/2026: KHÔNG — phát triển để khách không dùng Pancake vẫn dùng được bot.** Kéo lớp kênh (M6) và kênh trực tiếp (M11) lên trước | — | — |
| Q4 | Kênh tiếp theo sau Pancake (Messenger trực tiếp / Zalo OA / Instagram / TikTok) | Dịch vụ ngoài mới (AGENTS §7) | M11 |
| Q5 | VNX chuyển sang dùng chính sản phẩm (gỡ bot nhà)? Nếu có: page nào thử trước | Rủi ro doanh thu của shop nhà | M10 |
| Q6 | Ai của nhà vận hành được xem hội thoại của khách? | Hợp đồng + quyền (AGENTS §7) | M9 |
| Q7 | Tài khoản nhận tiền thuê bao tách khỏi tài khoản shop VNX? | Tiền + kế toán | M9 |
| Q8 | Ngân sách hạ tầng khi vượt ~5–15 tenant (`scale-plan.md`) | Chi phí | M9 |

## 10. Rủi ro

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Đổi lời nhắc/kênh làm bot HSLC nói sai với khách thật | Cao | M1 trước mọi bước; lời nhắc HSLC giống từng ký tự ở M5 |
| Pancake đổi API / chặn webhook theo page | Cao | Adapter (M6) để thay kênh không đụng engine; kênh trực tiếp (M11) |
| Hai hội thoại bán cùng món cuối | Vừa | M3 |
| Con số "AI bán được" bị phồng (đơn chốt ≠ đơn giao; chi phí AI phục vụ đơn người tính cho AI) | Vừa | `ORDER_OUTCOME` + tách feature sổ AI (M2) |
| Một VPS 2 nhân không chịu nhiều tenant | Vừa → Cao khi > 15 | M9 theo `scale-plan.md` |
| Mọi ADMIN nhà thấy hội thoại khách | Vừa (pháp lý) | M9 / Q6 |
| Gỡ bot nhà làm VNX mất đơn | Cao | M10 từng page, chế độ bóng, đo theo nhóm |
