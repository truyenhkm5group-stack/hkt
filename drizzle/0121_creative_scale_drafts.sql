-- Vòng mẫu: scale mẫu thắng bằng chiến dịch NHÁP sao chép từ chiến dịch MẪU do người dựng
-- (docs/creative-loop.md §5f, chủ shop quyết 24/09/2026).
--
-- Thuần bổ sung, viết tay idempotent (AGENTS.md mục 4): một bảng mới (toàn bộ dòng sinh ra SAU
-- migration này — không backfill gì) và nới ràng buộc hành động của sổ ghi Facebook thêm sáu hành
-- động scale. Không đụng dòng nào đã có: mọi dòng cũ đều mang một trong sáu hành động cũ.
CREATE TABLE IF NOT EXISTS "creative_scale_drafts" (
  "id" text PRIMARY KEY NOT NULL,
  "variant_id" text NOT NULL,
  "batch_id" text,
  "kind" text NOT NULL,
  "status" text DEFAULT 'PROPOSED' NOT NULL,
  "proposed_verdict" text DEFAULT '' NOT NULL,
  "proposal_metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "source_campaign_id" text DEFAULT '' NOT NULL,
  "fb_campaign_id" text,
  "fb_adset_id" text,
  "fb_ad_id" text,
  "fb_creative_id" text,
  "budget_level" text DEFAULT '' NOT NULL,
  "daily_budget_vnd" integer,
  "currency" text DEFAULT 'VND' NOT NULL,
  "error" text DEFAULT '' NOT NULL,
  "copy_attempted_at" timestamp with time zone,
  "drafted_by_user_id" text,
  "drafted_by_name" text DEFAULT '' NOT NULL,
  "drafted_at" timestamp with time zone,
  "approved_by_user_id" text,
  "approved_by_name" text DEFAULT '' NOT NULL,
  "approved_at" timestamp with time zone,
  "paused_at" timestamp with time zone,
  "dismissed_by_user_id" text,
  "dismissed_at" timestamp with time zone,
  "notified_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "creative_scale_drafts_kind_check" CHECK ("creative_scale_drafts"."kind" IN ('PURCHASE_MESSAGING', 'LEADS')),
  CONSTRAINT "creative_scale_drafts_status_check" CHECK ("creative_scale_drafts"."status" IN ('PROPOSED', 'DRAFTING', 'DRAFT', 'ACTIVE', 'PAUSED', 'FAILED', 'DISMISSED')),
  CONSTRAINT "creative_scale_drafts_budget_check" CHECK ("creative_scale_drafts"."daily_budget_vnd" IS NULL OR ("creative_scale_drafts"."daily_budget_vnd" > 0 AND "creative_scale_drafts"."daily_budget_vnd" <= 500000)),
  CONSTRAINT "creative_scale_drafts_active_check" CHECK ("creative_scale_drafts"."status" NOT IN ('ACTIVE', 'PAUSED') OR ("creative_scale_drafts"."fb_campaign_id" IS NOT NULL AND "creative_scale_drafts"."approved_at" IS NOT NULL)),
  CONSTRAINT "creative_scale_drafts_draft_check" CHECK ("creative_scale_drafts"."status" <> 'DRAFT' OR ("creative_scale_drafts"."fb_campaign_id" IS NOT NULL AND "creative_scale_drafts"."fb_ad_id" IS NOT NULL AND "creative_scale_drafts"."fb_creative_id" IS NOT NULL AND "creative_scale_drafts"."daily_budget_vnd" IS NOT NULL))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_scale_drafts" ADD CONSTRAINT "creative_scale_drafts_variant_id_creative_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."creative_variants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_scale_drafts" ADD CONSTRAINT "creative_scale_drafts_batch_id_creative_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."creative_batches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_scale_drafts" ADD CONSTRAINT "creative_scale_drafts_drafted_by_user_id_users_id_fk" FOREIGN KEY ("drafted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_scale_drafts" ADD CONSTRAINT "creative_scale_drafts_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_scale_drafts" ADD CONSTRAINT "creative_scale_drafts_dismissed_by_user_id_users_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "creative_scale_drafts_variant_kind_uq" ON "creative_scale_drafts" ("variant_id","kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creative_scale_drafts_status_idx" ON "creative_scale_drafts" ("status");
--> statement-breakpoint
ALTER TABLE "creative_fb_actions" DROP CONSTRAINT IF EXISTS "creative_fb_actions_action_check";
--> statement-breakpoint
ALTER TABLE "creative_fb_actions" ADD CONSTRAINT "creative_fb_actions_action_check" CHECK ("creative_fb_actions"."action" IN ('UPLOAD_IMAGE', 'CREATE_CREATIVE', 'CREATE_ADSET', 'CREATE_AD', 'PAUSE_ADSET', 'EXTEND_ADSET', 'COPY_SCALE_CAMPAIGN', 'CREATE_SCALE_CREATIVE', 'SET_SCALE_AD_CREATIVE', 'SET_SCALE_BUDGET', 'ACTIVATE_SCALE', 'PAUSE_SCALE'));
