# AI Revenue OS — bản đồ hiện trạng (08/10/2026)

> Kiểm kê theo «TECH LEAD DELIVERY PIPELINE — MASTER MISSION» của chủ shop (08/10/2026). Mỗi mục: **DONE** (đã chạy production)
> · **PARTIAL** (có nền, còn thiếu phần ghi rõ) · **MISSING** · **BLOCKED** (chờ bên ngoài / chủ shop). Dùng lại nền có sẵn —
> không dựng hệ song song. Cập nhật tệp này khi một lát vào production.

## P0

| # | Hạng mục | Trạng thái | Đã có (bằng chứng) | Còn thiếu |
|---|----------|-----------|--------------------|-----------|
| 1 | Meta Direct độc lập Pancake | BLOCKED | Kết nối Facebook bằng Configuration ID, webhook trực tiếp, song song Pancake/Meta theo page (#641), Kênh kết nối hợp nhất (#637) | Meta chưa cấp quyền Page cho app (use case Messenger) — việc của chủ shop trong App Dashboard |
| 2 | Unified Inbox | PARTIAL | Tất cả / từng page · chưa đọc · chưa trả lời · có / chưa SĐT · đã / chưa chốt · AI / Người · cần người · phụ trách · level; ghi chú nội bộ; nhãn; giao việc; lịch sử mua + giao (ORDER_OUTCOME); dấu vết AI từng tin; tiếp quản / trả lại AI; vỏ app điện thoại (#638) | Chèn câu trả lời mẫu ngay ô soạn · gửi thẻ sản phẩm · tìm kiếm · đo hiệu năng (sứ mệnh `saas-inbox-perf`) |
| 3 | Commerce Truth | PARTIAL | Tập công cụ đóng; giá luôn đọc lại ở máy chủ; tồn khả dụng; tính giỏ; **tra trạng thái đơn của CHÍNH hội thoại theo căn cứ (đơn → vận đơn đại diện → chứng từ ĐVVC; giao lỗi / hoàn ⇒ chuyển người — `get_order_status`, lát này)** | Khuyến mại (chưa có bộ máy khuyến mại) · giữ hàng (reserve) |
| 4 | Order Truth | PARTIAL | `confirm_order` đòi đơn nháp + đủ người nhận + giá không đổi + không vượt tồn + lời xác nhận NGUYÊN VĂN; đơn thật qua cùng lõi đơn tay (idempotent theo lượt mua); truy vết đơn → hội thoại (`sales_conversation_id`) → sự kiện `order.confirmed` → sổ AI theo `ref` (model, nhà cung cấp, mốc) | Dấu phiên bản lời nhắc trên sự kiện chốt đơn |
| 5 | Conversation → Delivered Profit | PARTIAL | Quy kết từng đơn (`attribution.ts`), màn Hiệu quả AI (phễu · kết cục đơn qua ORDER_OUTCOME · tiền AI theo hội thoại), so AI vs Người theo nhánh (`experiment-report.ts`); **lãi gộp đã giao theo nhãn AI tự bán / AI góp công / Người bán qua giá vốn chung `orderCogsFast`, đơn chưa có giá vốn đứng riêng (#646)** | Trừ chi phí AI / cước / quảng cáo theo hội thoại · lãi gộp theo nhánh thử nghiệm AI vs Người · ROI khách |

## P1

| # | Hạng mục | Trạng thái | Đã có | Còn thiếu |
|---|----------|-----------|-------|-----------|
| 6 | Revenue Rescue | PARTIAL | Quét khách bị bỏ sót (`recovery.ts`), follow-up, quét lại tin rơi | Sự kiện cứu có lý do · giá trị kỳ vọng · kết quả · đơn / doanh thu giao / lợi nhuận cứu được |
| 7 | AI vs Human dashboard | PARTIAL | Chế độ EXPERIMENT + báo cáo nhánh + drill-down hội thoại | Gộp theo lợi nhuận giao thành công |
| 8–10 | AI Balance + QR + ledger + giá phiên | PARTIAL | PR #644: sổ cái chỉ ghi thêm, nạp QR ERPNAP qua SePay (cộng đúng một lần), trừ khách AI vượt phần gồm, cổng hết số dư chỉ chặn khách mới, báo số dư; backtest phiên 24 giờ (docs/saas/AI_SESSION_BACKTEST_2026-10-08.md) | Chủ shop khai tài khoản nhận tiền · kế toán / pháp lý duyệt (AI_BALANCE_V1 §4) · kinh tế đơn vị trên /platform · giá phiên chỉ công bố khi đủ 30 ngày dữ liệu + có tỷ lệ chốt |

## P2 / P3

| Hạng mục | Trạng thái | Ghi chú |
|----------|-----------|---------|
| Model / task optimizer | PARTIAL | Platform AI Model Control (định tuyến model, A/B model, `workload` từ 07/10); thiếu đo theo việc × model × kết quả kinh doanh |
| Replay / regression | DONE | Replay · Shadow · sales-bench · hội thoại vàng (12 kịch bản) |
| Automation builder | PARTIAL | Luật tự động (workflows) có sẵn |
| Ads / CAPI closed loop | PARTIAL | Quy kết quảng cáo trên đơn chat (`chatOrderAdId`) |
| Vertical playbooks | PARTIAL | Hải sản (HSLC) chạy thật; thời trang / mỹ phẩm chưa |
| Instagram · Zalo · TikTok / Shopee · Outcome pricing | PARTIAL / MISSING | Zalo OA có; Instagram theo Meta; còn lại chưa |

## Đo lường phát hiện được trong lượt kiểm kê

- `platform_ai_usage.conversation_id` rỗng ở 100% dòng 30 ngày — khoá hội thoại hiện đọc qua `ref`. Việc nhỏ: điền
  `conversation_id` ở đường ghi của bot (làm sau #644 + lát tra đơn vì cùng chạm `engine.ts`).
- Chưa đọc được tỷ lệ chốt / giao / lợi nhuận theo phiên ở CSDL tổ chức qua `db-query` (chỉ đọc CSDL nhà) — cần một thao tác
  ops chỉ đọc theo tổ chức trước khi chốt giá phiên.
