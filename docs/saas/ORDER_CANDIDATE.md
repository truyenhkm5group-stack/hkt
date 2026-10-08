# Order Candidate — đơn đang lên từ hội thoại (thiết kế)

*MASTER MISSION §16–§23 · lát C2 (R0) · 08/10/2026 · số dòng mã đối chiếu trên `origin/main` `217cb26c`. Đây là tài liệu THIẾT KẾ: chưa tạo bảng nào
và chưa đổi luật chốt nào. Đổi luật chỉ được làm khi đủ hai điều kiện: (a) Golden Dataset v2 (lát C1) đã có số đo, (b) chủ shop đã
quyết ở §5. Chỗ ghi **SUY LUẬN** là đọc từ đường mã, chưa chạy thử.*

Đọc kèm:
- `docs/productization/TARGET_ARCHITECTURE.md` §⑤: `OrderService.draft/confirm` có `idempotencyKey`.
- `docs/productization/TECH_DEBT.md`: TD-03 (idempotency), TD-20 (~11 hàm SĐT).
- `docs/productization/AI_SALES_PRODUCT_SPEC.md` §4, guardrail 2: chỉ chốt khi khách đồng ý bằng lời.
- `docs/productization/CHOTDON_SMART_ROADMAP.md` B4: xác minh SĐT và địa chỉ lúc chốt.
- `docs/business-rules/ORDER_OUTCOME.md`: kết cục đơn. Tài liệu này **không** đổi nó.
- `INBOX_V2.md` §7.
- `docs/revenue-os/MASTER_MISSION_STATUS.md`: bảng P0 ghi «Order Truth» là DONE theo tiêu chí của bảng đó (#660). Tài liệu này
  không phủ nhận điều đó. Nó bàn bước kế tiếp: bằng chứng từng trường và zero-unverified, kèm các lỗ đo được ở §1. Mục «An toàn
  bot bán hàng» liệt kê #647–#657.
- AGENTS mục 3.12, 8, 34, 35.

Viết tắt: `sc/` = `lib/sales-chatbot/`.

## 1. Hiện trạng: một state machine NGẦM

| Mảnh | Ở đâu | Hiện nay |
|---|---|---|
| Nháp | `sc/tools.ts:181-213`, chạy ở `:598-636` | `create_draft_order` / `update_draft_order` ghi một dòng `orders` với stage NEW (`orderInput(…, "NEW")`, `:625`). Bản sao nằm ở `state.draft` (`:633`) và ở `sales_chat_conversations.draft_order_id` (`sc/engine.ts:1027`). Bot được báo «Nháp — chưa chốt, chưa giữ hàng» (`tools.ts:634`) |
| Chốt của bot | `sc/tools.ts:637-685` | Các cổng theo thứ tự: (1) lời trích dài 2–300 ký tự, (2) khách đã thấy tóm tắt ở lượt **trước**, (3) có nháp, (4) đã chốt thì trả `already_confirmed`, (5) «nguyên văn», (6) đủ tên · SĐT · địa chỉ (chỉ cần không rỗng, `:652`), (7) tính lại giá, giá đổi thì dừng, kiểm tồn khi biết tồn. Ghi CONFIRMED qua `updateOrderAsAgent` |
| «Nguyên văn» | `sc/tools.ts:648`, `sc/text.ts:7-16` | Chỉ là phép **chuỗi con** sau khi bỏ dấu và thay ký tự không phải chữ/số bằng dấu cách. Chạy thử hàm thật: câu cuối «Không chốt đâu», trích «chốt» ⇒ **qua**. Trích «!!» (gập thành chuỗi rỗng) ⇒ **qua với mọi câu cuối**. Trích «ok» qua với câu «em đặt book» |
| Lời nhắc nới «đồng ý» | `sc/engine.ts:166` (luật 6) | Sau tóm tắt, «ok», «chốt», «được», «giao đi»… hay một câu dặn dò giao hàng đều được tính là đồng ý |
| «Câu cuối của khách» | `sc/engine.ts:955`, `sc/fanpage.ts:1030-1038` | Là cả lượt gộp lại: nhiều tin đến dồn, kèm mô tả ảnh do máy viết |
| Công tắc «đơn đủ thông tin = đã xác nhận» | `lib/records/order-create.ts:452-454`, `:460-464`, gọi ở `:473`. Khoá `orders.autoConfirmComplete` (`lib/constants/manual-orders.ts:196`) | Mặc định TẮT. Khi bật: đơn NEW đủ thông tin (`manualOrderGaps`, `manual-orders.ts:212-221`: SĐT 8–15 số, địa chỉ ≥ 5 ký tự, có tỉnh, có xã, ≥ 1 dòng) được nâng lên CONFIRMED. Công tắc nằm ở `/orders` (`app/(dashboard)/orders/auto-confirm-button.tsx:31-36`), trang này mở trong vỏ Chốt Đơn |
| Hệ quả của công tắc (**SUY LUẬN**) | `order-create.ts:473`, `:846-871` | Công tắc áp cả cho nháp do bot tạo. Vậy khi bật, `create_draft_order` sinh ra đơn CONFIRMED và sự kiện miền `order.confirmed` **trước** khi khách đồng ý, trong khi bot vẫn được báo là «nháp». Bật công tắc còn nâng luôn MỌI đơn NEW đủ thông tin đang có (`:857-868`) |
| Ghi đơn từ hội thoại nhân viên | `sc/order-sync.ts` (mặc định tắt) | Luật chủ shop HSLC chốt 05/10 (`:204-245`): (1) khách TỰ gửi SĐT + địa chỉ trong tin mới ⇒ là đơn, không cần xác nhận. (2) Khách cũ nhắn «giao lại về địa chỉ cũ» ⇒ đơn theo thông tin lần trước, máy nhắn khách xác nhận lại (`:273-280`, `:741-746`). (3) SĐT/địa chỉ chỉ có trong tin của shop ⇒ không phải đơn. Đơn được ghi NEW (`:719`), nhưng công tắc ở dòng trên vẫn nâng được lên CONFIRMED (`:729-731`) |
| Khoá lần mua | `order-create.ts:482-496`, `sc/tools.ts:349-357`, `sc/order-sync.ts:726`, `lib/records/chat-order.ts:194` | Khoá chỉ nằm trong `orders.raw->>'agentKey'`. Không có cột, không có chỉ mục, không có UNIQUE (`db/schema.ts:1338-1357`). Lượt tra nằm trong advisory lock nhưng **không lọc stage**. **SUY LUẬN:** một đơn đã huỷ hay đã xoá mang cùng khoá vẫn bị «dùng lại». Ba nguồn khoá: bot `sales-chat:<hội thoại>:<số đơn trước>`, máy ghi đơn `order-sync:<hội thoại>:<tin chốt>`, form nhân viên `chat:<hội thoại>:<requestKey>` |
| Chống trùng của máy ghi đơn | `sc/order-sync.ts:101-110`, `:693-695`, `:698-702`, `:726` | Bốn lớp: mốc cắt · dấu «Mã tin fanpage» trong ghi chú (không lọc stage) · cửa sổ 30 phút · khoá lần mua |
| Bằng chứng | `sc/engine.ts:948`; `sc/order-sync.ts:121`, `:255`, `:290` | `customer_confirmation` không được lưu thành dữ liệu có cấu trúc, chỉ nằm trong nội dung lời gọi công cụ. `summary` của máy ghi đơn bị bỏ ở nhánh tạo đơn, nên suy đoán «khách không nói số lượng ⇒ 1» không để lại dấu nào trên đơn |
| Sự kiện | `db/schema.ts:11106-11143`; `sc/events-shared.ts:22-42`, `:250-257`; `lib/events/emit.ts:43-67` | Có `order.drafted` và `order.confirmed` trong `sales_conversation_events`. Ngoài ra còn một dòng `order.confirmed` **riêng** trong `domain_events`. Khi công tắc bật, hai dòng này lệch thời điểm |
| Dấu lời nhắc / model | `sc/prompt-stamp.ts:15`, `sc/tools.ts:676`, `sc/events-shared.ts:255` | Chỉ có trên `state.confirmed.stamp` và trong payload sự kiện. Không có trên `orders`, không có cho nháp, máy ghi đơn hay đơn nhân viên |
| Danh tính | `sc/tools.ts:586-595`, `sc/fanpage.ts:1020-1022`, `sc/order-sync.ts:493` | «Đã xác minh» chỉ đạt được khi khớp mã Facebook, mà mã này chỉ có trên đường Pancake. Meta trực tiếp, Zalo và web luôn có `fbIds: []` |
| SĐT | `lib/records/customer-create.ts:44`, `:172`; `sc/returning.ts:63`; `lib/wholesale/phone.ts:41-43`, `:53` | Bot dùng `normalizeCustomerPhone` (8–15 chữ số, **không** đổi +84 thành 0). `returning.ts` có hàm thứ hai, và ngoài ra còn ≥ 20 hàm/regex khác trong `lib/` và `chatbot/`. Bộ kiểm chặt (đầu số di động theo nhà mạng, máy bàn 02, 1800/1900, không bao giờ bịa số) đã có nhưng chưa dùng cho đơn. SĐT trong nháp chỉ bị giới hạn `max(30)` (`sc/tools.ts:602`, `order-create.ts:171`) |
| Địa chỉ | `lib/address/vn-address.ts:188`, `:286-299` | `normalizeVnAddress` có 34 tỉnh / 3.321 xã và trả MATCHED · AMBIGUOUS (≤ 8 ứng viên) · PROVINCE_ONLY · UNKNOWN. **Bot không gọi hàm này**, nên địa chỉ mơ hồ không làm bot hỏi lại. Lõi đơn chỉ điền xã khi MATCHED (`:297`) |
| Giá · tồn | `lib/commerce/pricing.ts:19-70`, `sc/tools.ts:360-386`, `order-create.ts:375-379`; `lib/commerce/stock.ts:23-27` | Giá luôn tính ở máy chủ và cấm giảm giá. Tồn được khoá theo biến thể trong giao dịch |

## 2. State machine

| Trạng thái | Nghĩa | Có dòng `orders` không (giai đoạn 2) |
|---|---|---|
| `DETECTED` | Phát hiện ý định mua, có căn cứ trong tin của khách (món / giỏ, hoặc SĐT / địa chỉ) | không |
| `COLLECTING` | Đang gom các trường | không |
| `NEEDS_VERIFICATION` | Có trường then chốt INVALID, AMBIGUOUS hoặc chưa kiểm | không |
| `NEEDS_REVIEW` | Máy không tự quyết được: xung đột, SĐT trùng hồ sơ người khác, luật chặn. Chờ người | không |
| `READY_TO_CONFIRM` | Đủ 5 trường VERIFIED (§5), giá máy tính xong, **chưa** gửi tóm tắt | không |
| `AWAITING_CUSTOMER` | Đã gửi tóm tắt (có `summary_message_id` và ảnh chụp giá trị đã tóm tắt), đang chờ khách | không |
| `CONFIRMED` | Khách đồng ý (lưu tin đồng ý), hoặc người xác nhận (lưu `users.id`) | không |
| `CREATING` | Đang ghi vào hệ thống quản lý đơn (OMS), có khoá idempotent | — |
| `CREATED_IN_OMS` | Đơn đã có trong OMS: ERP `orders` CONFIRMED hôm nay, Pancake POS sau M10 | có |
| `OMS_ERROR` | Ghi OMS lỗi: giá đổi · hết hàng · hạn mức nợ · lỗi mạng | không (lỗi lưu ở `oms_error`) |
| `CANCELLED` | Khách huỷ, người huỷ, hoặc bị thay bằng candidate khác | — |
| `EXPIRED` | Bỏ dở quá N giờ (chủ shop khai). Đóng lại, không xoá | — |

**Giai đoạn 1 (ghi bóng):** luồng đơn hôm nay giữ nguyên hoàn toàn, nháp vẫn là dòng `orders` NEW. Candidate chỉ được ghi song
song để đo, nên không báo cáo nào đổi. **Giai đoạn 2:** chỉ ghi `orders` từ `CREATING` trở đi, và chỉ làm khi chủ shop duyệt (§9).

**Chuyển trạng thái hợp lệ.** Mỗi lượt chuyển ghi một sự kiện `candidate.*` vào `sales_conversation_events`, trong cùng giao dịch.

| Từ | Sang | Ai / thứ gì được chuyển | Điều kiện |
|---|---|---|---|
| (chưa có) | `DETECTED` | công cụ của AI · máy ghi đơn · nhân viên (form trong hộp thư) | ít nhất một tin của KHÁCH làm căn cứ |
| `DETECTED`, `COLLECTING` | `COLLECTING` | bộ trích (luật / AI) · nhân viên sửa | ghi trường mới (§3) |
| `COLLECTING` | `NEEDS_VERIFICATION` | **hệ thống** (kiểm tất định) | có trường then chốt INVALID / AMBIGUOUS / chưa kiểm |
| `NEEDS_VERIFICATION` | `COLLECTING` | khách gửi lại · nhân viên sửa | — |
| `COLLECTING`, `NEEDS_VERIFICATION` | `READY_TO_CONFIRM` | **chỉ hệ thống**, qua hàm thuần `readiness(candidate)` | 5 trường VERIFIED + giá máy tính OK |
| bất kỳ trạng thái mở | `NEEDS_REVIEW` | hệ thống | SĐT trùng hồ sơ người khác · hai candidate tranh nhau · luật chặn |
| `READY_TO_CONFIRM` | `AWAITING_CUSTOMER` | AI hoặc nhân viên gửi tóm tắt (tin có id) | lưu ảnh chụp giá trị + giá đã tóm tắt |
| `AWAITING_CUSTOMER` | `CONFIRMED` | (a) **khách**: tin SAU tóm tắt được phân loại là đồng ý, lưu `agreement_message_id` · (b) **nhân viên** bấm «Khách đã đồng ý», lưu `users.id` (AGENTS 34) · (c) chỉ khi chủ shop chọn phương án B ở §5: luật HSLC | (c) ghi `confirmed_via = RULE_HSLC` |
| `AWAITING_CUSTOMER` | `COLLECTING` | khách sửa một trường | tóm tắt cũ hết hiệu lực |
| `CONFIRMED` | `CREATING` → `CREATED_IN_OMS` | bộ ghi OMS (`ErpOrderSink` hôm nay) | khoá idempotent = `candidate.id` |
| `CREATING` | `OMS_ERROR` | bộ ghi OMS | lỗi nghiệp vụ hoặc lỗi mạng |
| `OMS_ERROR` | `CREATING` | người, hoặc job (có trần số lần thử) | lỗi tạm thời |
| `OMS_ERROR` | `COLLECTING` | hệ thống | giá hay tồn đổi ⇒ phải tóm tắt lại |
| mọi trạng thái trước `CREATING` | `CANCELLED` | khách (tin) · nhân viên | — |
| `DETECTED` … `AWAITING_CUSTOMER` | `EXPIRED` | job theo mốc chủ shop khai | không xoá |
| `CREATED_IN_OMS` | (không chuyển nữa) | — | Huỷ hay sửa đơn sau khi tạo là việc của OMS. Candidate chỉ ghi sự kiện tham chiếu |

**Năm bất biến.** Mỗi bất biến có một bài kiểm riêng.

1. Chỉ HỆ THỐNG đưa candidate vào `READY_TO_CONFIRM`. AI và người đều không làm được. Điều kiện là một hàm thuần.
2. Không lối nào tới `CONFIRMED` mà bỏ qua `AWAITING_CUSTOMER`, trừ đường (b) nhân viên và đường (c) khi chủ shop chọn. Đường (c)
   luôn để lại `confirmed_via` rõ ràng.
3. Chuyển trạng thái là compare-and-set (`UPDATE … WHERE id = $1 AND state = $2 AND version = $3`), ghi sự kiện cùng giao dịch.
4. Mỗi `(conversation_id, purchase_seq)` có nhiều nhất một candidate đang mở.
5. AI không bao giờ đặt `validation_state = VERIFIED`. Chỉ bộ kiểm tất định hoặc người đặt được.

**Ánh xạ từ cái ngầm hôm nay:**
- `state.draft` ↔ `READY_TO_CONFIRM` / `AWAITING_CUSTOMER`.
- `draft.shownTurn` ↔ `summary_message_id`.
- `state.confirmed` ↔ `CONFIRMED` / `CREATED_IN_OMS`.
- Nhánh CREATE của máy ghi đơn ↔ `DETECTED` → `CREATED_IN_OMS` theo luật HSLC.
- `autoConfirmComplete` ↔ một bước nhảy ẩn thẳng tới `CREATED_IN_OMS` ngay khi nháp đủ thông tin, kể cả khi khách chưa thấy
  tóm tắt.

## 3. Mô hình bằng chứng từng trường

Danh sách trường:
- `recipient_name` · `phone` · `address_raw` · `province` · `ward` · `items[]` (variant_id · quantity · unit) · `note` ·
  `payment_method`.
- `shipping_fee` và `total` **không** phải trường trích ra. Máy chủ tính chúng.

Mỗi lần một trường đổi giá trị thì ghi **một dòng mới**. Dòng cũ không bị xoá, chỉ được đánh dấu là đã bị thay.

| Thuộc tính | Kiểu | Ghi chú |
|---|---|---|
| `value_raw` | text | Đúng chữ được trích ra, để đối chiếu |
| `value_normalized` | jsonb | Kết quả bộ chuẩn hoá: E.164 · mã tỉnh/xã · `variant_id` |
| `confidence` | enum `HIGH` · `MEDIUM` · `LOW` · `UNKNOWN` | Mức của bộ trích. Không phải phần trăm, không hiển thị thành số |
| `source` | enum `CUSTOMER_MESSAGE` · `STAFF_MESSAGE` · `STAFF_EDIT` · `PREVIOUS_ORDER` · `CHANNEL_PROFILE` · `SYSTEM_DEFAULT` · `AI_INFERRED` | `PREVIOUS_ORDER` chỉ được dùng khi khách TỰ xin «giao như lần trước» (AGENTS 3.12) |
| `source_message_ids` | text[] | Id các tin chứa giá trị (`sales_chat_inbound.message_id` / id tin nhân viên) |
| `extractor` · `extractor_version` · `model` · `prompt_stamp` | text · text · text NULL · jsonb NULL | `RULE` / `AI` / `HUMAN`. Dấu lời nhắc dùng lại `sc/prompt-stamp.ts` |
| `validation_state` | enum `VERIFIED` · `INVALID` · `AMBIGUOUS` · `UNCHECKED` | §4 |
| `validation_detail` | jsonb | Lý do và ứng viên, ví dụ hai xã trùng tên |
| `set_by_user_id` | text NULL | Người sửa (AGENTS 34). NULL nghĩa là máy làm |
| `created_at` · `superseded_at` · `superseded_by` | | Giá trị hiện hành là dòng chưa bị thay mới nhất |

Ví dụ, dữ liệu giả:

| Trường | value_raw | source | validation_state | Panel (khối 4) nói |
|---|---|---|---|---|
| phone | «0912 xxx 678» | CUSTOMER_MESSAGE | VERIFIED | «SĐT: đúng định dạng di động (máy kiểm)» |
| ward | «P. Bến Thành» | CUSTOMER_MESSAGE | AMBIGUOUS (2 ứng viên) | «Địa chỉ: 2 xã trùng tên — cần hỏi lại» |
| quantity | — | SYSTEM_DEFAULT (= 1) | UNCHECKED | «Số lượng: khách không nói — đang để 1 (suy đoán)» |

Mọi dữ liệu này nằm trong CSDL của workspace (SILO), không bao giờ ra control plane.

## 4. Kiểm tất định

| Trường | Bộ kiểm | VERIFIED khi | Còn lại |
|---|---|---|---|
| SĐT | **Một hàm duy nhất**, gốc là `normalizeVnPhone` (`lib/wholesale/phone.ts:53`) | Di động 10 số đúng đầu số, hoặc máy bàn 02 + 9 số, **và** số nằm trong tin của khách hoặc do người nhập | Nhiều số trong một tin ⇒ AMBIGUOUS (hỏi lại). Sai đầu số ⇒ INVALID. Trùng SĐT hồ sơ người khác ⇒ `NEEDS_REVIEW` |
| Địa chỉ | `normalizeVnAddress` (`lib/address/vn-address.ts:188`) và kiểm «có trong tin khách» (`addressGrounded`, `sc/order-sync.ts:157-162`) | MATCHED tới cấp xã, và có căn cứ trong tin khách | AMBIGUOUS ⇒ hỏi lại, đưa ≤ 3 ứng viên (lệnh `/diachi` ở `INBOX_V2.md` §6). PROVINCE_ONLY / UNKNOWN ⇒ hỏi xã/phường |
| Sản phẩm / biến thể | Danh mục đang bán (`sellableCatalog`), biến thể còn tồn tại và chưa xoá (`lib/records/order-create.ts:215-237`) | Đúng MỘT biến thể khớp: khách nói rõ quy cách / size / màu | Nhiều biến thể ⇒ AMBIGUOUS, hỏi size/màu. Không đoán mẫu mã (AGENTS 3.11) |
| Số lượng / đơn vị | Số nguyên ≥ 1, đơn vị khớp quy cách | Khách nói rõ | Khách không nói ⇒ giá trị 1, `source = SYSTEM_DEFAULT`, `UNCHECKED`. **Không bao giờ** thành VERIFIED |
| Tên người nhận | Không rỗng, không phải SĐT | Khách gửi, hoặc lấy từ tên hồ sơ kênh | — |
| Giá · phí giao · tổng | **Không trích ra.** Luôn tính ở máy chủ (`priceLines`, `agentPriceGate`) | — | Giá đổi sau khi gửi tóm tắt ⇒ quay về `COLLECTING` để tóm tắt lại |

**Gom hàm SĐT (TD-20).**
- Một tệp, một hàm, trả `{ ok, e164, national, kind: MOBILE | LANDLINE | SPECIAL, reason }`.
- Thứ tự thay:
  1. Đường đơn và khách trước: `lib/records/customer-create.ts:172`, `sc/returning.ts:63`, `sc/order-sync.ts:143`,
     `lib/constants/manual-orders.ts:212-221`.
  2. Các chỗ khác thì thay dần, khi có PR nào chạm tới.
- Đổi cách chuẩn hoá SĐT của khách làm thay đổi phép khớp hồ sơ (+84… và 0… hôm nay là hai khách, **SUY LUẬN**). Vì vậy:
  - Đổi bằng cách so sánh lúc đọc, kèm bài kiểm.
  - **Không backfill** các hồ sơ cũ (AGENTS 35).

## 5. ZERO-UNVERIFIED AUTO-CONFIRM: lựa chọn cho chủ shop

**Định nghĩa.** Máy chỉ được tự đi tới `CONFIRMED` / `CREATED_IN_OMS` khi:
- **5 trường then chốt** đều VERIFIED: (1) SĐT, (2) địa chỉ tới cấp xã, (3) biến thể sản phẩm, (4) số lượng (khách nói rõ),
  (5) tên người nhận;
- **và** có căn cứ đồng ý (§2, các đường a/b/c).

Giá không nằm trong 5 trường vì luôn do hệ thống tính.

| Đường hôm nay | Luật đang chạy | Khoảng cách so với zero-unverified |
|---|---|---|
| `confirm_order` (bot) | Lời đồng ý là chuỗi con của câu cuối (`sc/tools.ts:648`). Tên · SĐT · địa chỉ chỉ cần không rỗng (`:652`) | SĐT không được kiểm định dạng. Địa chỉ không cần MATCHED. Câu phủ định vẫn qua |
| Công tắc `autoConfirmComplete` | NEW đủ thông tin ⇒ CONFIRMED (`lib/records/order-create.ts:460-464`), áp cả nháp bot | Không cần khách đồng ý. SĐT chỉ cần 8–15 số. Có đòi xã MATCHED |
| Máy ghi đơn, luật HSLC (05/10) | Khách tự gửi SĐT + địa chỉ ⇒ đơn (`sc/order-sync.ts:204-245`) | Không cần đồng ý: đây là **chủ shop HSLC chọn**. Địa chỉ chỉ cần ≥ 5 ký tự và có căn cứ, chưa cần MATCHED. Số lượng mặc định 1 mà không gắn cờ |

**Các phương án.** Chưa quyết: chờ chủ shop.

| Phương án | Nội dung | Được | Mất |
|---|---|---|---|
| **A. Giữ nguyên, đo trước** | Không đổi luật. Chỉ ghi bằng chứng (§3, chế độ bóng) và đo `false_auto_confirm_rate` trên Golden v2 và trên phát lại hội thoại cũ | Không ảnh hưởng HSLC | Đơn sai SĐT / xã mơ hồ vẫn lọt trong lúc đo |
| **B. Zero-unverified, giữ luật HSLC làm căn cứ đồng ý** | Luật HSLC vẫn được coi là khách đồng ý (đường c), **nhưng** chỉ khi 5 trường VERIFIED. Thiếu trường nào thì về `NEEDS_VERIFICATION`: bot hoặc máy hỏi lại, không chốt | Giữ tốc độ chốt của HSLC, chặn đơn sai SĐT hay xã mơ hồ | Một phần đơn HSLC chậm thêm một câu hỏi |
| **C. Zero-unverified nghiêm** | Luôn phải tóm tắt rồi khách đồng ý sau tóm tắt. Luật HSLC đổi thành «tạo candidate + gửi tóm tắt» | An toàn nhất | Đổi luật HSLC đã duyệt ngày 05/10, phải hỏi lại HSLC. Khách im lặng thì không có đơn |

Áp cho cả ba phương án: công tắc `autoConfirmComplete` **tách khỏi nháp của bot**. Chỉ áp cho đơn do người tạo, hoặc đòi đủ 5 trường
VERIFIED. Hôm nay nó âm thầm biến nháp thành đơn đã xác nhận.

**Khuyến nghị kỹ thuật:**
1. Làm A ngay để có số đo.
2. Chuyển sang B khi C1 có số.
3. C chỉ làm mặc định cho workspace **mới**, nếu chủ shop muốn.

**Sửa «nguyên văn».** Đi cùng C3 và không phụ thuộc phương án nào:
- Lời trích phải còn ≥ 2 chữ cái sau khi gập. Ký hiệu đơn thuần như «!!» không tính.
- Từ chối khi trước cụm trích có phủ định trong cùng câu («không», «chưa», «đừng», «thôi»).
- Lưu `agreement_message_id` thay vì chỉ lưu một chuỗi.
- Mỗi sửa đổi có một ca trong Golden v2 trước khi viết mã.

## 6. Khách sửa thông tin (§22)

1. Giá trị mới trong tin của **khách** thay giá trị cũ bằng một dòng trường mới. Dòng cũ được đánh dấu bị thay, không xoá.
   Nếu giá trị cũ do người sửa (`set_by_user_id` khác NULL), candidate quay về `NEEDS_VERIFICATION` và timeline ghi «Khách đổi
   SĐT (nhân viên đã sửa trước đó)». Máy không âm thầm đè lên việc của người.
2. Khách sửa khi đang `AWAITING_CUSTOMER` ⇒ về `COLLECTING`. Tóm tắt cũ hết hiệu lực và phải tóm tắt lại.
3. Khách sửa sau `CREATED_IN_OMS` ⇒ đi qua đường sửa đơn của OMS, có audit.
   - Kiện đã rời kho (`SHIPMENT_LEFT_WAREHOUSE`) thì không tự sửa nữa mà chuyển cho người.
   - ORDER_OUTCOME không đổi.
4. Lịch sử sửa hiện ở khối 4 của panel và trong timeline (`INBOX_V2.md` §5, §7).
5. Không bao giờ chép dữ liệu hồ sơ cũ vào đơn khi khách chưa xin. Chỉ được **gợi ý** (AGENTS 3.12; luật #647–#657 ở
   `lib/records/chat-order.ts:62`).

## 7. Chống trùng ở mọi đường (§23)

| Đường | Rủi ro | Cơ chế |
|---|---|---|
| Webhook lặp (Meta thử lại, Pancake gửi lại) | Một tin bị xử lý hai lần | Giữ `message_id` UNIQUE đã có ở `sales_chat_inbound`. Ghi trường idempotent theo `(candidate, field, source_message_id)` |
| Pancake và Meta cùng một page | Hai đường nhận cùng một hội thoại | Giữ luật một đường nhận cho mỗi page (`sc/channel-ownership.ts:84`). Candidate gắn với MỘT hội thoại |
| Worker thử lại / DLQ | Tạo đơn hai lần | Khoá idempotent của bộ ghi OMS là `candidate.id`, và có UNIQUE ở phía OMS (dòng cuối của bảng này) |
| Nhân viên bấm xác nhận đúng lúc job chạy | Đua nhau | Compare-and-set trạng thái + advisory lock theo hội thoại (`hashtextextended(concat('candidate:', conversation_id), 0)`) |
| AI đánh giá lại ở lượt sau | Sinh candidate thứ hai | UNIQUE partial trên `(conversation_id, purchase_seq)` cho các candidate đang mở |
| Bot và máy ghi đơn cùng một hội thoại | Hai nguồn tạo đơn | Cả hai chỉ ghi vào CÙNG một candidate. Không nguồn nào tạo đơn trực tiếp nữa |
| `agentKey` hôm nay | Không UNIQUE, tra không lọc stage | Lát C4: (1) đo số khoá trùng trên production bằng thao tác chỉ đọc, đếm `raw->>'agentKey'` có count > 1 theo từng tổ chức; (2) rồi thêm cột `orders.idempotency_key` UNIQUE partial (TD-03), R3 |

## 8. Bảng và migration DỰ KIẾN (chỉ phác, chưa tạo)

```text
sales_order_candidates                      -- CSDL workspace (SILO)
  id text pk · conversation_id text not null → sales_chat_conversations · purchase_seq int not null
  state text not null check (DETECTED|COLLECTING|NEEDS_VERIFICATION|NEEDS_REVIEW|READY_TO_CONFIRM|AWAITING_CUSTOMER|
                             CONFIRMED|CREATING|CREATED_IN_OMS|OMS_ERROR|CANCELLED|EXPIRED)
  version int not null default 0            -- compare-and-set
  order_id text null                        -- giai đoạn 1: dòng NEW; giai đoạn 2: chỉ khi CREATED_IN_OMS
  summary_message_id text null · summary_snapshot jsonb null
  agreement_message_id text null · confirmed_via text null check (CUSTOMER|STAFF|RULE_HSLC|AUTO_COMPLETE)
  confirmed_by_user_id text null · oms_error jsonb null · expires_at timestamptz null · created_at · updated_at
  unique (conversation_id, purchase_seq) where state not in ('CANCELLED','EXPIRED')

sales_order_candidate_fields
  id · candidate_id → sales_order_candidates · field text · value_raw text · value_normalized jsonb
  confidence text · source text · source_message_ids text[] · extractor text · extractor_version text
  model text null · prompt_stamp jsonb null · validation_state text · validation_detail jsonb
  set_by_user_id text null · created_at · superseded_at null · superseded_by null
  index (candidate_id, field) where superseded_at is null
```

- Sự kiện: thêm các kiểu `candidate.*` vào danh sách CHECK của `sales_conversation_events` (`sc/events-shared.ts:22-42`). **Không**
  tạo bảng sự kiện thứ hai.
- Migration là việc SERIAL: sửa `db/schema.ts` và `drizzle/`.
  - Phải giữ chỗ số hiệu qua sổ `ai-control/registry` trước khi đặt tên tệp.
  - Sổ hiện dừng ở `0235_ai_balance_ledger`. PR #631 đang mang `0236` (kiểm kê 08/10), nên số trống dự kiến là `0237`. Đọc lại
    lúc làm.
- Kiểm kê đề xuất **MỘT** migration chung với bảng danh tính kênh (lát B4) để chỉ một lần đi qua làn SERIAL.

## 9. Thứ tự PR

| PR | Nội dung | Vùng tệp | Phụ thuộc | Rủi ro |
|---|---|---|---|---|
| C1 (đang làm) | Golden Dataset v2 + bộ đo **lưu** kết quả | `tests/sales-agent-golden/**`, `sc/order-sync-bench.ts`, `sc/sales-bench.ts` | — | R0–R1 |
| C3a | Hàm thuần: state machine (`sc/candidate-shared.ts`), kiểm tất định, MỘT hàm SĐT. Chưa nối vào đường nào | `sc/candidate-shared.ts`, `lib/commerce/phone.ts`, `tests/order-candidate.test.ts` | tài liệu này được duyệt | R1 |
| C3b | Migration bảng candidate (gộp với B4). **Chỉ ghi bóng**: bot và máy ghi đơn ghi candidate song song, hành vi đơn không đổi | `db/schema.ts`, `drizzle/`, đường ghi trong `sc/tools.ts` và `sc/order-sync.ts` | C3a | R3 |
| C3c | Panel khối 3–4 đọc candidate | `app/(dashboard)/ai/sales-chatbot/inbox/copilot-panel/*` | C3b, V2-6 | R1 |
| C4 | Đo khoá trùng trên production → cột `idempotency_key` UNIQUE | `lib/records/order-create.ts`, migration | có số đo | R3 |
| C3d | Đổi luật chốt theo phương án chủ shop chọn. Có công tắc theo workspace, mặc định giữ hành vi cũ | `sc/tools.ts`, `lib/records/order-create.ts`, `sc/order-sync.ts` | C1 có số **và** chủ shop đã quyết | R3 (R4 với HSLC) |
| C5 | Gom các hàm SĐT còn lại | nhiều tệp | C3a | R1 |

## 10. Golden Dataset v2 (lát C1) cần có gì cho tài liệu này

- **Ca mới**, mỗi ca có nhãn đúng/sai cho từng trường:
  - khách sửa SĐT / địa chỉ giữa chừng;
  - đơn trùng (gọi lại, webhook lặp);
  - SĐT của người khác;
  - ghi đơn từ hội thoại nhân viên;
  - câu phủ định («không chốt đâu») và câu chỉ có ký hiệu («!!»);
  - nhiều SĐT trong một tin;
  - hai xã trùng tên;
  - khách không nói số lượng;
  - khách cũ «giao như lần trước» trên kênh không phải Pancake.
- **Chỉ số được lưu**, không chỉ in ra (kiểm kê B#23):
  - `order_intent_recall`;
  - độ đúng từng trường;
  - `false_auto_confirm_rate`;
  - `duplicate_order_rate`.
- **Dữ liệu thật có PII.** Kho mã PUBLIC nên không được chứa hội thoại thật. Phải che SĐT/tên bằng cùng bộ che của `playbook.ts`,
  và nơi lưu bản chưa che là quyết định của chủ shop (§11).

## 11. Câu hỏi cho chủ shop

1. Chọn phương án nào ở §5: A, B hay C?
2. Công tắc «đơn đủ thông tin = đã xác nhận» có còn được áp cho **nháp của bot** không? Đề xuất là không.
3. HSLC có đồng ý để máy hỏi lại khi địa chỉ mơ hồ hoặc SĐT sai đầu số, thay vì chốt luôn không?
4. Candidate bỏ dở thì đóng (`EXPIRED`) sau bao nhiêu giờ?
5. Hội thoại thật có nhãn dùng cho Golden v2 được lưu ở đâu (có PII, không được vào kho PUBLIC)?

## 12. Quyết định chủ shop 08/10/2026

Đã chốt, đã có trong mã (`lib/constants/order-review.ts`, cờ CẦN NGƯỜI KIỂM ở `orders.raw.review` của đơn tay):

1. **Công tắc «đơn đủ thông tin = đã xác nhận» CÓ áp cho nháp của bot.** Giữ nguyên hành vi (trả lời câu hỏi 2 ở §11).
2. **Khách huỷ sau khi đã có đơn (nháp hoặc đã xác nhận) ⇒ máy KHÔNG tự huỷ.** `mark_declined` ghi chú «khách huỷ» (nguyên văn +
   mốc) lên đơn của chính hội thoại và gắn cờ CẦN NGƯỜI KIỂM. Người huỷ đơn, hoặc cứu được thì xác nhận lại.
3. **Địa chỉ chưa ghép được xã / phường ⇒ VẪN chốt, kèm cờ CẦN NGƯỜI KIỂM** và lý do; người sửa xã rồi xác nhận lại.
4. **Nút nhanh «Xác nhận đơn» / «Huỷ đơn»** ở hộp thư (panel đơn của hội thoại) và quản lý đơn (danh sách + chi tiết), lọc
   «Cần kiểm» ở danh sách đơn. Nút đi qua đúng server action / lõi đổi trạng thái đơn đang có.

Hệ quả cho luật 04/10 (ghi ở đây, không sửa đặc tả `docs/business-rules/ORDER_OUTCOME.md` — đặc tả do chủ shop giữ):

- Công tắc **không nâng** đơn `NEW` đang mang cờ «khách huỷ» (đúng vế «trừ những đơn huỷ»).
- Cờ cần kiểm **không đổi `stage` và không đổi `ORDER_OUTCOME`**: đơn `CONFIRMED` mang cờ vẫn là đơn đã xác nhận và vẫn được đếm ở
  mọi báo cáo như trước cho tới khi người huỷ (`CANCELLED`) — không có phép trừ tạm nào theo cờ.
