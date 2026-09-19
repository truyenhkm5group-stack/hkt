-- SỔ NGUỒN CỦA TỪNG Ô ĐƠN HÀNG — ai nói ra dữ kiện này, ở tin nhắn nào.
--
-- VẤN ĐỀ: trạng thái đơn nằm ở MỘT ô jsonb (`sales_conversations.state`) — một túi phẳng các giá
-- trị trần. `state.size = 'L'` không nói được "L" từ đâu ra, mà nó có tới BA chỗ ghi khác nhau:
-- khách nói, bảng số đo ERP suy ra, hoặc dòng mẫu mã khớp được. Cả ba ghi cùng một chuỗi.
--
-- Nên khi một đơn giao sai size, câu hỏi đầu tiên của người xử lý khiếu nại — *lúc ấy ai đã chốt
-- size này* — không có chỗ nào trả lời. `ai_runs.state_before/state_after` cho biết ô ấy ĐỔI ở
-- lượt nào, nhưng không cho biết AI đã đổi nó.
--
-- ĐÂY KHÔNG PHẢI MÁY TRẠNG THÁI THỨ HAI. `sales_conversations.state` vẫn là nguồn sự thật cho dây
-- chuyền bán hàng; bảng này chỉ GHI LẠI. Không một quyết định bán hàng nào được đọc nó — nếu có,
-- ta vừa dựng hai nơi trả lời cùng một câu hỏi, và chúng sẽ nói khác nhau vào đúng lúc tệ nhất.
--
-- HAI CỘT CHO HAI CÂU HỎI KHÁC NHAU, KHÔNG ĐƯỢC GỘP:
--   `source_type` — dữ kiện tới TỪ ĐÂU (khách · nhân viên · danh mục · bảng số đo · mô hình…)
--   `claim`       — nó có phải LỜI KHÁCH NÓI không (STATED · DERIVED · INFERRED)
-- Gộp lại thì "size do bảng số đo gợi ý" và "size khách tự chọn" trông y hệt nhau, và khi kiện
-- hàng không vừa thì hồ sơ sẽ nói khách tự chọn.
--
-- LỊCH SỬ CHÍNH LÀ THỨ CẦN GIỮ: đổi giá trị thì dòng cũ thành SUPERSEDED, KHÔNG xoá.
--
-- Khoá ngoại `set null` cho `run_id` và `source_message_id`: sổ này sống lâu hơn một lượt chạy và
-- lâu hơn dữ liệu khách có thể bị xoá — mất dấu vết thì phải in ra là mất, không giả vờ còn.
create table if not exists "order_field_provenance" (
  "id" text primary key not null,
  "conversation_id" text not null references "sales_conversations"("id") on delete cascade,
  "run_id" text references "ai_runs"("id") on delete set null,
  "field" text not null,
  "value" text not null default '',
  "source_type" text not null,
  "claim" text not null,
  "source_message_id" text references "sales_messages"("id") on delete set null,
  "source_reference" text not null default '',
  "evidence" text not null default '',
  "confidence" double precision,
  "status" text not null default 'ACTIVE',
  "superseded_at" timestamp with time zone,
  "created_at" timestamp with time zone default now() not null
);
--> statement-breakpoint
-- Tra theo hội thoại + ô: câu hỏi thật sự là "ô size của hội thoại này đã đi qua những giá trị nào".
create index if not exists "order_field_provenance_conv_idx" on "order_field_provenance" ("conversation_id","field","created_at");
--> statement-breakpoint
create index if not exists "order_field_provenance_run_idx" on "order_field_provenance" ("run_id");
--> statement-breakpoint
-- Hai cột phân loại là DANH SÁCH ĐÓNG, khoá ở CSDL chứ không chỉ ở TypeScript: một chuỗi lạ lọt
-- vào đây buộc mọi phép đếm sau này phải chọn giữa bỏ sót và đếm nhầm.
alter table "order_field_provenance" drop constraint if exists "order_field_provenance_claim_check";
--> statement-breakpoint
alter table "order_field_provenance" add constraint "order_field_provenance_claim_check"
  check ("claim" in ('STATED','DERIVED','INFERRED'));
--> statement-breakpoint
alter table "order_field_provenance" drop constraint if exists "order_field_provenance_status_check";
--> statement-breakpoint
alter table "order_field_provenance" add constraint "order_field_provenance_status_check"
  check ("status" in ('ACTIVE','SUPERSEDED'));
--> statement-breakpoint
-- Dòng còn hiệu lực KHÔNG được mang mốc hết hiệu lực, và ngược lại. Không có ràng buộc này thì
-- "ACTIVE kèm superseded_at" đi lọt, và không ai biết nên tin cột nào.
alter table "order_field_provenance" drop constraint if exists "order_field_provenance_superseded_check";
--> statement-breakpoint
alter table "order_field_provenance" add constraint "order_field_provenance_superseded_check"
  check (("status" = 'ACTIVE' and "superseded_at" is null) or ("status" = 'SUPERSEDED' and "superseded_at" is not null));
