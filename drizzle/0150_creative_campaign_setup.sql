-- 0150 · THƯ VIỆN MEDIA — LUỒNG TAY (bỏ lô hằng ngày) + SETUP CAMP (chủ shop 26/09/2026).
--
--  · `creative_manual_gen_images.campaign_setup` (jsonb, NULL được): setup camp đã chọn cho bài ở hàng đợi — TKQC ·
--    fanpage · mục tiêu · ngân sách · vị trí · tuổi · giới tính. NULL = chưa chọn (hộp đăng điền mặc định).
--  · `creative_manual_gens.kind` nhận thêm `UPLOAD`: "Mẫu tự làm" (ảnh người tải lên, không qua máy vẽ) nay đi thẳng
--    vào hàng đợi đăng camp thay cho lô hằng ngày đã bỏ.
--
-- KHÔNG BACKFILL. Viết tay và idempotent như 0033–0149: ADD COLUMN IF NOT EXISTS; DROP CONSTRAINT IF EXISTS rồi ADD.

ALTER TABLE "creative_manual_gen_images" ADD COLUMN IF NOT EXISTS "campaign_setup" jsonb;
--> statement-breakpoint
ALTER TABLE "creative_manual_gens" DROP CONSTRAINT IF EXISTS "creative_manual_gens_kind_check";
--> statement-breakpoint
ALTER TABLE "creative_manual_gens" ADD CONSTRAINT "creative_manual_gens_kind_check" CHECK ("kind" IN ('MOCKUP', 'DESIGN', 'UPLOAD'));
