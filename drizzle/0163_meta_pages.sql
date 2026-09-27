-- 0163 · DYNAMIC PAGE RUNTIME (docs/platform/phase-4-contracts.md mục 2).
--
--  · CHỈ THÊM một bảng trong CSDL tổ chức: `meta_pages` (trang tuỳ biến: slug, module chủ, quyền xem, menu,
--    nháp / bản xuất bản / phiên bản). Không dòng nào được chèn: không trang nào tồn tại cho tới khi người tạo.
--  · Trang cũ (legacy) không đổi gì — trang động sống song song ở `/p/<slug>`.
-- Viết tay và idempotent như các migration trước.

CREATE TABLE IF NOT EXISTS "meta_pages" (
  "id" text PRIMARY KEY NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "module_key" text NOT NULL,
  "required_permission" text,
  "nav" jsonb DEFAULT '{"enabled":false,"label":"","zone":null,"order":0}'::jsonb NOT NULL,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "draft" jsonb,
  "published" jsonb,
  "published_version" integer DEFAULT 0 NOT NULL,
  "published_at" timestamp with time zone,
  "published_by" text,
  "created_by" text,
  "updated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "meta_pages_status_check" CHECK ("status" in ('ACTIVE','ARCHIVED')),
  CONSTRAINT "meta_pages_slug_check" CHECK ("slug" ~ '^[a-z][a-z0-9-]{1,60}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "meta_pages_slug_uq" ON "meta_pages" ("slug");
