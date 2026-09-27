-- 0155 · VIDEO SCALE CHO MÃ WIN — dữ liệu + hàng đợi việc + tệp video (chủ shop 27/09/2026).
--
-- Từ ảnh sản phẩm THẬT của một mã win: máy viết kịch bản theo góc bán, sinh clip 9:16 bằng Veo (Gemini API), hậu kỳ
-- bằng ffmpeg, kiểm chất lượng, rồi chờ người duyệt. Đặc tả: `docs/video-scale.md`. Hợp đồng: `lib/constants/video-scale.ts`.
--
--  · `video_scale_skus` — cấu hình theo mã (chế độ duyệt).
--  · `video_scale_runs` — một lượt "Tạo chiến dịch media" (ảnh gốc người chọn, ảnh chụp cấu hình).
--  · `video_scale_variants` — một kịch bản + một bản hoàn chỉnh. CHECK: video QC loại không bao giờ ĐÃ DUYỆT; máy chỉ tự
--    duyệt video QC ĐẠT.
--  · `video_scale_jobs` — hàng đợi việc: khoá chống trùng, số lần thử, cầm việc có hạn, mã thao tác nhà cung cấp, dấu
--    "đang gửi" chống gọi tốn tiền hai lần, tiền từng lượt + tiền giữ chỗ trong trần ngày.
--  · `video_scale_assets` + `video_scale_asset_chunks` — tệp trong CSDL, khúc bytea 2 MB (cùng lối tệp topic sản xuất).
--  · `video_scale_music` — nhạc CÓ QUYỀN sử dụng; bắt buộc khai nguồn / quyền.
--
-- Không backfill, không chạm bảng nào khác. Viết tay và idempotent như 0033–0154.

