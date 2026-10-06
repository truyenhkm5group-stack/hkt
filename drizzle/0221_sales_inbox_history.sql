-- HỘP THƯ KHÁCH: NHẬP ĐỦ LỊCH SỬ HỘI THOẠI (M8 · lib/sales-chatbot/history.ts).
--
--  · Chủ shop 06/10/2026: hộp thư phải có ĐỦ lịch sử tin đã nhắn và TẤT CẢ khách từng nhắn fanpage, như Pancake — không chỉ tin
--    tới sau lúc nối page với ERP.
--  · `sales_chat_inbound.imported_at`: dòng tin do LƯỢT NHẬP LỊCH SỬ ghi (NULL = tin sống từ webhook / lượt quét lại). Tin lịch
--    sử KHÔNG vào hàng chờ của bot, KHÔNG làm ứng viên cho máy ghi đơn, KHÔNG chép vào lịch sử bot, KHÔNG đếm là việc của bot.
--  · `sales_chat_conversations.history_until`: mốc tin MỚI NHẤT (mọi phía) đã nhập từ lịch sử — tin khách tới mốc này là LỊCH SỬ,
--    không phải «chờ trả lời»; hội thoại do lượt nhập tạo xếp theo mốc này, không theo giờ nhập.
--  · `sales_chat_conversations.history_imported_at`: lần cuối lượt nhập đọc XONG hội thoại này (phần quét lại hội thoại ERP).
--  · Chỉ THÊM cột; dòng cũ để trống (= tin sống / chưa nhập), không backfill. CSDL mọi tổ chức. Viết tay, idempotent.

ALTER TABLE "sales_chat_inbound" ADD COLUMN IF NOT EXISTS "imported_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "history_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "history_imported_at" timestamp with time zone;
