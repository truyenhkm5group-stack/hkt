-- KÊNH ZALO OA CHO CHATBOT BÁN HÀNG (lib/sales-chatbot/zalo.ts · kết nối «zalo-oa»).
--
--  · Chủ shop 04/10/2026: khách KHÔNG dùng Pancake vẫn dùng được bot ⇒ kênh nhắn tin thứ hai sau fanpage: Zalo OA của
--    CHÍNH shop. Hội thoại mang kênh `ZALO`; khoá `visitor_key` = băm (OA, người dùng Zalo), UNIQUE như kênh FANPAGE để
--    hai gói webhook tới cùng lúc không mở hai hội thoại.
--  · Chỉ NỚI ràng buộc (thêm một giá trị) — dòng cũ không đổi, không backfill.
--  · CSDL mọi tổ chức. Viết tay, idempotent.

ALTER TABLE "sales_chat_conversations" DROP CONSTRAINT IF EXISTS "sales_chat_conversations_channel_check";
--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD CONSTRAINT "sales_chat_conversations_channel_check" CHECK ("sales_chat_conversations"."channel" IN ('TEST','WEB','FANPAGE','ZALO'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_chat_conversations_zalo_key" ON "sales_chat_conversations" USING btree ("visitor_key") WHERE "sales_chat_conversations"."channel" = 'ZALO';
