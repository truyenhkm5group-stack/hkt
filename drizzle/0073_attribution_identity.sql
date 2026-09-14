-- ═══════════ DANH TÍNH THẬT CHO BA MIỀN QUY KẾT + ĐÍCH CHỈ SỐ ═══════════
--
-- Mọi cột thêm ở đây đều NULLABLE và KHÔNG có mặc định. `NULL` nghĩa là CHƯA NỐI ĐƯỢC VỀ MỘT TÀI
-- KHOẢN — không phải "không có ai". Đặt mặc định hay backfill bằng suy đoán sẽ biến một lỗ hổng
-- dữ liệu thành một lời khẳng định sai, và sau đó không phân biệt được nữa.
--
-- Migration này KHÔNG backfill. Ánh xạ dòng lịch sử chạy riêng, chỉ khi XÁC ĐỊNH, và có báo cáo
-- chạy thử trước.

ALTER TABLE "cs_cases" ADD COLUMN IF NOT EXISTS "assignee_user_id" text;
--> statement-breakpoint
ALTER TABLE "cs_cases" ADD COLUMN IF NOT EXISTS "created_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "return_inspections" ADD COLUMN IF NOT EXISTS "received_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "return_inspections" ADD COLUMN IF NOT EXISTS "inspected_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "return_inspection_items" ADD COLUMN IF NOT EXISTS "inspected_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "care_case_events" ADD COLUMN IF NOT EXISTS "previous_owner_id" text;
--> statement-breakpoint
ALTER TABLE "care_case_events" ADD COLUMN IF NOT EXISTS "next_owner_id" text;
--> statement-breakpoint
ALTER TABLE "performance_snapshots" ADD COLUMN IF NOT EXISTS "source_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

-- Khoá ngoại ON DELETE SET NULL: người nghỉ việc và tài khoản bị xoá thì dòng dữ liệu vẫn còn,
-- chỉ mất phần nối về tài khoản. Xoá dòng theo người là xoá lịch sử công việc của shop.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cs_cases_assignee_user_id_users_id_fk') THEN
    ALTER TABLE "cs_cases" ADD CONSTRAINT "cs_cases_assignee_user_id_users_id_fk"
      FOREIGN KEY ("assignee_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cs_cases_created_by_user_id_users_id_fk') THEN
    ALTER TABLE "cs_cases" ADD CONSTRAINT "cs_cases_created_by_user_id_users_id_fk"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'return_inspections_received_by_user_id_users_id_fk') THEN
    ALTER TABLE "return_inspections" ADD CONSTRAINT "return_inspections_received_by_user_id_users_id_fk"
      FOREIGN KEY ("received_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'return_inspections_inspected_by_user_id_users_id_fk') THEN
    ALTER TABLE "return_inspections" ADD CONSTRAINT "return_inspections_inspected_by_user_id_users_id_fk"
      FOREIGN KEY ("inspected_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'return_inspection_items_inspected_by_user_id_users_id_fk') THEN
    ALTER TABLE "return_inspection_items" ADD CONSTRAINT "return_inspection_items_inspected_by_user_id_users_id_fk"
      FOREIGN KEY ("inspected_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'care_case_events_previous_owner_id_users_id_fk') THEN
    ALTER TABLE "care_case_events" ADD CONSTRAINT "care_case_events_previous_owner_id_users_id_fk"
      FOREIGN KEY ("previous_owner_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'care_case_events_next_owner_id_users_id_fk') THEN
    ALTER TABLE "care_case_events" ADD CONSTRAINT "care_case_events_next_owner_id_users_id_fk"
      FOREIGN KEY ("next_owner_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "cs_cases_assignee_user_idx" ON "cs_cases" ("assignee_user_id","resolved_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_inspections_inspector_idx" ON "return_inspections" ("inspected_by_user_id","inspected_at");
--> statement-breakpoint

-- ═══════════ ĐÍCH CHỈ SỐ ═══════════
CREATE TABLE IF NOT EXISTS "metric_targets" (
  "id" text PRIMARY KEY NOT NULL,
  "metric_key" text NOT NULL,
  "scope" text NOT NULL,
  "scope_ref" text,
  "target" double precision NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "effective_from" timestamp with time zone NOT NULL,
  "set_by" text,
  "set_by_email" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'metric_targets_set_by_users_id_fk') THEN
    ALTER TABLE "metric_targets" ADD CONSTRAINT "metric_targets_set_by_users_id_fk"
      FOREIGN KEY ("set_by") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'metric_targets_scope_check') THEN
    ALTER TABLE "metric_targets" ADD CONSTRAINT "metric_targets_scope_check"
      CHECK ("scope" IN ('COMPANY', 'DEPARTMENT', 'POSITION'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'metric_targets_ref_check') THEN
    ALTER TABLE "metric_targets" ADD CONSTRAINT "metric_targets_ref_check"
      CHECK (("scope" = 'COMPANY' AND "scope_ref" IS NULL) OR ("scope" <> 'COMPANY' AND "scope_ref" IS NOT NULL AND length(trim("scope_ref")) > 0));
  END IF;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "metric_targets_uq" ON "metric_targets" ("metric_key","scope",coalesce("scope_ref", ''),"effective_from");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "metric_targets_lookup_idx" ON "metric_targets" ("metric_key","effective_from");
