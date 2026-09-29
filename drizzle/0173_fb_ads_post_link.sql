-- 0173 · MẨU QUẢNG CÁO → CREATIVE → BÀI VIẾT (docs/meta-ad-post-resolver.md).
--
--  · CHỈ THÊM cột vào `fb_ads` — không tạo bảng mới: khoá tự nhiên vẫn là `ad_id`, và mọi truy vấn quy kết đang đọc
--    bảng này. `story_id` / `post_id` giữ nguyên nghĩa (bài ĐÃ DÙNG); hai cột thô `effective_object_story_id` /
--    `object_story_id` lưu nguyên văn creative trả về, `post_resolution_source` ghi trường nào đã thắng.
--  · KHÔNG unique trên `story_id`: một bài có sẵn được nhiều mẩu dùng lại — đó chính là mối nối mẫu → nhiều mẩu.
--  · Không backfill, không đổi dữ liệu nào đang có (AGENTS.md mục 8.8): dòng cũ để NULL = CHƯA BIẾT, job
--    `facebook-ads` hằng giờ điền dần khi nó hỏi lại Meta. Viết tay và idempotent như các migration trước.

ALTER TABLE "fb_ads" ADD COLUMN IF NOT EXISTS "creative_id" text;
--> statement-breakpoint
ALTER TABLE "fb_ads" ADD COLUMN IF NOT EXISTS "page_id" text;
--> statement-breakpoint
ALTER TABLE "fb_ads" ADD COLUMN IF NOT EXISTS "effective_object_story_id" text;
--> statement-breakpoint
ALTER TABLE "fb_ads" ADD COLUMN IF NOT EXISTS "object_story_id" text;
--> statement-breakpoint
ALTER TABLE "fb_ads" ADD COLUMN IF NOT EXISTS "post_resolution_source" text;
--> statement-breakpoint
ALTER TABLE "fb_ads" ADD COLUMN IF NOT EXISTS "page_name" text;
--> statement-breakpoint
ALTER TABLE "fb_ads" ADD COLUMN IF NOT EXISTS "permalink_url" text;
--> statement-breakpoint
ALTER TABLE "fb_ads" ADD COLUMN IF NOT EXISTS "post_resolved_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "fb_ads" ADD COLUMN IF NOT EXISTS "resolve_error" jsonb;
--> statement-breakpoint
ALTER TABLE "fb_ads" DROP CONSTRAINT IF EXISTS "fb_ads_post_source_check";
--> statement-breakpoint
ALTER TABLE "fb_ads" ADD CONSTRAINT "fb_ads_post_source_check" CHECK ("post_resolution_source" IS NULL OR "post_resolution_source" IN ('EFFECTIVE_OBJECT_STORY_ID', 'OBJECT_STORY_ID'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fb_ads_story_idx" ON "fb_ads" USING btree ("story_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fb_ads_page_post_idx" ON "fb_ads" USING btree ("page_id", "post_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fb_ads_creative_idx" ON "fb_ads" USING btree ("creative_id");
