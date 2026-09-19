-- BỘ CA HỒI QUY CHO NHÂN SỰ BÁN HÀNG.
--
-- Một ca là ẢNH CHỤP BẤT BIẾN của một tình huống, không phải một con trỏ tới hội thoại. Người soát
-- mở /ai/review, thấy một lượt máy xử lý sai (hoặc một ca khó máy xử lý đúng), bấm thêm vào bộ hồi
-- quy và khai kỳ vọng. Từ giây ấy ca phải cho cùng một kết quả mãi mãi.
--
-- VÌ SAO KHÔNG ĐỌC LẠI HỘI THOẠI GỐC LÚC CHẠY:
--   · hội thoại thật đi tiếp — khách nhắn thêm, nhân viên nhận việc — nên đọc lại là đo một tình
--     huống KHÁC tình huống đã được chấm;
--   · tồn kho và giá đổi mỗi ngày, và một ca đỏ vì kho vừa hết hàng là ca người ta đi gia hạn con
--     số thay vì đọc thông điệp (AGENTS.md mục 50);
--   · dữ liệu khách có thể bị xoá.
-- Nên `input` giữ đủ: tin của khách (mốc TƯƠNG ĐỐI theo phút), trạng thái trước, kết quả công cụ
-- ERP đã chụp, bối cảnh. Hai khoá ngoại là `set null` — ca sống lâu hơn dữ liệu khách, và mất dấu
-- vết thì in ra là mất chứ không giả vờ còn.
--
-- `case_key` DUY NHẤT: bấm hai lần trên cùng một lượt phải là CẬP NHẬT, không phải đẻ ca thứ hai.
-- Một bộ hồi quy có hai ca trùng thì mọi tỷ lệ đọc từ nó đều lệch, và lệch âm thầm.
--
-- Tắt bằng `active = false` thay vì xoá: một ca sai cũng là một quyết định đã có người đưa ra.
create table if not exists "sales_regression_cases" (
  "id" text primary key not null,
  "case_key" text not null,
  "title" text not null default '',
  "page_id" text not null default '',
  "source_suggestion_id" text references "sales_suggestions"("id") on delete set null,
  "source_conversation_id" text references "sales_conversations"("id") on delete set null,
  "input" jsonb not null,
  "expected" jsonb not null,
  "note" text not null default '',
  "active" boolean not null default true,
  "created_by_user_id" text references "users"("id") on delete set null,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);
--> statement-breakpoint
create unique index if not exists "sales_regression_cases_key_uq" on "sales_regression_cases" ("case_key");
--> statement-breakpoint
create index if not exists "sales_regression_cases_active_idx" on "sales_regression_cases" ("active", "created_at");
