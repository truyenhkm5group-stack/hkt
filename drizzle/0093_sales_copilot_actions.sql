-- SỔ THAO TÁC CỦA NHÂN VIÊN TRÊN NẤC TRỢ LÝ — nơi DUY NHẤT ghi "ai đã gửi gì cho khách".
--
-- Mỗi tin rời khỏi ERP ở nấc COPILOT để lại đúng một dòng ở đây, mang KHOÁ TÀI KHOẢN của người
-- bấm. `actor_user_id` là NOT NULL và `on delete restrict`: không có đường nào ghi một lần gửi mà
-- không quy được về một con người, và xoá tài khoản không được phép làm mồ côi một dòng gửi tin.
--
-- BA CỘT CHỮ, BA NGHĨA: câu MÁY soạn · câu THẬT SỰ gửi · sửa bao nhiêu. Gộp lại thì không bao giờ
-- trả lời được "nhân viên có dùng được câu máy soạn không" — câu hỏi lớn nhất của cả giai đoạn.
create table if not exists "sales_copilot_actions" (
  "id" text primary key not null,
  "conversation_id" text not null references "sales_conversations"("id") on delete cascade,
  "suggestion_id" text references "sales_suggestions"("id") on delete set null,
  "run_id" text references "ai_runs"("id") on delete set null,
  "page_id" text not null default '',
  "action" text not null,
  "suggested_text" text not null default '',
  "final_text" text not null default '',
  "edited" boolean,
  "edit_distance" integer,
  "reject_reason" text,
  "note" text not null default '',
  "send_status" text not null default 'NONE',
  "pancake_message_id" text not null default '',
  "send_error" text not null default '',
  "review_seconds" integer,
  "actor_user_id" text not null references "users"("id") on delete restrict,
  "actor_name" text not null default '',
  "created_at" timestamptz not null default now()
);--> statement-breakpoint

-- Danh sách ĐÓNG, chặn ở CSDL chứ không chỉ ở lược đồ đầu vào: một giá trị lạ lọt vào thì mọi bảng
-- đếm sau này phải chọn giữa bỏ qua nó và hiện một nhãn không ai hiểu.
alter table "sales_copilot_actions" add constraint "sales_copilot_actions_action_check"
  check ("action" in ('SEND', 'EDIT_SEND', 'REJECT', 'REGENERATE', 'TAKEOVER', 'RELEASE'));--> statement-breakpoint

alter table "sales_copilot_actions" add constraint "sales_copilot_actions_status_check"
  check ("send_status" in ('NONE', 'PENDING', 'SENT', 'FAILED'));--> statement-breakpoint

-- MỘT CÂU GỢI Ý CHỈ ĐƯỢC KẾT THÚC MỘT LẦN.
--
-- Hai tab cùng mở, hai lần bấm Gửi, hai tin nhắn cho khách — đó là thứ một phép kiểm ở tầng ứng
-- dụng KHÔNG chặn được, vì cả hai lượt đều đọc thấy "chưa gửi" trước khi lượt nào kịp ghi. Ràng
-- buộc duy nhất ở CSDL thì chặn được: đúng một lượt thắng, lượt kia nhận lỗi trùng và KHÔNG gọi
-- tới Pancake.
--
-- Dòng `FAILED` nằm NGOÀI ràng buộc có chủ ý: gửi hỏng vì mạng thì phải bấm lại được. Dòng
-- `PENDING` thì nằm TRONG — chưa biết Pancake đã nhận hay chưa, và gửi hai lần tệ hơn gửi thiếu.
create unique index if not exists "sales_copilot_actions_terminal_uq"
  on "sales_copilot_actions" ("suggestion_id")
  where "action" in ('SEND', 'EDIT_SEND', 'REJECT') and "send_status" <> 'FAILED';--> statement-breakpoint

create index if not exists "sales_copilot_actions_conv_idx" on "sales_copilot_actions" ("conversation_id", "created_at");--> statement-breakpoint
create index if not exists "sales_copilot_actions_actor_idx" on "sales_copilot_actions" ("actor_user_id", "created_at");--> statement-breakpoint
create index if not exists "sales_copilot_actions_action_idx" on "sales_copilot_actions" ("action", "created_at");
