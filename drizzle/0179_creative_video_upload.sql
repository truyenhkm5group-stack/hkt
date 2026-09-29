-- 0179 · MẪU QUẢNG CÁO — VIDEO TỰ TẢI LÊN ⇒ ĐĂNG CAMP (chủ shop 29/09/2026).
--
--  · `video_scale_assets`: thêm loại `AD_UPLOAD` (video người tải lên ở trang Mẫu quảng cáo) + `uploaded_by_user_id` (chỉ người
--    xin chỗ mới gửi khúc / hoàn tất được lượt tải — mục 34).
--  · `creative_manual_gen_images.video_asset_id` + `fb_videos` (TKQC → id video đã tải, để bấm lại không tải lại).
--  · `creative_variants.video_asset_id` + `fb_video_id`.
--
-- Không backfill: mọi dòng cũ là bài ảnh. Viết tay và idempotent như 0033–0178.

ALTER TABLE "video_scale_assets" ADD COLUMN IF NOT EXISTS "uploaded_by_user_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_assets" ADD CONSTRAINT "video_scale_assets_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "video_scale_assets" DROP CONSTRAINT IF EXISTS "video_scale_assets_kind_check";
--> statement-breakpoint
ALTER TABLE "video_scale_assets" ADD CONSTRAINT "video_scale_assets_kind_check" CHECK ("video_scale_assets"."kind" IN ('SOURCE_CLIP', 'VOICE', 'MUSIC', 'FINAL', 'THUMBNAIL', 'AD_UPLOAD'));
--> statement-breakpoint
ALTER TABLE "creative_manual_gen_images" ADD COLUMN IF NOT EXISTS "video_asset_id" text;
--> statement-breakpoint
ALTER TABLE "creative_manual_gen_images" ADD COLUMN IF NOT EXISTS "fb_videos" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_manual_gen_images" ADD CONSTRAINT "creative_manual_gen_images_video_asset_id_video_scale_assets_id_fk" FOREIGN KEY ("video_asset_id") REFERENCES "public"."video_scale_assets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "creative_variants" ADD COLUMN IF NOT EXISTS "video_asset_id" text;
--> statement-breakpoint
ALTER TABLE "creative_variants" ADD COLUMN IF NOT EXISTS "fb_video_id" text DEFAULT '' NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_video_asset_id_video_scale_assets_id_fk" FOREIGN KEY ("video_asset_id") REFERENCES "public"."video_scale_assets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
