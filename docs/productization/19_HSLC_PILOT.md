# 19 · Pilot HSLC — Quan sát → Copilot → Thử nghiệm AI vs Người → Tự động

> Áp cho MỌI tổ chức có kênh mà người trả lời song song (fanpage qua Pancake; Messenger / Zalo khi nối cổng). HSLC là
> tổ chức đầu tiên đi lộ trình này. Mã: `lib/sales-chatbot/operating-mode-shared.ts` (luật thuần, `replyGate`),
> `lib/sales-chatbot/operating-mode.ts` (cấu hình, ghim nhánh, gợi ý Copilot), cổng gọi trong `lib/sales-chatbot/fanpage.ts`.
> Cài đặt: thẻ «Chế độ vận hành» trên `/ai/sales-chatbot`; số đo: `/ai/sales-chatbot/copilot`. Bài kiểm:
> `tests/sales-operating-mode.test.ts`.

## 1. Bốn chế độ

| Chế độ | Bot làm gì | Tốn AI | Đo được gì |
|---|---|---|---|
| **Quan sát** | Không gọi AI, không nói gì. Tin khách + câu của page vẫn vào lịch sử hội thoại | 0 | Đường nền của NGƯỜI (thời gian trả lời, đơn ghi hộ qua order-sync) · nguồn cho «Phát lại hội thoại cũ» |
| **Copilot** | Soạn câu ở hội thoại BÓNG (kênh thử — `lib/sales-chatbot/shadow.ts`), KHÔNG gửi, lưu làm gợi ý | 1 lượt / tin khách | Người dùng lại gợi ý tới đâu: gần như nguyên văn · sửa · khác hẳn · không ai trả lời + trung vị độ giống |
| **Thử nghiệm** | Mỗi hội thoại vào MỘT nhánh theo băm (khoá thử nghiệm + hội thoại): nhánh AI = tự động, nhánh NGƯỜI = quan sát. Nhánh được GHIM vào `state.experiment` ở lượt đầu | chỉ nhánh AI | Hai nhóm hội thoại cùng kỳ, cùng nguồn khách, chia ngẫu nhiên — so sánh được (đơn, giao, doanh thu theo nhánh ở màn «Hiệu quả») |
| **Tự động** | Như trước nay | mỗi lượt | — |

Mặc định **Tự động** khi bot đang bật: shop chưa đổi chế độ không thấy gì khác (bài kiểm khoá điều này). Trang chat web
không có người ở đầu kia ⇒ luôn tự động.

## 2. Vì sao chia theo băm và ghim nhánh

- **Băm tất định** (FNV-1a của `khoá:page:thread`): cùng hội thoại luôn cùng nhánh, không cần bảng phân công; tỷ lệ trên
  2.000 hội thoại thử nằm trong ±4 điểm của tỷ lệ đặt (bài kiểm).
- **Ghim nhánh**: đổi tỷ lệ giữa chừng KHÔNG chuyển hội thoại đang chạy sang nhánh kia — nếu chuyển, một khách bị cả hai
  bên chạm và hai nhóm đem so không còn là hai nhóm. Muốn chia lại từ đầu ⇒ «Chia lại từ đầu» = khoá thử nghiệm mới.
- **Tỷ lệ là quyết định của chủ shop** (AGENTS §38) — mã không có tỷ lệ "đúng".

## 3. Đo Copilot

Câu thật = tin page (`PAGE_REPLY`) ĐẦU TIÊN của cùng hội thoại tới SAU gợi ý. Độ giống = 1 − Levenshtein / độ dài lớn
hơn trên chuỗi đã chuẩn hoá (chữ thường, bỏ dấu câu). Ranh giới **định nghĩa phép đo** (không phải đích): ≥ 0,9 gần như
nguyên văn · ≥ 0,5 sửa · < 0,5 khác hẳn · không có câu trong 24 giờ = không ai trả lời. Trung vị độ giống luôn in cạnh
(mẫu < 5 ⇒ «—»).

**Giới hạn đã biết:** câu trả lời tự động của Meta cũng là «tin page» và bị đem so như câu người; nhân viên chưa thấy gợi ý
ngay trong Pancake (chỉ thấy ở ERP) — hộp thư người trong ERP (M8, phiên khác) là chỗ đặt gợi ý cạnh ô trả lời.

## 4. Lộ trình đề xuất cho HSLC

1. **Quan sát 1–2 tuần** — đo đường nền người; chạy «Phát lại hội thoại cũ» (`22_HISTORICAL_REPLAY.md`) trên chính các
   hội thoại đó để đọc AI sẽ nói gì.
2. **Copilot 1 tuần** — nhân viên xem gợi ý; theo dõi tỷ lệ "gần như nguyên văn + sửa".
3. **Thử nghiệm** — tỷ lệ AI do chủ shop chọn; so hai nhánh trên màn «Hiệu quả» khi đủ mẫu (sổ sự kiện #522 + kết cục đơn
   theo `ORDER_OUTCOME`).
4. **Tự động** — khi chủ shop đọc số và quyết. Không có ngưỡng tự chuyển chế độ trong mã.

## 5. Nối các kênh khác

Lối vào kênh gọi `loadModeConfig()` + `replyGate(cfg, khoá hội thoại, readPinnedArm(conv.state))` NGAY TRƯỚC lượt AI, rồi
`pinArm`; OBSERVE ⇒ bỏ qua có ghi chú; COPILOT ⇒ `draftCopilotSuggestion`; AUTOPILOT ⇒ như cũ. Messenger (#517) và Zalo OA
(nhánh `claude/zalo-oa`) nối theo đúng mẫu này.
