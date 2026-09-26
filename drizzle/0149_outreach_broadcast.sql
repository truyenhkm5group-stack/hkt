-- 0149 · GỬI TIN HÀNG LOẠT THEO BỘ LỌC (chủ shop 26/09/2026).
--
--  · `outreach_broadcasts`: mỗi lượt bấm "Gửi" là một dòng — bộ lọc, các tin, người bấm (khoá tài khoản),
--    trạng thái RUNNING / STOPPED / DONE và nhịp tim của vòng gửi.
--  · `outreach_broadcast_recipients`: danh sách người nhận CHỤP LẠI lúc bấm, mỗi hội thoại đúng một dòng
--    mỗi lượt (chỉ mục duy nhất), kết quả gửi ghi vào chính dòng đó.
--
-- Bảng mới, KHÔNG BACKFILL. Viết tay và idempotent như 0033–0148: CREATE … IF NOT EXISTS, DROP CONSTRAINT
-- IF EXISTS rồi tạo lại.

CREATE TABLE IF NOT EXISTS "outreach_broadcasts" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text DEFAULT '' NOT NULL,
  "filters" jsonb NOT NULL,
  "messages" jsonb NOT NULL,
  "media_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "gap_seconds" integer DEFAULT 2 NOT NULL,
  "total" integer DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'RUNNING' NOT NULL,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "stopped_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "heartbeat_at" timestamp with time zone,
  "run_id" text,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outreach_broadcasts" DROP CONSTRAINT IF EXISTS "outreach_broadcasts_status_check";
--> statement-breakpoint
ALTER TABLE "outreach_broadcasts" ADD CONSTRAINT "outreach_broadcasts_status_check" CHECK ("status" IN ('RUNNING','STOPPED','DONE'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_broadcasts_created_idx" ON "outreach_broadcasts" USING btree ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outreach_broadcast_recipients" (
  "id" text PRIMARY KEY NOT NULL,
  "broadcast_id" text NOT NULL REFERENCES "outreach_broadcasts"("id") ON DELETE CASCADE,
  "seq" integer NOT NULL,
  "page_id" text NOT NULL,
  "conversation_id" text NOT NULL,
  "pancake_customer_id" text DEFAULT '' NOT NULL,
  "customer_name" text DEFAULT '' NOT NULL,
  "phone" text,
  "tags" text[] DEFAULT '{}'::text[] NOT NULL,
  "last_customer_message_at" timestamp with time zone,
  "last_shop_message_at" timestamp with time zone,
  "status" text DEFAULT 'PENDING' NOT NULL,
  "reason" text,
  "error" text DEFAULT '' NOT NULL,
  "messages_sent" integer DEFAULT 0 NOT NULL,
  "provider_message_id" text,
  "claimed_at" timestamp with time zone,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outreach_broadcast_recipients" DROP CONSTRAINT IF EXISTS "outreach_broadcast_recipients_status_check";
--> statement-breakpoint
ALTER TABLE "outreach_broadcast_recipients" ADD CONSTRAINT "outreach_broadcast_recipients_status_check" CHECK ("status" IN ('PENDING','SENDING','SENT','SKIPPED','FAILED'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outreach_broadcast_recipients_uq" ON "outreach_broadcast_recipients" USING btree ("broadcast_id","page_id","conversation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_broadcast_recipients_queue_idx" ON "outreach_broadcast_recipients" USING btree ("broadcast_id","status","seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_broadcast_recipients_conv_idx" ON "outreach_broadcast_recipients" USING btree ("page_id","conversation_id","sent_at");
