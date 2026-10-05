-- HỘP THƯ KHÁCH: «CHƯA ĐỌC» (M8 · lib/sales-chatbot/inbox.ts).
--
--  · Chủ shop 05/10/2026: «đảm bảo tin nhắn không bao giờ bị miss». `staff_seen_at` = lần cuối một nhân viên mở hội thoại trong
--    hộp thư; tin khách mới hơn mốc đó là CHƯA ĐỌC (đậm + chấm + bộ lọc «Chưa đọc»).
--  · Chỉ THÊM cột; dòng cũ để trống (= chưa ai đọc), không backfill. CSDL mọi tổ chức. Viết tay, idempotent.

ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "staff_seen_at" timestamp with time zone;
