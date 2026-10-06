-- AI BÁN HÀNG: THỬ LẠI CÓ LÙI DẦN + DEAD-LETTER CHO TIN KHÁCH (sau sự cố P0 06/10/2026 · lib/sales-chatbot/inbound-retry.ts).
--
--  · Sự cố: tài khoản AI hết tiền lúc 11:38 ⇒ mọi tin khách bị chốt `DONE` kèm «Chuyển nhân viên», không lượt thử lại nào,
--    và không có cách nào phân biệt tin ĐÃ xử lý với tin bot KHÔNG trả lời được.
--  · `attempts` / `next_attempt_at` / `last_error`: số lượt hỏng, mốc được thử lại sớm nhất, câu lỗi cuối.
--  · `status = 'DEAD'`: tin bot không trả lời được (AI hỏng · gửi hỏng · hết lượt) — việc của người, cockpit đọc thẳng.
--  · Chỉ mục `created_at`: bộ giám sát 5 phút / lần đọc theo cửa sổ thời gian.
--  · Chỉ THÊM cột / nới CHECK; dòng cũ giữ nguyên (attempts = 0, không backfill). CSDL mọi tổ chức. Viết tay, idempotent.

ALTER TABLE "sales_chat_inbound" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sales_chat_inbound" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sales_chat_inbound" ADD COLUMN IF NOT EXISTS "last_error" text;
--> statement-breakpoint
ALTER TABLE "sales_chat_inbound" DROP CONSTRAINT IF EXISTS "sales_chat_inbound_status_check";
--> statement-breakpoint
ALTER TABLE "sales_chat_inbound" ADD CONSTRAINT "sales_chat_inbound_status_check" CHECK ("sales_chat_inbound"."status" IN ('PENDING','DONE','SKIPPED','DEAD'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_chat_inbound_created_idx" ON "sales_chat_inbound" USING btree ("created_at");
