-- 0252 · SỔ DÙNG AI KHAI ĐỦ LOẠI VIỆC (giai đoạn 2 «AI Sales Self-Optimizing», chủ shop duyệt 21/10/2026).
--
--  · Baseline 14 ngày HSLC: 7.848 lời gọi / 4,58 USD (18%) ghi sổ KHÔNG nhãn `workload` — tin nhắc tự động, tự học, tự nạp câu mẫu,
--    góp ý, học từ hội thoại cũ, AI Builder, Copilot, quảng cáo, săn khách sỉ. Mã nay khai MỌI đường (trường bắt buộc).
--  · Chỉ NỚI ràng buộc CHECK — không thêm / đổi / xoá cột, không backfill (dòng cũ giữ NULL = chưa khai). Mã ghi giá trị mới trên
--    lược đồ CHƯA áp mục này ⇒ đường ghi bắt đúng vi phạm ràng buộc này và ghi lại với workload NULL (không mất dòng tiền).
--  · Viết tay, idempotent (ảnh chụp drizzle cũ từ 0032 — không dùng `db:generate`).

ALTER TABLE "platform_ai_usage" DROP CONSTRAINT IF EXISTS "platform_ai_usage_workload_check";--> statement-breakpoint
ALTER TABLE "platform_ai_usage" ADD CONSTRAINT "platform_ai_usage_workload_check" CHECK ("platform_ai_usage"."workload" IS NULL OR "platform_ai_usage"."workload" IN ('sales_chatbot','order_sync','quick_extract','vision','followup','lessons','quick_reply_learn','inbox_feedback','playbook','ai_builder','copilot','creative','lead_hunter'));
