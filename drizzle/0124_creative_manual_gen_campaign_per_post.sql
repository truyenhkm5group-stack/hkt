-- 0124 · Vòng mẫu: gen ảnh bằng tay · tên chiến dịch / nhóm / quảng cáo sửa được · MỖI BÀI MỘT CHIẾN DỊCH
-- (chủ shop chốt 25/09/2026, docs/creative-loop.md §5i).
--
-- Viết tay, idempotent (AGENTS.md mục 4 — không dùng db:generate). Thuần bổ sung:
--  · `creative_variants` thêm tên chiến dịch · nhóm · quảng cáo (rỗng = mẫu của lô cũ, đăng với tên
--    `VM <ngày> #<ô>` như trước — phiếu duyệt của lô cũ tính lại vẫn khớp vì khoá tên VẮNG khỏi digest khi
--    cả ba rỗng), số thứ tự trong ngày đăng (duy nhất trong lô), id CHIẾN DỊCH RIÊNG của bài, và mốc
--    "đang gửi bước nào" để một phản hồi rơi mất không đẻ ra đối tượng thứ hai.
--  · Sổ `creative_fb_actions` nhận thêm hai hành động `CREATE_CAMPAIGN` · `ACTIVATE_CAMPAIGN`. Mọi dòng cũ
--    mang một trong mười hai hành động cũ — không dòng nào vi phạm ràng buộc mới.
--  · Hai bảng mới của gen tay: lượt gen (`creative_manual_gens`) và từng ảnh (`creative_manual_gen_images`).
-- Không backfill (mục 35): mẫu cũ chưa từng có tên / chiến dịch riêng, NULL / rỗng là đúng sự thật.
ALTER TABLE "creative_variants" ADD COLUMN IF NOT EXISTS "campaign_name" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "creative_variants" ADD COLUMN IF NOT EXISTS "adset_name" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "creative_variants" ADD COLUMN IF NOT EXISTS "ad_name" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "creative_variants" ADD COLUMN IF NOT EXISTS "name_seq" integer;
--> statement-breakpoint
ALTER TABLE "creative_variants" ADD COLUMN IF NOT EXISTS "fb_campaign_id" text;
--> statement-breakpoint
ALTER TABLE "creative_variants" ADD COLUMN IF NOT EXISTS "fb_pending_step" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "creative_variants" ADD COLUMN IF NOT EXISTS "fb_pending_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "creative_variants_batch_name_seq_uq" ON "creative_variants" ("batch_id","name_seq") WHERE "creative_variants"."name_seq" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "creative_fb_actions" DROP CONSTRAINT IF EXISTS "creative_fb_actions_action_check";
--> statement-breakpoint
ALTER TABLE "creative_fb_actions" ADD CONSTRAINT "creative_fb_actions_action_check" CHECK ("creative_fb_actions"."action" IN ('UPLOAD_IMAGE', 'CREATE_CREATIVE', 'CREATE_ADSET', 'CREATE_AD', 'PAUSE_ADSET', 'EXTEND_ADSET', 'CREATE_CAMPAIGN', 'ACTIVATE_CAMPAIGN', 'COPY_SCALE_CAMPAIGN', 'CREATE_SCALE_CREATIVE', 'SET_SCALE_AD_CREATIVE', 'SET_SCALE_BUDGET', 'ACTIVATE_SCALE', 'PAUSE_SCALE'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "creative_manual_gens" (
  "id" text PRIMARY KEY NOT NULL,
  "product_id" text,
  "product_photo_source_id" text,
  "own_ad_source_id" text,
  "idea" text DEFAULT '' NOT NULL,
  "requested" integer NOT NULL,
  "model" text NOT NULL,
  "size" text NOT NULL,
  "quality" text NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "created_by_user_id" text,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_manual_gens" ADD CONSTRAINT "creative_manual_gens_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_manual_gens" ADD CONSTRAINT "creative_manual_gens_product_photo_source_id_creative_sources_id_fk" FOREIGN KEY ("product_photo_source_id") REFERENCES "public"."creative_sources"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_manual_gens" ADD CONSTRAINT "creative_manual_gens_own_ad_source_id_creative_sources_id_fk" FOREIGN KEY ("own_ad_source_id") REFERENCES "public"."creative_sources"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_manual_gens" ADD CONSTRAINT "creative_manual_gens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creative_manual_gens_created_idx" ON "creative_manual_gens" ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "creative_manual_gen_images" (
  "id" text PRIMARY KEY NOT NULL,
  "gen_id" text NOT NULL,
  "seq" integer NOT NULL,
  "genes" jsonb NOT NULL,
  "prompt" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'PLANNED' NOT NULL,
  "image_id" text,
  "cost_usd" text DEFAULT '' NOT NULL,
  "error" text DEFAULT '' NOT NULL,
  "claimed_at" timestamp with time zone,
  "drawn_at" timestamp with time zone,
  "headline" text DEFAULT '' NOT NULL,
  "primary_text" text DEFAULT '' NOT NULL,
  "caption_model" text DEFAULT '' NOT NULL,
  "caption_error" text DEFAULT '' NOT NULL,
  "reviewed_by_user_id" text,
  "reviewed_by_name" text DEFAULT '' NOT NULL,
  "reviewed_at" timestamp with time zone,
  "reject_reason" text DEFAULT '' NOT NULL,
  "variant_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "creative_manual_gen_images_status_check" CHECK ("creative_manual_gen_images"."status" IN ('PLANNED', 'DRAWING', 'GENERATED', 'GEN_FAILED', 'APPROVED', 'REJECTED', 'PROMOTED')),
  CONSTRAINT "creative_manual_gen_images_image_check" CHECK ("creative_manual_gen_images"."status" NOT IN ('GENERATED', 'APPROVED', 'PROMOTED') OR "creative_manual_gen_images"."image_id" IS NOT NULL),
  CONSTRAINT "creative_manual_gen_images_promoted_check" CHECK ("creative_manual_gen_images"."status" <> 'PROMOTED' OR "creative_manual_gen_images"."variant_id" IS NOT NULL)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_manual_gen_images" ADD CONSTRAINT "creative_manual_gen_images_gen_id_creative_manual_gens_id_fk" FOREIGN KEY ("gen_id") REFERENCES "public"."creative_manual_gens"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_manual_gen_images" ADD CONSTRAINT "creative_manual_gen_images_image_id_creative_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."creative_images"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_manual_gen_images" ADD CONSTRAINT "creative_manual_gen_images_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_manual_gen_images" ADD CONSTRAINT "creative_manual_gen_images_variant_id_creative_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."creative_variants"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "creative_manual_gen_images_gen_seq_uq" ON "creative_manual_gen_images" ("gen_id","seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creative_manual_gen_images_status_idx" ON "creative_manual_gen_images" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creative_manual_gen_images_image_idx" ON "creative_manual_gen_images" ("image_id");
