# Thay Pancake cho social commerce — báo cáo đợt P0

> Nhánh `feat/pancake-replacement` (cây `wt-pancake-replacement`), 06/10/2026 — đợt 1 (trước #598 / #599) + đợt 2 (sau khi hai
> dependency vào main). Trạng thái: **mã xong + kiểm thử xanh trên nhánh; CHƯA PR / CHƯA merge / CHƯA deploy** — xem §9. Kế hoạch sống: `docs/pancake-replacement-gap-analysis.md`.

## 1. Đã làm (mã mới)

| # | Kết quả nghiệp vụ | Commit |
|---|---|---|
| 1 | Người gửi tin / tiếp quản trong lúc AI đang soạn ⇒ khách KHÔNG nhận thêm câu bot (fanpage Pancake · Messenger trực tiếp · Zalo). Chế độ hội thoại AUTO · COPILOT · HUMAN; Tiếp quản bền; Trả lại AI; nhật ký trước → sau + lý do | `6e1a0e2a` |
| 2 | Hộp thư dùng được trên điện thoại: lớp phủ «Khách · Đơn» (khách, tạo đơn, ghi chú); hết tràn ngang | `82374b0f` |
| 3 | Đơn bot / tạo trong chat mở đúng hội thoại trong Hộp thư ERP (mọi kênh); hồ sơ khách có khối «Hội thoại» | `7e96d30e` |
| 4 | Token Meta bị thu hồi ⇒ kết nối «cần nối lại» + báo người một lần; lỗi ngoài 24 giờ không bị hiểu là kết nối hỏng | `f571d606` |
| 5 | Trang Kết nối của tổ chức khách: «Facebook · Instagram nối thẳng» lên đầu; Pancake về «Kết nối cũ / chuyển đổi» | `484d5f56`, `6ea0fb80` |
| 6 | Webhook Messenger để lại log có cấu trúc khi chữ ký sai / page lạ / gói trùng / lượt nền hỏng | `7407e557` |
| 7 | Hộp thư lọc «AI đang trả lời / Người đang xử lý» | `949692c1` |
| 8 | (sau #598 / #599) Gộp main; báo token hỏng theo ĐÚNG page có token riêng — page khác chạy tiếp, trạng thái page do người chọn | `a8156fa2` |
| 9 | Lát A — shop chỉ nối Facebook trực tiếp được máy ghi đơn từ hội thoại (đọc sổ tin ERP, không Pancake); bài kiểm trọn đường nhận → bot → nhân viên → đơn → ghi đơn với 0 lời gọi pages.fm | `66617dc4` |
| 10 | Lát B — lịch sử hội thoại Messenger / Instagram trực tiếp (20 tin gần nhất / hội thoại) qua đường ghi của #599; `/me/accounts` phân trang tới 500 page; gỡ page ⇒ `DELETE subscribed_apps` | `f1e0218f` |
| 11 | Lát C — 8 đòn mới × 2 chiều trong bộ tấn công chéo tổ chức cho các bề mặt mới; khai đường gọi mạng | `59ec07a4` |
| — | Tài liệu: gap analysis · Meta production readiness · runbook · báo cáo này | `5b62ee8e`, `9be180e3`, các commit tài liệu sau |

## 2. Dùng lại (không dựng lại)

Messenger + Instagram trực tiếp (OAuth, webhook ký, PAGE_INDEX, chống trùng `mid`), Hộp thư khách M8 (gửi chữ / ảnh, nhãn,
ghi chú, nhận / giao), `replyGate` + bốn chế độ tổ chức, `chatTurn` / công cụ bán hàng (giá / tồn từ ERP), đơn idempotent
(`chat:` / `sales-chat:` + khoá advisory), sổ sự kiện + màn «Hiệu quả» (`ORDER_OUTCOME`), SILO + bài tấn công cô lập, sổ kết nối
(`lib/connectors/service.ts` — đường ghi duy nhất của `org_connections`), `notifications` + hộp thư cá nhân + đẩy.

## 3. Sửa lại cái đang có

- `engine.ts::bump` giữ `state.control` đang nằm trong CSDL (trước: ghi đè cả `state` từ ảnh chụp đầu lượt ⇒ tiếp quản giữa
  lượt AI bị xoá). `resumeConversationToAi` gỡ luôn `state.control`.
- `orderChatThreads` đọc khoá cứng `orders.sales_conversation_id` trước đường tra ngược cũ; trả mã hội thoại + kênh.
- `graph()` của Messenger trả loại lỗi + câu việc-phải-làm.
- Bỏ `handBackToAiAction` (thanh AI ↔ người thay nút cũ; lõi `handBackToAiCore` giữ).

## 4. Bỏ qua vì đã có / đang làm ở nhánh khác

| Việc của lệnh | Ở đâu |
|---|---|
| Nhiều page một tổ chức, token riêng từng page, bật / tắt AI theo page | #598 (`wt-master-mission`) — đã vào main, đã gộp, DÙNG LẠI |
| Hộp thư chung + lọc theo page, chỉ số theo page | #598 — dùng lại |
| Onboarding «bạn trả lời tin bằng gì» không bắt buộc Pancake | #598 — dùng lại |
| Quy kết từng đơn AI_ONLY / AI_ASSISTED / HUMAN_ONLY, AOV, follow-up thu hồi | #598 — dùng lại |
| Hộp thư lọc SĐT / level / thời gian / nhân viên, «Xem thêm», lịch sử giao / hoàn | #595 — dùng lại |
| Nhập lịch sử hội thoại Pancake | #599 — dùng lại; đường ghi của nó dùng chung cho lịch sử Messenger trực tiếp |

## 5. Migration

Không có. Chế độ hội thoại nằm trong `sales_chat_conversations.state` (jsonb sẵn có) — tránh trùng số migration với hai nhánh
đang mở (cả hai dùng 0216).

## 6. Kiểm thử

- `npm run typecheck` sạch · `npm run lint` sạch · `npm run build` đạt · `npm test` **«TẤT CẢ KIỂM THỬ ĐẠT»** (794 dòng ✓, nhánh
  đã gộp main `419fe3be` gồm #598 + #599; sau đó gộp thêm #600 — chỉ chạm `chatbot/`; 10 mục «CHƯA ĐO ĐƯỢC trên win32» có từ trước
  — CI Linux đo).
- Bài kiểm mới đợt 2: `tests/native-order-sync.test.ts` (đột biến bỏ nguồn Messenger ⇒ đỏ), `tests/messenger-lifecycle.test.ts`
  (bắt được một regex mất dấu gạch chéo ngược trước khi vào kho), 8 đòn mới trong `tests/ai-sales-isolation.test.ts`.
- Bài kiểm mới: `tests/conversation-control.test.ts` (thuần + tổ chức thật qua Messenger trực tiếp, Graph giả: race giữa lượt
  AI, tiếp quản bền, Copilot hội thoại, trả lại AI, hai người cùng bấm, quyền, bộ lọc AI / người), `tests/conversation-trace.test.ts`
  (khoá cứng, kênh thử, trùng tên không lọt hồ sơ), `tests/messenger-health.test.ts` (phân loại lỗi Graph, 190 ⇒ Nháp + báo một
  lần, log không lộ nội dung), `tests/connectors-legacy.test.ts`.
- Đột biến: bỏ phần giữ `control` trong `bump()` ⇒ bài kiểm đỏ. Bài kiểm trace bắt được một lỗi câu con tương quan trước khi vào
  kho.
- Đo giao diện thật (Chrome headless, app `next dev` + PGlite): 390 × 844 không tràn ngang, lớp phủ khách / tạo đơn / Tiếp quản
  chạy; 1440 × 900 giữ ba cột.

## 7. CI · deploy · kiểm production

**Chưa chạy.** Nhánh đã push (`origin/feat/pancake-replacement`); PR chưa mở — xem §9.

## 8. Giới hạn đã biết

- Câu bot đã soạn mà KHÔNG gửi (người vừa tiếp quản) vẫn nằm trong lịch sử của bot — cùng tiền lệ với câu gửi hỏng.
- Đơn chat / AI không ghi `orders.page_id` (quyết định của chủ shop — §9); truy về page qua hội thoại.
- Lịch sử Messenger trực tiếp: tối đa 20 tin gần nhất mỗi hội thoại, 200 hội thoại / page — giới hạn của Meta / trần của lượt nhập.
- Page có token riêng bị thu hồi: máy BÁO, không tự tắt page (trạng thái page do người chọn) — bot vẫn thử gửi tới khi người nối
  lại hoặc tắt page.
- Tin nhân viên ngoài 24 giờ (thẻ `HUMAN_AGENT`) chưa làm — cần App Review.

## 9. Việc chặn bên ngoài (owner phải làm)

| Việc | Vì sao mã không tự làm được |
|---|---|
| Mở PR + merge + chạy «Deploy ERP to VPS» | Phiên không có quyền dùng credential GitHub (lấy token từ trình quản lý credential bị chặn). Nhánh đã push đủ — mở PR từ `feat/pancake-replacement`, hoặc cho phiên quyền dùng credential |
| App Review + Business Verification cho app Meta | Thủ tục của Meta (`meta-production-readiness.md` §3) |
| Đặt `FACEBOOK_API_VERSION` ≥ `v24.0` trên VPS | Biến môi trường production; `v21.0` hết hạn 21/01/2027 |
| Có ghi `orders.page_id` cho đơn chat / AI không | Đổi quy kết fanpage → marketer / hoa hồng (AGENTS luật 9, 16) |

## 10. P1 đề xuất (theo thứ tự)

1. Khi có duyệt Human Agent: thẻ `HUMAN_AGENT` CHỈ cho tin nhân viên trong hộp thư, 7 ngày.
2. Tự nhập hội thoại gần đây ngay sau khi nối page (hôm nay là nút bấm).
3. Page có token riêng hỏng liên tục: đề nghị người tắt page / tạm dừng AI page đó (không tự đổi trạng thái).
4. Zalo OA: nhập lịch sử + ghi đơn từ hội thoại theo cùng khuôn nguồn tin.
