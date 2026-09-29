-- 0174 · STUDIO TẠO ẢNH — biến thể màu, kiểu ảnh đầu ra, tuỳ chọn lượt (chủ shop 29/09/2026).
--
--  · `creative_manual_gens.options`: tuỳ chọn người chọn lúc bấm (số mẫu, kiểu ảnh, màu, khổ, chất lượng) — cho "Tạo lại
--    tương tự". `{}` = lượt cũ.
--  · `creative_manual_gen_images.color` / `output_style`: biến thể màu + kiểu ảnh của TỪNG ảnh — thẻ ảnh in ra, câu lệnh đã
--    lưu sẵn ở `prompt`. Rỗng = ảnh cũ (trước studio).
--
-- Không backfill. Viết tay và idempotent như 0033–0172.

ALTER TABLE "creative_manual_gens" ADD COLUMN IF NOT EXISTS "options" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "creative_manual_gen_images" ADD COLUMN IF NOT EXISTS "color" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "creative_manual_gen_images" ADD COLUMN IF NOT EXISTS "output_style" text DEFAULT '' NOT NULL;
