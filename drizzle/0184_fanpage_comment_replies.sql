-- 0184 · BOT FANPAGE TRẢ LỜI BÌNH LUẬN BẰNG TIN NHẮN RIÊNG (private reply của Facebook qua Pancake).
--
--  · `sales_chat_inbound.kind`: `INBOX` (tin nhắn) · `COMMENT` (bình luận dưới bài viết). Bình luận KHÔNG bao giờ được trả lời
--    công khai — bot gửi MỘT tin nhắn riêng cho người bình luận (Facebook chỉ cho một tin riêng mỗi bình luận).
--  · `post_id` + `from_id`: Pancake `private_replies` đòi bài viết và người bình luận, không suy được từ mã hội thoại.
--  · Dòng cũ đều là tin nhắn ⇒ mặc định `INBOX`. Viết tay và idempotent như các migration trước.

ALTER TABLE "sales_chat_inbound" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'INBOX' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_chat_inbound" ADD COLUMN IF NOT EXISTS "post_id" text;--> statement-breakpoint
ALTER TABLE "sales_chat_inbound" ADD COLUMN IF NOT EXISTS "from_id" text;--> statement-breakpoint
ALTER TABLE "sales_chat_inbound" DROP CONSTRAINT IF EXISTS "sales_chat_inbound_kind_check";--> statement-breakpoint
ALTER TABLE "sales_chat_inbound" ADD CONSTRAINT "sales_chat_inbound_kind_check" CHECK ("kind" IN ('INBOX','COMMENT'));
