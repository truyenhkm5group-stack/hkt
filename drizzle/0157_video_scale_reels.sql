-- 0157 · VIDEO SCALE — CONTENT + ĐĂNG FACEBOOK REEL (chủ shop 27/09/2026, PR 2/4).
--
--  · `video_scale_skus`: fanpage ĐƯỢC DUYỆT cho mã (`page_id`, người chọn — máy không đoán theo tên), chế độ đăng riêng
--    của mã (`publish_mode` NULL = theo fanpage · `MANUAL_REVIEW` = luôn chờ người), dừng khẩn cấp cấp mã.
--  · `video_scale_pages`: chế độ đăng theo fanpage. Không có dòng = CHƯA CẤU HÌNH = chờ người duyệt (mặc định an toàn).
--  · `video_scale_variants`: phương án content + content sẽ đăng + ai chốt.
--  · `video_scale_posts`: một dòng mỗi (biến thể, fanpage) — thử lại dùng lại dòng, không đẻ bài thứ hai.
--  · `video_scale_jobs`: thêm loại `CAPTION` · `PUBLISH_REEL` và cột `post_id`.
--
-- Không backfill. Viết tay và idempotent như 0033–0155.

ALTER TABLE "video_scale_skus" ADD COLUMN IF NOT EXISTS "page_id" text;
--> statement-breakpoint
ALTER TABLE "video_scale_skus" ADD COLUMN IF NOT EXISTS "publish_mode" text;
--> statement-breakpoint
ALTER TABLE "video_scale_skus" ADD COLUMN IF NOT EXISTS "automation_paused_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "video_scale_skus" ADD COLUMN IF NOT EXISTS "automation_paused_reason" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "video_scale_skus" DROP CONSTRAINT IF EXISTS "video_scale_skus_publish_mode_check";
--> statement-breakpoint
ALTER TABLE "video_scale_skus" ADD CONSTRAINT "video_scale_skus_publish_mode_check" CHECK ("publish_mode" IS NULL OR "publish_mode" = 'MANUAL_REVIEW');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_scale_pages" (
  "page_id" text PRIMARY KEY NOT NULL,
  "publish_mode" text DEFAULT 'MANUAL_REVIEW' NOT NULL,
  "max_posts_per_day" integer DEFAULT 3 NOT NULL,
  "paused_at" timestamp with time zone,
  "paused_reason" text DEFAULT '' NOT NULL,
  "updated_by_user_id" text,
  "updated_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "video_scale_pages_mode_check" CHECK ("publish_mode" IN ('MANUAL_REVIEW', 'AUTO_PUBLISH')),
  CONSTRAINT "video_scale_pages_max_check" CHECK ("max_posts_per_day" BETWEEN 1 AND 10)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_pages" ADD CONSTRAINT "video_scale_pages_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "video_scale_variants" ADD COLUMN IF NOT EXISTS "caption_options" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "video_scale_variants" ADD COLUMN IF NOT EXISTS "caption" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "video_scale_variants" ADD COLUMN IF NOT EXISTS "caption_state" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "video_scale_variants" ADD COLUMN IF NOT EXISTS "caption_model" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "video_scale_variants" ADD COLUMN IF NOT EXISTS "caption_cost_usd" double precision;
--> statement-breakpoint
ALTER TABLE "video_scale_variants" ADD COLUMN IF NOT EXISTS "caption_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "video_scale_variants" ADD COLUMN IF NOT EXISTS "caption_by" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "video_scale_variants" ADD COLUMN IF NOT EXISTS "caption_at" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_variants" ADD CONSTRAINT "video_scale_variants_caption_by_user_id_users_id_fk" FOREIGN KEY ("caption_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "video_scale_variants" DROP CONSTRAINT IF EXISTS "video_scale_variants_caption_state_check";
--> statement-breakpoint
ALTER TABLE "video_scale_variants" ADD CONSTRAINT "video_scale_variants_caption_state_check" CHECK ("caption_state" IN ('', 'DRAFTED', 'READY'));
--> statement-breakpoint
ALTER TABLE "video_scale_jobs" ADD COLUMN IF NOT EXISTS "post_id" text;
--> statement-breakpoint
ALTER TABLE "video_scale_jobs" DROP CONSTRAINT IF EXISTS "video_scale_jobs_kind_check";
--> statement-breakpoint
ALTER TABLE "video_scale_jobs" ADD CONSTRAINT "video_scale_jobs_kind_check" CHECK ("kind" IN ('SCRIPT', 'CLIP', 'TTS', 'RENDER', 'QC', 'CAPTION', 'PUBLISH_REEL'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_scale_posts" (
  "id" text PRIMARY KEY NOT NULL,
  "variant_id" text NOT NULL,
  "product_id" text NOT NULL,
  "page_id" text NOT NULL,
  "status" text DEFAULT 'QUEUED' NOT NULL,
  "caption" text NOT NULL,
  "publish_at" timestamp with time zone,
  "fb_video_id" text DEFAULT '' NOT NULL,
  "fb_post_id" text DEFAULT '' NOT NULL,
  "permalink" text DEFAULT '' NOT NULL,
  "published_at" timestamp with time zone,
  "uploaded_at" timestamp with time zone,
  "pending_step" text DEFAULT '' NOT NULL,
  "pending_at" timestamp with time zone,
  "error" text DEFAULT '' NOT NULL,
  "authorized_by_user_id" text,
  "authorized_by" text DEFAULT '' NOT NULL,
  "auto" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "video_scale_posts_status_check" CHECK ("status" IN ('QUEUED', 'UPLOADING', 'PROCESSING', 'SCHEDULED', 'PUBLISHED', 'FAILED', 'CANCELLED')),
  CONSTRAINT "video_scale_posts_published_check" CHECK ("status" <> 'PUBLISHED' OR ("fb_video_id" <> '' AND "published_at" IS NOT NULL)),
  CONSTRAINT "video_scale_posts_caption_check" CHECK (length(btrim("caption")) > 0),
  CONSTRAINT "video_scale_posts_auto_check" CHECK ("auto" = false OR "authorized_by_user_id" IS NULL)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_posts" ADD CONSTRAINT "video_scale_posts_variant_id_video_scale_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."video_scale_variants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_posts" ADD CONSTRAINT "video_scale_posts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_posts" ADD CONSTRAINT "video_scale_posts_authorized_by_user_id_users_id_fk" FOREIGN KEY ("authorized_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "video_scale_posts_variant_page_uq" ON "video_scale_posts" USING btree ("variant_id","page_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_scale_posts_page_idx" ON "video_scale_posts" USING btree ("page_id","created_at");
