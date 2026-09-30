-- 0182 · CHATBOT BÁN HÀNG TRẢ LỜI TIN NHẮN FANPAGE (qua Pancake) CỦA TỪNG TỔ CHỨC.
--
--  · Kênh hội thoại thứ ba `FANPAGE` (cạnh `TEST` · `WEB`). Một hội thoại fanpage = MỘT hội thoại Pancake: khoá là
--    `visitor_key` = băm (page, hội thoại Pancake) — UNIQUE riêng cho kênh này, nên tin đến sau nối tiếp đúng hội thoại cũ.
--  · Bảng `sales_chat_inbound`: tin khách gửi tới fanpage, ghi NGAY khi webhook tới (trả 200 < 1 giây), xử lý sau.
--    `message_id` UNIQUE ⇒ Pancake gửi lại / gửi trùng không sinh câu trả lời thứ hai. Nhiều tin liên tiếp của cùng một
--    khách GOM thành một lượt (giành bằng `claim_id` + `claimed_at`, lượt treo quá hạn thì lượt sau lấy lại).
--  · CSDL mọi tổ chức (bảng rỗng ở tổ chức nhà — bot fanpage của nhà vẫn là container riêng, không đổi gì).
-- Viết tay và idempotent như các migration trước.

ALTER TABLE "sales_chat_conversations" DROP CONSTRAINT IF EXISTS "sales_chat_conversations_channel_check";--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD CONSTRAINT "sales_chat_conversations_channel_check" CHECK ("channel" IN ('TEST','WEB','FANPAGE'));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_chat_conversations_fanpage_key" ON "sales_chat_conversations" ("visitor_key") WHERE "channel" = 'FANPAGE';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sales_chat_inbound" (
  "id" text PRIMARY KEY NOT NULL,
  "page_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "message_id" text NOT NULL,
  "text" text NOT NULL,
  "customer_name" text,
  "status" text DEFAULT 'PENDING' NOT NULL,
  "claim_id" text,
  "claimed_at" timestamp with time zone,
  "processed_at" timestamp with time zone,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sales_chat_inbound_status_check" CHECK ("status" IN ('PENDING','DONE','SKIPPED'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_chat_inbound_message_key" ON "sales_chat_inbound" ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_chat_inbound_thread_idx" ON "sales_chat_inbound" ("page_id", "thread_id", "status");
