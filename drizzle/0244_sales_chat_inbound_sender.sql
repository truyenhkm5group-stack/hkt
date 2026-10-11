-- 0244 · AI IM LẶNG / CHẶN TRẢ LỜI SAI (P0 response-ownership, chủ shop 11/10/2026 — ca «Uyen Tran», «Lê Bạch Nguyên»).
-- Tin phía page được ghi `PAGE_REPLY` mà không biết AI GỬI: tin chào quảng cáo bị coi là «nhân viên đã trả lời», chữ hệ thống
-- trả lời bình luận của Facebook bị coi là NGƯỜI và bật nhường 30 phút. Ba cột cho dòng sổ tin thô, chỉ CỘNG THÊM, idempotent:
--   sender_kind — nguồn gốc người gửi của tin phía page ngoài ERP (lib/sales-chatbot/response-ownership.ts::OUTBOUND_ORIGINS);
--   source_at   — mốc TẠO tin ở nguồn (Pancake inserted_at / Meta timestamp) — so thứ tự theo nguồn, không theo giờ webhook tới;
--   sender_app  — mã ứng dụng / tài khoản gửi mà payload mang theo (app_id của Meta, uid nhân viên Pancake) — vết truy nguyên.
-- NULL ở dòng cũ = CHƯA BIẾT (không backfill đoán — luật 35): bộ đọc coi `PAGE_REPLY` cũ là UNKNOWN.

ALTER TABLE "sales_chat_inbound" ADD COLUMN IF NOT EXISTS "sender_kind" text;
--> statement-breakpoint
ALTER TABLE "sales_chat_inbound" ADD COLUMN IF NOT EXISTS "source_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sales_chat_inbound" ADD COLUMN IF NOT EXISTS "sender_app" text;
--> statement-breakpoint
ALTER TABLE "sales_chat_inbound" DROP CONSTRAINT IF EXISTS "sales_chat_inbound_sender_kind_check";
--> statement-breakpoint
ALTER TABLE "sales_chat_inbound" ADD CONSTRAINT "sales_chat_inbound_sender_kind_check" CHECK ("sender_kind" IS NULL OR "sender_kind" IN ('AI_AGENT','VERIFIED_HUMAN','PANCAKE_AUTOMATION','META_SYSTEM','OTHER_APP','UNKNOWN'));
