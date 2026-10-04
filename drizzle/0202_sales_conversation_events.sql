-- 0202 · SỔ SỰ KIỆN HỘI THOẠI BÁN HÀNG (lib/sales-chatbot/events.ts · docs/productization/MIGRATION_PLAN.md M2).
--
--  · `sales_conversation_events`: APPEND-ONLY, mỗi bước bán hàng có mốc (khách nhắn, AI trả lời, chuyển bước, báo giá, khách để
--    lại SĐT, upsell, đơn nháp / chốt, chuyển người, nhân viên nhận, trả lại AI, nhắc khách). `dedupe_key` UNIQUE.
--  · `orders.origin` + `orders.sales_conversation_id`: đơn của AI nối về hội thoại bằng KHOÁ thay cho chuỗi `source`.
--  · Chỉ THÊM. Không backfill (luật 35): dòng cũ để NULL = «trước khi có sổ», không đoán ngược từ `state`.
--  · CHECK trên `orders` thêm NOT VALID rồi VALIDATE riêng: không giữ khoá ghi cả bảng trong lúc quét (cột mới toàn NULL).
--  Viết tay, idempotent.

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "origin" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "sales_conversation_id" text;
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_origin_check";
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_origin_check" CHECK ("origin" IS NULL OR "origin" IN ('PANCAKE_POS','ERP_FORM','AI_AGENT','AI_ORDER_SYNC','IMPORT')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_origin_check";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_sales_conversation_idx" ON "orders" USING btree ("sales_conversation_id") WHERE "sales_conversation_id" is not null;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_conversation_events" (
  "id" text PRIMARY KEY NOT NULL,
  "conversation_id" text NOT NULL REFERENCES "sales_chat_conversations"("id") ON DELETE cascade,
  "cycle" integer DEFAULT 0 NOT NULL,
  "type" text NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_user_id" text,
  "channel" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "order_id" text,
  "amount_vnd" bigint,
  "reason_code" text,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "dedupe_key" text NOT NULL,
  "schema_version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sales_conversation_events_type_check" CHECK ("type" IN ('conversation.opened','message.received','ai.replied','stage.changed','quote.given','customer.identified','upsell.offered','upsell.accepted','upsell.declined','order.drafted','order.confirmed','appointment.booked','handoff.requested','human.took_over','human.replied','ai.resumed','followup.sent','conversation.declined')),
  CONSTRAINT "sales_conversation_events_actor_check" CHECK ("actor_kind" IN ('CUSTOMER','AI','HUMAN','SYSTEM')),
  CONSTRAINT "sales_conversation_events_channel_check" CHECK ("channel" ~ '^[A-Z_]{2,20}$'),
  CONSTRAINT "sales_conversation_events_amount_check" CHECK ("amount_vnd" IS NULL OR "amount_vnd" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_conversation_events_dedupe_uq" ON "sales_conversation_events" USING btree ("dedupe_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_conversation_events_conv_idx" ON "sales_conversation_events" USING btree ("conversation_id","occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_conversation_events_type_idx" ON "sales_conversation_events" USING btree ("type","occurred_at");
