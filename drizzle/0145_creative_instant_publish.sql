-- 0145 · VÒNG MẪU — ĐĂNG CAMP LẺ (NGAY / HẸN GIỜ) + ẢNH ĐẦU VÀO TẢI LÊN Ở GEN TAY (chủ shop 26/09/2026).
--
--  · `creative_batches.kind`: `LOOP` (lô hằng ngày — mặc định, mọi dòng cũ) · `INSTANT` (một bài người bấm
--    "Đăng camp"). Chỉ mục duy nhất `creative_batches_day_uq` thành chỉ mục TỪNG PHẦN trên `kind = 'LOOP'`:
--    vẫn đúng một lô hằng ngày mỗi ngày chạy, còn lô đăng lẻ thì một ngày có bao nhiêu cũng được.
--  · `creative_manual_gens.upload_image_ids`: ảnh người tải lên ngay trong khối gen tay, gửi máy vẽ KÈM ảnh
--    sản phẩm thật.
--
-- KHÔNG BACKFILL ngoài giá trị mặc định có nghĩa thật: mọi lô trước bản này là lô hằng ngày (`LOOP`), mọi lượt
-- gen tay trước bản này không có ảnh tải lên (`{}`). Viết tay và idempotent như 0033–0144: ADD COLUMN IF NOT
-- EXISTS, DROP … IF EXISTS rồi tạo lại — chạy lại ra đúng một ràng buộc / chỉ mục mỗi tên.

ALTER TABLE "creative_batches" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'LOOP' NOT NULL;
--> statement-breakpoint
ALTER TABLE "creative_batches" DROP CONSTRAINT IF EXISTS "creative_batches_kind_check";
--> statement-breakpoint
ALTER TABLE "creative_batches" ADD CONSTRAINT "creative_batches_kind_check" CHECK ("kind" IN ('LOOP', 'INSTANT'));
--> statement-breakpoint
DROP INDEX IF EXISTS "creative_batches_day_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "creative_batches_day_uq" ON "creative_batches" USING btree ("batch_day") WHERE "kind" = 'LOOP';
--> statement-breakpoint
ALTER TABLE "creative_manual_gens" ADD COLUMN IF NOT EXISTS "upload_image_ids" text[] DEFAULT '{}'::text[] NOT NULL;
