-- MỐC ĐỌC CỦA BỘ NẠP TIN SỐNG — một dòng cho mỗi page.
--
-- Hai việc trong một bảng, đi cùng nhau có lý do: MỐC (đã đọc tới đâu) và SỨC KHOẺ (vòng gần nhất
-- lúc nào, hỏng mấy lần liền). Người trực mở màn hình hỏi "hệ thống có đang sống không" — câu trả
-- lời phải là một con số đọc được, không phải một dòng log.
--
-- `last_ok_at` tách khỏi `last_run_at` có chủ ý: gộp lại thì một bộ nạp hỏng liên tục vẫn trông như
-- đang sống, vì nó vẫn "chạy" đều đặn.
--
-- Mốc nằm ở CSDL nên dựng lại container không mất. Và mất mốc cũng không sinh ra bản sao: đường nạp
-- chống trùng bằng mã tin ngoài và bằng vân tay nội dung.
create table if not exists "sales_ingest_cursors" (
  "page_id" text primary key not null,
  "last_message_at" timestamptz,
  "last_message_external_id" text not null default '',
  "last_run_at" timestamptz,
  "last_ok_at" timestamptz,
  "last_error" text not null default '',
  "consecutive_errors" integer not null default 0,
  "messages_ingested" integer not null default 0,
  "conversations_seen" integer not null default 0,
  "updated_at" timestamptz not null default now()
);
