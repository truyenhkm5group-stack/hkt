-- HOÀ GIẢI R1 — BỐN MIGRATION CỦA `main` MÀ BẢN CHẠY THỬ SẼ BỎ QUA.
--
-- Drizzle quyết định "đã chạy chưa" bằng MỐC THỜI GIAN trong sổ, không bằng tên tệp. Bản chạy thử
-- có mốc trần 1789381643786 (14/09/2026), cao hơn mốc của `main` 0084–0087 — nên khi gộp nhánh,
-- bốn migration ấy sẽ bị BỎ QUA VĨNH VIỄN ở đó, im lặng.
--
-- Đó không phải chuyện nhỏ: `main` 0090 chạy `ALTER TABLE "fanpages"`, mà bảng `fanpages` do
-- chính 0086 tạo ra. Thiếu nó thì lượt migration trên bản chạy thử CHẾT giữa chừng — `IF NOT
-- EXISTS` trên tên cột không cứu được một bảng không tồn tại.
--
-- Tệp này mang đúng hiệu ứng của bốn migration ấy, chạy lại được. Trên CSDL đã có chúng (bản
-- production) nó bị bỏ qua vì mốc thấp hơn trần; trên bản chạy thử nó chạy và tạo đủ.
--
-- SINH RA bởi scripts/migration-reconcile/generate.mjs — đừng sửa tay.
--> statement-breakpoint
-- ┌─ 0084_metric_target_product_scope.sql ────────────────
ALTER TABLE "metric_targets" DROP CONSTRAINT IF EXISTS "metric_targets_scope_check";
--> statement-breakpoint
ALTER TABLE "metric_targets" DROP CONSTRAINT IF EXISTS "metric_targets_scope_check";
--> statement-breakpoint
ALTER TABLE "metric_targets" ADD CONSTRAINT "metric_targets_scope_check"
  CHECK ("scope" IN ('COMPANY', 'DEPARTMENT', 'POSITION', 'USER', 'PRODUCT'));
