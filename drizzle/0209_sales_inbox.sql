-- HỘP THƯ NGƯỜI TRONG ERP (M8 · lib/sales-chatbot/inbox.ts).
--
--  · Chủ shop 05/10/2026: nhân viên đọc và TRẢ LỜI khách Messenger / Instagram / Zalo OA / chat web NGAY TRONG ERP, tốt hơn
--    Pancake. Hội thoại có người CẦM (`assignee_user_id`, khoá tài khoản — luật 34) và mốc tin cuối nhân viên gửi từ ERP.
--  · Bảng `sales_chat_staff_messages`: MỘT dòng cho MỘT lượt «Gửi» — ai gửi, gửi gì, kết quả; khoá (hội thoại, request_key)
--    chống gửi khách hai lần khi bấm đôi.
--  · Chỉ THÊM cột / bảng; dòng cũ không đổi, không backfill (mục 35: không đoán người cho lịch sử).
--  · CSDL mọi tổ chức. Viết tay, idempotent.

ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "assignee_user_id" text;
--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "assigned_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "last_staff_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_chat_conversations_inbox_idx" ON "sales_chat_conversations" USING btree ("last_customer_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_chat_conversations_assignee_idx" ON "sales_chat_conversations" USING btree ("assignee_user_id") WHERE "sales_chat_conversations"."assignee_user_id" is not null;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_chat_staff_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"request_key" text NOT NULL,
	"user_id" text NOT NULL,
	"user_name" text DEFAULT '' NOT NULL,
	"channel" text NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'SENDING' NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_chat_staff_messages_status_check" CHECK ("sales_chat_staff_messages"."status" IN ('SENDING','SENT','FAILED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_chat_staff_messages_request_key" ON "sales_chat_staff_messages" USING btree ("conversation_id","request_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_chat_staff_messages_conv_idx" ON "sales_chat_staff_messages" USING btree ("conversation_id","created_at");
