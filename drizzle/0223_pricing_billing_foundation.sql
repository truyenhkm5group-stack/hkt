-- 0222 · NỀN MÓNG GIÁ & THU PHÍ (docs/platform/pricing-billing-foundation.md) — MỞ RỘNG 0169 · 0176 · 0187 · 0194 · 0204.
--
--  · `platform_plans.commercial` (jsonb): phần THƯƠNG MẠI của một gói — hiện ở /pricing không, «Liên hệ»,
--    hạn mức theo tháng (fanpage · hội thoại AI · tin AI · đơn), tính năng (entitlement), chính sách vượt, mức áp hạn mức
--    (mềm / cứng). Đọc bằng `lib/pricing/catalog.ts::parseCommercial` — ô thiếu = CHƯA KHAI, màn hình nói ra.
--    Người dùng vẫn là `limits.users` (0169) — không khai lần hai. Số ngày dùng thử vẫn là `TRIAL_DAYS` (lib/billing/rules.ts,
--    nằm trong Điều khoản sử dụng) — KHÔNG có ô thứ hai trong CSDL để hai nơi nói hai số.
--  · Gói MỚI `enterprise` «Doanh nghiệp»: KHÔNG có giá (price_vnd NULL = không bán tự phục vụ) ⇒ /pricing in «Liên hệ».
--  · `platform_ai_usage` thêm `event_key` (khoá sự kiện — gọi lại / thử lại cùng khoá KHÔNG ghi dòng thứ hai, chỉ mục duy
--    nhất theo tổ chức), `conversation_id`, `modality` (TEXT · VISION · IMAGE). Dòng cũ để NULL — không backfill.
--  · `platform_tenant_usage_daily.fanpages_active`: số fanpage đang hoạt động lúc chụp. NULL = CHƯA ĐO (không phải 0).
--  · Bảng MỚI `platform_org_pricing`: ghi đè của người vận hành theo tổ chức (tính năng · hạn mức · mức áp) + cờ
--    `grandfathered`. MỌI tổ chức khách có từ trước migration này được ghi một dòng `grandfathered = true` ⇒ giữ ĐỦ tính
--    năng, mức áp `SOFT` — lần deploy này không làm ai mất tính năng và không bật trần cứng nào.
--  · MỌI lệnh gieo chỉ chạm ô còn nguyên (`commercial = '{}'`): ô người vận hành đã sửa không bị đè; chạy lại không đổi gì.
--  · Mặt phẳng điều khiển: chỉ thật ở CSDL NHÀ (xoá sạch ở CSDL tổ chức — db/migrate.ts). Viết tay, idempotent.

ALTER TABLE "platform_plans" ADD COLUMN IF NOT EXISTS "commercial" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
INSERT INTO "platform_plans" ("key", "name", "description", "limits", "position", "price_vnd", "yearly_free_months") VALUES
  ('enterprise', 'Doanh nghiệp', 'Chuỗi cửa hàng, nhiều fanpage, cần cấu hình riêng và cam kết hỗ trợ — báo giá theo nhu cầu.', '{"users":null,"pages":null,"objects":null,"records":null,"workflows":null,"aiDraftsPerDay":null,"storageMb":null,"ai":{"requestsPerDay":null,"requestsPerMonth":null,"costUsdPerMonth":{"soft":null,"hard":null},"platformCreditUsdPerMonth":0}}'::jsonb, 18, NULL, 0)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
