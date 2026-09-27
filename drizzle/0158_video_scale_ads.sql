-- 0158 · VIDEO SCALE — QUẢNG CÁO META + HẠN MỨC (chủ shop 27/09/2026, PR 3/4).
--
--  · `video_scale_skus`: tài khoản quảng cáo, chế độ quảng cáo (DRAFT mặc định · PUBLISH_PAUSED · AUTO_LAUNCH), ngân sách
--    ngày mỗi quảng cáo, trần mã / ngày, tự tăng ngân sách (mặc định tắt), người bật chế độ.
--    CHECK: AUTO_LAUNCH đòi đủ tài khoản + ngân sách + trần mã + người đứng tên; ngân sách trong trần cứng.
--  · `video_scale_ads`: một quảng cáo cho một (video, tài khoản) — chiến dịch riêng, dựng TẮT. CHECK: "đang chạy / đang
--    tắt" phải có id Facebook; ngân sách ngày 20.000–500.000đ.
--  · `video_scale_ad_actions`: sổ mọi lượt tạo / bật / tắt / đổi ngân sách, kể cả lượt bị chặn.
--  · `video_scale_jobs`: loại `CREATE_AD` · `PAUSE_AD` và cột `ad_id`.
--
-- Không backfill. Viết tay và idempotent như 0033–0157.

