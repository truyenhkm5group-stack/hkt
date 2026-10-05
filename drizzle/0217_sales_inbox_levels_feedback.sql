-- HỘP THƯ KHÁCH: LEVEL KHÁCH + SĐT CỦA HỘI THOẠI + GÓP Ý CHO AI (lib/sales-chatbot/levels.ts · inbox-feedback.ts).
--
--  · Chủ shop 06/10/2026 (mọi tổ chức SaaS): lọc theo level khách / hội thoại có SĐT; mỗi hội thoại có ô góp ý gửi AI để bot
--    rút kinh nghiệm. `customer_level` + `customer_phone` là KẾT QUẢ ĐỌC (hàm thuần trên tin khách + sổ trạng thái bot + đơn)
--    do job làm mới — lưu để lọc / đếm nhanh, không phải nguồn sự thật; `level_at` = lần tính gần nhất.
--  · Chỉ THÊM cột / bảng; dòng cũ để trống (job tự tính dần), không backfill trong migration. CSDL mọi tổ chức. Viết tay, idempotent.

ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "customer_level" text;
--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "customer_phone" text;
--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "level_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" DROP CONSTRAINT IF EXISTS "sales_chat_conversations_level_check";
--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD CONSTRAINT "sales_chat_conversations_level_check" CHECK ("customer_level" IS NULL OR "customer_level" IN ('ORDERED','UPSELL_REPLY','FULL_INFO_ORDER','FULL_INFO_NO_ITEM','PHONE_ONLY','ADDRESS_ONLY','PICKED_ITEM','MEASUREMENTS','NEW_MESSAGE','DECLINED'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_chat_conversations_level_idx" ON "sales_chat_conversations" ("customer_level") WHERE "customer_level" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_chat_conversations_phone_idx" ON "sales_chat_conversations" ("customer_phone") WHERE "customer_phone" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_chat_feedback" (
  "id" text PRIMARY KEY NOT NULL,
  "conversation_id" text NOT NULL,
  "user_id" text NOT NULL,
  "user_name" text DEFAULT '' NOT NULL,
  "text" text NOT NULL,
  "lessons" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sales_chat_feedback_status_check" CHECK ("status" IN ('APPLIED','FAILED'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_chat_feedback_conv_idx" ON "sales_chat_feedback" ("conversation_id","created_at");
