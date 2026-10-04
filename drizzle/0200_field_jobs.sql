-- 0200 · PHIẾU CÔNG VIỆC HIỆN TRƯỜNG — dịch vụ tại nhà (module `field_jobs` — docs/verticals/home-service.md).
--
--  · `field_jobs`: một việc tại nhà khách — báo giá → khách đồng ý → hẹn thợ → đang làm → nghiệm thu (khách ký: tên người ký
--    gõ lại từ biên bản) / huỷ (bắt buộc lý do). Một thợ không bị hẹn chồng giờ (kiểm ở đường ghi sau khoá tư vấn theo thợ).
--    Bảo hành dịch vụ: số tháng; hạn TÍNH lúc đọc từ ngày nghiệm thu. Lượt bảo hành là một phiếu MỚI trỏ về phiếu gốc.
--  · `field_job_lines`: dòng báo giá (chữ tự do · số lượng nguyên · đơn giá). Tổng / đã thu / còn nợ KHÔNG lưu cột.
--  · `field_job_receipts`: phiếu thu theo đợt (cọc, đợt 2, nghiệm thu…); huỷ phiếu thu bắt buộc lý do, không xoá.
--  · `field_job_photos`: ảnh trước / sau (đã thu nhỏ ở trình duyệt, ≤ 2 MB mỗi ảnh).
--  · Module MỚI mặc định TẮT ở tổ chức nhà. CSDL mọi tổ chức. Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "field_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "customer_id" text NOT NULL REFERENCES "customers"("id") ON DELETE RESTRICT,
  "parent_job_id" text REFERENCES "field_jobs"("id") ON DELETE SET NULL,
  "title" text NOT NULL,
  "address" text DEFAULT '' NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'QUOTED' NOT NULL,
  "accepted_at" timestamp with time zone,
  "accepted_note" text DEFAULT '' NOT NULL,
  "assignee_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "scheduled_start" timestamp with time zone,
  "scheduled_end" timestamp with time zone,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "signed_by_name" text,
  "completion_note" text DEFAULT '' NOT NULL,
  "warranty_months" integer,
  "cancel_reason" text,
  "cancelled_at" timestamp with time zone,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "field_jobs_status_check" CHECK ("status" IN ('QUOTED','ACCEPTED','SCHEDULED','IN_PROGRESS','DONE','CANCELLED')),
  CONSTRAINT "field_jobs_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 200),
  CONSTRAINT "field_jobs_slot_check" CHECK (("scheduled_start" IS NULL) = ("scheduled_end" IS NULL) AND ("scheduled_end" IS NULL OR "scheduled_end" > "scheduled_start")),
  CONSTRAINT "field_jobs_scheduled_check" CHECK ("status" NOT IN ('SCHEDULED','IN_PROGRESS') OR ("assignee_user_id" IS NOT NULL AND "scheduled_start" IS NOT NULL)),
  CONSTRAINT "field_jobs_done_check" CHECK ("status" <> 'DONE' OR ("completed_at" IS NOT NULL AND length(btrim(coalesce("signed_by_name", ''))) >= 1)),
  CONSTRAINT "field_jobs_cancel_check" CHECK ("status" <> 'CANCELLED' OR length(btrim(coalesce("cancel_reason", ''))) >= 3),
  CONSTRAINT "field_jobs_warranty_check" CHECK ("warranty_months" IS NULL OR "warranty_months" BETWEEN 1 AND 120)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "field_jobs_code_uq" ON "field_jobs" ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "field_jobs_customer_idx" ON "field_jobs" ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "field_jobs_assignee_slot_idx" ON "field_jobs" ("assignee_user_id", "scheduled_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "field_jobs_status_idx" ON "field_jobs" ("status", "updated_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "field_job_lines" (
  "id" text PRIMARY KEY NOT NULL,
  "job_id" text NOT NULL REFERENCES "field_jobs"("id") ON DELETE CASCADE,
  "description" text NOT NULL,
  "quantity" integer NOT NULL,
  "unit_price" integer NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "field_job_lines_qty_check" CHECK ("quantity" BETWEEN 1 AND 10000),
  CONSTRAINT "field_job_lines_price_check" CHECK ("unit_price" >= 0),
  CONSTRAINT "field_job_lines_text_check" CHECK (length(btrim("description")) BETWEEN 1 AND 300)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "field_job_lines_job_idx" ON "field_job_lines" ("job_id", "position");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "field_job_receipts" (
  "id" text PRIMARY KEY NOT NULL,
  "job_id" text NOT NULL REFERENCES "field_jobs"("id") ON DELETE CASCADE,
  "amount" integer NOT NULL,
  "method" text NOT NULL,
  "paid_at" timestamp with time zone NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'CONFIRMED' NOT NULL,
  "void_reason" text,
  "voided_at" timestamp with time zone,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "field_job_receipts_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "field_job_receipts_method_check" CHECK ("method" IN ('CASH','BANK','OTHER')),
  CONSTRAINT "field_job_receipts_status_check" CHECK ("status" IN ('CONFIRMED','VOIDED')),
  CONSTRAINT "field_job_receipts_void_check" CHECK ("status" <> 'VOIDED' OR length(btrim(coalesce("void_reason", ''))) >= 3)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "field_job_receipts_job_idx" ON "field_job_receipts" ("job_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "field_job_photos" (
  "id" text PRIMARY KEY NOT NULL,
  "job_id" text NOT NULL REFERENCES "field_jobs"("id") ON DELETE CASCADE,
  "phase" text NOT NULL,
  "content_type" text NOT NULL,
  "bytes" integer NOT NULL,
  "data" bytea NOT NULL,
  "uploaded_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "uploaded_by_name" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "field_job_photos_phase_check" CHECK ("phase" IN ('BEFORE','AFTER')),
  CONSTRAINT "field_job_photos_type_check" CHECK ("content_type" IN ('image/jpeg','image/png','image/webp')),
  CONSTRAINT "field_job_photos_bytes_check" CHECK ("bytes" BETWEEN 1 AND 2000000)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "field_job_photos_job_idx" ON "field_job_photos" ("job_id", "phase");--> statement-breakpoint
INSERT INTO "platform_organization_modules" ("organization_id", "module_key", "enabled", "features", "config", "disabled_at", "updated_by")
SELECT "id", 'field_jobs', false, '{}'::jsonb, '{}'::jsonb, now(), 'system:0200'
FROM "platform_organizations" WHERE "is_home"
ON CONFLICT ("organization_id", "module_key") DO NOTHING;
