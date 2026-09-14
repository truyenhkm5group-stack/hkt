-- ═══════ BẰNG CHỨNG HÀNH ĐỘNG ═══════
--
-- Một dòng mỗi lần MỘT NGƯỜI đóng một việc trong hàng đợi. Bắt đầu ghi từ hôm nay: không suy ngược
-- từ lịch sử, vì toàn bộ 96 việc đã đóng có kết quả đơn đều mang `resolution = 'UNKNOWN'` (đóng
-- trước khi có cột ghi nguồn gốc) và không ca nào chứng minh được là có người xử lý.
--
-- `recovered_value` để TRỐNG lúc ghi, tính sau khi đơn ngã ngũ. NULL = CHƯA BIẾT, không phải 0.
CREATE TABLE IF NOT EXISTS "action_evidence" (
  "id" text PRIMARY KEY NOT NULL,
  "notification_id" text NOT NULL,
  "case_type" text NOT NULL,
  "team" text DEFAULT '' NOT NULL,
  "entity_type" text DEFAULT '' NOT NULL,
  "entity_id" text DEFAULT '' NOT NULL,
  "actor_id" text,
  "actor_email" text DEFAULT '' NOT NULL,
  "detected_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone NOT NULL,
  "hours_to_close" integer,
  "money_at_risk" bigint,
  "outcome_at_close" text,
  "recovered_value" integer,
  "recovered_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "action_evidence" DROP CONSTRAINT IF EXISTS "action_evidence_actor_id_users_id_fk";
  ALTER TABLE "action_evidence" ADD CONSTRAINT "action_evidence_actor_id_users_id_fk"
    FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_evidence_actor_idx" ON "action_evidence" USING btree ("actor_id","completed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_evidence_type_idx" ON "action_evidence" USING btree ("case_type","completed_at");--> statement-breakpoint
-- Một việc đóng một lần: bấm hai lần không được đếm thành hai công.
CREATE UNIQUE INDEX IF NOT EXISTS "action_evidence_notification_idx" ON "action_evidence" USING btree ("notification_id");
