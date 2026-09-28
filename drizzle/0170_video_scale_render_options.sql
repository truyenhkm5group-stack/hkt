-- 0170 · VIDEO SCALE — SỬA VIDEO (chủ shop 28/09/2026).
--
--  · `video_scale_variants.render_options`: tuỳ chọn dựng riêng của video (nhạc, giọng đọc, phụ đề, chữ trên hình, âm gốc) —
--    ghi đè cấu hình của lượt khi người bấm "Sửa video". Rỗng = theo lượt.
--  · `video_scale_variants.render_rev`: số lần dựng lại — đi vào khoá việc dựng (`render:<id>:r<n>`).
--
-- Không backfill. Viết tay và idempotent như 0033–0169.

ALTER TABLE "video_scale_variants" ADD COLUMN IF NOT EXISTS "render_options" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "video_scale_variants" ADD COLUMN IF NOT EXISTS "render_rev" integer DEFAULT 0 NOT NULL;
