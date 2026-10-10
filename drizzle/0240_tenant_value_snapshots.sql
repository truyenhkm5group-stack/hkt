-- 0240 · ẢNH GIÁ TRỊ THEO TỔ CHỨC + SỨC KHOẺ THEO NGÀY (sứ mệnh saas-value-snapshots, mẹ saas-value-center · docs/saas/VALUE_CENTER.md §8).
--
--  · `platform_tenant_value_snapshots`: MỘT dòng mỗi (ngày VN, tổ chức, cửa sổ 7/30/90). `metrics` = ĐÚNG ô của `buildTenantValue`;
--    cột phẳng chỉ để sắp xếp / lọc, NULL = CHƯA BIẾT (khác 0). `/platform/saas` đọc ảnh này thay vì mở CSDL từng tổ chức mỗi lần mở trang.
--  · `platform_tenant_health_daily`: MỘT dòng mỗi (ngày VN, tổ chức) — mức sức khoẻ V1 · rủi ro rời bỏ · mã lý do của cả hai (mọi mức
--    có ít nhất một mã — CHECK), vấn đề lớn nhất hôm nay. Không điểm /100.
--  · Hai bảng chỉ được ghi bởi lượt chụp của JOB (lib/saas/tenant-value-capture.ts · lib/saas/tenant-health-daily.ts): hôm nay ghi
--    lại được, ngày đã qua đóng băng.
--  · Chỉ CỘNG THÊM: bảng RỖNG, không gieo, không backfill (AGENTS 35 · 8.8) — ngày trước lượt chụp đầu tiên là CHƯA ĐO.
--    Viết tay, idempotent (ảnh chụp drizzle cũ từ 0032 — không dùng `db:generate`).

CREATE TABLE IF NOT EXISTS "platform_tenant_value_snapshots" (
	"captured_day" date NOT NULL,
	"org_code" text NOT NULL,
	"window_days" integer NOT NULL,
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	"metrics" jsonb NOT NULL,
	"customer_spend_vnd" bigint,
	"variable_cogs_vnd" bigint,
	"platform_gross_profit_vnd" bigint,
	"ai_credited_gross_profit_vnd" bigint,
	"value_multiple_milli" integer,
	"orders_pending" integer,
	"formula_version" text NOT NULL,
	"source_errors" text[] DEFAULT '{}'::text[] NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_tenant_value_snapshots_pkey" PRIMARY KEY ("captured_day", "org_code", "window_days"),
	CONSTRAINT "platform_tenant_value_snapshots_window_check" CHECK ("platform_tenant_value_snapshots"."window_days" IN (7, 30, 90)),
	CONSTRAINT "platform_tenant_value_snapshots_version_check" CHECK (length(btrim("platform_tenant_value_snapshots"."formula_version")) > 0),
	CONSTRAINT "platform_tenant_value_snapshots_nonneg_check" CHECK (("platform_tenant_value_snapshots"."customer_spend_vnd" IS NULL OR "platform_tenant_value_snapshots"."customer_spend_vnd" >= 0) AND ("platform_tenant_value_snapshots"."variable_cogs_vnd" IS NULL OR "platform_tenant_value_snapshots"."variable_cogs_vnd" >= 0) AND ("platform_tenant_value_snapshots"."orders_pending" IS NULL OR "platform_tenant_value_snapshots"."orders_pending" >= 0)),
	CONSTRAINT "platform_tenant_value_snapshots_range_check" CHECK ("platform_tenant_value_snapshots"."window_from" < "platform_tenant_value_snapshots"."window_to"),
	CONSTRAINT "platform_tenant_value_snapshots_metrics_check" CHECK (jsonb_typeof("platform_tenant_value_snapshots"."metrics") = 'object')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_tenant_value_snapshots_org_idx" ON "platform_tenant_value_snapshots" USING btree ("org_code","window_days","captured_day" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_tenant_health_daily" (
	"day" date NOT NULL,
	"org_code" text NOT NULL,
	"level" text NOT NULL,
	"churn_risk" text NOT NULL,
	"reason_codes" text[] NOT NULL,
	"gap_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"churn_reason_codes" text[] NOT NULL,
	"top_issue" jsonb,
	"rule_version" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_tenant_health_daily_pkey" PRIMARY KEY ("day", "org_code"),
	CONSTRAINT "platform_tenant_health_daily_level_check" CHECK ("platform_tenant_health_daily"."level" IN ('CRITICAL','NEEDS_ATTENTION','UNKNOWN','HEALTHY','INACTIVE')),
	CONSTRAINT "platform_tenant_health_daily_churn_check" CHECK ("platform_tenant_health_daily"."churn_risk" IN ('CRITICAL','HIGH','MEDIUM','LOW','UNKNOWN')),
	CONSTRAINT "platform_tenant_health_daily_codes_check" CHECK (cardinality("platform_tenant_health_daily"."reason_codes") >= 1 AND cardinality("platform_tenant_health_daily"."churn_reason_codes") >= 1 AND array_position("platform_tenant_health_daily"."reason_codes", NULL) IS NULL AND array_position("platform_tenant_health_daily"."gap_codes", NULL) IS NULL AND array_position("platform_tenant_health_daily"."churn_reason_codes", NULL) IS NULL AND array_to_string("platform_tenant_health_daily"."reason_codes", ',') ~ '^[A-Z][A-Z0-9_]{1,40}(,[A-Z][A-Z0-9_]{1,40})*$' AND (cardinality("platform_tenant_health_daily"."gap_codes") = 0 OR array_to_string("platform_tenant_health_daily"."gap_codes", ',') ~ '^[A-Z][A-Z0-9_]{1,40}(,[A-Z][A-Z0-9_]{1,40})*$') AND array_to_string("platform_tenant_health_daily"."churn_reason_codes", ',') ~ '^[A-Z][A-Z0-9_]{1,40}(,[A-Z][A-Z0-9_]{1,40})*$'),
	CONSTRAINT "platform_tenant_health_daily_version_check" CHECK (length(btrim("platform_tenant_health_daily"."rule_version")) > 0),
	CONSTRAINT "platform_tenant_health_daily_issue_check" CHECK ("platform_tenant_health_daily"."top_issue" IS NULL OR jsonb_typeof("platform_tenant_health_daily"."top_issue") = 'object')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_tenant_health_daily_org_day_idx" ON "platform_tenant_health_daily" USING btree ("org_code","day");
