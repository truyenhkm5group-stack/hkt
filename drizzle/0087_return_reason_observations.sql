-- QUAN SÁT LÝ DO HOÀN: MỘT DÒNG CHO MỘT LẦN AI ĐÓ NÓI RA VÌ SAO KIỆN HOÀN.
--
-- VÌ SAO KHÔNG NHÉT THÊM CỘT VÀO `shipment_return_reasons`: bảng đó khai `shipment_id` UNIQUE, tức
-- nó trả lời "kiện này CUỐI CÙNG xếp vào lý do nào" — một kết luận cho một kiện. Nhưng một kiện có
-- thể có ĐVVC nói một câu lúc 9h, khách nhắn một câu lúc 14h, kho ghi nhận xét hôm sau. Nhét cả ba
-- vào một dòng thì hai cái sau ghi đè hai cái trước và không ai còn thấy chúng từng mâu thuẫn nhau.
--
-- Bảng này CHỈ THÊM, không sửa. Chữ gốc là sự thật bất biến; phân loại và nhóm được suy lúc ĐỌC,
-- nên đổi cách đọc không phải viết lại lịch sử.
--
-- KHOÁ CHỐNG TRÙNG LÀ NỘI DUNG (`dedupe_key` = kiện · nguồn · mốc · vân tay chữ), không phải một
-- số thứ tự: nhờ vậy chạy lại lượt rút quan sát không sinh thêm dòng nào, và webhook Viettel Post
-- gửi trùng (họ thử lại tối đa 5 lần) không nhân bản chứng cứ.
--
-- KHÔNG backfill trong migration. Việc rút quan sát từ dữ liệu cũ là một lượt chạy RIÊNG, có chạy
-- thử và có thống kê trước/sau — nhét vào đây thì nó chạy một lần, im lặng, không ai kiểm được.
CREATE TABLE IF NOT EXISTS "return_reason_observations" (
  "id" text PRIMARY KEY NOT NULL,
  "shipment_id" text,
  "order_id" text,
  "source" text NOT NULL,
  "raw_text" text NOT NULL,
  "reason_at_write" text DEFAULT 'UNKNOWN' NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "source_ref" text DEFAULT '' NOT NULL,
  "actor_id" text,
  "actor_email" text DEFAULT '' NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "dedupe_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "return_reason_obs_raw_check" CHECK (length(btrim("raw_text")) > 0),
  CONSTRAINT "return_reason_obs_link_check" CHECK ("shipment_id" IS NOT NULL OR "order_id" IS NOT NULL)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "return_reason_observations" ADD CONSTRAINT "return_reason_observations_shipment_id_shipments_id_fk"
    FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "return_reason_observations" ADD CONSTRAINT "return_reason_observations_order_id_orders_id_fk"
    FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "return_reason_observations" ADD CONSTRAINT "return_reason_observations_actor_id_users_id_fk"
    FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "return_reason_obs_uq" ON "return_reason_observations" ("dedupe_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_reason_obs_shipment_idx" ON "return_reason_observations" ("shipment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_reason_obs_order_idx" ON "return_reason_observations" ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_reason_obs_source_idx" ON "return_reason_observations" ("source");
