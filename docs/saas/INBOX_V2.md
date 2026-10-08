# Hộp thư V2 — bàn điều khiển Bán hàng & Đơn (thiết kế)

*MASTER MISSION §8–§15 và §24 · lát B1 (R0) · 08/10/2026 · số dòng mã đối chiếu trên `origin/main` `217cb26c` (đã có #661 «câu mẫu
+ dòng sản phẩm ở ô soạn»). Số đo màn hình lấy từ bản chạy thử cục bộ của `051f49a5`, tức trước #661 (PGlite, `next build` +
`next start`, Chrome headless, workspace vỏ Chốt Đơn tự đăng ký, 40 hội thoại GIẢ). Đây là tài liệu THIẾT KẾ: không dòng mã nào
đổi. Chỗ ghi **SUY LUẬN** là chưa được kiểm bằng bài kiểm hay số đo production.*

Đọc kèm:
- `docs/productization/CHOTDON_SMART_ROADMAP.md`: A3 (điểm chốt), A4 (Copilot), C1 (hạn trả lời), C2 (tóm tắt).
- `docs/productization/TARGET_ARCHITECTURE.md` §②: các trạng thái điều khiển hội thoại.
- `docs/productization/AI_SALES_PRODUCT_SPEC.md` §4: guardrails.
- `docs/design-system.md`: ba lớp bề mặt, và màu chưa biết ≠ màu xấu.
- `ORDER_CANDIDATE.md`: khối «Đơn đang lên» và «Độ chắc của đơn».
- `SHELL_AUDIT_2026-10-08.md`.
- AGENTS mục 19, 22, 26, 38, 42.

Viết tắt dùng trong tài liệu: `inbox/` = `app/(dashboard)/ai/sales-chatbot/inbox/`, `sc/` = `lib/sales-chatbot/`. Số «B#n» trỏ tới
dòng n của bảng kiểm kê hiện trạng ngày 08/10 (mục B).

## 0. Quyết định trong một bảng

