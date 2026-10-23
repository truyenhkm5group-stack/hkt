-- 0256 · TÌM HÀNG NGUỒN — KHO MẪU NHẬP TAY (SRC-3, docs/tech/ai-sourcing.md §3.1, Tech Lead duyệt 23/10/2026).
--
-- Chỉ TẠO ba bảng mới ở CSDL của tổ chức, không đổi bảng nào mã đang đọc, không gieo dòng nào. Idempotent.
-- Tiền CNY là số nguyên FEN trong jsonb `tiers`; «cũ» không lưu (tính lúc đọc từ captured_at / facts_as_of).
CREATE TABLE IF NOT EXISTS "sourcing_suppliers" (
  "id" text PRIMARY KEY NOT NULL,
  "platform" text NOT NULL,
  "shop_url" text NOT NULL,
  "name" text DEFAULT '' NOT NULL,
  "years_on_platform" integer,
  "rating_x100" integer,
  "response_rate_bp" integer,
  "verified" boolean,
  "ship_from" text,
  "facts_source" text DEFAULT 'MANUAL' NOT NULL,
  "facts_as_of" timestamp with time zone,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sourcing_suppliers_platform_check" CHECK ("platform" IN ('1688', 'ALIBABA', 'TAOBAO', 'OTHER')),
  CONSTRAINT "sourcing_suppliers_facts_source_check" CHECK ("facts_source" IN ('MANUAL', 'API', 'UNKNOWN')),
  CONSTRAINT "sourcing_suppliers_years_check" CHECK ("years_on_platform" IS NULL OR "years_on_platform" BETWEEN 0 AND 100),
  CONSTRAINT "sourcing_suppliers_rating_check" CHECK ("rating_x100" IS NULL OR "rating_x100" BETWEEN 0 AND 500),
  CONSTRAINT "sourcing_suppliers_response_check" CHECK ("response_rate_bp" IS NULL OR "response_rate_bp" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sourcing_suppliers_shop_url_uq" ON "sourcing_suppliers" USING btree ("shop_url");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_suppliers" ADD CONSTRAINT "sourcing_suppliers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sourcing_offers" (
  "id" text PRIMARY KEY NOT NULL,
  "platform" text NOT NULL,
  "offer_id" text,
  "canonical_url" text NOT NULL,
  "source_url" text NOT NULL,
  "title_zh" text DEFAULT '' NOT NULL,
  "title_vi" text DEFAULT '' NOT NULL,
  "image_url" text,
  "image_key" text,
  "supplier_id" text,
  "data_status" text DEFAULT 'MANUAL' NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "archived_at" timestamp with time zone,
  CONSTRAINT "sourcing_offers_platform_check" CHECK ("platform" IN ('1688', 'ALIBABA', 'TAOBAO', 'OTHER')),
  CONSTRAINT "sourcing_offers_data_status_check" CHECK ("data_status" IN ('MANUAL', 'API', 'UNKNOWN'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sourcing_offers_canonical_url_uq" ON "sourcing_offers" USING btree ("canonical_url");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sourcing_offers_platform_offer_uq" ON "sourcing_offers" USING btree ("platform", "offer_id") WHERE "offer_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sourcing_offers_image_key_idx" ON "sourcing_offers" USING btree ("image_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sourcing_offers_supplier_idx" ON "sourcing_offers" USING btree ("supplier_id");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_offers" ADD CONSTRAINT "sourcing_offers_supplier_id_sourcing_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."sourcing_suppliers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_offers" ADD CONSTRAINT "sourcing_offers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sourcing_offer_snapshots" (
  "id" text PRIMARY KEY NOT NULL,
  "offer_id" text NOT NULL,
  "captured_at" timestamp with time zone DEFAULT now() NOT NULL,
  "tiers" jsonb NOT NULL,
  "moq" integer,
  "skus" jsonb,
  "source" text DEFAULT 'MANUAL' NOT NULL,
  "captured_by" text,
  CONSTRAINT "sourcing_offer_snapshots_source_check" CHECK ("source" IN ('MANUAL', 'API', 'UNKNOWN')),
  CONSTRAINT "sourcing_offer_snapshots_tiers_check" CHECK (jsonb_typeof("tiers") = 'array' AND jsonb_array_length("tiers") BETWEEN 1 AND 8),
  CONSTRAINT "sourcing_offer_snapshots_moq_check" CHECK ("moq" IS NULL OR "moq" >= 1)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sourcing_offer_snapshots_offer_idx" ON "sourcing_offer_snapshots" USING btree ("offer_id", "captured_at");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_offer_snapshots" ADD CONSTRAINT "sourcing_offer_snapshots_offer_id_sourcing_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."sourcing_offers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_offer_snapshots" ADD CONSTRAINT "sourcing_offer_snapshots_captured_by_users_id_fk" FOREIGN KEY ("captured_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
