-- 0156 · THƯ VIỆN MEDIA — SỬA ẢNH (chủ shop 27/09/2026: "mấy ảnh đã tạo duyệt được về kiểu dáng nhưng muốn đổi sang màu
-- khác, đổi kiểu trình bày mockup khác, hoặc tuỳ chỉnh chi tiết gì đó trên ảnh để tạo ra ảnh mới ưng ý hơn").
--
--  · `creative_manual_gens.kind` nhận thêm `EDIT`: lượt vẽ lại TỪ MỘT ẢNH đã tạo, theo yêu cầu sửa của người.
--  · `creative_manual_gens.source_gen_image_id` (NULL được): ảnh gen tay được sửa. Xoá ảnh gốc không xoá lượt sửa.
--
-- KHÔNG BACKFILL. Viết tay và idempotent như 0033–0155: ADD COLUMN IF NOT EXISTS; khoá ngoại + CHECK thì DROP IF EXISTS rồi ADD.

ALTER TABLE "creative_manual_gens" ADD COLUMN IF NOT EXISTS "source_gen_image_id" text;
--> statement-breakpoint
ALTER TABLE "creative_manual_gens" DROP CONSTRAINT IF EXISTS "creative_manual_gens_source_gen_image_id_fk";
--> statement-breakpoint
ALTER TABLE "creative_manual_gens" ADD CONSTRAINT "creative_manual_gens_source_gen_image_id_fk" FOREIGN KEY ("source_gen_image_id") REFERENCES "creative_manual_gen_images"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "creative_manual_gens" DROP CONSTRAINT IF EXISTS "creative_manual_gens_kind_check";
--> statement-breakpoint
ALTER TABLE "creative_manual_gens" ADD CONSTRAINT "creative_manual_gens_kind_check" CHECK ("kind" IN ('MOCKUP', 'DESIGN', 'UPLOAD', 'EDIT'));
