-- 0131 · COMPANY OS — SỔ DANH TÍNH MẪU · LỊCH SỬ VÒNG ĐỜI · SỔ SỰ KIỆN.
--
-- Hợp đồng: docs/company-os/shared-contracts.md mục 1–2. Ba bảng MỚI, không đổi một cột nào của bảng cũ.
--
-- `product_models` là sổ danh tính (mã chủ shop Q001 / TK-260925-01), KHÔNG phải chủ dữ liệu sản phẩm:
-- `products` vẫn là chủ. `lifecycle_state` NULL = CHƯA KHAI — migration này KHÔNG gieo dòng nào và KHÔNG
-- backfill trạng thái (AGENTS.md mục 8.8, 35). Sổ được lấp bằng job `model-registry` do người bấm, và
-- trạng thái chỉ đổi qua `transitionModelCore` (lib/models/service.ts).
--
-- `domain_events` và `product_model_state_history` là APPEND-ONLY: không UPDATE / DELETE ở đâu cả
-- (tests/company-os-models.test.ts quét mã nguồn).
--
-- Thứ tự tạo theo khoá ngoại: product_models → domain_events (model_id) → history (source_event_id).
-- Viết tay và idempotent như 0033–0130.

CREATE TABLE IF NOT EXISTS "product_models" (
  "id" text PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "name" text DEFAULT '' NOT NULL,
  "product_id" text,
  "design_concept_id" text,
  "lifecycle_state" text,
  "state_changed_at" timestamp with time zone,
  "owner_user_id" text,
  "registered_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "product_models_code_unique" UNIQUE("code"),
  CONSTRAINT "product_models_product_id_unique" UNIQUE("product_id"),
  CONSTRAINT "product_models_design_concept_id_unique" UNIQUE("design_concept_id"),
  CONSTRAINT "product_models_state_check" CHECK ("lifecycle_state" IS NULL OR "lifecycle_state" IN ('IDEA', 'CREATIVE', 'ADS_TESTING', 'WINNER', 'LOSER', 'PRODUCTION_DISCUSSION', 'COSTING', 'SAMPLING', 'SAMPLE_REVIEW', 'APPROVED', 'PRODUCTION_PLANNING', 'IN_PRODUCTION', 'SELLING', 'CLEARANCE', 'DISCONTINUED')),
  CONSTRAINT "product_models_registered_by_check" CHECK ("registered_by" IN ('SYNC', 'USER')),
  CONSTRAINT "product_models_code_check" CHECK (length("code") > 0)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "product_models" ADD CONSTRAINT "product_models_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "product_models" ADD CONSTRAINT "product_models_design_concept_id_design_concepts_id_fk" FOREIGN KEY ("design_concept_id") REFERENCES "public"."design_concepts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "product_models" ADD CONSTRAINT "product_models_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_models_state_idx" ON "product_models" ("lifecycle_state");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "domain_events" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "subject_type" text NOT NULL,
  "subject_id" text NOT NULL,
  "model_id" text,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_id" text,
  "source" text NOT NULL,
  "correlation_id" text,
  "causation_id" text,
  "dedupe_key" text,
  "occurred_at" timestamp with time zone NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "domain_events_dedupe_key_unique" UNIQUE("dedupe_key"),
  CONSTRAINT "domain_events_name_check" CHECK ("name" ~ '^[a-z_]+(\.[a-z_]+)+$'),
  CONSTRAINT "domain_events_actor_kind_check" CHECK ("actor_kind" IN ('USER', 'SYSTEM', 'AGENT', 'WEBHOOK')),
  CONSTRAINT "domain_events_user_actor_check" CHECK ("actor_kind" <> 'USER' OR "actor_id" IS NOT NULL)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_model_id_product_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."product_models"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "domain_events_model_idx" ON "domain_events" ("model_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "domain_events_name_idx" ON "domain_events" ("name", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "domain_events_subject_idx" ON "domain_events" ("subject_type", "subject_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_model_state_history" (
  "id" text PRIMARY KEY NOT NULL,
  "model_id" text NOT NULL,
  "from_state" text,
  "to_state" text NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_id" text,
  "actor_name" text DEFAULT '' NOT NULL,
  "reason" text NOT NULL,
  "source" text NOT NULL,
  "source_event_id" text,
  "related_type" text,
  "related_id" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "product_model_state_history_to_check" CHECK ("to_state" IN ('IDEA', 'CREATIVE', 'ADS_TESTING', 'WINNER', 'LOSER', 'PRODUCTION_DISCUSSION', 'COSTING', 'SAMPLING', 'SAMPLE_REVIEW', 'APPROVED', 'PRODUCTION_PLANNING', 'IN_PRODUCTION', 'SELLING', 'CLEARANCE', 'DISCONTINUED')),
  CONSTRAINT "product_model_state_history_actor_kind_check" CHECK ("actor_kind" IN ('USER', 'SYSTEM', 'AGENT', 'WEBHOOK')),
  CONSTRAINT "product_model_state_history_user_actor_check" CHECK ("actor_kind" <> 'USER' OR "actor_id" IS NOT NULL)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "product_model_state_history" ADD CONSTRAINT "product_model_state_history_model_id_product_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."product_models"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "product_model_state_history" ADD CONSTRAINT "product_model_state_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "product_model_state_history" ADD CONSTRAINT "product_model_state_history_source_event_id_domain_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."domain_events"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_model_state_history_model_idx" ON "product_model_state_history" ("model_id", "occurred_at");
