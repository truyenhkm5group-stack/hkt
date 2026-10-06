-- 0224 · SAAS CONTROL PLANE (docs/saas/README.md) — Account → Workspace → Product Subscription, sổ dùng chung, sổ chi phí,
-- bảng kê (hoá đơn ngoài / chargeback nội bộ), job cấp phát. MỞ RỘNG mặt phẳng điều khiển đã có, KHÔNG thay:
--
--  · `platform_accounts`: KHÁCH HÀNG THƯƠNG MẠI. `account_type` INTERNAL | EXTERNAL, `billing_mode` INTERNAL_CHARGEBACK |
--    EXTERNAL_INVOICE. Khác nhau giữa khách nội bộ và khách ngoài CHỈ nằm ở hai cột này — không có nhánh mã riêng.
--  · `platform_organizations.account_id`: workspace (= "tổ chức", ranh giới cô lập SILO, một CSDL) thuộc tài khoản nào.
--    Tên bảng giữ nguyên vì `code` của nó nằm trong JWT, khoá đệm và tên CSDL (target-architecture P2).
--  · `platform_product_subscriptions`: workspace × sản phẩm (danh mục sản phẩm là MÃ NGUỒN — lib/saas/catalog.ts, như sổ
--    module). `plan_key NULL` = theo gói của workspace (`platform_organizations.plan`, gói GỘP như bán hôm nay) — KHÔNG chép
--    gói sang chỗ thứ hai. Tình trạng hiệu lực (dùng thử · quá hạn · hết hạn) là HÀM của dòng này + thu phí, tính lúc đọc.
--  · `platform_plans.product_keys`: gói phủ sản phẩm nào. NULL = gói gộp (mọi sản phẩm) — mọi gói có từ trước.
--  · `platform_usage_events`: sổ dùng CHUNG, chỉ thêm, khoá idempotent (tổ chức, event_key). Lượt AI vẫn CHỈ ở
--    `platform_ai_usage` (một nguồn cho một khoản) — sổ này cho chỉ số không phải lượt gọi model.
--  · `platform_cost_entries`: chi phí ngoài AI (API ngoài, tin nhắn, lưu trữ…) có căn cứ phân bổ. Chi phí hạ tầng / hỗ trợ
--    nền theo tháng vẫn khai ở `platform_settings['platform.economics.costs']` (0203) — sổ này KHÔNG nhận hạng mục đó.
--  · `platform_billing_statements`: bảng kê kỳ của một tài khoản. DRAFT tính lúc đọc; FINAL đóng băng ảnh chụp (luật 21).
--  · `platform_provisioning_jobs`: mỗi lượt cấp phát một dòng, có bước, lần thử, lỗi, khoá idempotent.
--  · `platform_audit_log.target_account_id`: thao tác ở cấp tài khoản.
--
-- BACKFILL TẤT ĐỊNH: mỗi workspace có từ trước ⇒ ĐÚNG MỘT tài khoản riêng (KHÔNG gộp theo tên gần giống — ba workspace HSLC
-- vẫn là ba tài khoản cho tới khi người vận hành gộp tay, có nhật ký). Workspace nhà ⇒ tài khoản `vnxcommerce` INTERNAL /
-- INTERNAL_CHARGEBACK. Thuê bao sản phẩm suy từ module ĐANG BẬT, cùng luật với `productsFromModules()`
-- (tests/saas-platform.test.ts chạy cả hai trên cùng dữ liệu). Mặt phẳng điều khiển: chỉ thật ở CSDL NHÀ (xoá ở CSDL tổ chức
-- — db/migrate.ts). Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "platform_accounts" (
  "id" text PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "account_type" text DEFAULT 'EXTERNAL' NOT NULL,
  "billing_mode" text DEFAULT 'EXTERNAL_INVOICE' NOT NULL,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "legal_name" text,
  "tax_code" text,
  "billing_email" text,
  "note" text,
  "source" text DEFAULT 'OPERATOR' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" text,
  CONSTRAINT "platform_accounts_code_check" CHECK ("code" ~ '^[a-z][a-z0-9-]{1,40}$'),
  CONSTRAINT "platform_accounts_type_check" CHECK ("account_type" IN ('INTERNAL','EXTERNAL')),
  CONSTRAINT "platform_accounts_billing_mode_check" CHECK ("billing_mode" IN ('INTERNAL_CHARGEBACK','EXTERNAL_INVOICE')),
  CONSTRAINT "platform_accounts_status_check" CHECK ("status" IN ('ACTIVE','SUSPENDED','CLOSED')),
  CONSTRAINT "platform_accounts_source_check" CHECK ("source" IN ('BACKFILL_0224','OPERATOR','PROVISIONING','SIGNUP','TEST'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_accounts_code_key" ON "platform_accounts" ("code");--> statement-breakpoint

ALTER TABLE "platform_organizations" ADD COLUMN IF NOT EXISTS "account_id" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "platform_organizations" ADD CONSTRAINT "platform_organizations_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "platform_accounts"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_organizations_account_idx" ON "platform_organizations" ("account_id");--> statement-breakpoint

ALTER TABLE "platform_plans" ADD COLUMN IF NOT EXISTS "product_keys" text[];--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "platform_product_subscriptions" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL REFERENCES "platform_accounts"("id"),
  "org_code" text NOT NULL,
  "product_key" text NOT NULL,
  "plan_key" text,
  "state" text DEFAULT 'ACTIVE' NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone,
  "end_reason" text,
  "scheduled_plan_key" text,
  "scheduled_at" date,
  "source" text DEFAULT 'OPERATOR' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" text,
  CONSTRAINT "platform_product_subscriptions_product_check" CHECK ("product_key" ~ '^[a-z][a-z0-9_]{1,30}$'),
  CONSTRAINT "platform_product_subscriptions_state_check" CHECK ("state" IN ('ACTIVE','PAUSED','CANCELED')),
  CONSTRAINT "platform_product_subscriptions_ended_check" CHECK (("state" = 'CANCELED') = ("ended_at" IS NOT NULL)),
  CONSTRAINT "platform_product_subscriptions_schedule_check" CHECK (("scheduled_plan_key" IS NULL) = ("scheduled_at" IS NULL)),
  CONSTRAINT "platform_product_subscriptions_source_check" CHECK ("source" IN ('BACKFILL_0224','OPERATOR','PROVISIONING','SIGNUP','TEST'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_product_subscriptions_live_key" ON "platform_product_subscriptions" ("org_code", "product_key") WHERE "ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_product_subscriptions_account_idx" ON "platform_product_subscriptions" ("account_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "platform_usage_events" (
  "id" text PRIMARY KEY NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  "account_id" text,
  "org_code" text NOT NULL,
  "product_key" text NOT NULL,
  "subscription_id" text,
  "metric" text NOT NULL,
  "quantity" bigint NOT NULL,
  "unit" text NOT NULL,
  "source" text NOT NULL,
  "event_key" text NOT NULL,
  "correlation_id" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  CONSTRAINT "platform_usage_events_metric_check" CHECK ("metric" ~ '^[a-z][a-z0-9_]{1,60}$'),
  CONSTRAINT "platform_usage_events_product_check" CHECK ("product_key" ~ '^[a-z][a-z0-9_]{1,30}$'),
  CONSTRAINT "platform_usage_events_quantity_check" CHECK ("quantity" >= 0),
  CONSTRAINT "platform_usage_events_key_check" CHECK (length("event_key") BETWEEN 1 AND 200)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_usage_events_org_key" ON "platform_usage_events" ("org_code", "event_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_usage_events_org_at_idx" ON "platform_usage_events" ("org_code", "occurred_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "platform_cost_entries" (
  "id" text PRIMARY KEY NOT NULL,
  "period_month" date NOT NULL,
  "category" text NOT NULL,
  "scope" text NOT NULL,
  "product_key" text,
  "account_id" text,
  "org_code" text,
  "allocation_basis" text NOT NULL,
  "amount_vnd" bigint NOT NULL,
  "description" text NOT NULL,
  "entry_key" text NOT NULL,
  "created_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "voided_at" timestamp with time zone,
  "void_reason" text,
  CONSTRAINT "platform_cost_entries_month_check" CHECK (extract(day from "period_month") = 1),
  CONSTRAINT "platform_cost_entries_category_check" CHECK ("category" IN ('EXTERNAL_API','MESSAGING','STORAGE','INFRA_DIRECT','OTHER')),
  CONSTRAINT "platform_cost_entries_scope_check" CHECK (
    ("scope" = 'PLATFORM' AND "product_key" IS NULL AND "account_id" IS NULL AND "org_code" IS NULL)
    OR ("scope" = 'PRODUCT' AND "product_key" IS NOT NULL AND "account_id" IS NULL AND "org_code" IS NULL)
    OR ("scope" = 'ACCOUNT' AND "account_id" IS NOT NULL AND "org_code" IS NULL)
    OR ("scope" = 'WORKSPACE' AND "org_code" IS NOT NULL)),
  CONSTRAINT "platform_cost_entries_basis_check" CHECK ("allocation_basis" IN ('DIRECT','EQUAL_ACTIVE_WORKSPACES','AI_COST_SHARE')),
  CONSTRAINT "platform_cost_entries_direct_check" CHECK ("allocation_basis" <> 'DIRECT' OR "scope" IN ('ACCOUNT','WORKSPACE')),
  CONSTRAINT "platform_cost_entries_amount_check" CHECK ("amount_vnd" > 0),
  CONSTRAINT "platform_cost_entries_void_check" CHECK (("voided_at" IS NULL) = ("void_reason" IS NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_cost_entries_key" ON "platform_cost_entries" ("entry_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_cost_entries_month_idx" ON "platform_cost_entries" ("period_month");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "platform_billing_statements" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL REFERENCES "platform_accounts"("id"),
  "period_month" date NOT NULL,
  "billing_mode" text NOT NULL,
  "status" text DEFAULT 'FINAL' NOT NULL,
  "total_known_vnd" bigint NOT NULL,
  "unknown_lines" integer DEFAULT 0 NOT NULL,
  "snapshot" jsonb NOT NULL,
  "engine_version" text NOT NULL,
  "finalized_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finalized_by_email" text,
  CONSTRAINT "platform_billing_statements_month_check" CHECK (extract(day from "period_month") = 1),
  CONSTRAINT "platform_billing_statements_mode_check" CHECK ("billing_mode" IN ('INTERNAL_CHARGEBACK','EXTERNAL_INVOICE')),
  CONSTRAINT "platform_billing_statements_status_check" CHECK ("status" IN ('FINAL')),
  CONSTRAINT "platform_billing_statements_unknown_check" CHECK ("unknown_lines" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_billing_statements_account_month_key" ON "platform_billing_statements" ("account_id", "period_month");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "platform_provisioning_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "account_id" text,
  "org_code" text,
  "product_key" text,
  "input" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'PENDING' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "last_error" text,
  "requested_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  CONSTRAINT "platform_provisioning_jobs_kind_check" CHECK ("kind" IN ('CREATE_CUSTOMER','SUBSCRIBE_PRODUCT','CANCEL_SUBSCRIPTION')),
  CONSTRAINT "platform_provisioning_jobs_status_check" CHECK ("status" IN ('PENDING','RUNNING','SUCCEEDED','FAILED')),
  CONSTRAINT "platform_provisioning_jobs_error_check" CHECK ("status" <> 'FAILED' OR "last_error" IS NOT NULL),
  CONSTRAINT "platform_provisioning_jobs_key_check" CHECK (length("idempotency_key") BETWEEN 1 AND 200)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_provisioning_jobs_key" ON "platform_provisioning_jobs" ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_provisioning_jobs_status_idx" ON "platform_provisioning_jobs" ("status", "created_at");--> statement-breakpoint

ALTER TABLE "platform_audit_log" ADD COLUMN IF NOT EXISTS "target_account_id" text;--> statement-breakpoint

-- ── Backfill tài khoản: mỗi workspace một tài khoản. Nhà ⇒ VNXCommerce INTERNAL. ──
INSERT INTO "platform_accounts" ("id", "code", "name", "account_type", "billing_mode", "source", "note")
SELECT 'acct-' || o."code",
       CASE WHEN o."is_home" THEN 'vnxcommerce' ELSE o."code" END,
       CASE WHEN o."is_home" THEN 'VNXCommerce' ELSE o."name" END,
       CASE WHEN o."is_home" THEN 'INTERNAL' ELSE 'EXTERNAL' END,
       CASE WHEN o."is_home" THEN 'INTERNAL_CHARGEBACK' ELSE 'EXTERNAL_INVOICE' END,
       'BACKFILL_0224',
       '0224: một workspace có từ trước ⇒ một tài khoản; gộp tài khoản là việc tay của người vận hành (không gộp theo tên)'
FROM "platform_organizations" o
WHERE o."account_id" IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "platform_organizations" o SET "account_id" = 'acct-' || o."code"
WHERE o."account_id" IS NULL AND EXISTS (SELECT 1 FROM "platform_accounts" a WHERE a."id" = 'acct-' || o."code");--> statement-breakpoint

-- ── Backfill thuê bao sản phẩm — CÙNG luật với lib/saas/catalog.ts::productsFromModules ──
-- Module đang bật = (dòng enabled) ∪ (module_default = ENABLED và không có dòng tắt). Lõi thương mại dùng chung
-- (core · work · customers · products · orders · inventory) KHÔNG tự nó là ERP: shop «Chỉ cần AI bán hàng» có chúng mà
-- không thuê ERP. ERP ⇔ có ít nhất một module ERP KHÁC lõi đang bật. Chốt Đơn ⇔ `ai_sales` đang bật.
WITH mods AS (
  SELECT o."code", o."account_id", m.key AS module_key
  FROM "platform_organizations" o
  CROSS JOIN (VALUES ('core'),('work'),('customers'),('products'),('orders'),('inventory'),('purchasing'),('production'),('logistics'),('returns'),('customer_care'),('sales_channels'),('marketing'),('finance'),('payroll'),('alerts'),('tech'),('connector_pancake'),('connector_viettelpost'),('connector_meta'),('connector_bank'),('connector_messaging'),('integrations'),('apps'),('ai_sales'),('appointments'),('warranty'),('wholesale_leads'),('stays'),('lots'),('field_jobs'),('real_estate')) AS m(key)
  WHERE o."account_id" IS NOT NULL
    AND o."status" <> 'SETUP_FAILED'
    AND (
      EXISTS (SELECT 1 FROM "platform_organization_modules" r WHERE r."organization_id" = o."id" AND r."module_key" = m.key AND r."enabled")
      OR (o."module_default" = 'ENABLED' AND NOT EXISTS (SELECT 1 FROM "platform_organization_modules" r WHERE r."organization_id" = o."id" AND r."module_key" = m.key AND NOT r."enabled"))
    )
), wanted AS (
  SELECT DISTINCT "code", "account_id", 'erp' AS product_key FROM mods
  WHERE module_key NOT IN ('core','work','customers','products','orders','inventory','ai_sales')
  UNION
  SELECT DISTINCT "code", "account_id", 'chotdon' AS product_key FROM mods WHERE module_key = 'ai_sales'
  UNION
  -- Bot nhà (`chatbot/`, feature `connector_pancake.chatbot`) là RUNTIME CŨ của miền AI bán hàng — chủ sở hữu miền là Chốt
  -- Đơn (docs/saas/OWNERSHIP.md). Workspace chạy nó vẫn là khách của Chốt Đơn, chỉ khác runtime.
  SELECT DISTINCT m."code", m."account_id", 'chotdon' AS product_key FROM mods m
  WHERE m.module_key = 'connector_pancake'
    AND NOT EXISTS (
      SELECT 1 FROM "platform_organization_modules" r JOIN "platform_organizations" o ON o."id" = r."organization_id"
      WHERE o."code" = m."code" AND r."module_key" = 'connector_pancake' AND (r."features" ->> 'connector_pancake.chatbot') = 'false'
    )
)
INSERT INTO "platform_product_subscriptions" ("id", "account_id", "org_code", "product_key", "plan_key", "state", "started_at", "source")
SELECT 'psub-' || w."code" || '-' || w.product_key, w."account_id", w."code", w.product_key, NULL, 'ACTIVE',
       (SELECT o."created_at" FROM "platform_organizations" o WHERE o."code" = w."code"), 'BACKFILL_0224'
FROM wanted w
WHERE NOT EXISTS (SELECT 1 FROM "platform_product_subscriptions" s WHERE s."org_code" = w."code" AND s."product_key" = w.product_key AND s."ended_at" IS NULL)
ON CONFLICT DO NOTHING;
