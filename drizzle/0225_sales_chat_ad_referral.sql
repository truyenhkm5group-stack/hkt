-- QUẢNG CÁO DẪN KHÁCH VÀO HỘI THOẠI ⇒ ĐƠN BOT / ĐƠN GHI TỪ HỘI THOẠI MANG `orders.ad_id` (chủ shop HSLC chốt 06/10/2026).
--
--  · Sự cố: /ads của tổ chức chỉ có đơn ERP in «0 đơn chốt» ở mọi chiến dịch — đơn bot / ghi đơn từ hội thoại không mang mã quảng
--    cáo, vì đường nhận tin chưa từng lưu quảng cáo nào dẫn khách tới (lib/sales-chatbot/ad-referral-shared.ts).
--  · `ad_id` / `ad_seen_at` / `ad_source`: mã mẩu quảng cáo Meta đọc từ gói tin của KHÁCH, mốc khách bấm (thiếu ⇒ mốc tin), nguồn.
--  · Chỉ THÊM cột + CHECK; dòng cũ giữ NULL (không backfill — chưa từng đọc được nguồn này). CSDL mọi tổ chức. Viết tay, idempotent.

ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "ad_id" text;
--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "ad_seen_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "ad_source" text;
--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" DROP CONSTRAINT IF EXISTS "sales_chat_conversations_ad_source_check";
--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD CONSTRAINT "sales_chat_conversations_ad_source_check" CHECK ("sales_chat_conversations"."ad_source" IS NULL OR "sales_chat_conversations"."ad_source" IN ('PANCAKE','MESSENGER'));
