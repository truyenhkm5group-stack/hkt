-- ═══════ MỐC "KHÁCH ĐÃ CHO ĐỦ SĐT + ĐỊA CHỈ" ═══════
--
-- Khác `created_at`: case được phát hiện lúc job quét (có thể vài giờ sau), còn mốc này là lúc
-- khách thật sự đưa đủ thông tin để lên đơn. Đo "bao lâu từ đủ thông tin tới lúc có đơn" mà lấy
-- `created_at` thì con số đó đo tốc độ của JOB QUÉT, không đo tốc độ của CSKH.
--
-- `conversation_id` tách khỏi `chat_url` vì URL là để NGƯỜI bấm, còn cột này để MÁY ghép case với
-- đơn được tạo sau đó (`orders.conversation_id`).
--
-- Cả hai đều NULL với case cũ — CHƯA BIẾT, không phải 0.
ALTER TABLE "cs_cases" ADD COLUMN IF NOT EXISTS "conversation_id" text;--> statement-breakpoint
ALTER TABLE "cs_cases" ADD COLUMN IF NOT EXISTS "info_complete_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cs_cases_conversation_idx" ON "cs_cases" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cs_cases_info_complete_idx" ON "cs_cases" USING btree ("info_complete_at");
