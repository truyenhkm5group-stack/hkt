-- 0185 · FOLLOW-UP TỰ ĐỘNG CHO CHATBOT FANPAGE (khách im lặng giữa quy trình bán).
--
--  · `status = 'WAITING'`: bot đã trả lời, đang CHỜ KHÁCH. Khách nhắn lại ⇒ về `OPEN`. Chốt đơn / từ chối rõ / cần người
--    xử lý ⇒ không follow-up.
--  · `page_id` + `thread_id`: địa chỉ fanpage của hội thoại (khoá `visitor_key` là băm — job follow-up cần gửi lại đúng chỗ).
--  · `last_customer_at` / `last_bot_at`: mốc tin cuối của hai phía — Facebook chỉ cho page nhắn trong 24 giờ kể từ tin cuối
--    của khách, nên follow-up KHÔNG BAO GIỜ gửi ngoài khung đó.
--  · `waiting_since` + `followups_sent` + `next_followup_at`: lịch follow-up (mặc định 1 giờ · 6 giờ · 22 giờ tính từ lúc bắt
--    đầu im lặng; chủ shop chốt 01/10/2026).
--  · CSDL mọi tổ chức. Viết tay và idempotent như các migration trước.

ALTER TABLE "sales_chat_conversations" DROP CONSTRAINT IF EXISTS "sales_chat_conversations_status_check";--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD CONSTRAINT "sales_chat_conversations_status_check" CHECK ("status" IN ('OPEN','WAITING','HANDOFF','CLOSED'));--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "page_id" text;--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "thread_id" text;--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "last_customer_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "last_bot_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "waiting_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "followups_sent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "next_followup_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_chat_conversations_followup_idx" ON "sales_chat_conversations" ("status", "next_followup_at");
