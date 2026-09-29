-- 0176 · SỔ DÙNG AI + HẠN MỨC AI THEO GÓI (docs/platform/ai-usage.md).
--
--  · CHỈ THÊM một bảng của mặt phẳng điều khiển `platform_ai_usage` (chỉ thật ở CSDL NHÀ; bản sao trong CSDL tổ chức
--    khác bị `migrateOrganizationDb` xoá rỗng mỗi lần mở, như các bảng platform_* của 0152 / 0169 / 0172).
--    Một dòng = một lượt AI (một bản nháp AI Builder, một câu hỏi Copilot). Không lưu prompt / câu trả lời / khoá.
--    `cost_usd` và token NULL = CHƯA BIẾT (luật 42), không phải 0.
--  · Gieo khoá `ai` vào `platform_plans.limits` của ba gói có sẵn — DỮ LIỆU CẤU HÌNH của nền tảng, không phải dữ liệu
--    khách. Chỉ gieo khi gói CHƯA có khoá `ai` (`NOT (limits ? 'ai')`): người vận hành đã sửa thì chạy lại không đè.
--    `platformCreditUsdPerMonth = 0` ở MỌI gói: AI do nền tảng trả tiền (nguồn PLATFORM) KHÔNG bật bằng migration này —
--    bật là quyết định của chủ nền tảng (launch-gates.md mục D), cần cả biến môi trường lẫn credit > 0 trên gói.
--  · `ai_blueprint_drafts.ai_source` nhận thêm `PLATFORM` (CSDL mọi tổ chức): ràng buộc cũ thay bằng tập LỚN hơn, mọi dòng
--    đang có vẫn hợp lệ — cùng cách 0169 nới trạng thái tổ chức.
--  · Không backfill: lượt AI trước migration không được dựng lại thành dòng sổ (mục 8.8, 35).
-- Viết tay và idempotent như các migration trước.

CREATE TABLE IF NOT EXISTS "platform_ai_usage" (
  "id" text PRIMARY KEY NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "org_code" text NOT NULL,
  "feature" text NOT NULL,
  "billing_source" text NOT NULL,
  "provider" text,
  "model" text,
  "requests" integer DEFAULT 0 NOT NULL,
  "input_tokens" integer,
  "output_tokens" integer,
  "cost_usd" double precision,
  "status" text NOT NULL,
  "actor_id" text,
  "ref" text
);
--> statement-breakpoint
ALTER TABLE "platform_ai_usage" DROP CONSTRAINT IF EXISTS "platform_ai_usage_source_check";
--> statement-breakpoint
ALTER TABLE "platform_ai_usage" ADD CONSTRAINT "platform_ai_usage_source_check" CHECK ("billing_source" in ('BYOK','PLATFORM','HOME'));
--> statement-breakpoint
ALTER TABLE "platform_ai_usage" DROP CONSTRAINT IF EXISTS "platform_ai_usage_status_check";
--> statement-breakpoint
ALTER TABLE "platform_ai_usage" ADD CONSTRAINT "platform_ai_usage_status_check" CHECK ("status" in ('OK','ERROR','BLOCKED_QUOTA'));
--> statement-breakpoint
ALTER TABLE "platform_ai_usage" DROP CONSTRAINT IF EXISTS "platform_ai_usage_feature_check";
--> statement-breakpoint
ALTER TABLE "platform_ai_usage" ADD CONSTRAINT "platform_ai_usage_feature_check" CHECK ("feature" ~ '^[a-z][a-z0-9_]{1,40}$');
--> statement-breakpoint
ALTER TABLE "platform_ai_usage" DROP CONSTRAINT IF EXISTS "platform_ai_usage_requests_check";
--> statement-breakpoint
ALTER TABLE "platform_ai_usage" ADD CONSTRAINT "platform_ai_usage_requests_check" CHECK ("requests" >= 0);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_ai_usage_org_at_idx" ON "platform_ai_usage" ("org_code","at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_ai_usage_at_idx" ON "platform_ai_usage" ("at");
--> statement-breakpoint
UPDATE "platform_plans" SET "limits" = "limits" || '{"ai":{"requestsPerDay":10,"requestsPerMonth":100,"costUsdPerMonth":{"soft":20,"hard":50},"platformCreditUsdPerMonth":0}}'::jsonb, "updated_at" = now() WHERE "key" = 'trial' AND NOT ("limits" ? 'ai');
--> statement-breakpoint
UPDATE "platform_plans" SET "limits" = "limits" || '{"ai":{"requestsPerDay":100,"requestsPerMonth":1000,"costUsdPerMonth":{"soft":100,"hard":300},"platformCreditUsdPerMonth":0}}'::jsonb, "updated_at" = now() WHERE "key" = 'standard' AND NOT ("limits" ? 'ai');
--> statement-breakpoint
UPDATE "platform_plans" SET "limits" = "limits" || '{"ai":{"requestsPerDay":null,"requestsPerMonth":null,"costUsdPerMonth":{"soft":null,"hard":null},"platformCreditUsdPerMonth":0}}'::jsonb, "updated_at" = now() WHERE "key" = 'internal' AND NOT ("limits" ? 'ai');
--> statement-breakpoint
ALTER TABLE "ai_blueprint_drafts" DROP CONSTRAINT IF EXISTS "ai_blueprint_drafts_source_check";
--> statement-breakpoint
ALTER TABLE "ai_blueprint_drafts" ADD CONSTRAINT "ai_blueprint_drafts_source_check" CHECK ("ai_source" is null or "ai_source" in ('ORG_CONNECTION','HOME','PLATFORM'));
