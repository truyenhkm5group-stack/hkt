-- 0159 · VIDEO SCALE — ĐO LƯỜNG + VÒNG TỐI ƯU (chủ shop 27/09/2026, PR 4/4).
--
--  · `video_scale_verdicts`: phán quyết hằng ngày của từng quảng cáo (cùng luật tắt / giữ của vòng mẫu ảnh) + hành động.
--  · `video_scale_ad_metrics`: số đo VIDEO của Meta (xem 3 giây, ThruPlay, 25–100%) — không phải tiền; tiền vẫn là `ad_spends`.
--  · `video_scale_reel_metrics`: ảnh chụp số đo bài Reel (không trả tiền).
--  · `video_scale_lessons`: bài học đã đếm của từng biến thể (từ quảng cáo, hoặc lý do người loại video).
--  · `video_scale_skus.auto_next_round`: máy tự tạo vòng mới mỗi ngày — mặc định TẮT.
--
-- Không backfill. Viết tay và idempotent như 0033–0158.

ALTER TABLE "video_scale_skus" ADD COLUMN IF NOT EXISTS "auto_next_round" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_scale_verdicts" (
  "id" text PRIMARY KEY NOT NULL,
  "ad_id" text NOT NULL,
  "day" text NOT NULL,
  "verdict" text NOT NULL,
  "reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "action" text DEFAULT 'NONE' NOT NULL,
  "action_result" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "video_scale_verdicts_action_check" CHECK ("action" IN ('NONE', 'PAUSE', 'SCALE', 'RECOMMEND_SCALE'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_verdicts" ADD CONSTRAINT "video_scale_verdicts_ad_id_video_scale_ads_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."video_scale_ads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "video_scale_verdicts_ad_day_uq" ON "video_scale_verdicts" USING btree ("ad_id","day");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_scale_ad_metrics" (
  "id" text PRIMARY KEY NOT NULL,
  "ad_id" text NOT NULL,
  "day" text NOT NULL,
  "video_plays" integer,
  "thruplays" integer,
  "p25" integer,
  "p50" integer,
  "p75" integer,
  "p100" integer,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_ad_metrics" ADD CONSTRAINT "video_scale_ad_metrics_ad_id_video_scale_ads_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."video_scale_ads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "video_scale_ad_metrics_ad_day_uq" ON "video_scale_ad_metrics" USING btree ("ad_id","day");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_scale_reel_metrics" (
  "id" text PRIMARY KEY NOT NULL,
  "post_id" text NOT NULL,
  "plays" integer,
  "reach" integer,
  "reactions" integer,
  "comments" integer,
  "shares" integer,
  "error" text DEFAULT '' NOT NULL,
  "captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_reel_metrics" ADD CONSTRAINT "video_scale_reel_metrics_post_id_video_scale_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."video_scale_posts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_scale_reel_metrics_post_idx" ON "video_scale_reel_metrics" USING btree ("post_id","captured_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_scale_lessons" (
  "id" text PRIMARY KEY NOT NULL,
  "variant_id" text NOT NULL,
  "product_id" text NOT NULL,
  "source" text NOT NULL,
  "angle" text NOT NULL,
  "angle_vocab_version" integer NOT NULL,
  "hook" text DEFAULT '' NOT NULL,
  "verdict" text NOT NULL,
  "success" boolean,
  "summary" text NOT NULL,
  "metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "video_scale_lessons_source_check" CHECK ("source" IN ('AD', 'REVIEW'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_lessons" ADD CONSTRAINT "video_scale_lessons_variant_id_video_scale_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."video_scale_variants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_lessons" ADD CONSTRAINT "video_scale_lessons_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "video_scale_lessons_variant_source_uq" ON "video_scale_lessons" USING btree ("variant_id","source");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_scale_lessons_product_idx" ON "video_scale_lessons" USING btree ("product_id","created_at");