ALTER TABLE "video_scale_skus" ADD COLUMN IF NOT EXISTS "ad_account_id" text;
--> statement-breakpoint
ALTER TABLE "video_scale_skus" ADD COLUMN IF NOT EXISTS "ads_mode" text DEFAULT 'DRAFT' NOT NULL;
--> statement-breakpoint
ALTER TABLE "video_scale_skus" ADD COLUMN IF NOT EXISTS "daily_budget_per_ad_vnd" integer;
--> statement-breakpoint
ALTER TABLE "video_scale_skus" ADD COLUMN IF NOT EXISTS "sku_daily_cap_vnd" integer;
--> statement-breakpoint
ALTER TABLE "video_scale_skus" ADD COLUMN IF NOT EXISTS "auto_scale" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "video_scale_skus" ADD COLUMN IF NOT EXISTS "ads_mode_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "video_scale_skus" ADD COLUMN IF NOT EXISTS "ads_mode_by" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "video_scale_skus" ADD COLUMN IF NOT EXISTS "ads_mode_at" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_skus" ADD CONSTRAINT "video_scale_skus_ads_mode_by_user_id_users_id_fk" FOREIGN KEY ("ads_mode_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "video_scale_skus" DROP CONSTRAINT IF EXISTS "video_scale_skus_ads_mode_check";
--> statement-breakpoint
ALTER TABLE "video_scale_skus" ADD CONSTRAINT "video_scale_skus_ads_mode_check" CHECK ("ads_mode" IN ('DRAFT', 'PUBLISH_PAUSED', 'AUTO_LAUNCH'));
--> statement-breakpoint
ALTER TABLE "video_scale_skus" DROP CONSTRAINT IF EXISTS "video_scale_skus_auto_launch_check";
--> statement-breakpoint
ALTER TABLE "video_scale_skus" ADD CONSTRAINT "video_scale_skus_auto_launch_check" CHECK ("ads_mode" <> 'AUTO_LAUNCH' OR ("ad_account_id" IS NOT NULL AND "daily_budget_per_ad_vnd" > 0 AND "sku_daily_cap_vnd" > 0 AND "ads_mode_by_user_id" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "video_scale_skus" DROP CONSTRAINT IF EXISTS "video_scale_skus_budget_check";
--> statement-breakpoint
ALTER TABLE "video_scale_skus" ADD CONSTRAINT "video_scale_skus_budget_check" CHECK (("daily_budget_per_ad_vnd" IS NULL OR "daily_budget_per_ad_vnd" BETWEEN 20000 AND 500000) AND ("sku_daily_cap_vnd" IS NULL OR "sku_daily_cap_vnd" BETWEEN 20000 AND 2000000));
--> statement-breakpoint
ALTER TABLE "video_scale_jobs" ADD COLUMN IF NOT EXISTS "ad_id" text;
--> statement-breakpoint
ALTER TABLE "video_scale_jobs" DROP CONSTRAINT IF EXISTS "video_scale_jobs_kind_check";
--> statement-breakpoint
ALTER TABLE "video_scale_jobs" ADD CONSTRAINT "video_scale_jobs_kind_check" CHECK ("kind" IN ('SCRIPT', 'CLIP', 'TTS', 'RENDER', 'QC', 'CAPTION', 'PUBLISH_REEL', 'CREATE_AD', 'PAUSE_AD'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_scale_ads" (
  "id" text PRIMARY KEY NOT NULL,
  "variant_id" text NOT NULL,
  "product_id" text NOT NULL,
  "post_id" text,
  "page_id" text NOT NULL,
  "ad_account_id" text NOT NULL,
  "mode" text NOT NULL,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "daily_budget_vnd" integer NOT NULL,
  "campaign_name" text NOT NULL,
  "adset_name" text NOT NULL,
  "ad_name" text NOT NULL,
  "message" text NOT NULL,
  "template_ad_id" text NOT NULL,
  "fb_video_id" text DEFAULT '' NOT NULL,
  "fb_image_hash" text DEFAULT '' NOT NULL,
  "fb_creative_id" text DEFAULT '' NOT NULL,
  "fb_campaign_id" text DEFAULT '' NOT NULL,
  "fb_adset_id" text DEFAULT '' NOT NULL,
  "fb_ad_id" text DEFAULT '' NOT NULL,
  "pending_step" text DEFAULT '' NOT NULL,
  "pending_at" timestamp with time zone,
  "error" text DEFAULT '' NOT NULL,
  "authorized_by_user_id" text,
  "authorized_by" text DEFAULT '' NOT NULL,
  "activated_at" timestamp with time zone,
  "activated_by" text DEFAULT '' NOT NULL,
  "stopped_at" timestamp with time zone,
  "stop_reason" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "video_scale_ads_mode_check" CHECK ("mode" IN ('DRAFT', 'PUBLISH_PAUSED', 'AUTO_LAUNCH')),
  CONSTRAINT "video_scale_ads_status_check" CHECK ("status" IN ('DRAFT', 'QUEUED', 'CREATING', 'PAUSED', 'ACTIVE', 'FAILED', 'STOPPED')),
  CONSTRAINT "video_scale_ads_budget_check" CHECK ("daily_budget_vnd" BETWEEN 20000 AND 500000),
  CONSTRAINT "video_scale_ads_live_check" CHECK ("status" NOT IN ('PAUSED', 'ACTIVE') OR ("fb_ad_id" <> '' AND "fb_campaign_id" <> ''))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_ads" ADD CONSTRAINT "video_scale_ads_variant_id_video_scale_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."video_scale_variants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_ads" ADD CONSTRAINT "video_scale_ads_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_ads" ADD CONSTRAINT "video_scale_ads_post_id_video_scale_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."video_scale_posts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_ads" ADD CONSTRAINT "video_scale_ads_authorized_by_user_id_users_id_fk" FOREIGN KEY ("authorized_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "video_scale_ads_variant_account_uq" ON "video_scale_ads" USING btree ("variant_id","ad_account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "video_scale_ads_fb_ad_uq" ON "video_scale_ads" USING btree ("fb_ad_id") WHERE "fb_ad_id" <> '';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_scale_ads_product_idx" ON "video_scale_ads" USING btree ("product_id","status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_scale_ad_actions" (
  "id" text PRIMARY KEY NOT NULL,
  "ad_id" text,
  "action" text NOT NULL,
  "outcome" text NOT NULL,
  "denial" text DEFAULT '' NOT NULL,
  "detail" text DEFAULT '' NOT NULL,
  "budget_before_vnd" integer,
  "budget_after_vnd" integer,
  "actor_user_id" text,
  "actor" text DEFAULT '' NOT NULL,
  "request" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "video_scale_ad_actions_action_check" CHECK ("action" IN ('CREATE', 'ACTIVATE', 'PAUSE', 'SET_BUDGET')),
  CONSTRAINT "video_scale_ad_actions_outcome_check" CHECK ("outcome" IN ('APPLIED', 'DENIED', 'FAILED'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_ad_actions" ADD CONSTRAINT "video_scale_ad_actions_ad_id_video_scale_ads_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."video_scale_ads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_ad_actions" ADD CONSTRAINT "video_scale_ad_actions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_scale_ad_actions_ad_idx" ON "video_scale_ad_actions" USING btree ("ad_id","created_at");
