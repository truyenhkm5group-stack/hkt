-- 0152 · MẶT PHẲNG ĐIỀU KHIỂN CỦA NỀN TẢNG ĐA TỔ CHỨC (docs/platform/shared-contracts.md mục 2).
--
--  · CHỈ THÊM: bốn bảng `platform_*` và MỘT dòng — tổ chức nhà. Không bảng nghiệp vụ nào bị đổi, không
--    backfill: CSDL này (DATABASE_URL) trở thành CSDL của tổ chức nhà, nguyên vẹn (target-architecture P2).
--  · Tổ chức nhà `module_default = 'ENABLED'` và KHÔNG có dòng module nào ⇒ mọi module bật, đúng hành vi
--    trước nền tảng. Tổ chức mới mặc định 'DISABLED' ⇒ chỉ có đúng những gì được bật.
--  · Cùng bộ migration áp cho CSDL của mọi tổ chức, nên CSDL tổ chức khác cũng có bốn bảng này — RỖNG và
--    không ai đọc (chỉ `getPlatformDb()` đọc, và nó luôn là CSDL nhà). Dòng tổ chức nhà dưới đây chỉ được
--    chèn khi bảng đang RỖNG, và CSDL của tổ chức khác được cấp bằng `provisionOrganization()` — hàm đó
--    xoá dòng này khỏi bản sao rỗng ngay sau khi migrate (xem lib/platform/provision.ts).
-- Viết tay và idempotent như 0033–0151.

CREATE TABLE IF NOT EXISTS "platform_organizations" (
  "id" text PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "is_home" boolean DEFAULT false NOT NULL,
  "module_default" text DEFAULT 'DISABLED' NOT NULL,
  "plan" text,
  "template_key" text,
  "settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_organizations_status_check" CHECK ("status" in ('ACTIVE','SUSPENDED','ARCHIVED')),
  CONSTRAINT "platform_organizations_module_default_check" CHECK ("module_default" in ('ENABLED','DISABLED')),
  CONSTRAINT "platform_organizations_code_check" CHECK ("code" ~ '^[a-z][a-z0-9-]{1,30}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_organizations_code_key" ON "platform_organizations" ("code");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_organizations_one_home" ON "platform_organizations" ("is_home") WHERE "is_home";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_organization_modules" (
  "organization_id" text NOT NULL REFERENCES "platform_organizations"("id"),
  "module_key" text NOT NULL,
  "enabled" boolean NOT NULL,
  "features" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "enabled_at" timestamp with time zone,
  "disabled_at" timestamp with time zone,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_organization_modules_pk" ON "platform_organization_modules" ("organization_id","module_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_flag_overrides" (
  "organization_id" text NOT NULL REFERENCES "platform_organizations"("id"),
  "flag_key" text NOT NULL,
  "enabled" boolean NOT NULL,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_flag_overrides_pk" ON "platform_flag_overrides" ("organization_id","flag_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_audit_log" (
  "id" text PRIMARY KEY NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "actor_org_code" text,
  "actor_user_id" text,
  "actor_email" text,
  "target_org_code" text NOT NULL,
  "action" text NOT NULL,
  "subject" text NOT NULL,
  "before" jsonb,
  "after" jsonb,
  "reason" text,
  "source" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_log_target_at_idx" ON "platform_audit_log" ("target_org_code","at");
--> statement-breakpoint
INSERT INTO "platform_organizations" ("id", "code", "name", "status", "is_home", "module_default", "template_key")
SELECT 'org-home', 'vnx', 'VNXcommerce', 'ACTIVE', true, 'ENABLED', 'fashion-commerce'
WHERE NOT EXISTS (SELECT 1 FROM "platform_organizations");
--> statement-breakpoint
INSERT INTO "platform_audit_log" ("id", "target_org_code", "action", "subject", "after", "reason", "source")
SELECT 'audit-org-home-created', 'vnx', 'ORG_CREATE', 'vnx', '{"isHome":true,"moduleDefault":"ENABLED"}'::jsonb,
       'Tổ chức có từ trước nền tảng trở thành tổ chức nhà — dữ liệu giữ nguyên trong CSDL này.', 'MIGRATION'
WHERE EXISTS (SELECT 1 FROM "platform_organizations" WHERE "id" = 'org-home')
  AND NOT EXISTS (SELECT 1 FROM "platform_audit_log" WHERE "id" = 'audit-org-home-created');
