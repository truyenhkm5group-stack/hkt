-- Vòng mẫu: THIẾT KẾ SẢN PHẨM MỚI + luật riêng theo mã cho ô mockup (chủ shop 24/09/2026; docs/creative-loop.md §5f).
--
-- Thuần bổ sung, viết tay và idempotent (AGENTS.md mục 4 — không dùng db:generate):
--  · bảng `product_dna` — DNA đọc từ ảnh của sản phẩm đang có (một dòng mỗi mã);
--  · bảng `design_concepts` — thiết kế mới, mã `TK-YYMMDD-NN`;
--  · `creative_variants` thêm `design_concept_id` (ô DESIGN nối về thiết kế) và `rules_snapshot` (luật riêng
--    của ô mockup, chụp lúc lập lô); nới `creative_variants_mode_check` thêm 'DESIGN'.
-- Không đụng dòng nào đã có, không backfill: mọi ô cũ không phải ô thiết kế và không có luật riêng, nên NULL
-- là đúng sự thật (mục 35).
CREATE TABLE IF NOT EXISTS "product_dna" (
  "id" text PRIMARY KEY NOT NULL,
  "product_id" text NOT NULL,
  "dna" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "dna_version" integer NOT NULL,
  "image_source" text DEFAULT '' NOT NULL,
  "image_sha256" text DEFAULT '' NOT NULL,
  "summary" text DEFAULT '' NOT NULL,
  "model" text DEFAULT '' NOT NULL,
  "error" text DEFAULT '' NOT NULL,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_dna_product_uq" ON "product_dna" ("product_id");
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "product_dna" ADD CONSTRAINT "product_dna_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "design_concepts" (
  "id" text PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "batch_id" text,
  "dna" jsonb NOT NULL,
  "dna_version" integer NOT NULL,
  "parent_product_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  "why" text DEFAULT '' NOT NULL,
  "image_id" text,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "price_vnd" integer,
  "production_by_user_id" text,
  "production_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "design_concepts_status_check" CHECK ("design_concepts"."status" IN ('DRAFT', 'TESTING', 'WIN', 'LOSE', 'PRODUCTION')),
  CONSTRAINT "design_concepts_code_check" CHECK ("design_concepts"."code" ~ '^TK-[0-9]{6}-[0-9]{2,}$'),
  CONSTRAINT "design_concepts_price_check" CHECK ("design_concepts"."price_vnd" IS NULL OR "design_concepts"."price_vnd" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "design_concepts_code_uq" ON "design_concepts" ("code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "design_concepts_status_idx" ON "design_concepts" ("status","created_at");
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "design_concepts" ADD CONSTRAINT "design_concepts_batch_id_creative_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."creative_batches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "design_concepts" ADD CONSTRAINT "design_concepts_image_id_creative_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."creative_images"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "design_concepts" ADD CONSTRAINT "design_concepts_production_by_user_id_users_id_fk" FOREIGN KEY ("production_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "creative_variants" ADD COLUMN IF NOT EXISTS "design_concept_id" text;
--> statement-breakpoint
ALTER TABLE "creative_variants" ADD COLUMN IF NOT EXISTS "rules_snapshot" jsonb;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_design_concept_id_design_concepts_id_fk" FOREIGN KEY ("design_concept_id") REFERENCES "public"."design_concepts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creative_variants_design_idx" ON "creative_variants" ("design_concept_id");
--> statement-breakpoint
ALTER TABLE "creative_variants" DROP CONSTRAINT IF EXISTS "creative_variants_mode_check";
--> statement-breakpoint
ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_mode_check" CHECK ("creative_variants"."mode" IN ('EXPLOIT', 'EXPLORE', 'MANUAL', 'DESIGN'));
