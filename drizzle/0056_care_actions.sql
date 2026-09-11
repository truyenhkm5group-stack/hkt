-- ═══════════ SỔ CHĂM SÓC ĐƠN GIAO HỤT ═══════════
--
-- Trước bảng này, "CSKH đã làm gì với kiện hàng đó" không tồn tại ở đâu cả. Có case CSKH khi BOT tự
-- nhắn, nhưng người gọi điện xong thì không có chỗ nào ghi. Hệ quả: không trả lời được câu quan
-- trọng nhất của khâu giao vận — **gọi khách có cứu được đơn không, và cứu được bao nhiêu tiền.**
--
-- ĐO TỪ HÔM NAY, KHÔNG SUY NGƯỢC. Dữ liệu cũ không có actor nên không thể dựng lại cohort quá khứ;
-- suy ngược sẽ tạo ra một tỷ lệ hiệu quả nghe rất thuyết phục mà không có gì đứng sau.
--
-- Cột `*_at_action` là ẢNH CHỤP tại thời điểm hành động, cố ý không tính lại về sau: so sánh phải
-- đứng trên trạng thái LÚC ĐÓ, không phải trạng thái hôm nay.
create table if not exists "care_actions" (
  "id" text primary key not null,
  "shipment_id" text not null references "shipments"("id") on delete cascade,
  "order_id" text references "orders"("id") on delete set null,
  "actor_id" text references "users"("id") on delete set null,
  "actor_email" text default '' not null,
  "kind" text not null,
  "note" text default '' not null,
  -- Ảnh chụp bối cảnh lúc hành động
  "stage_at_action" text default '' not null,
  "bucket_at_action" text default '' not null,
  "cod_at_action" bigint,
  "event_age_hours_at_action" integer,
  "failed_attempts_at_action" integer,
  "created_at" timestamp with time zone default now() not null
);

--> statement-breakpoint
create index if not exists "care_actions_shipment_idx" on "care_actions" ("shipment_id", "created_at");
--> statement-breakpoint
create index if not exists "care_actions_created_idx" on "care_actions" ("created_at");
