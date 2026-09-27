-- 0153 · TOPIC SẢN XUẤT: TAG NGƯỜI VÀ TOPIC RIÊNG (chủ shop 27/09/2026).
--
-- Marketing mở topic để trao đổi với sản xuất và TAG những người cần tham gia. Người được tag nhận tin ở
-- hộp thư cá nhân, và chỉ họ (cùng người mở topic và ADMIN) xem được topic.
--
--  · `production_topics.restricted` — topic mở từ nay mang `true`. Topic cũ giữ `false` = tầm nhìn cũ: KHÔNG
--    backfill, không đoán ai "lẽ ra" được tag (AGENTS.md mục 35).
--  · `production_topic_members` — một dòng mỗi người được tag, khoá (topic, người) duy nhất.
--
-- Viết tay và idempotent như 0033–0152.

ALTER TABLE "production_topics" ADD COLUMN IF NOT EXISTS "restricted" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "production_topic_members" (
  "id" text PRIMARY KEY NOT NULL,
  "topic_id" text NOT NULL,
  "user_id" text NOT NULL,
  "added_by_user_id" text,
  "added_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "production_topic_members" ADD CONSTRAINT "production_topic_members_topic_id_production_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."production_topics"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "production_topic_members" ADD CONSTRAINT "production_topic_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "production_topic_members" ADD CONSTRAINT "production_topic_members_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "production_topic_members_uq" ON "production_topic_members" USING btree ("topic_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_topic_members_user_idx" ON "production_topic_members" USING btree ("user_id");
