-- 0253 · SỔ DÙNG AI TÁCH TOKEN GHI VÀO BỘ ĐỆM (giai đoạn 2 «AI Sales Self-Optimizing», chủ shop duyệt 21/10/2026).
--
--  · Baseline 14 ngày HSLC: `input_tokens` gộp cả đọc + ghi bộ đệm ⇒ không tách được chi phí ghi bộ đệm khi phân tích. Tiền USD vốn đã
--    tính phần này (estimateCostUsd) — cột chỉ để PHÂN TÍCH. NULL = nhà cung cấp không trả / dòng cũ (KHÔNG backfill).
--  · Chỉ CỘNG THÊM một cột. Đường ghi sổ (`recordAiUsage`) dò cột qua information_schema và chỉ ghi cột khi đã có — CSDL nhà chưa áp
--    mục này vẫn ghi được mọi dòng tiền (serve-compat).
--  · Viết tay, idempotent (ảnh chụp drizzle cũ từ 0032 — không dùng `db:generate`).

ALTER TABLE "platform_ai_usage" ADD COLUMN IF NOT EXISTS "cache_write_tokens" integer;--> statement-breakpoint
ALTER TABLE "platform_ai_usage" DROP CONSTRAINT IF EXISTS "platform_ai_usage_cache_write_check";--> statement-breakpoint
ALTER TABLE "platform_ai_usage" ADD CONSTRAINT "platform_ai_usage_cache_write_check" CHECK ("platform_ai_usage"."cache_write_tokens" IS NULL OR "platform_ai_usage"."cache_write_tokens" >= 0);