UPDATE "platform_plans" SET "commercial" = '{"publicListed":true,"contactSales":false,"quotas":{"fanpages":1,"aiConversations":120,"aiMessages":960,"orders":50},"features":["ai_sales","ai_order_creation","human_handoff","analytics"],"overage":{"policy":"REQUIRE_UPGRADE","unitPricesVnd":{},"graceAllowancePct":0},"limitModes":{}}'::jsonb, "updated_at" = now() WHERE "key" = 'trial' AND "commercial" = '{}'::jsonb;--> statement-breakpoint
UPDATE "platform_plans" SET "commercial" = '{"publicListed":true,"contactSales":false,"quotas":{"fanpages":1,"aiConversations":180,"aiMessages":1440,"orders":null},"features":["ai_sales","ai_order_creation","human_handoff","analytics"],"overage":{"policy":"REQUIRE_UPGRADE","unitPricesVnd":{},"graceAllowancePct":10},"limitModes":{}}'::jsonb, "updated_at" = now() WHERE "key" = 'basic' AND "commercial" = '{}'::jsonb;--> statement-breakpoint
UPDATE "platform_plans" SET "commercial" = '{"publicListed":true,"contactSales":false,"quotas":{"fanpages":2,"aiConversations":360,"aiMessages":2880,"orders":null},"features":["ai_sales","multi_page_inbox","ai_order_creation","upsell","follow_up","human_handoff","analytics","multi_user"],"overage":{"policy":"REQUIRE_UPGRADE","unitPricesVnd":{},"graceAllowancePct":10},"limitModes":{}}'::jsonb, "updated_at" = now() WHERE "key" = 'starter' AND "commercial" = '{}'::jsonb;--> statement-breakpoint
UPDATE "platform_plans" SET "commercial" = '{"publicListed":true,"contactSales":false,"highlight":true,"quotas":{"fanpages":5,"aiConversations":950,"aiMessages":7600,"orders":null},"features":["ai_sales","multi_page_inbox","ai_order_creation","upsell","cross_sell","follow_up","human_handoff","analytics","advanced_analytics","multi_user","webhook"],"overage":{"policy":"BILL_OVERAGE","unitPricesVnd":{},"graceAllowancePct":10},"limitModes":{}}'::jsonb, "updated_at" = now() WHERE "key" = 'growth' AND "commercial" = '{}'::jsonb;--> statement-breakpoint
UPDATE "platform_plans" SET "commercial" = '{"publicListed":true,"contactSales":false,"quotas":{"fanpages":10,"aiConversations":1800,"aiMessages":14400,"orders":null},"features":["ai_sales","multi_page_inbox","ai_order_creation","upsell","cross_sell","follow_up","human_handoff","analytics","advanced_analytics","custom_ai_training","api","webhook","multi_user"],"overage":{"policy":"BILL_OVERAGE","unitPricesVnd":{},"graceAllowancePct":10},"limitModes":{}}'::jsonb, "updated_at" = now() WHERE "key" = 'pro' AND "commercial" = '{}'::jsonb;--> statement-breakpoint
UPDATE "platform_plans" SET "commercial" = '{"publicListed":true,"contactSales":true,"quotas":{"fanpages":null,"aiConversations":null,"aiMessages":null,"orders":null},"features":["ai_sales","multi_page_inbox","ai_order_creation","upsell","cross_sell","follow_up","human_handoff","analytics","advanced_analytics","custom_ai_training","api","webhook","multi_user"],"overage":{"policy":"SOFT_ONLY","unitPricesVnd":{},"graceAllowancePct":0},"limitModes":{}}'::jsonb, "updated_at" = now() WHERE "key" = 'enterprise' AND "commercial" = '{}'::jsonb;--> statement-breakpoint
UPDATE "platform_plans" SET "commercial" = '{"publicListed":false,"contactSales":false,"quotas":{"fanpages":null,"aiConversations":null,"aiMessages":null,"orders":null},"features":["ai_sales","multi_page_inbox","ai_order_creation","upsell","cross_sell","follow_up","human_handoff","analytics","advanced_analytics","custom_ai_training","api","webhook","multi_user"],"overage":{"policy":"SOFT_ONLY","unitPricesVnd":{},"graceAllowancePct":0},"limitModes":{}}'::jsonb, "updated_at" = now() WHERE "key" = 'internal' AND "commercial" = '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "platform_ai_usage" ADD COLUMN IF NOT EXISTS "event_key" text;--> statement-breakpoint
ALTER TABLE "platform_ai_usage" ADD COLUMN IF NOT EXISTS "conversation_id" text;--> statement-breakpoint
ALTER TABLE "platform_ai_usage" ADD COLUMN IF NOT EXISTS "modality" text;--> statement-breakpoint
ALTER TABLE "platform_ai_usage" DROP CONSTRAINT IF EXISTS "platform_ai_usage_modality_check";--> statement-breakpoint
ALTER TABLE "platform_ai_usage" ADD CONSTRAINT "platform_ai_usage_modality_check" CHECK ("modality" IS NULL OR "modality" IN ('TEXT','VISION','IMAGE'));--> statement-breakpoint
ALTER TABLE "platform_ai_usage" DROP CONSTRAINT IF EXISTS "platform_ai_usage_event_key_check";--> statement-breakpoint
ALTER TABLE "platform_ai_usage" ADD CONSTRAINT "platform_ai_usage_event_key_check" CHECK ("event_key" IS NULL OR length("event_key") BETWEEN 1 AND 200);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_ai_usage_org_event_key" ON "platform_ai_usage" ("org_code", "event_key") WHERE "event_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_tenant_usage_daily" ADD COLUMN IF NOT EXISTS "fanpages_active" integer;--> statement-breakpoint
ALTER TABLE "platform_tenant_usage_daily" DROP CONSTRAINT IF EXISTS "platform_tenant_usage_daily_fanpages_check";--> statement-breakpoint
ALTER TABLE "platform_tenant_usage_daily" ADD CONSTRAINT "platform_tenant_usage_daily_fanpages_check" CHECK ("fanpages_active" IS NULL OR "fanpages_active" >= 0);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_org_pricing" (
  "org_code" text PRIMARY KEY NOT NULL,
  "grandfathered" boolean DEFAULT false NOT NULL,
  "feature_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "quota_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "enforcement" text DEFAULT 'SOFT' NOT NULL,
  "reason" text,
  "updated_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_org_pricing_enforcement_check" CHECK ("enforcement" IN ('OFF','SOFT','HARD'))
);--> statement-breakpoint
INSERT INTO "platform_org_pricing" ("org_code", "grandfathered", "enforcement", "reason")
SELECT "code", true, 'SOFT', '0222: tổ chức có từ trước bảng giá cấu hình được — giữ đủ tính năng, không bật trần cứng'
FROM "platform_organizations" WHERE "is_home" = false
ON CONFLICT ("org_code") DO NOTHING;
