-- Phán quyết review cho từng lượt chạy agent: cơ sở của chuỗi "lượt chạy sạch".
--
-- Tiêu chí mở vai QA — "5 lượt chạy sạch liên tiếp" — trước đây chỉ là một câu chú thích trong
-- lib/constants/agent-scopes.ts. Không ai đếm được vì không có chỗ ghi lượt nào sạch.
--
-- NULL = CHƯA REVIEW, không phải một giá trị thứ ba. KHÔNG backfill (AGENTS.md mục 8.8):
-- không ai biết lượt cũ nào sạch, và đoán là bịa ra lịch sử.
ALTER TABLE "tech_agent_runs" ADD COLUMN IF NOT EXISTS "review_verdict" text;
--> statement-breakpoint
ALTER TABLE "tech_agent_runs" ADD COLUMN IF NOT EXISTS "review_note" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tech_agent_runs" ADD COLUMN IF NOT EXISTS "reviewed_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "tech_agent_runs" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tech_agent_runs" ADD CONSTRAINT "tech_agent_runs_reviewed_by_user_id_users_id_fk"
    FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "tech_agent_runs" DROP CONSTRAINT IF EXISTS "tech_agent_runs_review_verdict_check";
--> statement-breakpoint
ALTER TABLE "tech_agent_runs" ADD CONSTRAINT "tech_agent_runs_review_verdict_check" CHECK ("tech_agent_runs"."review_verdict" IS NULL OR "tech_agent_runs"."review_verdict" IN ('SACH','CO_LOI'));
--> statement-breakpoint
ALTER TABLE "tech_agent_runs" DROP CONSTRAINT IF EXISTS "tech_agent_runs_review_attrib_check";
--> statement-breakpoint
ALTER TABLE "tech_agent_runs" ADD CONSTRAINT "tech_agent_runs_review_attrib_check" CHECK ("tech_agent_runs"."review_verdict" IS NULL OR "tech_agent_runs"."reviewed_at" IS NOT NULL);
