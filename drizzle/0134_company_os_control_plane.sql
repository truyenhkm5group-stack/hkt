-- 0134 · COMPANY OS · MẶT PHẲNG ĐIỀU KHIỂN (Agent G): DUYỆT HAI BƯỚC TIÊU THỤ ĐƯỢC + NHẬT KÝ CÓ CỘT.
--
-- 1. `approval_requests.payload_fingerprint` — dấu vân tay của việc đã xin. Yêu cầu ĐÃ DUYỆT chỉ
--    được tiêu thụ khi người xin làm lại ĐÚNG việc đó (cùng nhóm · thao tác · thực thể · payload).
--    Dòng cũ để NULL: không đoán lại dấu vân tay từ payload đã lưu (AGENTS.md mục 35).
-- 2. Chỉ mục duy nhất MỘT PHẦN: một người không có hai yêu cầu ĐANG CHỜ cho cùng một việc.
--    Dòng cũ (fingerprint NULL) nằm ngoài chỉ mục nên không vi phạm được.
-- 3. `audit_logs.actor_kind` · `correlation_id` · `reason` — NULL được, KHÔNG backfill: dòng cũ
--    không biết ai là người hay máy, và điền "USER" cho chúng là bịa (mục 35). `detail` giữ nguyên.
-- Viết tay và idempotent như 0033–0130.

ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "payload_fingerprint" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_requester_idx" ON "approval_requests" ("requested_by", "group", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approval_pending_fingerprint_uq" ON "approval_requests" ("requested_by", "group", "payload_fingerprint") WHERE "status" = 'PENDING' and "payload_fingerprint" is not null;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "actor_kind" text;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "correlation_id" text;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "reason" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_correlation_idx" ON "audit_logs" ("correlation_id") WHERE "correlation_id" is not null;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_kind_check" CHECK ("actor_kind" is null or "actor_kind" in ('USER','SYSTEM','AGENT','WEBHOOK'));
EXCEPTION WHEN duplicate_object THEN null; END $$;
