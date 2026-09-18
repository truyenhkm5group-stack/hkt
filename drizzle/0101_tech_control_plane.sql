-- ═══════════ PHÒNG TECH AI — MẶT PHẲNG ĐIỀU KHIỂN (Phase 1) ═══════════
--
-- VÌ SAO. ERP đã có sáu hàng đợi nghiệp vụ và một hệ điều hành công việc cho NGƯỜI, nhưng việc của
-- chính hệ thống — lỗi, migration, deploy, sự cố, và (sắp tới) các agent AI xây nó — không có chỗ
-- nào để nằm. Chúng sống trong đầu người đang trực và trong lịch sử chat. Bản này dựng chỗ nằm đó.
--
-- PHASE NÀY KHÔNG XÂY MÁY THI HÀNH. Không bảng nào ở đây kích hoạt một lượt deploy, một lượt merge
-- hay một lượt ghi vào production. `tech_deployments` là LỚP QUAN SÁT: GitHub Actions vẫn là bên có
-- thẩm quyền về deploy, và commit đang chạy vẫn đọc từ `/api/health`.
--
-- VÌ SAO KHÔNG DÙNG `work_items`. AGENTS.md mục 19: mỗi sự việc chỉ có MỘT nơi giữ trạng thái, và
-- `/work` là PHÉP CHIẾU chứ không phải bản sao. Việc Tech là một miền mới với vòng đời riêng (13
-- trạng thái, có mức rủi ro, có cổng phê duyệt, có nhánh git) — không trạng thái nào của `WorkStatus`
-- diễn đạt được "đang quan sát sau deploy". Nên nó tự giữ trạng thái của mình; Phase 2 mới chiếu
-- nó lên `/work` bằng một nguồn khai tường minh.
--
-- CHỈ CỘNG THÊM: sáu bảng mới, KHÔNG sửa bảng nào đang có, KHÔNG backfill một dòng nào. Sổ agent
-- bắt đầu TRỐNG — mẫu ở `TECH_AGENT_TEMPLATES` chỉ chạy khi có NGƯỜI bấm (AGENTS.md mục 23).
-- Viết tay và idempotent như 0033–0100.

