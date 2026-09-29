-- 0175 · VIDEO SCALE — ĐOẠN BẢNG MÀU CUỐI VIDEO (chủ shop 29/09/2026).
--
--  · `video_scale_runs.showcase`: các ô bảng màu của lượt (nguồn PRODUCT_PHOTO từ ảnh mẫu mã Pancake + tên màu ERP) — mỗi video
--    của lượt ghép đoạn mở đầu (clip) với đoạn bảng màu. `[]` = lượt không có đoạn ấy (mọi lượt cũ).
--
-- Không backfill. Viết tay và idempotent như 0033–0174.

ALTER TABLE "video_scale_runs" ADD COLUMN IF NOT EXISTS "showcase" jsonb DEFAULT '[]'::jsonb NOT NULL;
