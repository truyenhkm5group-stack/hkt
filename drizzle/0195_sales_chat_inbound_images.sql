-- 0195 · BOT ĐỌC ẢNH KHÁCH GỬI (lib/sales-chatbot/vision.ts).
--
--  · `sales_chat_inbound.image_urls`: địa chỉ ảnh khách gửi trong tin fanpage, chờ bot đọc. Đọc xong ⇒ mô tả ghép vào `text`,
--    cột về NULL. Trước bản này tin chỉ có ảnh bị bỏ qua «để nhân viên xem».
--  · Cột mới, nullable, không backfill — tin cũ không có ảnh để đọc lại. Viết tay, idempotent.

ALTER TABLE "sales_chat_inbound" ADD COLUMN IF NOT EXISTS "image_urls" jsonb;
