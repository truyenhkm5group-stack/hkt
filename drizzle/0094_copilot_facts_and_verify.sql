-- BA THỨ THẺ HÀNG ĐỢI PHẢI NÓI ĐƯỢC, VÀ MỘT THỨ LẦN GỬI ĐẦU PHẢI CHỨNG MINH ĐƯỢC.
--
-- ① `sales_suggestions.facts_json` — ẢNH CHỤP DỮ KIỆN máy chủ đã dùng lúc soạn câu.
--
-- Nhân viên nhìn thấy câu chữ, nhưng thứ họ cần để quyết định bấm hay không là DỮ KIỆN đằng sau nó:
-- giá bao nhiêu, phí ship bao nhiêu, có những màu nào, size đã kết luận được chưa, chính sách đổi
-- trả đã khai chưa. Tính lại lúc đọc thì ra con số của HÔM NAY, không phải con số câu ấy đã dùng —
-- và khi hai con số lệch nhau thì người soát không còn kiểm được gì nữa. Nên phải là ảnh chụp.
--
-- ② `sales_copilot_actions.warnings` — lúc bấm gửi, ĐANG THIẾU những gì.
--
-- Máy không đoán size, không hứa còn hàng, không tự cam kết đổi trả. Nhưng nhân viên SỬA TAY rồi
-- gửi thì được — đó là quyền của họ. Cột này ghi lại rằng họ đã bấm TRONG LÚC hệ thống đang báo
-- thiếu. Không phải để trách ai; để sau này lần ra được vì sao một lời hứa sai đã ra khỏi cửa.
--
-- ③ `verified` / `verify_note` — LẦN GỬI ĐẦU PHẢI TỰ CHỨNG MINH.
--
-- Gửi xong, đọc lại hội thoại từ Pancake và đếm xem tin ấy có mặt ĐÚNG MỘT LẦN không. `null` là
-- CHƯA KIỂM (mạng hỏng, API từ chối) — khác hẳn `false` (đã kiểm và thấy sai).

alter table "sales_suggestions" add column if not exists "facts_json" jsonb;--> statement-breakpoint

alter table "sales_copilot_actions" add column if not exists "warnings" jsonb not null default '[]'::jsonb;--> statement-breakpoint
alter table "sales_copilot_actions" add column if not exists "verified" boolean;--> statement-breakpoint
alter table "sales_copilot_actions" add column if not exists "verify_note" text not null default '';--> statement-breakpoint

-- Mảng phải LÀ một mảng: một chuỗi lọt vào thì mọi phép đếm bên dưới sai thầm lặng.
alter table "sales_copilot_actions" drop constraint if exists "sales_copilot_actions_warnings_check";--> statement-breakpoint
alter table "sales_copilot_actions" add constraint "sales_copilot_actions_warnings_check"
  check (jsonb_typeof("warnings") = 'array');
