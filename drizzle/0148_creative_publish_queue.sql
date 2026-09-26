-- 0148 · THƯ VIỆN MEDIA — HÀNG ĐỢI ĐĂNG CAMP (chủ shop 26/09/2026: "duyệt ảnh mẫu → sửa content và lưu vào hàng đợi
-- đăng camp set ads, có thể ấn lưu sau đó ấn đăng camp luôn").
--
-- Ảnh gen tay đã duyệt giữ được bản nháp: câu chữ (đã có cột) + ba tên chiến dịch / nhóm / quảng cáo, và dấu "đang ở hàng
-- đợi" (`queued_at`, người lưu bằng khoá tài khoản — mục 34). KHÔNG BACKFILL: ảnh cũ không nằm hàng đợi nào (`NULL`), ba tên
-- rỗng = tên mặc định theo khuôn. Viết tay và idempotent như 0033–0147.

ALTER TABLE "creative_manual_gen_images" ADD COLUMN IF NOT EXISTS "campaign_name" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "creative_manual_gen_images" ADD COLUMN IF NOT EXISTS "adset_name" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "creative_manual_gen_images" ADD COLUMN IF NOT EXISTS "ad_name" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "creative_manual_gen_images" ADD COLUMN IF NOT EXISTS "queued_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "creative_manual_gen_images" ADD COLUMN IF NOT EXISTS "queued_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "creative_manual_gen_images" ADD COLUMN IF NOT EXISTS "queued_by_name" text DEFAULT '' NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_manual_gen_images" ADD CONSTRAINT "creative_manual_gen_images_queued_by_user_id_users_id_fk" FOREIGN KEY ("queued_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creative_manual_gen_images_queue_idx" ON "creative_manual_gen_images" USING btree ("queued_at");
