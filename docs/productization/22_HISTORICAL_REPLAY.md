# 22 · Phát lại hội thoại cũ (Historical Replay) — báo cáo sẵn sàng trước khi bật tự động

> Mã: `lib/sales-chatbot/replay-shared.ts` (thuần) · `lib/sales-chatbot/replay.ts` (máy chủ) · màn
> `/ai/sales-chatbot/replay` (nút «Phát lại hội thoại cũ» trên trang Chatbot bán hàng). Bảng `sales_replay_runs` +
> `sales_replay_points` ở CSDL của **chính tổ chức** (SILO). Bài kiểm: `tests/sales-replay.test.ts`.

## 1. Câu hỏi nó trả lời

"Nếu AI — với cấu hình, lời nhắc, sổ tay, câu mẫu **hôm nay** — đứng ở đúng chỗ ấy của một hội thoại thật, nó sẽ nói gì,
và câu đó có căn cứ không?" Đây là bước giữa **Observe** và **Copilot / Autopilot** của lộ trình pilot HSLC: trước khi
để AI tự trả lời khách, chủ shop đọc AI sẽ nói gì trên chính khách của mình.

## 2. Cách chạy

1. Người có `ai_sales:manage` chọn số điểm (5 · 10 · 20) và khoảng ngày (7 · 30 · 90), bấm «Phát lại».
2. Nguồn: hội thoại **khách thật** đã lưu trong ERP (kênh FANPAGE / WEB; không bao giờ kênh THỬ), có ít nhất một lượt.
3. Chọn điểm **tất định**: hội thoại mới trước; mỗi hội thoại tối đa 3 tin khách rải đều (đầu · giữa · cuối).
4. Mỗi điểm: mở một hội thoại **kênh THỬ**, nạp tối đa 20 tin lịch sử trước điểm đó, gọi **đúng đường bán hàng thật**
   (`chatTurn`). Kênh THỬ: công cụ ghi chỉ mô phỏng — không khách, không đơn, không giữ hàng, không tin tới khách / nhóm.
5. Chụp câu AI + công cụ + trạng thái, **xoá** hội thoại tạm, chấm, ghi điểm. Lỗi một điểm không dừng cả lượt.
6. Một lượt mỗi lúc; lượt treo quá 30 phút được thay.

Chi phí: mỗi điểm là một lượt AI thật trên khoá của tổ chức, qua hạn mức AI như mọi lượt khác (`platform_ai_usage`).

## 3. Chấm điểm — luật tất định, không có AI giám khảo

| Cờ | Nghĩa |
|---|---|
| `ERROR` | lượt AI hỏng |
| `EMPTY_REPLY` | AI không nói gì |
| `PRICE_UNGROUNDED` | câu AI có số tiền **không** thuộc: giá bảng mẫu mã đang bán · số do công cụ trả trong lượt · phí ship đã khai · số shop đã nói trước đó trong hội thoại. Dấu hiệu bịa giá — để NGƯỜI đọc, không phải điểm trừ tự động (AI có thể cộng hai số có căn cứ) |
| `TOOL_ERROR` | một công cụ báo lỗi |
| `AI_HANDOFF` | AI chuyển người |
| `HISTORY_HUMAN` | thực tế người / page trả lời câu đó (tin mang tiền tố «[Shop đã nhắn]») |

Câu "thật" chỉ tính khi đứng **trước** tin khách kế tiếp; khách nhắn tiếp trước khi ai trả lời ⇒ "không ai trả lời".

## 4. Báo cáo

Tỷ lệ AI hỏng · giá không căn cứ (mẫu số = câu AI có nhắc tiền, không phải mọi câu) · công cụ lỗi · AI chuyển người;
ma trận chuyển người (cả hai · chỉ AI · chỉ thực tế · không bên nào). Mẫu dưới 5 ⇒ "—". Tóm tắt là ẢNH CHỤP lúc xong —
đổi cấu hình sau đó không đổi số của lượt cũ.

**Không có ngưỡng "đạt / chưa đạt"** (AGENTS §38): bật tự động là quyết định kinh doanh của chủ shop, đọc từng câu.

## 5. Giới hạn đã biết (v1)

| Giới hạn | Hệ quả | Hướng mở |
|---|---|---|
| Nguồn chỉ là hội thoại đã lưu trong ERP | Shop chưa từng bật bot (chỉ có lịch sử ở Pancake) chưa có nguồn | v2: đọc lịch sử Pancake như «Học từ hội thoại cũ» (playbook) — cùng bộ che SĐT / tên |
| So câu AI với câu thật bằng mắt | Chưa có điểm "chất lượng bán hàng" | Chỉ thêm khi có nhãn người đọc (đúng / sai) làm dữ liệu kiểm chứng |
| Kết cục (đơn / giao / lợi nhuận) chưa nối vào điểm | Chưa trả lời "câu AI có làm khách mua không" | Nối khi sổ sự kiện (#522) gắn hội thoại ↔ đơn ↔ `ORDER_OUTCOME` |
| Công cụ ở kênh THỬ đọc giá / tồn HIỆN TẠI | Điểm cũ được trả lời bằng giá hôm nay | Đúng ý đồ: câu hỏi là "AI hôm nay" chứ không phải "AI hồi đó" |

## 6. An toàn dữ liệu

Không ghi vào hội thoại nguồn (bài kiểm băm tin nhắn nguồn trước = sau); hội thoại tạm bị xoá; không đơn; tổ chức khác
không đọc được lượt (CSDL riêng + bài kiểm bằng id). Lùi: revert PR — hai bảng ở lại, không ai đọc.
