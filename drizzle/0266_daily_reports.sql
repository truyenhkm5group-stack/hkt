-- 0266 · BÁO CÁO CEO HẰNG NGÀY (ai-daily-report, chủ shop duyệt 30/10/2026 · docs/tech/ai-daily-report.md).
--
-- CSDL của tổ chức. Idempotent. CHỈ TẠO một bảng mới + một trigger chặn sửa, không đụng bảng nào đang có, không gieo dòng nào.
--  · daily_reports: MỘT bản mỗi ngày báo cáo (report_date UNIQUE) — khối số máy gom, lời tóm tắt AI (đã qua hàng rào số), model,
--    chi phí. BẤT BIẾN: trigger chặn mọi UPDATE — bản của một ngày đã tạo thì không ai sửa được, kể cả ứng dụng.
CREATE TABLE IF NOT EXISTS "daily_reports" (
  "id" text PRIMARY KEY NOT NULL,
  "report_date" date NOT NULL,
  "facts" jsonb NOT NULL,
  "summary" text,
  "highlights" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "ai_status" text NOT NULL,
  "ai_note" text DEFAULT '' NOT NULL,
  "blocked_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "model" text,
  "cost_usd" double precision,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "daily_reports_ai_status_check" CHECK ("ai_status" IN ('OK', 'BLOCKED', 'SKIPPED', 'ERROR')),
  CONSTRAINT "daily_reports_summary_check" CHECK (("ai_status" = 'OK') = ("summary" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "daily_reports_date_uq" ON "daily_reports" USING btree ("report_date");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "daily_reports_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'daily_reports là bản bất biến — không sửa được bản báo cáo đã tạo';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "daily_reports_no_update" ON "daily_reports";
--> statement-breakpoint
CREATE TRIGGER "daily_reports_no_update" BEFORE UPDATE ON "daily_reports" FOR EACH ROW EXECUTE FUNCTION "daily_reports_immutable"();