CREATE TABLE IF NOT EXISTS "tech_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"can_code" boolean DEFAULT false NOT NULL,
	"can_review" boolean DEFAULT false NOT NULL,
	"can_merge" boolean DEFAULT false NOT NULL,
	"can_deploy" boolean DEFAULT false NOT NULL,
	"can_run_prod_read" boolean DEFAULT false NOT NULL,
	"can_run_prod_write" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'IDLE' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tech_agents_role_check" CHECK ("tech_agents"."role" IN ('AI_CTO','ARCHITECT','BACKEND','FRONTEND','DATA','INTEGRATION','QA','SECURITY','DEVOPS_SRE','DATA_QUALITY','INCIDENT','DOCUMENTATION')),
	CONSTRAINT "tech_agents_status_check" CHECK ("tech_agents"."status" IN ('IDLE','PLANNING','WORKING','REVIEWING','TESTING','DEPLOYING','OBSERVING','BLOCKED','ERROR'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tech_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"task_type" text DEFAULT 'BUGFIX' NOT NULL,
	"module" text DEFAULT 'PLATFORM' NOT NULL,
	"status" text DEFAULT 'NEW' NOT NULL,
	"priority" text DEFAULT 'P2' NOT NULL,
	"risk" text DEFAULT 'R0' NOT NULL,
	"risk_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_overridden_by" text,
	"risk_override_reason" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'OWNER' NOT NULL,
	"source_ref" text DEFAULT '' NOT NULL,
	"agent_id" text,
	"branch" text DEFAULT '' NOT NULL,
	"worktree" text DEFAULT '' NOT NULL,
	"parent_task_id" text,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_required" boolean DEFAULT false NOT NULL,
	"approval_status" text DEFAULT 'NOT_REQUIRED' NOT NULL,
	"approved_by" text,
	"approved_by_name" text DEFAULT '' NOT NULL,
	"approved_at" timestamp with time zone,
	"approval_note" text DEFAULT '' NOT NULL,
	"production_verified_at" timestamp with time zone,
	"production_verified_by" text,
	"production_evidence" text DEFAULT '' NOT NULL,
	"created_by_kind" text DEFAULT 'HUMAN' NOT NULL,
	"created_by_id" text,
	"created_by_name" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"blocked_reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tech_tasks_status_check" CHECK ("tech_tasks"."status" IN ('NEW','TRIAGED','SPEC_READY','BUILDING','REVIEW','QA','READY_TO_DEPLOY','DEPLOYING','OBSERVING','DONE','BLOCKED','FAILED','ROLLED_BACK')),
	CONSTRAINT "tech_tasks_priority_check" CHECK ("tech_tasks"."priority" IN ('P0','P1','P2','P3')),
	CONSTRAINT "tech_tasks_risk_check" CHECK ("tech_tasks"."risk" IN ('R0','R1','R2')),
	CONSTRAINT "tech_tasks_approval_check" CHECK ("tech_tasks"."approval_status" IN ('NOT_REQUIRED','PENDING','APPROVED','REJECTED')),
	CONSTRAINT "tech_tasks_actor_kind_check" CHECK ("tech_tasks"."created_by_kind" IN ('HUMAN','SYSTEM','AI_AGENT')),
	CONSTRAINT "tech_tasks_approval_consistency_check" CHECK (("tech_tasks"."approval_required" = false AND "tech_tasks"."approval_status" = 'NOT_REQUIRED') OR ("tech_tasks"."approval_required" = true AND "tech_tasks"."approval_status" <> 'NOT_REQUIRED')),
	CONSTRAINT "tech_tasks_risk_override_check" CHECK ("tech_tasks"."risk_overridden_by" IS NULL OR length(btrim("tech_tasks"."risk_override_reason")) >= 10),
	CONSTRAINT "tech_tasks_blocked_reason_check" CHECK ("tech_tasks"."status" <> 'BLOCKED' OR length(btrim("tech_tasks"."blocked_reason")) > 0),
	CONSTRAINT "tech_tasks_completed_check" CHECK ("tech_tasks"."status" <> 'DONE' OR "tech_tasks"."completed_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tech_task_events" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"kind" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"previous_value" text DEFAULT '' NOT NULL,
	"next_value" text DEFAULT '' NOT NULL,
	"actor_kind" text DEFAULT 'HUMAN' NOT NULL,
	"actor_id" text,
	"actor_agent_id" text,
	"actor_name" text DEFAULT '' NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tech_task_events_actor_kind_check" CHECK ("tech_task_events"."actor_kind" IN ('HUMAN','SYSTEM','AI_AGENT')),
	CONSTRAINT "tech_task_events_actor_link_check" CHECK ("tech_task_events"."actor_kind" = 'AI_AGENT' OR "tech_task_events"."actor_agent_id" IS NULL),
	CONSTRAINT "tech_task_events_human_link_check" CHECK ("tech_task_events"."actor_kind" = 'HUMAN' OR "tech_task_events"."actor_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tech_agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text,
	"agent_key" text DEFAULT '' NOT NULL,
	"task_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"branch" text DEFAULT '' NOT NULL,
	"base_commit" text DEFAULT '' NOT NULL,
	"result_commit" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"tests_run" text DEFAULT '' NOT NULL,
	"typecheck_result" text DEFAULT 'UNKNOWN' NOT NULL,
	"lint_result" text DEFAULT 'UNKNOWN' NOT NULL,
	"test_result" text DEFAULT 'UNKNOWN' NOT NULL,
	"build_result" text DEFAULT 'UNKNOWN' NOT NULL,
	"files_changed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tech_agent_runs_status_check" CHECK ("tech_agent_runs"."status" IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED')),
	CONSTRAINT "tech_agent_runs_typecheck_check" CHECK ("tech_agent_runs"."typecheck_result" IN ('PASSED','FAILED','SKIPPED','UNKNOWN')),
	CONSTRAINT "tech_agent_runs_lint_check" CHECK ("tech_agent_runs"."lint_result" IN ('PASSED','FAILED','SKIPPED','UNKNOWN')),
	CONSTRAINT "tech_agent_runs_test_check" CHECK ("tech_agent_runs"."test_result" IN ('PASSED','FAILED','SKIPPED','UNKNOWN')),
	CONSTRAINT "tech_agent_runs_build_check" CHECK ("tech_agent_runs"."build_result" IN ('PASSED','FAILED','SKIPPED','UNKNOWN')),
	CONSTRAINT "tech_agent_runs_ended_check" CHECK (("tech_agent_runs"."status" = 'RUNNING' AND "tech_agent_runs"."ended_at" IS NULL) OR ("tech_agent_runs"."status" <> 'RUNNING' AND "tech_agent_runs"."ended_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tech_deployments" (
	"id" text PRIMARY KEY NOT NULL,
	"commit_sha" text NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"actor_kind" text DEFAULT 'HUMAN' NOT NULL,
	"actor_id" text,
	"actor_name" text DEFAULT '' NOT NULL,
	"task_id" text,
	"health_result" text DEFAULT 'UNKNOWN' NOT NULL,
	"smoke_result" text DEFAULT 'UNKNOWN' NOT NULL,
	"observation_result" text DEFAULT 'UNKNOWN' NOT NULL,
	"rollback_of_id" text,
	"external_ref" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tech_deployments_status_check" CHECK ("tech_deployments"."status" IN ('PENDING','RUNNING','SUCCEEDED','FAILED','ROLLED_BACK')),
	CONSTRAINT "tech_deployments_actor_kind_check" CHECK ("tech_deployments"."actor_kind" IN ('HUMAN','SYSTEM','AI_AGENT')),
	CONSTRAINT "tech_deployments_health_check" CHECK ("tech_deployments"."health_result" IN ('PASSED','FAILED','SKIPPED','UNKNOWN')),
	CONSTRAINT "tech_deployments_smoke_check" CHECK ("tech_deployments"."smoke_result" IN ('PASSED','FAILED','SKIPPED','UNKNOWN')),
	CONSTRAINT "tech_deployments_observation_check" CHECK ("tech_deployments"."observation_result" IN ('PASSED','FAILED','SKIPPED','UNKNOWN')),
	CONSTRAINT "tech_deployments_rollback_check" CHECK ("tech_deployments"."status" <> 'ROLLED_BACK' OR "tech_deployments"."rollback_of_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tech_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"source" text DEFAULT 'MONITOR' NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"severity" text DEFAULT 'SEV2' NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"module" text DEFAULT 'PLATFORM' NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"task_id" text,
	"deployment_id" text,
	"root_cause" text DEFAULT '' NOT NULL,
	"mitigation" text DEFAULT '' NOT NULL,
	"resolution" text DEFAULT '' NOT NULL,
	"resolved_at" timestamp with time zone,
	"opened_by_kind" text DEFAULT 'HUMAN' NOT NULL,
	"opened_by_id" text,
	"opened_by_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tech_incidents_severity_check" CHECK ("tech_incidents"."severity" IN ('SEV0','SEV1','SEV2','SEV3')),
	CONSTRAINT "tech_incidents_status_check" CHECK ("tech_incidents"."status" IN ('OPEN','INVESTIGATING','MITIGATED','MONITORING','RESOLVED')),
	CONSTRAINT "tech_incidents_actor_kind_check" CHECK ("tech_incidents"."opened_by_kind" IN ('HUMAN','SYSTEM','AI_AGENT')),
	CONSTRAINT "tech_incidents_resolved_check" CHECK ("tech_incidents"."status" <> 'RESOLVED' OR ("tech_incidents"."resolved_at" IS NOT NULL AND length(btrim("tech_incidents"."resolution")) >= 10))
);
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "tech_tasks" ADD CONSTRAINT "tech_tasks_agent_id_tech_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."tech_agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_tasks" ADD CONSTRAINT "tech_tasks_parent_task_id_tech_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tech_tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_tasks" ADD CONSTRAINT "tech_tasks_risk_overridden_by_users_id_fk" FOREIGN KEY ("risk_overridden_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_tasks" ADD CONSTRAINT "tech_tasks_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_tasks" ADD CONSTRAINT "tech_tasks_production_verified_by_users_id_fk" FOREIGN KEY ("production_verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_tasks" ADD CONSTRAINT "tech_tasks_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_task_events" ADD CONSTRAINT "tech_task_events_task_id_tech_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tech_tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_task_events" ADD CONSTRAINT "tech_task_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_task_events" ADD CONSTRAINT "tech_task_events_actor_agent_id_tech_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."tech_agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_agent_runs" ADD CONSTRAINT "tech_agent_runs_agent_id_tech_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."tech_agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_agent_runs" ADD CONSTRAINT "tech_agent_runs_task_id_tech_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tech_tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_deployments" ADD CONSTRAINT "tech_deployments_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_deployments" ADD CONSTRAINT "tech_deployments_task_id_tech_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tech_tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_deployments" ADD CONSTRAINT "tech_deployments_rollback_of_id_tech_deployments_id_fk" FOREIGN KEY ("rollback_of_id") REFERENCES "public"."tech_deployments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_incidents" ADD CONSTRAINT "tech_incidents_task_id_tech_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tech_tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_incidents" ADD CONSTRAINT "tech_incidents_deployment_id_tech_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."tech_deployments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_incidents" ADD CONSTRAINT "tech_incidents_opened_by_id_users_id_fk" FOREIGN KEY ("opened_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "tech_agents_key_uq" ON "tech_agents" USING btree ("key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_agents_role_idx" ON "tech_agents" USING btree ("role");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tech_tasks_code_uq" ON "tech_tasks" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_tasks_status_idx" ON "tech_tasks" USING btree ("status","priority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_tasks_created_idx" ON "tech_tasks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_tasks_agent_idx" ON "tech_tasks" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_tasks_module_idx" ON "tech_tasks" USING btree ("module");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_task_events_task_idx" ON "tech_task_events" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_agent_runs_agent_idx" ON "tech_agent_runs" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_agent_runs_task_idx" ON "tech_agent_runs" USING btree ("task_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_agent_runs_started_idx" ON "tech_agent_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_deployments_started_idx" ON "tech_deployments" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_deployments_commit_idx" ON "tech_deployments" USING btree ("commit_sha");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tech_incidents_code_uq" ON "tech_incidents" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_incidents_status_idx" ON "tech_incidents" USING btree ("status","severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_incidents_detected_idx" ON "tech_incidents" USING btree ("detected_at");
