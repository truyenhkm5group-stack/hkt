-- 0232 · SỔ AI TÁCH TOKEN SUY NGHĨ + ĐỘ TRỄ + WORKLOAD (docs/platform/ai-model-control.md §8).
--
--  · CỘNG THÊM, chỉ để QUAN SÁT: `output_tokens` / `cost_usd` GIỮ NGUYÊN nghĩa (token ra = hiện ra + suy nghĩ — đúng thứ nhà
--    cung cấp tính tiền). `thinking_tokens` là PHẦN của `output_tokens` dành cho suy nghĩ; `cached_tokens` là PHẦN của
--    `input_tokens` đọc từ bộ đệm; `latency_ms` = thời gian lời gọi model; `workload` = loại việc của Platform AI Policy
--    (`sales_chatbot` · `order_sync` · `quick_extract` · `vision`).
--  · NULL = CHƯA ĐO (dòng cũ, nhà cung cấp không tách) — KHÔNG backfill, không phải 0.
--  · Viết tay, idempotent.

ALTER TABLE "platform_ai_usage" ADD COLUMN IF NOT EXISTS "cached_tokens" integer;--> statement-breakpoint
ALTER TABLE "platform_ai_usage" ADD COLUMN IF NOT EXISTS "thinking_tokens" integer;--> statement-breakpoint
ALTER TABLE "platform_ai_usage" ADD COLUMN IF NOT EXISTS "latency_ms" integer;--> statement-breakpoint
ALTER TABLE "platform_ai_usage" ADD COLUMN IF NOT EXISTS "workload" text;--> statement-breakpoint
ALTER TABLE "platform_ai_usage" DROP CONSTRAINT IF EXISTS "platform_ai_usage_workload_check";--> statement-breakpoint
ALTER TABLE "platform_ai_usage" ADD CONSTRAINT "platform_ai_usage_workload_check" CHECK ("platform_ai_usage"."workload" IS NULL OR "platform_ai_usage"."workload" IN ('sales_chatbot','order_sync','quick_extract','vision'));