| # | Quyết định | Vì sao |
|---|---|---|
| D1 | Giữ khung 3 cột đang có, chỉ đổi mật độ và lớp màu. Không viết lại | Khung đã chạy (B#8); việc cần làm là bớt chiếm chỗ, không phải đổi kiến trúc |
| D2 | Ưu tiên P0–P3 là một **hàm thuần** `inboxPriority()` đặt ở `sc/inbox-priority-shared.ts` (tệp mới). Hạng tính lúc đọc, không ghi cột | Giống AGENTS 26: hàm của thời gian thì luôn đúng tới từng giây và không tốn dòng CSDL nào |
| D3 | Danh sách **không tự sắp lại** khi người đang xem; hạng mới hiện trong một dải «bấm để sắp lại» | Lượt làm mới 5 giây hôm nay đổi thứ tự dòng ngay dưới tay người bấm |
| D4 | Bộ lọc gọn còn **một hàng ≤ 5 chip** và một ngăn «Lọc». Đích: dòng hội thoại nhìn thấy trọn **tăng ≥ 30%** (đo được: 3 → ≥ 4 ở 1366×768) | Khối lọc đang chiếm ~300 px trước dòng hội thoại đầu tiên |
| D5 | Timeline đọc thêm `sales_conversation_events` để hiện sự kiện hệ thống. Sự kiện không bao giờ vẽ thành bong bóng | Bảng sự kiện đã được ghi nhưng chưa có mã hộp thư nào đọc |
| D6 | Ô soạn không có bảng câu mẫu thứ hai: mở rộng đúng `sales_chat_quick_replies` mà #661 đang dùng | AGENTS: dùng lại, không dựng hệ song song |
| D7 | Panel phải «Sales Copilot» có 7 khối. «Độ chắc của đơn» viết bằng **câu theo từng trường**, không in phần trăm | Độ tin của bộ trích chưa được hiệu chuẩn, nên một con số % là khẳng định không có căn cứ (AGENTS 8.6, 44) |
| D8 | **Đo trước, sửa sau**: có số nền p50/p95 và số câu SQL rồi mới đổi đường làm mới hay truy vấn | Kiểm kê B#24: chưa có số nền nào |
| D9 | Tách `inbox/thread-view.tsx` (491 dòng) thành các tệp nhỏ trong một PR thuần di chuyển, trước mọi tính năng | Tệp đó đang ôm cả ô soạn lẫn panel nên là điểm va chạm giữa các phiên (B#8) |

## 1. Hiện trạng: đo từ mã và từ bản chạy thử

| Mảnh | Ở đâu | Hiện nay | Khoảng trống |
|---|---|---|---|
| Khung | `inbox/page.tsx:27-34`, `inbox/thread-view.tsx:236` | Lưới `lg:grid-cols-[360px_minmax(0,1fr)]`. Cột 3 (320 px) chỉ có từ `xl` (≥ 1280 px). Dưới `xl`, panel phải là lớp phủ toàn màn (`thread-view.tsx:428-431`). Trên điện thoại, danh sách ẩn khi mở hội thoại (`page.tsx:213`, `:353`) | Từ 1024 tới 1279 px, muốn xem khách là phải che cả hội thoại |
| Danh sách | `listInbox` `sc/inbox.ts:254` | Mặc định 100 dòng, trần `INBOX_LIST_MAX = 500` (`sc/inbox-shared.ts:77`, `page.tsx:146`). Sắp `desc(ACTIVITY)`, trong đó `ACTIVITY = greatest(...)` (`inbox.ts:112`, `:346`). Riêng «Chờ trả lời» sắp người chờ lâu nhất lên trước | Không có hạng ưu tiên. Thứ tự đổi ở mỗi lượt làm mới |
| Đếm thẻ | `inbox.ts:295-302`, `:303-308` | Một câu `count(*) filter` cho 10 thẻ và một câu GROUP BY theo level. Không LIMIT, chạy ở mọi lượt dựng | Quét toàn bộ hội thoại không phải TEST mỗi 5 giây (§8) |
| Làm mới | `inbox/auto-refresh.tsx:44`, `:55-59` | `router.refresh()` mỗi 5 giây khi tab đang hiện, 30 giây khi tab ẩn. Chạy độc lập với SSE `/api/events` (`components/realtime-provider.tsx:97`; sự kiện `chat` làm mới sau `URGENT_GAP` = 2 giây, `:36`) | Hai đường làm mới chồng nhau |
| Tín hiệu ưu tiên | `inbox/page.tsx:39-40`, `:100-102` | Chip đỏ khi khách chờ ≥ 15 phút (`WAIT_URGENT_MIN`), chip vàng dưới mức đó. Đây chỉ là màu, không sắp theo nó | B#9: chưa có điểm và chưa có sắp P0–P3 |
| Bộ lọc | `sc/inbox-shared.ts:18`, `inbox/page.tsx:215-335` | 10 thẻ, «Có SĐT», 3 mốc ngày, 9–10 thẻ level, ô tìm tên/SĐT và «Lọc nâng cao» (kênh, nhãn, nhân viên, kỳ) | Không lọc được theo nguồn Pancake/Direct. Không tìm được theo nội dung tin (B#10) |
| Timeline | `inbox.ts:483`, `:605`; `inbox/thread-view.tsx:40-41`, `:54-71` | Tối đa 200 tin, không tải được tin cũ hơn. Tin cùng một người trong vòng 5 phút gom chung một đầu mục | Sự kiện hệ thống không vào timeline. `sales_conversation_events` được ghi (`inbox.ts:741`) nhưng không mã hộp thư nào đọc (B#11–12) |
| Ô soạn | `inbox/thread-view.tsx:349-425`, `:397-402` | Enter gửi, Shift+Enter xuống dòng. Bỏ qua Enter khi bộ gõ tiếng Việt còn đang ghép chữ (`isComposing`). Gửi qua `sendStaffReplyCore` (`inbox.ts:660-743`), idempotent theo `requestKey` | Kiểm kê B#13 ghi «chưa có» lúc 11:00. Câu mẫu và dòng sản phẩm đã vào main qua #661 (dòng dưới). Còn thiếu lệnh `/` và thẻ sản phẩm có ảnh |
| Câu mẫu + sản phẩm (#661, lát B0) | `inbox/composer-tools.tsx` (365 dòng), `sc/inbox-composer.ts` (237 dòng); gộp 08/10, `07ef8aa8` | Nút «Câu mẫu» và «Sản phẩm» chèn chữ tại con trỏ, không tự gửi (`thread-view.tsx:412`). Đọc bảng `sales_chat_quick_replies` có sẵn (`sc/inbox-composer.ts:184`, `:198`). Điền chỗ trống bằng `renderQuickAnswer` lúc bấm (`:200`) | Phạm vi câu mẫu chỉ là cả workspace. Chưa có lệnh `/` |
| Panel phải | `inbox/thread-view.tsx:428-488`, `inbox/customer-insight.tsx:18-52` | Các khối Khách · Lịch sử mua & giao (theo ORDER_OUTCOME) · Đơn của khách + «Tạo đơn» · Góp ý cho AI · Ghi chú | Chưa có «bước tiếp theo» (B#14). Gợi ý Copilot được lưu ở `sales_copilot_suggestions` (`db/schema.ts:11228-11253`) nhưng hộp thư không đọc, chỉ trang `/ai/sales-chatbot/copilot` đọc |
| Thanh điều khiển AI | `inbox/control-bar.tsx:139-144`, `:173`, `:179` | Ở khổ 1366, thanh cao ~130 px và nói «AI chưa sẵn sàng» ba lần. Ở workspace khách, cụm «đội ngũ đang xử lý» in hai lần liên tiếp: lý do đã chứa cụm này (`lib/saas/visibility.ts:208`), dòng `:179` in thêm lần nữa | Chiếm chỗ của timeline |

**Đo trên bản chạy thử** (40 hội thoại giả, workspace vỏ Chốt Đơn; kịch bản đếm các dòng `[data-testid=inbox-list] > li`
nằm trọn trong màn hình):

| Khổ màn | Mép trên dòng đầu | Cao một dòng | Dòng thấy trọn |
|---|---|---|---|
| 1280×720 | 446 px | 105 px | 2 |
| 1366×768 | 446 px | 105 px | 3 |
| 1440×900 | 446 px | 105 px | 4 |
| 390×844 | 474 px | 84 px | 3 |

Ở 1366×768, khối lọc chiếm từ y = 147 tới y = 446 (~300 px). Trong đó có 6 hàng chip, ô tìm và hai ngăn gập («Lọc nâng cao»,
«Đường nhận tin & AI nhường»).

Tải hẳn trang hộp thư thì thấy: một lần xin RSC ban đầu, hai lần gọi server action ngay khi trang dựng xong, bốn lần prefetch
trang vỏ, rồi cứ 5 giây thêm một lần xin RSC.

## 2. Bố cục 3 cột và lớp màu (B#8)

| Khổ | Cột | Đổi so với hôm nay |
|---|---|---|
| ≥ 1280 px | danh sách 320 · hội thoại · panel 340 | Danh sách hẹp hơn 40 px. Panel rộng hơn 20 px để khối «Đơn đang lên» không phải xuống dòng |
| 1024–1279 px | danh sách · hội thoại. Panel là **ngăn trượt phải** rộng 360 px, hội thoại vẫn nhìn thấy | Hôm nay là lớp phủ toàn màn (`thread-view.tsx:428-431`) |
| < 1024 px | một cột: danh sách ↔ hội thoại. Panel là **bottom sheet** có ba thẻ (Khách · Đơn · Lịch sử) | Giữ cách ẩn/hiện danh sách. Khối «Bước tiếp theo» ghim thành một dòng ngay trên ô soạn |

Lớp màu chỉ dùng **ba bề mặt** của `docs/design-system.md` §1. Không chế thêm lớp thứ tư.

| Vùng | Bề mặt | Ghi chú |
|---|---|---|
| Nền trang, vùng trống, trạng thái rỗng | `--surface-sunken` | |
| Cột danh sách, khung hội thoại, các thẻ trong panel | `--surface` (`bg-card`) | Viền bao khối là `--border`, kẻ trong khối là `--hairline` |
| Ngăn «Lọc», bottom sheet, bảng gợi ý `/` | `--surface-raised` | |
| Tin khách | `bg-card` có viền, nằm trên nền timeline chìm | Hôm nay tin khách `bg-muted` (`thread-view.tsx:34`) nằm trên nền `bg-muted/20` (`:298`), nên gần như không tách ra |
| Tin bot / tin nhân viên | giữ tím / xanh lá như hiện tại | Màu mang nghĩa «ai nói», không phải trang trí |
| Sự kiện hệ thống | chữ nhỏ ở giữa, không nền, không avatar | §5 |
| Hạng P0 / P1 | vạch màu 3 px ở mép trái dòng + nhãn chữ | P0 dùng `warning` (cần người xử lý), không dùng `destructive` vì không có gì hỏng. Hạng **không** đổi màu nền cả dòng |

Thanh điều khiển AI thu về **một dòng**: trạng thái và một nút chính (ví dụ «Bật bot» hay «Tiếp quản»). Phần giải thích nằm trong
một popover. Sửa luôn lỗi in đôi cụm chữ ở `control-bar.tsx:179`.

## 3. Ưu tiên thông minh P0–P3: đặc tả hàm thuần (B#9)

Tệp mới `sc/inbox-priority-shared.ts`: chạy được ở cả client lẫn server, không import CSDL. Máy chủ gọi hàm trong `listInbox` cho
từng dòng rồi trả `rank` và `reasons` vào props. Client chỉ vẽ.

```ts
// Phác thảo, chưa phải mã.
type Unknownable<T> = T | null;                      // null = CHƯA BIẾT (AGENTS 42), không phải «không»
type PriorityInput = {
  now: Date;                                         // truyền vào, không đọc đồng hồ thật (AGENTS 50)
  control: "AI_ACTIVE" | "HANDOFF_PENDING" | "HUMAN_ACTIVE" | "AI_PAUSED" | "CLOSED"; // từ aiHoldOf + status, TARGET_ARCHITECTURE §②
  claimed: boolean;                                  // đã có người nhận (assignee_user_id)
  unreadCount: number;                               // UNREAD_COUNT đã có, trần 100
  waitingSince: Unknownable<Date>;                   // tin khách chưa ai trả lời (NEEDS_REPLY, inbox.ts:403)
  lastFrom: "CUSTOMER" | "BOT" | "STAFF" | "PAGE";
  hasPhone: Unknownable<boolean>;
  hasAddress: Unknownable<boolean>;
  candidate: Unknownable<{ state: CandidateState; blocking: FieldKey[] }>; // ORDER_CANDIDATE.md §2
  replySlaMinutes: Unknownable<number>;              // từ getWorkConfig() (AGENTS 22) — KHÔNG hard-code
  intent: Unknownable<{ kind: "BUY" | "COMPLAINT" | "SUPPORT" | "OTHER"; source: "RULE" | "AI"; level: "HIGH" | "LOW" }>;
};
type PriorityOutput = { rank: "P0" | "P1" | "P2" | "P3"; reasons: ReasonCode[]; since: Date | null };
```

**Hạng**: luật đầu tiên khớp quyết định hạng. Mọi luật khớp đều được ghi vào `reasons`, để màn hình nói ra được *vì sao*.

| Hạng | Điều kiện (chỉ cần một) | Mã lý do |
|---|---|---|
| **P0**: cần người ngay | AI đã nhường (`HANDOFF_PENDING`) mà chưa ai nhận · candidate ở `NEEDS_REVIEW` hoặc `OMS_ERROR` (có tiền đang treo) · khách chờ quá hạn trả lời (`waitingSince + replySlaMinutes < now`) · intent COMPLAINT có `source = RULE`, hoặc `source = AI` với `level = HIGH` | `HANDOFF_WAITING`, `ORDER_NEEDS_REVIEW`, `ORDER_OMS_ERROR`, `SLA_BREACHED`, `COMPLAINT` |
| **P1**: nên trả lời sớm | Khách đang chờ, còn trong hạn, và có ít nhất một tín hiệu mua: có SĐT, có địa chỉ, intent BUY, hoặc candidate đang `COLLECTING` / `NEEDS_VERIFICATION` / `AWAITING_CUSTOMER` · hội thoại do người làm (`HUMAN_ACTIVE`) mà khách vừa nhắn · intent COMPLAINT với `level = LOW` | `WAITING_BUYER`, `HAS_CONTACT`, `CANDIDATE_OPEN`, `HUMAN_THREAD_NEW`, `COMPLAINT_UNSURE` |
| **P2**: theo dõi | Có tin chưa đọc nhưng AI đang xử lý và chưa quá hạn · khách đang chờ nhưng chưa thấy tín hiệu mua | `AI_HANDLING`, `WAITING_OTHER` |
| **P3**: chưa cần làm gì | Tin cuối là của shop hoặc bot và khách chưa nhắn lại · hội thoại đã đóng · candidate `CREATED_IN_OMS` và không có tin mới | `NO_ACTION`, `CLOSED`, `ORDER_DONE` |

Sáu luật đi kèm:

1. **Chưa biết thì không hạ hạng.** `hasPhone = null` hay `intent = null` không đẩy được một hội thoại xuống P3. Tin khách chưa
   ai trả lời luôn ở mức ≥ P2. Đây là cùng tinh thần AGENTS 48: chưa rõ thì coi là nóng.
2. **Không có giờ cố định trong mã.** Hạn trả lời đọc qua `getWorkConfig()` (AGENTS 22). Chủ shop chưa khai thì không bao giờ ra
   `SLA_BREACHED`, và hội thoại vẫn xếp theo thời gian chờ. Hằng `WAIT_URGENT_MIN = 15` (`page.tsx:40`) giữ nguyên vai trò màu
   nhắc. Không biến nó thành hạn (AGENTS 38).
3. **AI chỉ là một lý do, và luôn mang nhãn ước tính.** Intent do AI đoán chỉ đẩy lên P0 khi mức HIGH. Mức LOW thì dừng ở P1
   (`COMPLAINT_UNSURE`). Luật từ khoá tất định (`source = RULE`) đứng trước.
4. **Thứ tự trong cùng hạng:** `since` cũ nhất lên trước, hoà nhau thì so `conversation.id`. Chạy hai lần với cùng đầu vào phải ra
   cùng kết quả (AGENTS 25).
5. **Tính lúc đọc:** không có cột `priority` hay `rank` trong CSDL. Hạng thay đổi theo `now`.
6. **Không chấm người:** hạng không đi vào thẻ điểm nhân viên (AGENTS 24). Số đo duy nhất là thời gian tới phản hồi đầu tiên của
   P0 và P1, tính theo đội, có kèm độ phủ.

**Chống nhảy loạn khi người đang xem**

| Luật | Cách làm |
|---|---|
| A. Giữ thứ tự đã thấy | Trong một phiên xem, client giữ danh sách id theo thứ tự đã vẽ. Lượt làm mới chỉ vá nội dung từng dòng tại chỗ (`docs/design-system.md` §7: vá tại chỗ, không cuộn) |
| B. Hội thoại đang mở đứng yên | Dòng đang mở không bao giờ đổi vị trí và không bao giờ mất trạng thái chọn |
| C. Nâng hạng thì báo, không chen ngang | Hội thoại mới lên P0/P1 không chèn vào giữa danh sách. Nó hiện trong dải trên cùng: «2 hội thoại cần xử lý — bấm để sắp lại» |
| D. Hạ hạng có trễ | Một dòng chỉ được tụt khỏi P0/P1 sau khi người rời hội thoại, hoặc sau 60 giây không thao tác. Hằng số đặt trong tệp thuần, có bài kiểm khoá |
| E. Khi nào được sắp lại | Mở trang · đổi bộ lọc · bấm dải báo · quay lại tab sau ≥ 5 phút |

**Bài kiểm của lát mã:** bảng ca biên gồm hạn đúng bằng mốc, chưa khai hạn, intent null, AI LOW so với HIGH, HANDOFF đã nhận so
với chưa nhận, candidate ở từng trạng thái. Thêm kiểm tính ổn định (hai lần chạy cùng kết quả) và không phụ thuộc đồng hồ thật.

## 4. Bộ lọc gọn (B#10)

**Hàng chip tối thiểu**: một hàng, trên điện thoại cuộn ngang. Mặc định là «Cần xử lý» khi có ít nhất một hội thoại ở P0/P1.

| Chip | Nghĩa | Thay cho |
|---|---|---|
| Cần xử lý | P0 + P1 (§3) | — (mới) |
| Chưa đọc | như hôm nay | giữ |
| Của tôi | như hôm nay | giữ |
| Có SĐT chưa đơn | có SĐT, chưa có đơn | ghép «Có SĐT» với «Chưa chốt» |
| Tất cả | | giữ |

**Ngăn «Lọc (n)»** ở lớp `--surface-raised` chứa phần còn lại:
- AI / Người · Cần người · Đã chốt · Chưa ai nhận.
- Kênh / page · nhãn · nhân viên · kỳ.
- Level (9–10 thẻ).
- **Nguồn Pancake / Direct (mới)**.
- **Tìm theo nội dung tin (mới)**: phải đo chi phí trước (§8), vì `ILIKE '%q%'` trên bảng tin là quét toàn bảng.

Số đếm chỉ tính cho 5 chip của hàng đầu. Số trong ngăn chỉ tính khi mở ngăn, nhờ vậy mỗi lượt làm mới bớt được câu đếm (§8).

Mọi tham số URL giữ nguyên (`pg`, `lb`, `nv`, `tg`, `lv`, `sdt`, `c`) để liên kết cũ không gãy.

**Đích đo được** (cùng kịch bản ở §1):

| Khổ | Hôm nay | Đích tối thiểu (+30%) | Cách đạt |
|---|---|---|---|
| 1366×768 | 3 dòng | ≥ 4 | Khối lọc còn ≤ 100 px, nên mép trên ~250 px và có (759 − 250) / 105 ≈ 4,8 dòng. Thêm chế độ «gọn» (dòng 72 px) thì được 7 |
| 390×844 | 3 dòng | ≥ 4 | Một hàng chip, ô tìm thu thành biểu tượng, hai ngăn gập đưa vào ngăn «Lọc» |

## 5. Timeline (B#11–12)

**Gom bong bóng.** Giữ luật 5 phút (`thread-view.tsx:40-41`). Thêm: tin liên tiếp cùng phía cách nhau dưới 60 giây thì không lặp
lại giờ. Giữ vạch ngày như hiện nay.

**Sự kiện hệ thống** đọc từ `sales_conversation_events` (`db/schema.ts:11106-11143`, các kiểu ở `sc/events-shared.ts:22-42`) và
từ candidate (`ORDER_CANDIDATE.md`). Cách vẽ: một dòng ở giữa, chữ nhỏ, có biểu tượng, **không** bong bóng và **không** avatar.
Sự kiện không bao giờ trông như một tin của khách.

| Kiểu | Câu hiện | Ai thấy |
|---|---|---|
| `human.took_over` / nhận hội thoại | «Lan nhận hội thoại» | mọi người |
| `handoff.requested` | «AI chuyển cho người: khách khiếu nại» | mọi người. Lý do ghi bằng lời, không in mã |
| `ai.resumed` | «AI trả lời lại (hết 30 phút nhường)» | mọi người |
| `order.drafted` / `candidate.*` | «Đơn nháp tạo: 2 món, 450.000 ₫» · «Khách đổi SĐT» | mọi người |
| `order.confirmed` | «Khách đồng ý đơn» kèm trích một dòng của tin đồng ý | mọi người |
| `followup.sent` | «Máy nhắn lại khách (mốc 6 giờ)» | mọi người |
| `stage.changed` / `quote.given` | không hiện mặc định, chỉ hiện trong chế độ «chi tiết» | người quản lý |

Workspace khách không thấy mã máy (`lib/saas/visibility.ts`). Câu chữ theo bảng thuật ngữ ở `HELP_CENTER.md` §6.

**Tải tin cũ.** Con trỏ `(created_at, id)` lùi 100 tin mỗi lần, qua nút «Xem tin cũ hơn». Lượt đầu giữ trần 200.
Chỉ mục `sales_chat_inbound (page_id, thread_id, status)` hiện không có `created_at` (`db/schema.ts:11076`). Nếu §8 đo ra chậm thì
thêm chỉ mục đó trong một migration riêng (R3, theo luật SERIAL).

## 6. Ô soạn (B#13)

**Phím**
- Giữ hành vi ở `thread-view.tsx:397-402`.
- Thêm Ctrl/⌘ + Enter cũng gửi. Esc đóng bảng gợi ý.
- **Trên màn cảm ứng** (`pointer: coarse`), đề xuất Enter là xuống dòng và gửi bằng nút, vì bàn phím ảo không có Shift+Enter.
  Đây là câu hỏi cho chủ shop (§10).

**Lệnh `/`**
- Gõ `/` ở **đầu dòng** sẽ mở bảng gợi ý, dùng cùng thành phần cmdk với `inbox/composer-tools.tsx` (#661).
- Lệnh chỉ **chèn chữ**, người vẫn phải bấm Gửi. Đây cũng là luật của #661.

| Lệnh | Chèn gì | Nguồn | Khi thiếu dữ liệu |
|---|---|---|---|
| `/gia` | giá của biến thể đang bàn (hoặc một biến thể người chọn), đọc lại ở máy chủ | ô `{{giá:SKU}}` của `renderQuickAnswer` (`sc/quick-replies.ts:103-137`) | không chèn, báo «mẫu mã chưa có giá» |
| `/ship` | phí giao theo luật cấu hình | `sc/shipping.ts` | «shop chưa khai phí giao» |
| `/diachi` | câu xin địa chỉ. Nếu địa chỉ của candidate đang AMBIGUOUS thì là câu hỏi lại xã/phường, kèm ≤ 3 lựa chọn | `ORDER_CANDIDATE.md` §4 | câu xin địa chỉ chung |
| `/cod` | câu về COD / chuyển khoản | hồ sơ và chính sách của shop | «shop chưa khai cách thanh toán» |
| `/xacnhan` | tóm tắt đơn đang lên: món, số lượng, giá do máy tính, người nhận | candidate + `priceLines` (`sc/tools.ts:360-386`) | **chặn** khi còn trường then chốt chưa xác minh, và nói rõ trường nào |
| `/upsell` | câu mời mua thêm theo sản phẩm đang bàn | câu mẫu ở phạm vi sản phẩm | không chèn |

**Phạm vi câu mẫu.** Mẫu hẹp đè mẫu rộng theo thứ tự: sản phẩm > page > workspace > nền tảng.

| Phạm vi | Ai sửa | Lưu ở đâu |
|---|---|---|
| Nền tảng | đội sản phẩm | mã nguồn, đi kèm gói ngành (TARGET_ARCHITECTURE T9). Khách chỉ đọc |
| Workspace | chủ shop | `sales_chat_quick_replies`, như hôm nay. #661 đang đọc bảng này |
| Page | chủ shop | thêm cột `page_id` (cho phép NULL) trên **cùng bảng** |
| Sản phẩm | chủ shop | thêm cột `product_id` / `variant_id` (cho phép NULL) trên cùng bảng |

Tài liệu này **không** định nghĩa bảng câu mẫu thứ hai. Thêm các cột phạm vi là một migration riêng (làn SERIAL), đọc qua đúng
`sc/inbox-composer.ts` của #661. `sales_chat_quick_replies` hiện dùng chung cho bot trả lời 0 token (`sc/quick-replies.ts:148-152`), nên câu mẫu «chỉ dành cho
nhân viên» cần thêm một cột đối tượng (`BOT | STAFF | BOTH`). Đây là câu hỏi ở §10.

## 7. Panel phải «Sales Copilot»: 7 khối (B#14, B#27)

| # | Khối | Nội dung | Nguồn | Khi chưa biết |
|---|---|---|---|---|
| 1 | Khách | Tên · SĐT (đã / chưa xác minh) · địa chỉ · kênh · level · nhãn | đã có (`thread-view.tsx:440-454`). Mức tin danh tính từ `chatCustomerTrust` (`lib/records/chat-order.ts:62`) | «Chưa có SĐT». Không bao giờ in «0» |
| 2 | Tóm tắt AI | 1–2 câu: khách muốn gì, đang kẹt ở đâu (roadmap C2) | **mới**: chỉ gọi khi người bấm. Kết quả lưu kèm mốc tin cuối và dấu lời nhắc. Không tự gọi ở mỗi lượt làm mới | «Chưa tóm tắt» và nút «Tóm tắt» |
| 3 | Đơn đang lên | Món, SL, giá máy tính, người nhận, trạng thái candidate | `ORDER_CANDIDATE.md` §2–§3 | Ẩn khi không có candidate |
| 4 | Độ chắc của đơn | **Câu theo từng trường**, ví dụ: «SĐT: đúng định dạng di động (máy kiểm)» · «Địa chỉ: có 2 xã trùng tên, cần hỏi lại» · «Số lượng: khách không nói, đang để 1 (suy đoán)» | `validation_state` và `source` của từng trường (`ORDER_CANDIDATE.md` §3) | Không bao giờ in kiểu «87%» |
| 5 | Lịch sử mua & giao | 6 ô ORDER_OUTCOME và cảnh báo rủi ro | đã có (`inbox/customer-insight.tsx:18-52`, `sc/inbox.ts:422-456`) | **Đề xuất:** hồ sơ chưa xác minh thì gắn nhãn «chưa xác minh» và không hiện lịch sử của hồ sơ. Hôm nay panel vẫn hiện (rủi ro LOW đã ghi ở `docs/revenue-os/MASTER_MISSION_STATUS.md`, mục «An toàn bot bán hàng»). Luật #647 hiện chỉ áp cho lời nhắc của bot (`sc/returning.ts:248-254`) |
| 6 | Bước tiếp theo | **Một** việc chính và tối đa hai việc phụ | **mới**: hàm thuần `nextBestAction(priority, candidate)` theo luật tất định. Gợi ý AI chỉ là nguồn phụ và mang nhãn | «Không có việc cần làm» |
| 7 | Thao tác | Tạo / sửa đơn · Nhận / Giao · Tiếp quản / Trả AI · Gắn nhãn · Ghi chú · Góp ý cho AI | đã có nhưng rải ở đầu khung và trong panel. Gom về một chỗ | — |

Ví dụ luật của khối 6. Mỗi luật là một dòng trong bảng mã của tệp thuần:

| Tình huống | Việc chính |
|---|---|
| Candidate `NEEDS_VERIFICATION`, xã mơ hồ | «Hỏi lại xã/phường». Bấm thì chèn `/diachi` |
| `AWAITING_CUSTOMER` quá X phút | «Nhắc khách xác nhận đơn». X do chủ shop khai, không có mặc định |
| `READY_TO_CONFIRM`, chưa gửi tóm tắt | «Gửi tóm tắt để khách xác nhận». Bấm thì chèn `/xacnhan` |
| `HANDOFF_PENDING`, chưa ai nhận | «Nhận hội thoại» |
| `SLA_BREACHED` | «Trả lời ngay (khách chờ 32 phút)» |
| `OMS_ERROR` | «Xem lỗi tạo đơn: giá vừa đổi» |

Vì sao khối 4 không in phần trăm: độ tin của bộ trích (luật hoặc AI) chưa được hiệu chuẩn trên dữ liệu có nhãn. Golden Dataset
v2 (lát C1) mới đo được độ đúng từng trường. Chưa có số đo thì in câu và không tô màu đạt/không đạt (AGENTS 44: `canConclude = false`).

Gợi ý câu trả lời của Copilot dùng lại dòng đã lưu trong `sales_copilot_suggestions` khi dòng đó còn mới (sinh sau tin khách cuối).
Chỉ khi không có dòng như vậy mới gọi AI. Hôm nay nút «AI gợi ý» luôn sinh mới (`sc/inbox.ts:853-856`).

## 8. Kế hoạch đo hiệu năng TRƯỚC khi sửa (§24, B#24)

**Chi phí đang biết, chưa có số ms**

| # | Chi phí | Bằng chứng |
|---|---|---|
| K1 | Mỗi tab đang mở hộp thư dựng lại RSC 12 lần mỗi phút | `inbox/auto-refresh.tsx:44`, `:55-59`. Đo cục bộ: xin RSC ở giây 5,25 và 10,26 |
| K2 | Mỗi lượt đếm toàn bộ hội thoại cho 10 thẻ, cộng một câu GROUP BY level | `sc/inbox.ts:295-302`, `:303-308` |
| K3 | ORDER BY và WHERE theo kỳ dùng biểu thức `greatest(...)`, không chỉ mục nào phủ biểu thức này | `inbox.ts:112`, `:279-280`, `:346`. Chỉ mục hiện có ở `db/schema.ts:10839-10853`, ví dụ `inbox_idx(last_customer_at)` (0209) |
| K4 | `inboxPages()` không đệm: chạy 2 lần mỗi lượt, 3 lần khi đang mở một hội thoại | `inbox/page.tsx:149`, `inbox.ts:381`, `:589` |
| K5 | Mở một hội thoại thì mỗi lượt làm mới chạy một câu `UPDATE … staff_seen_at` | `inbox.ts:579-580` |
| K6 | Hệ quả của K5 (**SUY LUẬN**, phải có bài kiểm trước khi đổi đường làm mới): `updated_at` có `$onUpdate` (`db/schema.ts:7`), và `aiHoldOf` lấy `updated_at` làm mốc hết nhường cho lý do AI_DOWN và làm mốc dự phòng cho lý do nhân viên (`sc/ai-hold-shared.ts:99-100`). Vậy mở một hội thoại đang nhường thì hạn nhường bị đẩy lùi mãi | |
| K7 | Tổng số câu SQL mỗi lượt có mở hội thoại ước 30–40 (**SUY LUẬN**, chưa đếm) | |
| K8 | `/api/perf` chỉ đo các báo cáo bọc `memo()` của tổ chức nhà (`app/api/perf/route.ts:24-47`), nên hộp thư không có trong đó. `tests/page-query-budget.test.ts` chưa có kịch bản hộp thư | |

**Chỉ số cần đo**

| Chỉ số | Định nghĩa | Đo ở đâu | Dụng cụ |
|---|---|---|---|
| S1 | ms dựng danh sách ở máy chủ (`/ai/sales-chatbot/inbox`, không có `c=`) | cục bộ + production, theo từng tổ chức | bọc `probe()` (`lib/perf/probe.ts:72-77`) quanh `listInbox` / `loadInboxThread`, bật `ERP_PERF_PROBE=1` (`db/index.ts:150-158`) |
| S2 | Số câu SQL mỗi lượt dựng, có và không có hội thoại mở | CI | thêm kịch bản hộp thư vào `tests/page-query-budget.test.ts`: 10 hội thoại so với 200, số câu phải **phẳng** |
| S3 | ms từng câu nặng (đếm thẻ · danh sách dòng · xem trước tin) | CSDL tổ chức lớn nhất | `EXPLAIN (ANALYZE, BUFFERS)`, nhớ tắt JIT của công cụ đo. Cần một thao tác ops chỉ đọc **theo tổ chức**: hôm nay `db-query` chỉ đọc CSDL nhà (`docs/revenue-os/MASTER_MISSION_STATUS.md` mục «Đo lường phát hiện được») |
| S4 | Tải do làm mới | máy chủ | số lần xin RSC hộp thư mỗi phút / số tab đang mở |
| S5 | Độ trễ từ lúc tin tới đến lúc hiện trên màn | trình duyệt | mốc nhận webhook → `performance.mark` ở client khi dòng được vẽ |
| S6 | Thời gian mở một hội thoại | trình duyệt | Playwright: bấm dòng → timeline vẽ xong |
| S7 | Dung lượng RSC của danh sách 100 dòng | trình duyệt | byte của lần xin RSC |

**Ngân sách đề xuất.** Đây là đề xuất kỹ thuật, chốt lại sau khi có số nền. Kho dữ liệu đo gồm 500 · 5.000 · 50.000 hội thoại giả
trên Postgres, không đo bằng PGlite.

| Đường | p50 | p95 |
|---|---|---|
| Dựng danh sách ở máy chủ (≤ 5.000 hội thoại) | ≤ 250 ms | ≤ 700 ms |
| Mở hội thoại ở máy chủ | ≤ 200 ms | ≤ 500 ms |
| Lượt làm mới khi không có gì đổi | ≤ 50 ms | ≤ 150 ms |
| Tin mới → hiện trên màn (SSE) | ≤ 2 s | ≤ 5 s |
| Số câu SQL mỗi lượt dựng | ≤ 12, không tăng theo số hội thoại | — |
| RSC danh sách 100 dòng | ≤ 150 KB | — |

**Hướng sửa, chỉ làm sau khi có số:**
1. Làm mới theo sự kiện SSE `chat`. Lượt poll 30 giây chỉ làm lưới đỡ. Bot trả lời hiện chưa phát `chat` (chỉ có tin khách và thay
   đổi điều khiển phát), nên phải thêm điểm phát đó trước.
2. Đếm lười cho các thẻ trong ngăn (§4).
3. Thêm cột `last_activity_at` được ghi khi có tin, kèm chỉ mục, thay cho `greatest()`. Đây là migration, R3.
4. Đệm `inboxPages()` theo request (React `cache`).
5. Chỉ `UPDATE staff_seen_at` khi giá trị thật sự đổi. Sửa luôn K6 nếu bài kiểm xác nhận.
6. Phân trang bằng con trỏ thay cho trần 500.

## 9. Thứ tự PR và vùng tệp

| PR | Nội dung | Vùng tệp | Phụ thuộc | Rủi ro |
|---|---|---|---|---|
| V2-0 | Đo nền: kịch bản hộp thư trong `page-query-budget` + script đo S1–S3. Không đổi hành vi | `tests/page-query-budget.test.ts` (chỉ nối thêm), `scripts/inbox-perf-probe.ts` (mới) | — | R1 |
| V2-1 | Tách `thread-view.tsx` thành `thread-header.tsx` · `thread-timeline.tsx` · `thread-composer.tsx` · `copilot-panel.tsx`. Thuần di chuyển | `inbox/*`. Giữ nguyên `composer-tools.tsx` của #661. Cùng PR phải sửa danh sách quét của `tests/saas-hide-internal.test.ts:238` (đang quét `thread-view.tsx`) | — (#661 đã gộp) | R1 |
| V2-2 | `inbox-priority-shared.ts` + bài kiểm, chưa nối vào màn | `sc/inbox-priority-shared.ts`, `tests/inbox-priority.test.ts` | — (chạy song song được) | R1 |
| V2-3 | Nối hạng ưu tiên, chống nhảy loạn, bộ lọc gọn + ngăn | `inbox/page.tsx`, `inbox/list-*.tsx` (mới), `sc/inbox.ts` (thêm cột đọc). `tests/saas-hide-internal.test.ts:315` khoá đúng chữ của `page.tsx:154`, đừng định dạng lại dòng đó | V2-0, V2-2 | R1 |
| V2-4 | Timeline: sự kiện hệ thống + tải tin cũ | `inbox/thread-timeline.tsx`, `loadInboxThread` trong `sc/inbox.ts`, migration chỉ mục nếu §8 cho thấy cần | V2-1 | R1 (R3 nếu có migration) |
| V2-5 | Lệnh `/` + phạm vi câu mẫu | `inbox/thread-composer.tsx`, `inbox/composer-tools.tsx`, `sc/inbox-composer.ts` (tệp của #661), migration cột phạm vi | V2-1 | R1 + R3 |
| V2-6 | Panel Copilot 7 khối, chỉ đọc | `inbox/copilot-panel/*` | V2-1. Khối 3–4 cần C3 (`ORDER_CANDIDATE.md` §9) | R1 |
| V2-7 | Sửa hiệu năng theo số đo | `sc/inbox.ts`, `inbox/auto-refresh.tsx`, `components/realtime-provider.tsx`, migration | V2-0 đã có số | R1 / R3 |

Tệp dùng chung với chỗ khác:
- `listInbox` còn được trang Tổng quan gọi (`app/(dashboard)/ai/overview/page.tsx:58`).
- `inboxPages` còn được `performance/`, `conversations/` và `sc/page-config.ts` dùng.

Vì vậy PR nào đổi chữ ký của hai hàm này phải kiểm lại cả các nơi gọi kể trên.

## 10. Câu hỏi mở (cần chủ shop)

1. Hạn trả lời một hội thoại là bao nhiêu phút? Khai ở `work.sla` (AGENTS 22). Không có mặc định, và chưa khai thì không có hạng
   `SLA_BREACHED`.
2. Trên điện thoại, Enter nên là xuống dòng (đề xuất) hay gửi (như hôm nay)?
3. Câu mẫu dùng chung cho bot và nhân viên, hay thêm cờ đối tượng `BOT | STAFF | BOTH`?
4. Có cần phạm vi page và sản phẩm cho câu mẫu ngay đợt này không?
5. «Tóm tắt AI» bấm tay có tính vào khách AI / Số dư AI không (`docs/saas/PRICING_V1.md` §II.2)?
