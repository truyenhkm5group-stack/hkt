-- 0151 · MỐC "KHÁCH ĐÃ XEM" CHO HỘI THOẠI (chủ shop 26/09/2026 — lọc gửi tin theo khách đã xem mà chưa trả lời).
--
--  · `conversation_funnel.customer_seen_at`: mốc đọc của khách lấy từ `read_watermarks` của Pancake, job `cs-chat`
--    ghi mỗi lượt quét. `NULL` = chưa biết (dòng cũ, hoặc Pancake không trả), KHÔNG phải "chưa xem".
--
-- KHÔNG BACKFILL: dòng cũ để NULL, lượt quét 15 phút kế tiếp tự điền cho hội thoại còn trong 48 giờ.
-- Viết tay và idempotent như 0033–0150.

ALTER TABLE "conversation_funnel" ADD COLUMN IF NOT EXISTS "customer_seen_at" timestamp with time zone;
