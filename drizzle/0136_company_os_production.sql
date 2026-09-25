-- 0135 · COMPANY OS · AGENT C — SẢN XUẤT NỬA ĐẦU: TOPIC → GIÁ THÀNH → MẪU → BẢN DUYỆT → LỆNH SX.
--
-- Bảy bảng mới + ba cột NULL được trên `production_orders`. Hợp đồng: docs/company-os/shared-contracts.md
-- mục 5; luật: lib/constants/production-os.ts.
--
-- KHÔNG GIEO, KHÔNG BACKFILL (AGENTS.md mục 8.8, 35): lệnh sản xuất cũ không có bản duyệt, không có
-- gợi ý đã lưu, không có lý do — ba cột mới để NULL và màn hình in "—". Cờ
-- `production.requireApprovedDesign` KHÔNG được ghi ở đây: không có dòng settings ⇒ mặc định TẮT (chỉ
-- cảnh báo); bật nó là HUMAN GATE.
--
-- Ba bảng APPEND-ONLY (`production_topic_messages`, `sample_reviews`, `design_versions`) và bảng giá thành
-- FINAL bất biến được canh bằng mã nguồn + bài kiểm (tests/company-os-production.test.ts); CHECK ở đây
-- chặn phần CSDL chặn được: FINAL phải có người chốt, phán quyết "sửa / loại" phải có ghi chú, mỗi mẫu
-- một phán quyết, người quyết là `users.id` FK RESTRICT.
-- Viết tay và idempotent như 0033–0132.

