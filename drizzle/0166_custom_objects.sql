-- 0166 · ĐỐI TƯỢNG TUỲ BIẾN (docs/platform/phase-6-contracts.md mục 1).
--
--  · CHỈ THÊM hai bảng trong CSDL tổ chức: `meta_objects` (định nghĩa đối tượng `x_…`) và `custom_records`
--    (bản ghi — CỘT HỆ THỐNG; giá trị field ở `custom_values`, định nghĩa field ở `meta_custom_fields`).
--  · Không bảng vật lý cho mỗi đối tượng (X5). Không dòng nào được chèn: không đối tượng nào tồn tại cho tới khi
--    người tạo. Tổ chức nhà không đổi gì.
-- Viết tay và idempotent như các migration trước.

CREATE TABLE IF NOT EXISTS "meta_objects" (
  "key" text PRIMARY KEY NOT NULL,
  "label" text NOT NULL,
  "label_plural" text NOT NULL,
  "icon" text DEFAULT 'box' NOT NULL,
  "module_key" text DEFAULT 'apps' NOT NULL,
  "title_label" text DEFAULT 'Tên' NOT NULL,
  "description" text,
  "view_permission" text DEFAULT 'records:view' NOT NULL,
  "write_permission" text DEFAULT 'records:write' NOT NULL,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "origin" text,
  "created_by" text,
  "updated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "meta_objects_key_check" CHECK ("key" ~ '^x_[a-z][a-z0-9_]{1,40}$'),
  CONSTRAINT "meta_objects_status_check" CHECK ("status" in ('ACTIVE','ARCHIVED'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "custom_records" (
  "id" text PRIMARY KEY NOT NULL,
  "object_key" text NOT NULL,
  "title" text NOT NULL,
  "owner_id" text,
  "version" integer DEFAULT 1 NOT NULL,
  "created_by" text,
  "updated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "custom_records_title_check" CHECK (length(btrim("title")) > 0)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "custom_records" ADD CONSTRAINT "custom_records_object_key_meta_objects_key_fk" FOREIGN KEY ("object_key") REFERENCES "public"."meta_objects"("key") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_records_object_idx" ON "custom_records" ("object_key","deleted_at","updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_records_owner_idx" ON "custom_records" ("owner_id");
