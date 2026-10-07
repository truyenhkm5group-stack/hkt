-- 0226 · MẶT PHẲNG ĐIỀU KHIỂN CÔNG TY — PROJECT · GOAL · MISSION · SỰ KIỆN (docs/tech-control-plane/README.md).
--
--  · CỘNG THÊM, không sửa dữ liệu cũ: bốn bảng mới + bốn cột trên `tech_tasks` (nullable / mặc định rỗng).
--  · `tech_tasks.status` mở rộng thêm `NEEDS_OWNER` (kèm loại leo thang + việc chủ shop phải làm — CHECK) và
--    `CANCELLED`. Không dòng nào bị đổi trạng thái; vòng đời chuẩn BACKLOG…DONE là PHÉP CHIẾU tính lúc đọc.
--  · KHÔNG gieo dự án ở đây: migration chạy trên CSDL của MỌI tổ chức (mỗi tổ chức một CSDL), và danh sách dự án
--    kỹ thuật là của tổ chức nhà. Bốn dự án mặc định gieo bằng nút "Khởi tạo dự án" ở /tech/goals (người bấm).
--  · Viết tay, idempotent (`IF NOT EXISTS` / `DROP … IF EXISTS`).

CREATE TABLE IF NOT EXISTS "tech_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"repo" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tech_projects_key_check" CHECK ("tech_projects"."key" ~ '^[a-z][a-z0-9-]{1,31}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tech_projects_key_uq" ON "tech_projects" USING btree ("key");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tech_goals" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"project_id" text,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"success_criteria" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"priority" text DEFAULT 'P2' NOT NULL,
	"outcome_note" text DEFAULT '' NOT NULL,
	"created_by_kind" text DEFAULT 'HUMAN' NOT NULL,
	"created_by_id" text,
	"created_by_name" text DEFAULT '' NOT NULL,
	"activated_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tech_goals_project_id_tech_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tech_projects"("id") ON DELETE set null,
	CONSTRAINT "tech_goals_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE set null,
	CONSTRAINT "tech_goals_status_check" CHECK ("tech_goals"."status" IN ('DRAFT','ACTIVE','PAUSED','ACHIEVED','ABANDONED')),
	CONSTRAINT "tech_goals_priority_check" CHECK ("tech_goals"."priority" IN ('P0','P1','P2','P3')),
	CONSTRAINT "tech_goals_actor_kind_check" CHECK ("tech_goals"."created_by_kind" IN ('HUMAN','SYSTEM','AI_AGENT')),
	CONSTRAINT "tech_goals_closed_check" CHECK ("tech_goals"."status" NOT IN ('ACHIEVED','ABANDONED') OR ("tech_goals"."closed_at" IS NOT NULL AND length(btrim("tech_goals"."outcome_note")) >= 10))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tech_goals_code_uq" ON "tech_goals" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_goals_status_idx" ON "tech_goals" USING btree ("status","priority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_goals_project_idx" ON "tech_goals" USING btree ("project_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tech_missions" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"goal_id" text,
	"project_id" text,
	"title" text NOT NULL,
	"objective" text DEFAULT '' NOT NULL,
	"definition_of_done" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'PLANNING' NOT NULL,
	"priority" text DEFAULT 'P2' NOT NULL,
	"registry_id" text DEFAULT '' NOT NULL,
	"outcome_note" text DEFAULT '' NOT NULL,
	"created_by_kind" text DEFAULT 'HUMAN' NOT NULL,
	"created_by_id" text,
	"created_by_name" text DEFAULT '' NOT NULL,
	"activated_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tech_missions_goal_id_tech_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "tech_goals"("id") ON DELETE set null,
	CONSTRAINT "tech_missions_project_id_tech_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tech_projects"("id") ON DELETE set null,
	CONSTRAINT "tech_missions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE set null,
	CONSTRAINT "tech_missions_status_check" CHECK ("tech_missions"."status" IN ('PLANNING','ACTIVE','PAUSED','DONE','CANCELLED')),
	CONSTRAINT "tech_missions_priority_check" CHECK ("tech_missions"."priority" IN ('P0','P1','P2','P3')),
	CONSTRAINT "tech_missions_actor_kind_check" CHECK ("tech_missions"."created_by_kind" IN ('HUMAN','SYSTEM','AI_AGENT')),
	CONSTRAINT "tech_missions_closed_check" CHECK ("tech_missions"."status" NOT IN ('DONE','CANCELLED') OR ("tech_missions"."closed_at" IS NOT NULL AND length(btrim("tech_missions"."outcome_note")) >= 10))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tech_missions_code_uq" ON "tech_missions" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tech_missions_registry_uq" ON "tech_missions" USING btree ("registry_id") WHERE "tech_missions"."registry_id" <> '';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_missions_goal_idx" ON "tech_missions" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_missions_status_idx" ON "tech_missions" USING btree ("status","priority");--> statement-breakpoint

ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "mission_id" text;--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "project_id" text;--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "owner_escalation" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "owner_action" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_tasks" DROP CONSTRAINT IF EXISTS "tech_tasks_mission_id_tech_missions_id_fk";--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD CONSTRAINT "tech_tasks_mission_id_tech_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "tech_missions"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "tech_tasks" DROP CONSTRAINT IF EXISTS "tech_tasks_project_id_tech_projects_id_fk";--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD CONSTRAINT "tech_tasks_project_id_tech_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tech_projects"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_tasks_mission_idx" ON "tech_tasks" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_tasks_project_idx" ON "tech_tasks" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "tech_tasks" DROP CONSTRAINT IF EXISTS "tech_tasks_status_check";--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD CONSTRAINT "tech_tasks_status_check" CHECK ("tech_tasks"."status" IN ('NEW','TRIAGED','SPEC_READY','BUILDING','REVIEW','QA','READY_TO_DEPLOY','DEPLOYING','OBSERVING','DONE','BLOCKED','FAILED','ROLLED_BACK','NEEDS_OWNER','CANCELLED'));--> statement-breakpoint
ALTER TABLE "tech_tasks" DROP CONSTRAINT IF EXISTS "tech_tasks_needs_owner_check";--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD CONSTRAINT "tech_tasks_needs_owner_check" CHECK ("tech_tasks"."status" <> 'NEEDS_OWNER' OR ("tech_tasks"."owner_escalation" IN ('APPROVAL_REQUIRED','CREDENTIAL_REQUIRED','PAYMENT_REQUIRED','EXTERNAL_AUTH_REQUIRED','IRREVERSIBLE_BUSINESS_DECISION','PRODUCTION_INCIDENT','SECURITY_INCIDENT','POLICY_CONFLICT','UNKNOWN_HIGH_RISK_STATE') AND length(btrim("tech_tasks"."owner_action")) >= 10));--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tech_events" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"task_id" text,
	"mission_id" text,
	"goal_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text,
	"actor_agent_id" text,
	"actor_name" text DEFAULT '' NOT NULL,
	"dedupe_key" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tech_events_task_id_tech_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tech_tasks"("id") ON DELETE set null,
	CONSTRAINT "tech_events_mission_id_tech_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "tech_missions"("id") ON DELETE set null,
	CONSTRAINT "tech_events_goal_id_tech_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "tech_goals"("id") ON DELETE set null,
	CONSTRAINT "tech_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE set null,
	CONSTRAINT "tech_events_actor_agent_id_tech_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "tech_agents"("id") ON DELETE set null,
	CONSTRAINT "tech_events_name_check" CHECK ("tech_events"."name" ~ '^[a-z_]+(\.[a-z_]+)+$'),
	CONSTRAINT "tech_events_subject_check" CHECK ("tech_events"."subject_type" IN ('GOAL','MISSION','TASK','WORKER','RUN','DEPLOYMENT','INCIDENT')),
	CONSTRAINT "tech_events_actor_kind_check" CHECK ("tech_events"."actor_kind" IN ('HUMAN','SYSTEM','AI_AGENT')),
	CONSTRAINT "tech_events_human_link_check" CHECK ("tech_events"."actor_kind" = 'HUMAN' OR "tech_events"."actor_id" IS NULL),
	CONSTRAINT "tech_events_agent_link_check" CHECK ("tech_events"."actor_kind" = 'AI_AGENT' OR "tech_events"."actor_agent_id" IS NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tech_events_dedupe_uq" ON "tech_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_events_subject_idx" ON "tech_events" USING btree ("subject_type","subject_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_events_occurred_idx" ON "tech_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_events_mission_idx" ON "tech_events" USING btree ("mission_id","occurred_at");
