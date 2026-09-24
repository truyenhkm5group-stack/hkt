-- ═══════════ VÒNG MẪU QUẢNG CÁO — Nấc 4 (NỘI DUNG) của phòng Marketing AI ═══════════
--
-- Đặc tả: `docs/creative-loop.md`. Hợp đồng: `lib/constants/creative-loop.ts`.
--
-- THUẦN BỔ SUNG: bảy bảng mới, không đụng một dòng hay một cột nào của bảng đã có. Không bảng nào
-- ở đây là nguồn của tiền — chi quảng cáo vẫn là `ad_spends` (hạt `AD`), kết quả đơn vẫn là
-- `ORDER_OUTCOME`. Không backfill: sổ bắt đầu rỗng (mục 8.8).

CREATE TABLE IF NOT EXISTS "creative_images" (
  "id" text PRIMARY KEY NOT NULL,
  "sha256" text NOT NULL,
  "content_type" text DEFAULT 'image/jpeg' NOT NULL,
  "bytes" integer DEFAULT 0 NOT NULL,
  "width" integer,
  "height" integer,
  "data" text DEFAULT '' NOT NULL,
  "purged_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "creative_images_purge_check" CHECK ("creative_images"."purged_at" IS NULL OR "creative_images"."data" = '')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creative_images_sha_idx" ON "creative_images" ("sha256");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "creative_sources" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "product_id" text,
  "title" text DEFAULT '' NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "source_url" text DEFAULT '' NOT NULL,
  "image_id" text,
  "genes" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "vision_summary" text DEFAULT '' NOT NULL,
  "vision_model" text DEFAULT '' NOT NULL,
  "vision_at" timestamp with time zone,
  "active" boolean DEFAULT true NOT NULL,
  "created_by_user_id" text,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "creative_sources_kind_check" CHECK ("creative_sources"."kind" IN ('PRODUCT_PHOTO', 'MANUAL', 'SPY', 'RND')),
  CONSTRAINT "creative_sources_product_photo_check" CHECK ("creative_sources"."kind" <> 'PRODUCT_PHOTO' OR "creative_sources"."product_id" IS NOT NULL)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_sources" ADD CONSTRAINT "creative_sources_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_sources" ADD CONSTRAINT "creative_sources_image_id_creative_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."creative_images"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_sources" ADD CONSTRAINT "creative_sources_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creative_sources_kind_idx" ON "creative_sources" ("kind","active");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creative_sources_product_idx" ON "creative_sources" ("product_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "creative_batches" (
  "id" text PRIMARY KEY NOT NULL,
  "batch_day" text NOT NULL,
  "status" text DEFAULT 'PLANNED' NOT NULL,
  "slot_count" integer DEFAULT 0 NOT NULL,
  "start_at" timestamp with time zone NOT NULL,
  "end_at" timestamp with time zone NOT NULL,
  "approval_deadline" timestamp with time zone NOT NULL,
  "plan" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "config_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "rule_version" integer NOT NULL,
  "error" text DEFAULT '' NOT NULL,
  "approval_digest" text DEFAULT '' NOT NULL,
  "approved_by_user_id" text,
  "approved_by_name" text DEFAULT '' NOT NULL,
  "approved_at" timestamp with time zone,
  "published_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "creative_batches_status_check" CHECK ("creative_batches"."status" IN ('PLANNED', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED', 'EXPIRED', 'REJECTED', 'FAILED')),
  CONSTRAINT "creative_batches_day_format_check" CHECK ("creative_batches"."batch_day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  CONSTRAINT "creative_batches_approval_check" CHECK ("creative_batches"."status" NOT IN ('APPROVED', 'PUBLISHED') OR ("creative_batches"."approved_at" IS NOT NULL AND "creative_batches"."approval_digest" <> ''))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_batches" ADD CONSTRAINT "creative_batches_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "creative_batches_day_uq" ON "creative_batches" ("batch_day");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creative_batches_status_idx" ON "creative_batches" ("status");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "creative_variants" (
  "id" text PRIMARY KEY NOT NULL,
  "batch_id" text NOT NULL,
  "slot" integer NOT NULL,
  "mode" text NOT NULL,
  "product_id" text,
  "product_photo_source_id" text,
  "inspiration_source_id" text,
  "parent_variant_id" text,
  "genes" jsonb NOT NULL,
  "genes_version" integer NOT NULL,
  "mutated_gene" text DEFAULT '' NOT NULL,
  "why" text DEFAULT '' NOT NULL,
  "image_prompt" text DEFAULT '' NOT NULL,
  "primary_text" text DEFAULT '' NOT NULL,
  "headline" text DEFAULT '' NOT NULL,
  "writer_model" text DEFAULT '' NOT NULL,
  "writer_cost_usd" text DEFAULT '' NOT NULL,
  "image_id" text,
  "gen_model" text DEFAULT '' NOT NULL,
  "gen_cost_usd" text DEFAULT '' NOT NULL,
  "gen_error" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'PLANNED' NOT NULL,
  "reject_reason" text DEFAULT '' NOT NULL,
  "rejected_by_user_id" text,
  "fb_image_hash" text DEFAULT '' NOT NULL,
  "fb_creative_id" text DEFAULT '' NOT NULL,
  "fb_post_id" text DEFAULT '' NOT NULL,
  "fb_adset_id" text,
  "fb_ad_id" text,
  "committed_budget_vnd" integer,
  "published_at" timestamp with time zone,
  "paused_at" timestamp with time zone,
  "pause_reason" text DEFAULT '' NOT NULL,
  "library_at" timestamp with time zone,
  "library_orders" integer,
  "lost_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "creative_variants_mode_check" CHECK ("creative_variants"."mode" IN ('EXPLOIT', 'EXPLORE')),
  CONSTRAINT "creative_variants_status_check" CHECK ("creative_variants"."status" IN ('PLANNED', 'GENERATED', 'GEN_FAILED', 'REJECTED', 'LIVE', 'PAUSED', 'ENDED', 'PUBLISH_FAILED')),
  CONSTRAINT "creative_variants_live_check" CHECK ("creative_variants"."status" NOT IN ('LIVE', 'PAUSED', 'ENDED') OR "creative_variants"."fb_ad_id" IS NOT NULL),
  CONSTRAINT "creative_variants_library_check" CHECK ("creative_variants"."library_at" IS NULL OR "creative_variants"."library_orders" IS NOT NULL)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_batch_id_creative_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."creative_batches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_product_photo_source_id_creative_sources_id_fk" FOREIGN KEY ("product_photo_source_id") REFERENCES "public"."creative_sources"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_inspiration_source_id_creative_sources_id_fk" FOREIGN KEY ("inspiration_source_id") REFERENCES "public"."creative_sources"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_parent_variant_id_creative_variants_id_fk" FOREIGN KEY ("parent_variant_id") REFERENCES "public"."creative_variants"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_image_id_creative_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."creative_images"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_rejected_by_user_id_users_id_fk" FOREIGN KEY ("rejected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "creative_variants_batch_slot_uq" ON "creative_variants" ("batch_id","slot");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "creative_variants_fb_ad_uq" ON "creative_variants" ("fb_ad_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creative_variants_status_idx" ON "creative_variants" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creative_variants_product_idx" ON "creative_variants" ("product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creative_variants_library_idx" ON "creative_variants" ("library_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "creative_fb_actions" (
  "id" text PRIMARY KEY NOT NULL,
  "action_day" text NOT NULL,
  "batch_id" text,
  "variant_id" text,
  "action" text NOT NULL,
  "outcome" text NOT NULL,
  "denial" text DEFAULT '' NOT NULL,
  "detail" text DEFAULT '' NOT NULL,
  "target_id" text DEFAULT '' NOT NULL,
  "amount_vnd" integer,
  "request" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "actor_user_id" text,
  "actor_email" text DEFAULT '' NOT NULL,
  "mode" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "creative_fb_actions_action_check" CHECK ("creative_fb_actions"."action" IN ('UPLOAD_IMAGE', 'CREATE_CREATIVE', 'CREATE_ADSET', 'CREATE_AD', 'PAUSE_ADSET', 'EXTEND_ADSET')),
  CONSTRAINT "creative_fb_actions_outcome_check" CHECK ("creative_fb_actions"."outcome" IN ('APPLIED', 'DENIED', 'FAILED')),
  CONSTRAINT "creative_fb_actions_denial_check" CHECK ("creative_fb_actions"."outcome" <> 'APPLIED' OR "creative_fb_actions"."denial" = ''),
  CONSTRAINT "creative_fb_actions_day_format_check" CHECK ("creative_fb_actions"."action_day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_fb_actions" ADD CONSTRAINT "creative_fb_actions_batch_id_creative_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."creative_batches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_fb_actions" ADD CONSTRAINT "creative_fb_actions_variant_id_creative_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."creative_variants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_fb_actions" ADD CONSTRAINT "creative_fb_actions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creative_fb_actions_day_idx" ON "creative_fb_actions" ("action_day","action","outcome");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creative_fb_actions_variant_idx" ON "creative_fb_actions" ("variant_id","created_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "creative_verdicts" (
  "id" text PRIMARY KEY NOT NULL,
  "verdict_day" text NOT NULL,
  "variant_id" text NOT NULL,
  "verdict" text NOT NULL,
  "reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "rule_version" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "creative_verdicts_verdict_check" CHECK ("creative_verdicts"."verdict" IN ('PENDING', 'RUNNING', 'AWAITING_ORDERS', 'KILL', 'PROMISING', 'WIN', 'LOSE', 'UNJUDGED'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_verdicts" ADD CONSTRAINT "creative_verdicts_variant_id_creative_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."creative_variants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "creative_verdicts_day_variant_uq" ON "creative_verdicts" ("verdict_day","variant_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "creative_learnings" (
  "id" text PRIMARY KEY NOT NULL,
  "learning_day" text NOT NULL,
  "gene_stats" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "observations" integer DEFAULT 0 NOT NULL,
  "relative_observations" integer DEFAULT 0 NOT NULL,
  "narrative" text DEFAULT '' NOT NULL,
  "narrative_model" text DEFAULT '' NOT NULL,
  "rule_version" integer NOT NULL,
  "genes_version" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "creative_learnings_day_uq" ON "creative_learnings" ("learning_day");