CREATE TABLE IF NOT EXISTS "video_scale_skus" (
  "product_id" text PRIMARY KEY NOT NULL,
  "review_mode" text DEFAULT 'MANUAL' NOT NULL,
  "updated_by_user_id" text,
  "updated_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "video_scale_skus_review_mode_check" CHECK ("review_mode" IN ('MANUAL', 'AUTO_ON_PASS'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_skus" ADD CONSTRAINT "video_scale_skus_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_skus" ADD CONSTRAINT "video_scale_skus_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_scale_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "product_id" text NOT NULL,
  "source_ids" jsonb NOT NULL,
  "status" text DEFAULT 'SCRIPTING' NOT NULL,
  "prompt_version" integer NOT NULL,
  "angle_vocab_version" integer NOT NULL,
  "variants_requested" integer NOT NULL,
  "angles_requested" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "config_snapshot" jsonb NOT NULL,
  "music_id" text,
  "brief" text DEFAULT '' NOT NULL,
  "script_model" text DEFAULT '' NOT NULL,
  "script_cost_usd" double precision,
  "is_test" boolean DEFAULT false NOT NULL,
  "error" text DEFAULT '' NOT NULL,
  "created_by_user_id" text,
  "created_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "video_scale_runs_status_check" CHECK ("status" IN ('SCRIPTING', 'PRODUCING', 'REVIEW', 'DONE', 'FAILED', 'CANCELLED')),
  CONSTRAINT "video_scale_runs_sources_check" CHECK (jsonb_typeof("source_ids") = 'array' AND jsonb_array_length("source_ids") > 0),
  CONSTRAINT "video_scale_runs_variants_check" CHECK ("variants_requested" BETWEEN 1 AND 6)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_runs" ADD CONSTRAINT "video_scale_runs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_runs" ADD CONSTRAINT "video_scale_runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_scale_runs_product_idx" ON "video_scale_runs" USING btree ("product_id","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_scale_assets" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "run_id" text,
  "variant_id" text,
  "content_type" text NOT NULL,
  "bytes" integer NOT NULL,
  "sha256" text NOT NULL,
  "duration_ms" integer,
  "width" integer,
  "height" integer,
  "chunk_count" integer NOT NULL,
  "status" text DEFAULT 'UPLOADING' NOT NULL,
  "is_test" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "purged_at" timestamp with time zone,
  CONSTRAINT "video_scale_assets_kind_check" CHECK ("kind" IN ('SOURCE_CLIP', 'VOICE', 'MUSIC', 'FINAL', 'THUMBNAIL')),
  CONSTRAINT "video_scale_assets_status_check" CHECK ("status" IN ('UPLOADING', 'READY', 'PURGED')),
  CONSTRAINT "video_scale_assets_size_check" CHECK ("bytes" > 0 AND "chunk_count" > 0),
  CONSTRAINT "video_scale_assets_ready_check" CHECK ("status" <> 'READY' OR "completed_at" IS NOT NULL)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_assets" ADD CONSTRAINT "video_scale_assets_run_id_video_scale_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."video_scale_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_scale_assets_variant_idx" ON "video_scale_assets" USING btree ("variant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_scale_asset_chunks" (
  "id" text PRIMARY KEY NOT NULL,
  "asset_id" text NOT NULL,
  "seq" integer NOT NULL,
  "data" bytea NOT NULL,
  CONSTRAINT "video_scale_asset_chunks_seq_check" CHECK ("seq" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_asset_chunks" ADD CONSTRAINT "video_scale_asset_chunks_asset_id_video_scale_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."video_scale_assets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "video_scale_asset_chunks_seq_uq" ON "video_scale_asset_chunks" USING btree ("asset_id","seq");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_scale_variants" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "product_id" text NOT NULL,
  "seq" integer NOT NULL,
  "angle" text NOT NULL,
  "angle_vocab_version" integer NOT NULL,
  "script" jsonb NOT NULL,
  "fingerprint" text DEFAULT '' NOT NULL,
  "source_id" text NOT NULL,
  "status" text DEFAULT 'SCRIPTED' NOT NULL,
  "qc_verdict" text,
  "qc" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "qc_at" timestamp with time zone,
  "final_asset_id" text,
  "thumbnail_asset_id" text,
  "duration_ms" integer,
  "reviewed_by_user_id" text,
  "reviewed_by" text DEFAULT '' NOT NULL,
  "reviewed_at" timestamp with time zone,
  "review_note" text DEFAULT '' NOT NULL,
  "auto_approved" boolean DEFAULT false NOT NULL,
  "is_test" boolean DEFAULT false NOT NULL,
  "error" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "video_scale_variants_status_check" CHECK ("status" IN ('SCRIPTED', 'GENERATING', 'RENDERING', 'QC', 'REVIEW', 'APPROVED', 'REJECTED', 'QC_FAILED', 'FAILED', 'CANCELLED')),
  CONSTRAINT "video_scale_variants_qc_check" CHECK ("qc_verdict" IS NULL OR "qc_verdict" IN ('PASS', 'FLAG', 'FAIL')),
  CONSTRAINT "video_scale_variants_approve_check" CHECK ("status" <> 'APPROVED' OR ("qc_verdict" IN ('PASS', 'FLAG') AND "final_asset_id" IS NOT NULL AND "reviewed_at" IS NOT NULL)),
  CONSTRAINT "video_scale_variants_auto_check" CHECK ("auto_approved" = false OR ("qc_verdict" = 'PASS' AND "reviewed_by_user_id" IS NULL))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_variants" ADD CONSTRAINT "video_scale_variants_run_id_video_scale_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."video_scale_runs"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_variants" ADD CONSTRAINT "video_scale_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_variants" ADD CONSTRAINT "video_scale_variants_final_asset_id_video_scale_assets_id_fk" FOREIGN KEY ("final_asset_id") REFERENCES "public"."video_scale_assets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_variants" ADD CONSTRAINT "video_scale_variants_thumbnail_asset_id_video_scale_assets_id_fk" FOREIGN KEY ("thumbnail_asset_id") REFERENCES "public"."video_scale_assets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_variants" ADD CONSTRAINT "video_scale_variants_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "video_scale_variants_run_seq_uq" ON "video_scale_variants" USING btree ("run_id","seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_scale_variants_product_idx" ON "video_scale_variants" USING btree ("product_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_scale_variants_status_idx" ON "video_scale_variants" USING btree ("status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_scale_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "run_id" text,
  "variant_id" text,
  "scene_index" integer,
  "idempotency_key" text NOT NULL,
  "status" text DEFAULT 'QUEUED' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer NOT NULL,
  "next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
  "locked_until" timestamp with time zone,
  "lock_token" text DEFAULT '' NOT NULL,
  "provider" text DEFAULT '' NOT NULL,
  "model" text DEFAULT '' NOT NULL,
  "provider_ref" text DEFAULT '' NOT NULL,
  "provider_pending_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "deadline_at" timestamp with time zone,
  "cost_usd" double precision,
  "cost_basis" text DEFAULT '' NOT NULL,
  "reserved_usd" double precision,
  "cost_day" text DEFAULT '' NOT NULL,
  "request" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "result" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error" text DEFAULT '' NOT NULL,
  "error_kind" text DEFAULT '' NOT NULL,
  "output_asset_id" text,
  "is_test" boolean DEFAULT false NOT NULL,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "video_scale_jobs_kind_check" CHECK ("kind" IN ('SCRIPT', 'CLIP', 'TTS', 'RENDER', 'QC')),
  CONSTRAINT "video_scale_jobs_status_check" CHECK ("status" IN ('QUEUED', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED')),
  CONSTRAINT "video_scale_jobs_error_kind_check" CHECK ("error_kind" IN ('', 'TRANSIENT', 'PERMANENT', 'AMBIGUOUS', 'TIMEOUT', 'BLOCKED')),
  CONSTRAINT "video_scale_jobs_cost_basis_check" CHECK ("cost_basis" IN ('', 'ESTIMATED')),
  CONSTRAINT "video_scale_jobs_attempts_check" CHECK ("attempts" >= 0 AND "max_attempts" >= 1)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_jobs" ADD CONSTRAINT "video_scale_jobs_run_id_video_scale_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."video_scale_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_jobs" ADD CONSTRAINT "video_scale_jobs_variant_id_video_scale_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."video_scale_variants"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_jobs" ADD CONSTRAINT "video_scale_jobs_output_asset_id_video_scale_assets_id_fk" FOREIGN KEY ("output_asset_id") REFERENCES "public"."video_scale_assets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_jobs" ADD CONSTRAINT "video_scale_jobs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "video_scale_jobs_idem_uq" ON "video_scale_jobs" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_scale_jobs_due_idx" ON "video_scale_jobs" USING btree ("status","next_run_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_scale_jobs_variant_idx" ON "video_scale_jobs" USING btree ("variant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_scale_jobs_cost_day_idx" ON "video_scale_jobs" USING btree ("cost_day");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_scale_music" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "license_note" text NOT NULL,
  "asset_id" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "uploaded_by_user_id" text,
  "uploaded_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "video_scale_music_license_check" CHECK (length(btrim("license_note")) >= 10),
  CONSTRAINT "video_scale_music_title_check" CHECK (length(btrim("title")) > 0)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_music" ADD CONSTRAINT "video_scale_music_asset_id_video_scale_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."video_scale_assets"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "video_scale_music" ADD CONSTRAINT "video_scale_music_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
