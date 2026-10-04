-- 0204 · SỔ DÙNG THEO NGÀY CỦA TỪNG TỔ CHỨC (docs/productization/11_SAAS_METRICS_SPEC.md §10).
--
--  · Một dòng = (ngày giờ VN, tổ chức): hội thoại khách mới · tin khách · tin bot gửi · hội thoại bot có trả lời · đơn do AI
--    chốt. ĐẾM từ chứng từ có mốc thời gian trong CSDL của chính tổ chức (kênh THỬ — khung thử, phát lại, copilot — không
--    bao giờ tính). Đây là ĐƠN VỊ ĐO cho hạn mức / tính phí theo hội thoại về sau và cho cột «dùng AI» của Owner Cockpit.
--  · Lượt chụp tính lại HÔM NAY và HÔM QUA (hôm qua có thể còn tin tới muộn lúc chụp trước); ngày cũ hơn đóng băng.
--  · Mặt phẳng điều khiển: chỉ thật ở CSDL NHÀ (xoá sạch ở CSDL tổ chức — db/migrate.ts). Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "platform_tenant_usage_daily" (
  "day" date NOT NULL,
  "org_code" text NOT NULL,
  "conversations_started" integer DEFAULT 0 NOT NULL,
  "customer_messages" integer DEFAULT 0 NOT NULL,
  "bot_messages" integer DEFAULT 0 NOT NULL,
  "ai_active_conversations" integer DEFAULT 0 NOT NULL,
  "ai_orders" integer DEFAULT 0 NOT NULL,
  "captured_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_tenant_usage_daily_pkey" PRIMARY KEY ("day", "org_code"),
  CONSTRAINT "platform_tenant_usage_daily_nonneg_check" CHECK ("conversations_started" >= 0 AND "customer_messages" >= 0 AND "bot_messages" >= 0 AND "ai_active_conversations" >= 0 AND "ai_orders" >= 0)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "platform_tenant_usage_daily_org_day_idx" ON "platform_tenant_usage_daily" ("org_code", "day");