--> statement-breakpoint
-- ┌─ 0085_return_reason_raw_text.sql ─────────────────────
ALTER TABLE "shipment_return_reasons" ADD COLUMN IF NOT EXISTS "raw_reason" text DEFAULT '' NOT NULL;
--> statement-breakpoint
-- ┌─ 0086_fanpage_marketer_attribution.sql ───────────────
CREATE TABLE IF NOT EXISTS "fanpages" (
  "id" text PRIMARY KEY NOT NULL,
  "external_page_id" text NOT NULL,
  "name" text NOT NULL DEFAULT '',
  "platform" text NOT NULL DEFAULT 'facebook',
  "active" boolean NOT NULL DEFAULT true,
  "first_order_at" timestamp with time zone,
  "last_order_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fanpages_external_uq" ON "fanpages" ("external_page_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fanpages_active_idx" ON "fanpages" ("active");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fanpage_marketer_assignments" (
  "id" text PRIMARY KEY NOT NULL,
  "fanpage_id" text NOT NULL,
  "marketer_id" text NOT NULL,
  "effective_from" timestamp with time zone NOT NULL,
  "effective_to" timestamp with time zone,
  "active" boolean NOT NULL DEFAULT true,
  "note" text NOT NULL DEFAULT '',
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "fanpage_marketer_assignments" ADD CONSTRAINT "fanpage_assign_page_fk"
    FOREIGN KEY ("fanpage_id") REFERENCES "fanpages"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "fanpage_marketer_assignments" ADD CONSTRAINT "fanpage_assign_creator_fk"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "fanpage_marketer_assignments" ADD CONSTRAINT "fanpage_assign_period_check"
    CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "fanpage_marketer_assignments" ADD CONSTRAINT "fanpage_assign_marketer_check"
    CHECK ("marketer_id" <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fanpage_assign_page_idx" ON "fanpage_marketer_assignments" ("fanpage_id", "effective_from");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fanpage_assign_marketer_idx" ON "fanpage_marketer_assignments" ("marketer_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fanpage_assign_open_uq"
  ON "fanpage_marketer_assignments" ("fanpage_id")
  WHERE "effective_to" IS NULL AND "active";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_attributions" (
  "id" text PRIMARY KEY NOT NULL,
  "order_id" text NOT NULL,
  "source_page_id" text,
  "fanpage_id" text,
  "marketer_id" text,
  "assignment_id" text,
  "status" text NOT NULL,
  "source_order_at" timestamp with time zone NOT NULL,
  "dedupe_key" text,
  "duplicate_of_order_id" text,
  "duplicate_score" integer,
  "duplicate_reason" text,
  "rule_version" integer NOT NULL DEFAULT 1,
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_attributions" ADD CONSTRAINT "order_attribution_order_fk"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_attributions" ADD CONSTRAINT "order_attribution_fanpage_fk"
    FOREIGN KEY ("fanpage_id") REFERENCES "fanpages"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_attributions" ADD CONSTRAINT "order_attribution_assignment_fk"
    FOREIGN KEY ("assignment_id") REFERENCES "fanpage_marketer_assignments"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_attributions" ADD CONSTRAINT "order_attribution_duplicate_fk"
    FOREIGN KEY ("duplicate_of_order_id") REFERENCES "orders"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_attributions" ADD CONSTRAINT "order_attribution_status_check"
    CHECK ("status" IN ('ATTRIBUTED', 'NO_PAGE', 'NO_ASSIGNMENT', 'DUPLICATE'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_attributions" ADD CONSTRAINT "order_attribution_marketer_check"
    CHECK (("status" = 'ATTRIBUTED') = ("marketer_id" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_attributions" ADD CONSTRAINT "order_attribution_duplicate_check"
    CHECK (("status" = 'DUPLICATE') = ("duplicate_of_order_id" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_attributions" ADD CONSTRAINT "order_attribution_evidence_check"
    CHECK (("status" = 'DUPLICATE') = ("duplicate_score" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_attributions" ADD CONSTRAINT "order_attribution_self_check"
    CHECK ("duplicate_of_order_id" IS NULL OR "duplicate_of_order_id" <> "order_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_attribution_order_uq" ON "order_attributions" ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_attribution_marketer_idx" ON "order_attributions" ("marketer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_attribution_page_idx" ON "order_attributions" ("source_page_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_attribution_status_idx" ON "order_attributions" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_attribution_dedupe_idx" ON "order_attributions" ("dedupe_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_attribution_version_idx" ON "order_attributions" ("rule_version");
--> statement-breakpoint
-- ┌─ 0087_return_reason_observations.sql ─────────────────
CREATE TABLE IF NOT EXISTS "return_reason_observations" (
  "id" text PRIMARY KEY NOT NULL,
  "shipment_id" text,
  "order_id" text,
  "source" text NOT NULL,
  "raw_text" text NOT NULL,
  "reason_at_write" text DEFAULT 'UNKNOWN' NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "source_ref" text DEFAULT '' NOT NULL,
  "actor_id" text,
  "actor_email" text DEFAULT '' NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "dedupe_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "return_reason_obs_raw_check" CHECK (length(btrim("raw_text")) > 0),
  CONSTRAINT "return_reason_obs_link_check" CHECK ("shipment_id" IS NOT NULL OR "order_id" IS NOT NULL)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "return_reason_observations" ADD CONSTRAINT "return_reason_observations_shipment_id_shipments_id_fk"
    FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "return_reason_observations" ADD CONSTRAINT "return_reason_observations_order_id_orders_id_fk"
    FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "return_reason_observations" ADD CONSTRAINT "return_reason_observations_actor_id_users_id_fk"
    FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "return_reason_obs_uq" ON "return_reason_observations" ("dedupe_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_reason_obs_shipment_idx" ON "return_reason_observations" ("shipment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_reason_obs_order_idx" ON "return_reason_observations" ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_reason_obs_source_idx" ON "return_reason_observations" ("source");
