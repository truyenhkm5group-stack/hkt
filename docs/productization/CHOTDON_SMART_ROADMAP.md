# Chốt Đơn Tự Động — đề xuất tính năng thông minh vượt Pancake (06/10/2026)

Chủ shop yêu cầu: «chủ động đề xuất phát triển thêm các tính năng thông minh khác nữa để tạo ra sản phẩm chotdontudong có
nhiều ưu điểm vượt trội hơn so với Pancake và các phần mềm quản lý chat chốt đơn khác». Danh sách dưới đây xếp theo **tiền
về cho shop / công sức**, mỗi mục ghi rõ đã có gì trong ERP để không làm lại.

Nền đã có (không phải đề xuất): hộp thư nhiều kênh + gửi ảnh + nhãn + ghi chú (M8), bot tự chốt đơn, máy ghi đơn từ hội thoại
nhân viên chốt, chuẩn hoá địa chỉ 34 tỉnh / 3.321 xã, tự xác nhận đơn đủ & đúng thông tin, tự tạo vận đơn VTP / GHN / GHTK +
danh sách tự giao, level khách + kịch bản theo level, góp ý cho AI, bot tự học, lịch sử giao / hoàn của khách.

## Nhóm A — chốt được nhiều đơn hơn (làm trước)

| # | Tính năng | Vì sao hơn Pancake | Nền có sẵn |
| --- | --- | --- | --- |
| A1 | **Cứu khách để SĐT chưa thành đơn**: hàng đợi «có SĐT mà chưa có đơn sau 15 phút», một chạm mở form đơn đã điền sẵn | Pancake đẻ đơn RỖNG cho mọi SĐT rồi để đó; ta biết vì sao chưa thành đơn (thiếu món / thiếu địa chỉ / món ngoài danh mục) | level khách, báo «khách để SĐT nhưng máy chưa lên được đơn» |
| A2 | **Nhắc khách bỏ dở theo LEVEL** (trong khung 24 giờ Meta): khách «cho SĐT thiếu địa chỉ» nhận câu xin địa chỉ, khách «đủ thông tin thiếu món» nhận câu xác nhận món | Follow-up của Pancake là kịch bản chung, không biết khách đang kẹt ở bước nào | follow-up 3 mốc + kịch bản theo level |
| A3 | **Điểm khả năng chốt** cho mỗi hội thoại (level + tốc độ trả lời + lịch sử mua + nguồn quảng cáo) và sắp hộp thư theo điểm | Nhân viên trả lời khách «nóng» trước, không theo thứ tự thời gian | level, lịch sử mua, quy kết quảng cáo |
| A4 | **AI soạn sẵn câu trả lời theo level** — một chạm gửi (Copilot) và đo tỷ lệ nhân viên dùng nguyên văn | Pancake chỉ có câu mẫu tĩnh | Copilot gợi ý + `sales_copilot_suggestions` |
| A5 | **Combo / upsell theo giỏ** đo được tiền tăng thêm mỗi đơn | | bot đã upsell; thiếu báo cáo AOV theo câu upsell |

## Nhóm B — ít hoàn, ít bom hàng

| # | Tính năng | Vì sao hơn | Nền có sẵn |
| --- | --- | --- | --- |
| B1 | **Chấm rủi ro TRƯỚC khi lên đơn** (lịch sử hoàn theo SĐT + địa chỉ mơ hồ + đơn giá trị cao) ⇒ xin cọc / gọi xác nhận tự động | Pancake chỉ hiện số đơn hoàn | `assessCustomerRisk`, lịch sử giao trong hộp thư |
| B2 | **Mạng cảnh báo bom hàng giữa các shop dùng Chốt Đơn** (chỉ băm SĐT, shop tự bật — cần chủ shop + pháp lý duyệt) | Lợi thế mạng lưới đối thủ không sao chép được | sổ kết quả đơn theo ORDER_OUTCOME |
| B3 | **Tin «đơn đang giao / hôm nay giao»** tự gửi khách qua chính kênh chat | Giảm hoàn vì khách quên / không nghe máy | webhook trạng thái vận đơn, kênh gửi tin |
| B4 | **Xác minh SĐT / địa chỉ lúc chốt**: nhà mạng hợp lệ, địa chỉ ghép được xã mới, gợi ý sửa một chạm | | bộ chuẩn hoá địa chỉ |

## Nhóm C — đội ngũ làm nhanh hơn, không sót tin

| # | Tính năng | Vì sao hơn | Nền có sẵn |
| --- | --- | --- | --- |
| C1 | **Hạn trả lời + tự chia hội thoại theo ca / tải** (không nhồi quá trần, người nghỉ không nhận) | Pancake chia vòng tròn, không biết tải | máy phân việc `lib/work/distribution.ts` |
| C2 | **Tóm tắt một dòng** cho người nhận ca: khách muốn gì, đang kẹt ở đâu | | AI của shop, lịch sử hội thoại |
| C3 | **Tự gắn thẻ theo nội dung** (khiếu nại, đổi trả, hỏi sỉ, hỏi ship) bằng lời gọi AI rẻ | Thẻ Pancake gắn tay | nhãn hội thoại |
| C4 | **Bảng hiệu quả từng nhân viên / bot** theo level: tỷ lệ chốt, thời gian phản hồi, đơn hoàn sau chốt | | `/ai/sales-chatbot/performance`, sổ sự kiện |
| C5 | **Ứng dụng điện thoại + thông báo đẩy** cho tin mới | | PWA + thông báo đẩy (#581) |

## Nhóm D — kênh và dữ liệu

| # | Tính năng | Ghi chú |
| --- | --- | --- |
| D1 | **TikTok Shop chat + Instagram DM trực tiếp** | Khoảng trống lớn nhất so với Pancake; cần tài khoản đối tác TikTok (HUMAN GATE) |
| D2 | **Đọc ghi âm / video khách gửi** cho bot khách (bot nhà đã có) | mở cho `lib/sales-chatbot` |
| D3 | **Báo cáo quảng cáo → hội thoại → đơn → tiền thật** theo từng bài / mẫu quảng cáo | ERP đã có quy kết quảng cáo + ORDER_OUTCOME; Pancake dừng ở «số đơn» |

## Đề xuất thứ tự

A1 → A2 → B1 → C1 → A3 → D3 (mỗi mục một PR, đo trước / sau bằng `org-order-audit` và trang Hiệu quả). B2 và D1 cần chủ shop
quyết (pháp lý / tài khoản đối tác) trước khi viết mã.
