-- Vòng đời care chuẩn (NEW → ASSIGNED → IN_PROGRESS → WAITING_* → RESOLVED/ESCALATED/CANCELLED),
-- lịch sử case chỉ-thêm, và yêu cầu ĐVVC: ACK → ACKNOWLEDGED, thêm gói tin thô + số lần gọi.
ALTER TABLE "shipment_care" DROP CONSTRAINT IF EXISTS "shipment_care_status_check";--> statement-breakpoint
UPDATE "shipment_care" SET "care_status" = 'WAITING_CUSTOMER' WHERE "care_status" = 'WAITING';--> statement-breakpoint
UPDATE "shipment_care" SET "care_status" = 'RESOLVED' WHERE "care_status" = 'DONE';--> statement-breakpoint
ALTER TABLE "shipment_care" ADD CONSTRAINT "shipment_care_status_check"
  CHECK ("care_status" IN ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_CARRIER', 'WAITING_REDELIVERY', 'RESOLVED', 'ESCALATED', 'CANCELLED'));--> statement-breakpoint
ALTER TABLE "carrier_action_requests" DROP CONSTRAINT IF EXISTS "carrier_action_status_check";--> statement-breakpoint
UPDATE "carrier_action_requests" SET "status" = 'ACKNOWLEDGED' WHERE "status" = 'ACK';--> statement-breakpoint
ALTER TABLE "carrier_action_requests" ADD CONSTRAINT "carrier_action_status_check"
  CHECK ("status" IN ('PENDING', 'SENT', 'ACKNOWLEDGED', 'SUCCESS', 'FAILED', 'UNSUPPORTED', 'MANUAL_REQUIRED', 'MANUAL_DONE'));--> statement-breakpoint
ALTER TABLE "carrier_action_requests" ADD COLUMN IF NOT EXISTS "raw_request" jsonb;--> statement-breakpoint
ALTER TABLE "carrier_action_requests" ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "care_case_events" (
  "id" text PRIMARY KEY NOT NULL,
  "shipment_id" text NOT NULL REFERENCES "shipments"("id") ON DELETE CASCADE,
  "actor_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "actor_email" text NOT NULL DEFAULT '',
  "source" text NOT NULL DEFAULT 'UI',
  "action" text NOT NULL,
  "note" text NOT NULL DEFAULT '',
  "previous_status" text,
  "next_status" text,
  "previous_owner" text,
  "next_owner" text,
  "follow_up_at" timestamp with time zone,
  "sla" jsonb,
  "payload" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "care_case_events_source_check" CHECK ("source" IN ('UI', 'API', 'AI', 'SYSTEM'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "care_case_events_shipment_idx" ON "care_case_events" USING btree ("shipment_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "care_case_events_actor_idx" ON "care_case_events" USING btree ("actor_email", "created_at");
