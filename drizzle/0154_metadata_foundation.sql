-- 0154 · LỚP METADATA & TUỲ BIẾN THEO TỔ CHỨC (docs/platform/phase-2-contracts.md mục 2).
--
--  · CHỈ THÊM: bảy bảng mới, không bảng nghiệp vụ nào bị đổi, không dữ liệu nào được chèn. Chạy trong
--    CSDL của MỌI tổ chức (cùng bộ migration) — metadata là dữ liệu của tổ chức, silo cô lập chúng.
--  · Giá trị custom nằm ở MỘT dòng mở rộng mỗi bản ghi (`custom_values`), không phải cột trên bảng
--    nghiệp vụ: đồng bộ Pancake upsert cả dòng `customers` / `products` mà không chạm bảng này.
--  · Tổ chức chưa cấu hình gì ⇒ các bảng rỗng ⇒ mọi trang chạy y như trước (form / danh sách MẶC ĐỊNH).
-- Viết tay và idempotent như 0033–0153.

CREATE TABLE IF NOT EXISTS "meta_custom_fields" (
  "id" text PRIMARY KEY NOT NULL,
  "object_key" text NOT NULL,
  "field_key" text NOT NULL,
  "label" text NOT NULL,
  "field_type" text NOT NULL,
  "required" boolean DEFAULT false NOT NULL,
  "default_value" jsonb,
  "options" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "validation" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "transitions" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "relation_object" text,
  "help_text" text,
  "view_permission" text,
  "edit_permission" text,
  "listable" boolean DEFAULT true NOT NULL,
  "filterable" boolean DEFAULT false NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "meta_custom_fields_status_check" CHECK ("status" in ('ACTIVE','ARCHIVED')),
  CONSTRAINT "meta_custom_fields_key_check" CHECK ("field_key" ~ '^[a-z][a-z0-9_]{1,40}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "meta_custom_fields_object_key_uq" ON "meta_custom_fields" ("object_key","field_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "custom_values" (
  "object_key" text NOT NULL,
  "record_id" text NOT NULL,
  "values" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "custom_values_pk" ON "custom_values" ("object_key","record_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_values_values_gin" ON "custom_values" USING gin ("values" jsonb_path_ops);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "custom_files" (
  "id" text PRIMARY KEY NOT NULL,
  "object_key" text NOT NULL,
  "record_id" text NOT NULL,
  "field_key" text NOT NULL,
  "filename" text NOT NULL,
  "mime" text NOT NULL,
  "size" integer NOT NULL,
  "data" bytea NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_files_record_idx" ON "custom_files" ("object_key","record_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "meta_forms" (
  "object_key" text NOT NULL,
  "form_key" text NOT NULL,
  "draft" jsonb,
  "published" jsonb,
  "published_version" integer DEFAULT 0 NOT NULL,
  "published_at" timestamp with time zone,
  "published_by" text,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "meta_forms_pk" ON "meta_forms" ("object_key","form_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "meta_list_views" (
  "object_key" text NOT NULL,
  "view_key" text NOT NULL,
  "draft" jsonb,
  "published" jsonb,
  "published_version" integer DEFAULT 0 NOT NULL,
  "published_at" timestamp with time zone,
  "published_by" text,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "meta_list_views_pk" ON "meta_list_views" ("object_key","view_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "meta_status_overrides" (
  "object_key" text NOT NULL,
  "field_key" text NOT NULL,
  "value" text NOT NULL,
  "label" text,
  "position" integer,
  "active" boolean DEFAULT true NOT NULL,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "meta_status_overrides_pk" ON "meta_status_overrides" ("object_key","field_key","value");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "meta_config_versions" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "object_key" text NOT NULL,
  "config_key" text NOT NULL,
  "version" integer NOT NULL,
  "snapshot" jsonb NOT NULL,
  "actor_id" text,
  "actor_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meta_config_versions_key_idx" ON "meta_config_versions" ("kind","object_key","config_key","version");