CREATE TABLE IF NOT EXISTS "production_topics" (
  "id" text PRIMARY KEY NOT NULL,
  "model_id" text NOT NULL,
  "title" text NOT NULL,
  "requirements" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'WAITING_QUOTE' NOT NULL,
  "supplier_id" text,
  "selected_option" text,
  "evidence_snapshot" jsonb NOT NULL,
  "created_by_user_id" text,
  "created_by" text DEFAULT '' NOT NULL,
  "status_changed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "production_topics_status_check" CHECK ("status" IN ('WAITING_QUOTE', 'DISCUSSING', 'OPTIONS_READY', 'WAITING_DECISION', 'SELECTED', 'CLOSED')),
  CONSTRAINT "production_topics_title_check" CHECK (length(btrim("title")) > 0),
  CONSTRAINT "production_topics_selected_check" CHECK ("status" <> 'SELECTED' OR length(btrim(coalesce("selected_option", ''))) > 0)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "production_topics" ADD CONSTRAINT "production_topics_model_id_product_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."product_models"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "production_topics" ADD CONSTRAINT "production_topics_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "production_topics" ADD CONSTRAINT "production_topics_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_topics_model_idx" ON "production_topics" ("model_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_topics_status_idx" ON "production_topics" ("status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "production_topic_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "topic_id" text NOT NULL,
  "author_user_id" text,
  "author_name" text DEFAULT '' NOT NULL,
  "kind" text DEFAULT 'NOTE' NOT NULL,
  "body" text NOT NULL,
  "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "quoted_unit_price" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "production_topic_messages_kind_check" CHECK ("kind" IN ('NOTE', 'QUOTE', 'OPTION', 'DECISION')),
  CONSTRAINT "production_topic_messages_body_check" CHECK (length(btrim("body")) > 0),
  CONSTRAINT "production_topic_messages_price_check" CHECK ("quoted_unit_price" IS NULL OR "quoted_unit_price" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "production_topic_messages" ADD CONSTRAINT "production_topic_messages_topic_id_production_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."production_topics"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "production_topic_messages" ADD CONSTRAINT "production_topic_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_topic_messages_topic_idx" ON "production_topic_messages" ("topic_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_sheets" (
  "id" text PRIMARY KEY NOT NULL,
  "model_id" text NOT NULL,
  "topic_id" text,
  "version" integer NOT NULL,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "total_unit_cost" integer DEFAULT 0 NOT NULL,
  "notes" text DEFAULT '' NOT NULL,
  "created_by_user_id" text,
  "created_by" text DEFAULT '' NOT NULL,
  "finalized_at" timestamp with time zone,
  "finalized_by_user_id" text,
  "finalized_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cost_sheets_status_check" CHECK ("status" IN ('DRAFT', 'FINAL')),
  CONSTRAINT "cost_sheets_version_check" CHECK ("version" > 0),
  CONSTRAINT "cost_sheets_total_check" CHECK ("total_unit_cost" >= 0),
  CONSTRAINT "cost_sheets_final_check" CHECK (("status" = 'DRAFT' AND "finalized_at" IS NULL AND "finalized_by_user_id" IS NULL) OR ("status" = 'FINAL' AND "finalized_at" IS NOT NULL AND "finalized_by_user_id" IS NOT NULL))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cost_sheets" ADD CONSTRAINT "cost_sheets_model_id_product_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."product_models"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cost_sheets" ADD CONSTRAINT "cost_sheets_topic_id_production_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."production_topics"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cost_sheets" ADD CONSTRAINT "cost_sheets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cost_sheets" ADD CONSTRAINT "cost_sheets_finalized_by_user_id_users_id_fk" FOREIGN KEY ("finalized_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cost_sheets_model_version_uq" ON "cost_sheets" ("model_id", "version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_sheets_topic_idx" ON "cost_sheets" ("topic_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_sheet_lines" (
  "id" text PRIMARY KEY NOT NULL,
  "cost_sheet_id" text NOT NULL,
  "kind" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "qty" double precision DEFAULT 0 NOT NULL,
  "unit" text DEFAULT '' NOT NULL,
  "unit_cost" integer DEFAULT 0 NOT NULL,
  "amount" integer DEFAULT 0 NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "cost_sheet_lines_kind_check" CHECK ("kind" IN ('FABRIC', 'LABOR', 'TRIM', 'PRINTING', 'PACKING', 'FACTORY_TRANSPORT', 'INBOUND', 'WASTAGE', 'OTHER')),
  CONSTRAINT "cost_sheet_lines_money_check" CHECK ("qty" >= 0 AND "unit_cost" >= 0 AND "amount" >= 0),
  CONSTRAINT "cost_sheet_lines_percent_check" CHECK ("unit" <> '%' OR ("kind" = 'WASTAGE' AND "qty" <= 100))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cost_sheet_lines" ADD CONSTRAINT "cost_sheet_lines_cost_sheet_id_cost_sheets_id_fk" FOREIGN KEY ("cost_sheet_id") REFERENCES "public"."cost_sheets"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_sheet_lines_sheet_idx" ON "cost_sheet_lines" ("cost_sheet_id", "sort_order");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "samples" (
  "id" text PRIMARY KEY NOT NULL,
  "model_id" text NOT NULL,
  "topic_id" text,
  "version" integer NOT NULL,
  "supplier_id" text,
  "cost_vnd" integer,
  "images" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "notes" text DEFAULT '' NOT NULL,
  "problems" text DEFAULT '' NOT NULL,
  "requested_changes" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'IN_PROGRESS' NOT NULL,
  "created_by_user_id" text,
  "created_by" text DEFAULT '' NOT NULL,
  "submitted_at" timestamp with time zone,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "samples_status_check" CHECK ("status" IN ('IN_PROGRESS', 'SUBMITTED', 'CHANGES_REQUESTED', 'REJECTED', 'APPROVED')),
  CONSTRAINT "samples_version_check" CHECK ("version" > 0),
  CONSTRAINT "samples_cost_check" CHECK ("cost_vnd" IS NULL OR "cost_vnd" >= 0),
  CONSTRAINT "samples_submitted_check" CHECK ("status" = 'IN_PROGRESS' OR "submitted_at" IS NOT NULL),
  CONSTRAINT "samples_decided_check" CHECK ("status" IN ('IN_PROGRESS', 'SUBMITTED') OR "decided_at" IS NOT NULL)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "samples" ADD CONSTRAINT "samples_model_id_product_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."product_models"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "samples" ADD CONSTRAINT "samples_topic_id_production_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."production_topics"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "samples" ADD CONSTRAINT "samples_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "samples" ADD CONSTRAINT "samples_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "samples_model_version_uq" ON "samples" ("model_id", "version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "samples_status_idx" ON "samples" ("status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sample_reviews" (
  "id" text PRIMARY KEY NOT NULL,
  "sample_id" text NOT NULL,
  "decision" text NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "reviewer_user_id" text NOT NULL,
  "reviewer_name" text DEFAULT '' NOT NULL,
  "reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sample_reviews_sample_id_unique" UNIQUE("sample_id"),
  CONSTRAINT "sample_reviews_decision_check" CHECK ("decision" IN ('REQUEST_CHANGES', 'REJECT', 'APPROVE')),
  CONSTRAINT "sample_reviews_note_check" CHECK ("decision" = 'APPROVE' OR length(btrim("note")) > 0)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sample_reviews" ADD CONSTRAINT "sample_reviews_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sample_reviews" ADD CONSTRAINT "sample_reviews_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "design_versions" (
  "id" text PRIMARY KEY NOT NULL,
  "model_id" text NOT NULL,
  "sample_id" text NOT NULL,
  "review_id" text NOT NULL,
  "cost_sheet_id" text,
  "version" integer NOT NULL,
  "spec" jsonb NOT NULL,
  "approved_by_user_id" text NOT NULL,
  "approved_by" text DEFAULT '' NOT NULL,
  "approved_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "design_versions_sample_id_unique" UNIQUE("sample_id"),
  CONSTRAINT "design_versions_review_id_unique" UNIQUE("review_id"),
  CONSTRAINT "design_versions_version_check" CHECK ("version" > 0)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "design_versions" ADD CONSTRAINT "design_versions_model_id_product_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."product_models"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "design_versions" ADD CONSTRAINT "design_versions_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "design_versions" ADD CONSTRAINT "design_versions_review_id_sample_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."sample_reviews"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "design_versions" ADD CONSTRAINT "design_versions_cost_sheet_id_cost_sheets_id_fk" FOREIGN KEY ("cost_sheet_id") REFERENCES "public"."cost_sheets"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "design_versions" ADD CONSTRAINT "design_versions_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "design_versions_model_version_uq" ON "design_versions" ("model_id", "version");
--> statement-breakpoint
ALTER TABLE "production_orders" ADD COLUMN IF NOT EXISTS "design_version_id" text;
--> statement-breakpoint
ALTER TABLE "production_orders" ADD COLUMN IF NOT EXISTS "suggested_cells" jsonb;
--> statement-breakpoint
ALTER TABLE "production_orders" ADD COLUMN IF NOT EXISTS "override_reason" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_design_version_id_design_versions_id_fk" FOREIGN KEY ("design_version_id") REFERENCES "public"."design_versions"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_orders_design_version_idx" ON "production_orders" ("design_version_id") WHERE "design_version_id" IS NOT NULL;
