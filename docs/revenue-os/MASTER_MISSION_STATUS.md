# AI Revenue OS — bản đồ hiện trạng (08/10/2026)

> Kiểm kê theo «TECH LEAD DELIVERY PIPELINE — MASTER MISSION» của chủ shop (08/10/2026). Mỗi mục: **DONE** (đã chạy production)
> · **PARTIAL** (có nền, còn thiếu phần ghi rõ) · **MISSING** · **BLOCKED** (chờ bên ngoài / chủ shop). Dùng lại nền có sẵn —
> không dựng hệ song song. Cập nhật tệp này khi một lát vào production.

## P0

| # | Hạng mục | Trạng thái | Đã có (bằng chứng) | Còn thiếu |
|---|----------|-----------|--------------------|-----------|
| 1 | Meta Direct độc lập Pancake | BLOCKED | Kết nối Facebook bằng Configuration ID, webhook trực tiếp, song song Pancake/Meta theo page (#641), Kênh kết nối hợp nhất (#637) | Meta chưa cấp quyền Page cho app (use case Messenger) — việc của chủ shop trong App Dashboard |
| 2 | Unified Inbox | PARTIAL | Tất cả / từng page · chưa đọc · chưa trả lời · có / chưa SĐT · đã / chưa chốt · AI / Người · cần người · phụ trách · level; ghi chú nội bộ; nhãn; giao việc; lịch sử mua + giao (ORDER_OUTCOME); dấu vết AI từng tin; tiếp quản / trả lại AI; vỏ app điện thoại (#638) | Chèn câu trả lời mẫu ngay ô soạn · gửi thẻ sản phẩm · tìm kiếm · đo hiệu năng (sứ mệnh `saas-inbox-perf`) |
| 3 | Commerce Truth | PARTIAL | Tập công cụ đóng; giá luôn đọc lại ở máy chủ; tồn khả dụng; tính giỏ; **tra trạng thái đơn của CHÍNH hội thoại theo căn cứ (đơn → vận đơn đại diện → chứng từ ĐVVC; giao lỗi / hoàn ⇒ chuyển người — `get_order_status`, lát này)**; khách cũ: lịch sử mua / địa chỉ chỉ theo danh tính ĐÃ XÁC MINH (mã Facebook) hoặc đơn có người đứng sau — đơn nháp người lạ gõ SĐT của chủ thật không thành «lần trước», không chặn ghi đơn thật (#647 · #651 · #652) | Khuyến mại (chưa có bộ máy khuyến mại) · giữ hàng (reserve) |
| 4 | Order Truth | DONE | `confirm_order` đòi đơn nháp + đủ người nhận + giá không đổi + không vượt tồn + lời xác nhận NGUYÊN VĂN; đơn thật qua cùng lõi đơn tay (idempotent theo lượt mua); truy vết đơn → hội thoại (`sales_conversation_id`) → sự kiện `order.confirmed` → sổ AI theo `ref` (model, nhà cung cấp, mốc); **dấu phiên bản lời nhắc (model · nhà cung cấp · phiên bản) trên sự kiện chốt đơn (#649)** | — |
| 5 | Conversation → Delivered Profit | PARTIAL | Quy kết từng đơn (`attribution.ts`), màn Hiệu quả AI (phễu · kết cục đơn qua ORDER_OUTCOME · tiền AI theo hội thoại), so AI vs Người theo nhánh (`experiment-report.ts`); **lãi gộp đã giao theo nhãn AI tự bán / AI góp công / Người bán qua giá vốn chung `orderCogsFast`, đơn chưa có giá vốn đứng riêng (#646)**; **lãi gộp + chi phí AI (ước tính, theo hội thoại của nhánh) + lãi sau AI theo nhánh thử nghiệm AI vs Người (#658)** | Trừ cước / quảng cáo / nhân sự theo hội thoại (chưa có căn cứ phân bổ theo hội thoại — luật 3.14) · ROI khách |

## P1

| # | Hạng mục | Trạng thái | Đã có | Còn thiếu |
|---|----------|-----------|-------|-----------|
| 6 | Revenue Rescue | PARTIAL | Quét khách bị bỏ sót (`recovery.ts`), follow-up, quét lại tin rơi | Sự kiện cứu có lý do · giá trị kỳ vọng · kết quả · đơn / doanh thu giao / lợi nhuận cứu được |
| 7 | AI vs Human dashboard | DONE | Chế độ EXPERIMENT + báo cáo nhánh + drill-down hội thoại; **so hai nhánh bằng lãi gộp đã giao / hội thoại và lãi sau chi phí AI, chênh lệch có chiều cận, thiếu giá vốn / chưa định giá thì không kết luận (#658)** | Chưa trừ nhân sự / cước / quảng cáo (xem mục 5) |
| 8–10 | AI Balance + QR + ledger + giá phiên | PARTIAL | #644: sổ cái chỉ ghi thêm, nạp QR ERPNAP qua SePay (cộng đúng một lần), trừ khách AI vượt phần gồm, cổng hết số dư chỉ chặn khách mới, báo số dư; backtest phiên 24 giờ (docs/saas/AI_SESSION_BACKTEST_2026-10-08.md); #648 doanh thu · chi phí · biên Số dư AI trên /platform; #650 sao kê / gõ tay không «nạp» hộ, tài khoản nhận đọc hỏng không khoá tiền; #653 đảo đúng MỘT khoản trừ theo mã dòng, cockpit tính doanh thu Số dư, «dùng» ròng; #655 tiền thuê bao cùng luật SePay — sao kê nhập tệp / gõ tay mang mã ERPHD chờ người vận hành xác nhận nguồn, không tự gia hạn; #659 ops `org-ai-cutover`: kiểm khoá AI của một tổ chức (dấu băm, project Google, credit) + chuyển AI Bán hàng sang AI dùng chung qua lõi /platform/org | Chủ shop khai tài khoản nhận tiền + bật cờ cho MỘT tổ chức thử (DoD nạp QR thật, không ai duyệt tay) · kế toán / pháp lý duyệt (AI_BALANCE_V1 §4) · giá phiên chỉ công bố khi đủ 30 ngày dữ liệu + có tỷ lệ chốt |

## P2 / P3

| Hạng mục | Trạng thái | Ghi chú |
|----------|-----------|---------|
| Model / task optimizer | PARTIAL | Platform AI Model Control (định tuyến model, A/B model, `workload` từ 07/10); thiếu đo theo việc × model × kết quả kinh doanh |
| Replay / regression | DONE | Replay · Shadow · sales-bench · hội thoại vàng (12 kịch bản) |
| Automation builder | PARTIAL | Luật tự động (workflows) có sẵn |
| Ads / CAPI closed loop | PARTIAL | Quy kết quảng cáo trên đơn chat (`chatOrderAdId`) |
| Vertical playbooks | PARTIAL | Hải sản (HSLC) chạy thật; thời trang / mỹ phẩm chưa |
| Instagram · Zalo · TikTok / Shopee · Outcome pricing | PARTIAL / MISSING | Zalo OA có; Instagram theo Meta; còn lại chưa |

## An toàn bot bán hàng (review bảo mật độc lập 08/10/2026)

| PR | Đóng lỗ gì |
|----|-----------|
| #647 | Lịch sử mua qua SĐT gõ tay: chỉ danh tính đã xác minh mới thấy «lần trước»; mức PHONE không bao giờ mang dữ liệu cũ vào lời nhắc ghi đơn |
| #651 | Đơn nháp người lạ dưới SĐT chủ thật không thành «lần trước»; giá đại lý chỉ cho đúng chủ hồ sơ; ô chữ hồ sơ vào lời nhắc là dữ liệu một dòng |
| #652 | Đơn máy (kể cả lượt nối hỏng) không chặn ghi đơn thật / không nâng mức khách; ký tự C1 / định dạng; bài học AI nhắc tới tiền / tài khoản / liên kết không tự áp (tự học + góp ý) |
| #654 | Bộ lọc bài học bắt tên miền / handle trần, không chặn nhầm; nguyên văn bài bị bỏ in ra; cờ bài cũ; hồ sơ do máy tạo không làm địa chỉ dự phòng |
| #656 | Tên miền dạng chung + có dấu, dấu chấm che giấu, @ ở mọi chỗ, cụm viết dính, ký tự vô hình, dãy số dài không lọt bộ lọc bài học; không nhìn-ngược trong mã tới trình duyệt; hồ sơ máy tạo không làm gợi ý `lookup_customer` và không làm tên / địa chỉ dự phòng |
| #657 | Form tạo đơn trong khung chat không điền / không dùng chữ ĐÃ LƯU của hồ sơ chưa xác minh (gắn qua SĐT gõ tay, kể cả chữ máy chủ điền từ đơn cũ) — chỉ chữ khách gõ, không có thì bắt nhập; LOW vòng 2 của bộ lọc bài học |

Rủi ro còn lại, đã ghi nhận: khung hộp thư vẫn hiện tên / địa chỉ / lịch sử đơn của hồ sơ chưa xác minh cho nhân viên (LOW — chỉ nhân
viên xem); form tạo đơn tay (POS) chọn hồ sơ bot tạo mà để trống địa chỉ thì lõi lấy địa chỉ đã lưu (LOW — cách hẹp: dự phòng về đơn
đáng tin gần nhất).

## Đo lường phát hiện được trong lượt kiểm kê

- `platform_ai_usage.conversation_id` từng rỗng ở 100% dòng 30 ngày — #649 điền ở đường ghi của bot + follow-up; lượt «AI ghi
  đơn hộ nhân viên» vẫn chỉ mang `ref = order-sync:<mã>`. Mọi báo cáo chi phí AI theo hội thoại đọc qua `ref` bằng một phép ánh xạ
  chung (`conversationOfRef`, #658) nên không thiếu.
- Chưa đọc được tỷ lệ chốt / giao / lợi nhuận theo phiên ở CSDL tổ chức qua `db-query` (chỉ đọc CSDL nhà) — cần một thao tác
  ops chỉ đọc theo tổ chức trước khi chốt giá phiên.
