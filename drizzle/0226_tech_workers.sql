-- 0226 · WORKER · LEASE · NHỊP TIM · NHẬT KÝ LƯỢT CHẠY (docs/tech-control-plane/README.md mục 4).
--
--  · CỘNG THÊM: bảng `tech_workers` (danh tính worker, khoá chỉ lưu băm), bảng `tech_run_logs` (nhật ký có trần),
--    cột lease / lần thử trên `tech_tasks`, cột worker / provider / model / generation trên `tech_agent_runs`.
--  · Hàng đợi là PostgreSQL: nhận việc bằng `FOR UPDATE SKIP LOCKED`; `lease_generation` là fencing token.
--  · Không dòng cũ nào đổi giá trị: `attempts = 0`, `max_attempts = 3`, lease rỗng = chưa ai giữ.
--  · Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "tech_workers" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"host" text DEFAULT '' NOT NULL,
	"provider" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_concurrency" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"disabled_reason" text DEFAULT '' NOT NULL,
	"secret_hash" text NOT NULL,
	"version" text DEFAULT '' NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tech_workers_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE set null,
	CONSTRAINT "tech_workers_key_check" CHECK ("tech_workers"."key" ~ '^[a-z][a-z0-9-]{2,39}$'),
	CONSTRAINT "tech_workers_provider_check" CHECK ("tech_workers"."provider" IN ('SUBSCRIPTION_CLAUDE_CODE','ANTHROPIC_API')),
	CONSTRAINT "tech_workers_concurrency_check" CHECK ("tech_workers"."max_concurrency" BETWEEN 1 AND 4),
	CONSTRAINT "tech_workers_secret_check" CHECK ("tech_workers"."secret_hash" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tech_workers_key_uq" ON "tech_workers" USING btree ("key");--> statement-breakpoint

ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "capability" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "lease_worker_id" text;--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "lease_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "max_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "last_error" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_tasks" DROP CONSTRAINT IF EXISTS "tech_tasks_lease_worker_id_tech_workers_id_fk";--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD CONSTRAINT "tech_tasks_lease_worker_id_tech_workers_id_fk" FOREIGN KEY ("lease_worker_id") REFERENCES "tech_workers"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "tech_tasks" DROP CONSTRAINT IF EXISTS "tech_tasks_lease_pair_check";--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD CONSTRAINT "tech_tasks_lease_pair_check" CHECK (("tech_tasks"."lease_worker_id" IS NULL) = ("tech_tasks"."lease_expires_at" IS NULL));--> statement-breakpoint
ALTER TABLE "tech_tasks" DROP CONSTRAINT IF EXISTS "tech_tasks_attempts_check";--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD CONSTRAINT "tech_tasks_attempts_check" CHECK ("tech_tasks"."attempts" >= 0 AND "tech_tasks"."max_attempts" BETWEEN 1 AND 10 AND "tech_tasks"."lease_generation" >= 0);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_tasks_claim_idx" ON "tech_tasks" USING btree ("status","priority","created_at") WHERE "tech_tasks"."status" = 'SPEC_READY';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_tasks_lease_idx" ON "tech_tasks" USING btree ("lease_expires_at") WHERE "tech_tasks"."lease_worker_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "tech_agent_runs" ADD COLUMN IF NOT EXISTS "worker_id" text;--> statement-breakpoint
ALTER TABLE "tech_agent_runs" ADD COLUMN IF NOT EXISTS "provider" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_agent_runs" ADD COLUMN IF NOT EXISTS "model" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_agent_runs" ADD COLUMN IF NOT EXISTS "lease_generation" integer;--> statement-breakpoint
ALTER TABLE "tech_agent_runs" DROP CONSTRAINT IF EXISTS "tech_agent_runs_worker_id_tech_workers_id_fk";--> statement-breakpoint
ALTER TABLE "tech_agent_runs" ADD CONSTRAINT "tech_agent_runs_worker_id_tech_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "tech_workers"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_agent_runs_worker_idx" ON "tech_agent_runs" USING btree ("worker_id","status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tech_run_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"line" text NOT NULL,
	CONSTRAINT "tech_run_logs_run_id_tech_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "tech_agent_runs"("id") ON DELETE cascade,
	CONSTRAINT "tech_run_logs_level_check" CHECK ("tech_run_logs"."level" IN ('info','warn','error')),
	CONSTRAINT "tech_run_logs_line_check" CHECK (length("tech_run_logs"."line") <= 2000)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tech_run_logs_run_seq_uq" ON "tech_run_logs" USING btree ("run_id","seq");
