-- 0229 · CHÍNH SÁCH R0–R4 + NGÂN SÁCH THEO PHẠM VI (docs/tech-control-plane/README.md mục 11).
--
--  · CỘNG THÊM: `tech_tasks.policy_level` (NULL = CHƯA XẾP ⇒ không tự động — đóng khi thiếu; dòng cũ KHÔNG backfill)
--    + `policy_reasons`; bảng `tech_budgets` (một dòng mỗi phạm vi, ô NULL = CHƯA KHAI).
--  · Viết tay, idempotent.

ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "policy_level" text;--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "policy_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_tasks" DROP CONSTRAINT IF EXISTS "tech_tasks_policy_check";--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD CONSTRAINT "tech_tasks_policy_check" CHECK ("tech_tasks"."policy_level" IS NULL OR "tech_tasks"."policy_level" IN ('R0','R1','R2','R3','R4'));--> statement-breakpoint

ALTER TABLE "tech_events" DROP CONSTRAINT IF EXISTS "tech_events_subject_check";--> statement-breakpoint
ALTER TABLE "tech_events" ADD CONSTRAINT "tech_events_subject_check" CHECK ("tech_events"."subject_type" IN ('GOAL','MISSION','TASK','WORKER','RUN','DEPLOYMENT','INCIDENT','BUDGET'));--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tech_budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL,
	"api_usd_daily" double precision,
	"api_usd_total" double precision,
	"max_run_minutes" integer,
	"max_attempts" integer,
	"max_concurrent_runs" integer,
	"note" text DEFAULT '' NOT NULL,
	"updated_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tech_budgets_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE set null,
	CONSTRAINT "tech_budgets_scope_check" CHECK ("tech_budgets"."scope_kind" IN ('COMPANY','PROJECT','GOAL','MISSION')),
	CONSTRAINT "tech_budgets_company_check" CHECK (("tech_budgets"."scope_kind" = 'COMPANY') = ("tech_budgets"."scope_id" = '')),
	CONSTRAINT "tech_budgets_values_check" CHECK (("tech_budgets"."api_usd_daily" IS NULL OR "tech_budgets"."api_usd_daily" >= 0) AND ("tech_budgets"."api_usd_total" IS NULL OR "tech_budgets"."api_usd_total" >= 0) AND ("tech_budgets"."max_run_minutes" IS NULL OR "tech_budgets"."max_run_minutes" BETWEEN 5 AND 240) AND ("tech_budgets"."max_attempts" IS NULL OR "tech_budgets"."max_attempts" BETWEEN 1 AND 10) AND ("tech_budgets"."max_concurrent_runs" IS NULL OR "tech_budgets"."max_concurrent_runs" BETWEEN 1 AND 16))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tech_budgets_scope_uq" ON "tech_budgets" USING btree ("scope_kind","scope_id");
