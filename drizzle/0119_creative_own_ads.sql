-- Vòng mẫu: nguồn ảnh "Quảng cáo cũ của shop" (OWN_AD) nhập từ Facebook (docs/creative-loop.md §2, §5c).
--
-- Thuần bổ sung: nới ràng buộc loại nguồn thêm 'OWN_AD'; thêm bốn cột (mẩu QC gốc · số đo lúc nhập ·
-- câu chữ đã chạy). Không đụng dòng nào đã có, không backfill — mọi nguồn cũ đều không phải OWN_AD nên
-- fb_ad_id NULL, metrics '{}' và câu chữ rỗng là đúng sự thật. Chỉ mục duy nhất đặt trên cột MỚI
-- (toàn NULL) nên không thể vấp dữ liệu trùng.
ALTER TABLE "creative_sources" DROP CONSTRAINT IF EXISTS "creative_sources_kind_check";
--> statement-breakpoint
ALTER TABLE "creative_sources" ADD CONSTRAINT "creative_sources_kind_check" CHECK ("creative_sources"."kind" IN ('PRODUCT_PHOTO', 'OWN_AD', 'MANUAL', 'SPY', 'RND'));
--> statement-breakpoint
ALTER TABLE "creative_sources" ADD COLUMN IF NOT EXISTS "fb_ad_id" text;
--> statement-breakpoint
ALTER TABLE "creative_sources" ADD COLUMN IF NOT EXISTS "metrics" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "creative_sources" ADD COLUMN IF NOT EXISTS "primary_text" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "creative_sources" ADD COLUMN IF NOT EXISTS "headline" text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "creative_sources_fb_ad_uq" ON "creative_sources" ("fb_ad_id") WHERE "creative_sources"."fb_ad_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "creative_sources" DROP CONSTRAINT IF EXISTS "creative_sources_own_ad_check";
--> statement-breakpoint
ALTER TABLE "creative_sources" ADD CONSTRAINT "creative_sources_own_ad_check" CHECK ("creative_sources"."kind" <> 'OWN_AD' OR "creative_sources"."fb_ad_id" IS NOT NULL);
