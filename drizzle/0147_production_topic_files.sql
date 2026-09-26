-- 0147 · TOPIC SẢN XUẤT: ẢNH / VIDEO ĐÍNH KÈM (chủ shop 26/09/2026).
--
-- Trước bản này topic chỉ nhận LINK (URL http/https) — ảnh chụp mẫu và video test quay bằng điện thoại
-- phải đi đường vòng qua Drive / Zalo rồi dán link. Nay tệp nằm ngay trong ERP:
--
--  · `production_topic_files` — một dòng mỗi tệp: loại (IMAGE / VIDEO), tên, kiểu nội dung, số byte, số
--    khúc, trạng thái (UPLOADING → READY), người tải (khoá tài khoản + ảnh chụp tên — luật 34).
--  · `production_topic_file_chunks` — nội dung nhị phân (bytea) chia khúc ≤ 2 MB: tải lên không vượt trần
--    thân Server Action, phát video theo `Range` chỉ đọc đúng khúc cần.
--
-- Bảng MỚI, không đụng dữ liệu cũ, không backfill. Viết tay và idempotent như 0033–0146: CREATE TABLE IF
-- NOT EXISTS, khoá ngoại bọc duplicate_object, DROP CONSTRAINT IF EXISTS rồi ADD.

CREATE TABLE IF NOT EXISTS "production_topic_files" (
  "id" text PRIMARY KEY NOT NULL,
  "topic_id" text NOT NULL,
  "kind" text NOT NULL,
  "file_name" text DEFAULT '' NOT NULL,
  "content_type" text NOT NULL,
  "bytes" integer NOT NULL,
  "chunk_count" integer NOT NULL,
  "status" text DEFAULT 'UPLOADING' NOT NULL,
  "uploaded_by_user_id" text,
  "uploaded_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "production_topic_files" ADD CONSTRAINT "production_topic_files_topic_id_production_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."production_topics"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "production_topic_files" ADD CONSTRAINT "production_topic_files_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_topic_files_topic_idx" ON "production_topic_files" USING btree ("topic_id","created_at");
--> statement-breakpoint
ALTER TABLE "production_topic_files" DROP CONSTRAINT IF EXISTS "production_topic_files_kind_check";
--> statement-breakpoint
ALTER TABLE "production_topic_files" ADD CONSTRAINT "production_topic_files_kind_check" CHECK ("kind" IN ('IMAGE', 'VIDEO'));
--> statement-breakpoint
ALTER TABLE "production_topic_files" DROP CONSTRAINT IF EXISTS "production_topic_files_status_check";
--> statement-breakpoint
ALTER TABLE "production_topic_files" ADD CONSTRAINT "production_topic_files_status_check" CHECK ("status" IN ('UPLOADING', 'READY'));
--> statement-breakpoint
ALTER TABLE "production_topic_files" DROP CONSTRAINT IF EXISTS "production_topic_files_size_check";
--> statement-breakpoint
ALTER TABLE "production_topic_files" ADD CONSTRAINT "production_topic_files_size_check" CHECK ("bytes" > 0 AND "chunk_count" > 0);
--> statement-breakpoint
ALTER TABLE "production_topic_files" DROP CONSTRAINT IF EXISTS "production_topic_files_ready_check";
--> statement-breakpoint
ALTER TABLE "production_topic_files" ADD CONSTRAINT "production_topic_files_ready_check" CHECK ("status" <> 'READY' OR "completed_at" IS NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "production_topic_file_chunks" (
  "id" text PRIMARY KEY NOT NULL,
  "file_id" text NOT NULL,
  "seq" integer NOT NULL,
  "data" bytea NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "production_topic_file_chunks" ADD CONSTRAINT "production_topic_file_chunks_file_id_production_topic_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."production_topic_files"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "production_topic_file_chunks_seq_uq" ON "production_topic_file_chunks" USING btree ("file_id","seq");
--> statement-breakpoint
ALTER TABLE "production_topic_file_chunks" DROP CONSTRAINT IF EXISTS "production_topic_file_chunks_seq_check";
--> statement-breakpoint
ALTER TABLE "production_topic_file_chunks" ADD CONSTRAINT "production_topic_file_chunks_seq_check" CHECK ("seq" >= 0);
