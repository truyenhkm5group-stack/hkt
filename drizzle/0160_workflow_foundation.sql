-- 0160 · WORKFLOW FOUNDATION (docs/platform/phase-3-contracts.md mục 1).
--
--  · CHỈ THÊM ba bảng trong CSDL tổ chức: workflow_rules, workflow_runs, workflow_cursors. Không dòng dữ
--    liệu nào được chèn — không luật nào tồn tại, không gì chạy cho tới khi người khai luật VÀ bật nó.
--  · NỚI (chỉ thêm một giá trị) hai CHECK có sẵn để việc do workflow tạo ghi đúng nguồn:
--      work_items.creation_source  + 'WORKFLOW'
--      work_item_events.source     + 'WORKFLOW'
--    Mọi dòng hiện có đều thoả ràng buộc mới (tập cũ là tập con), nên ADD CONSTRAINT không hỏng dòng nào.
-- Viết tay và idempotent như 0033–0159.

CREATE TABLE IF NOT EXISTS "workflow_rules" (
  "id" text PRIMARY KEY NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "mode" text DEFAULT 'DRY_RUN' NOT NULL,
  "trigger" jsonb NOT NULL,
  "conditions" jsonb,
  "actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "gate" jsonb,
  "version" integer DEFAULT 1 NOT NULL,
  "created_by" text,
  "updated_by" text,
  "activated_by" text,
  "activated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_rules_status_check" CHECK ("status" in ('DRAFT','ACTIVE','PAUSED','ARCHIVED')),
  CONSTRAINT "workflow_rules_mode_check" CHECK ("mode" in ('DRY_RUN','LIVE'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_rules_key_uq" ON "workflow_rules" ("key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "rule_id" text NOT NULL,
  "rule_version" integer NOT NULL,
  "mode" text NOT NULL,
  "trigger_kind" text NOT NULL,
  "trigger_ref" text NOT NULL,
  "subject_type" text,
  "subject_id" text,
  "dedupe_key" text NOT NULL,
  "status" text NOT NULL,
  "steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "causation_depth" integer DEFAULT 0 NOT NULL,
  "approval_request_id" text,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "workflow_runs_status_check" CHECK ("status" in ('DRY_RUN','PENDING','WAITING_APPROVAL','DONE','SKIPPED','FAILED','REJECTED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_runs_dedupe_uq" ON "workflow_runs" ("dedupe_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_runs_rule_idx" ON "workflow_runs" ("rule_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_runs_status_idx" ON "workflow_runs" ("status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_cursors" (
  "key" text PRIMARY KEY NOT NULL,
  "value" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_items" DROP CONSTRAINT IF EXISTS "work_items_creation_source_check";
--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_creation_source_check" CHECK ("creation_source" IN ('AUTO', 'MANUAL', 'RECURRING', 'WORKFLOW'));
--> statement-breakpoint
ALTER TABLE "work_item_events" DROP CONSTRAINT IF EXISTS "work_item_events_source_check";
--> statement-breakpoint
ALTER TABLE "work_item_events" ADD CONSTRAINT "work_item_events_source_check" CHECK ("source" IN ('UI', 'API', 'SYSTEM', 'RECURRENCE', 'WORKFLOW'));
