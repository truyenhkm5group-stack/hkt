-- ═══════════ PHÉP CHIẾU PULL REQUEST + ĐỀ XUẤT CỦA AI CTO ═══════════
--
-- Hai việc, một migration, vì chúng nói cùng một điều: control plane GHI LẠI thứ đang xảy ra ở
-- nơi khác, chứ không quyết định thay nơi đó.
--
--   · `tech_tasks.pr_*` — GitHub là bên có thẩm quyền về PR / check / merge. ERP chép về để
--     người mở `/tech` không phải sang GitHub mới biết việc đang nằm ở đâu. Rỗng = CHƯA BIẾT,
--     KHÔNG phải "không có PR" và KHÔNG phải "check đỏ".
--
--   · `tech_proposals` — bản kế hoạch AI CTO đề nghị. Chừng nào chưa ai bấm duyệt, nó không
--     có mặt ở hàng đợi nào và không agent nào chạy được nó. `suggested_risk` chỉ là Ý KIẾN:
--     lúc duyệt, từng việc chạy lại `classifyTechRisk()` và lấy kết quả của MÁY.
--
-- CHỈ CỘNG THÊM. Không đổi cột nào đang có, không đụng một dòng dữ liệu nghiệp vụ nào.

ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "pr_number" integer;--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "pr_url" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "pr_state" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "head_sha" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "base_sha" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "ci_state" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "review_state" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "merge_state" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_tasks" ADD COLUMN IF NOT EXISTS "pr_synced_at" timestamp with time zone;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "tech_tasks" ADD CONSTRAINT "tech_tasks_pr_state_check" CHECK ("tech_tasks"."pr_state" IN ('','OPEN','CLOSED','MERGED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_tasks" ADD CONSTRAINT "tech_tasks_ci_state_check" CHECK ("tech_tasks"."ci_state" IN ('','PENDING','SUCCESS','FAILURE'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_tasks" ADD CONSTRAINT "tech_tasks_review_state_check" CHECK ("tech_tasks"."review_state" IN ('','REVIEW_REQUIRED','CHANGES_REQUESTED','APPROVED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_tasks" ADD CONSTRAINT "tech_tasks_merge_state_check" CHECK ("tech_tasks"."merge_state" IN ('','MERGEABLE','CONFLICT','MERGED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tech_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"source_task_id" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"created_by_agent_id" text,
	"created_by_agent_key" text DEFAULT '' NOT NULL,
	"provider" text DEFAULT '' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_output" jsonb,
	"error" text DEFAULT '' NOT NULL,
	"decided_by" text,
	"decided_by_name" text DEFAULT '' NOT NULL,
	"decided_at" timestamp with time zone,
	"decision_note" text DEFAULT '' NOT NULL,
	"superseded_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tech_proposal_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL,
	"key" text NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"task_type" text DEFAULT 'BUGFIX' NOT NULL,
	"module" text DEFAULT 'PLATFORM' NOT NULL,
	"suggested_priority" text DEFAULT 'P2' NOT NULL,
	"suggested_risk" text DEFAULT 'R0' NOT NULL,
	"risk_explanation" text DEFAULT '' NOT NULL,
	"suggested_agent_key" text DEFAULT '' NOT NULL,
	"depends_on_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"needs_human_decision" boolean DEFAULT false NOT NULL,
	"human_decision_note" text DEFAULT '' NOT NULL,
	"applied_task_id" text,
	"applied_risk" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "tech_proposals" ADD CONSTRAINT "tech_proposals_source_task_id_tech_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tech_tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_proposals" ADD CONSTRAINT "tech_proposals_created_by_agent_id_tech_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."tech_agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_proposals" ADD CONSTRAINT "tech_proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_proposals" ADD CONSTRAINT "tech_proposals_superseded_by_id_tech_proposals_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."tech_proposals"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_proposal_tasks" ADD CONSTRAINT "tech_proposal_tasks_proposal_id_tech_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."tech_proposals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_proposal_tasks" ADD CONSTRAINT "tech_proposal_tasks_applied_task_id_tech_tasks_id_fk" FOREIGN KEY ("applied_task_id") REFERENCES "public"."tech_tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "tech_proposals" ADD CONSTRAINT "tech_proposals_status_check" CHECK ("tech_proposals"."status" IN ('DRAFT','READY_FOR_REVIEW','APPROVED','REJECTED','SUPERSEDED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- Đã quyết thì phải biết LÚC NÀO. Một bản APPROVED không mốc là một quyết định không ai chịu trách nhiệm.
DO $$ BEGIN
	ALTER TABLE "tech_proposals" ADD CONSTRAINT "tech_proposals_decided_check" CHECK ("tech_proposals"."status" NOT IN ('APPROVED','REJECTED') OR "tech_proposals"."decided_at" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- Từ chối mà không nói vì sao thì lần lập lại kế hoạch sau lặp đúng sai lầm cũ.
DO $$ BEGIN
	ALTER TABLE "tech_proposals" ADD CONSTRAINT "tech_proposals_reject_reason_check" CHECK ("tech_proposals"."status" <> 'REJECTED' OR length(btrim("tech_proposals"."decision_note")) >= 10);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_proposal_tasks" ADD CONSTRAINT "tech_proposal_tasks_priority_check" CHECK ("tech_proposal_tasks"."suggested_priority" IN ('P0','P1','P2','P3'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_proposal_tasks" ADD CONSTRAINT "tech_proposal_tasks_risk_check" CHECK ("tech_proposal_tasks"."suggested_risk" IN ('R0','R1','R2'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tech_proposal_tasks" ADD CONSTRAINT "tech_proposal_tasks_applied_risk_check" CHECK ("tech_proposal_tasks"."applied_risk" IN ('','R0','R1','R2'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tech_proposals_source_idx" ON "tech_proposals" USING btree ("source_task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_proposals_status_idx" ON "tech_proposals" USING btree ("status","created_at");--> statement-breakpoint
-- Khoá tự nhiên: một khoá `T1` chỉ xuất hiện MỘT lần trong một bản kế hoạch, nếu không
-- `depends_on_keys` trỏ vào chỗ nhập nhằng và đồ thị phụ thuộc mất nghĩa.
CREATE UNIQUE INDEX IF NOT EXISTS "tech_proposal_tasks_key_uq" ON "tech_proposal_tasks" USING btree ("proposal_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_proposal_tasks_applied_idx" ON "tech_proposal_tasks" USING btree ("applied_task_id");
