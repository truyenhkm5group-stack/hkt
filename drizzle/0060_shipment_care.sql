-- Trạng thái care nội bộ của kiện (tách khỏi trạng thái vận chuyển của ĐVVC) và sổ yêu cầu gửi ĐVVC
-- với vòng đời đầy đủ PENDING → SENT → ACK → SUCCESS/FAILED/UNSUPPORTED, MANUAL_REQUIRED → MANUAL_DONE.
CREATE TABLE IF NOT EXISTS "shipment_care" (
  "id" text PRIMARY KEY NOT NULL,
  "shipment_id" text NOT NULL UNIQUE REFERENCES "shipments"("id") ON DELETE CASCADE,
  "care_status" text NOT NULL DEFAULT 'NEW',
  "owner_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "owner_email" text NOT NULL DEFAULT '',
  "follow_up_at" timestamp with time zone,
  "last_note" text NOT NULL DEFAULT '',
  "last_note_at" timestamp with time zone,
  "last_note_by" text NOT NULL DEFAULT '',
  "first_response_at" timestamp with time zone,
  "done_at" timestamp with time zone,
  "escalated_at" timestamp with time zone,
  "reopen_count" integer NOT NULL DEFAULT 0,
  "updated_by" text NOT NULL DEFAULT '',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shipment_care_status_check" CHECK ("care_status" IN ('NEW', 'IN_PROGRESS', 'WAITING', 'ESCALATED', 'DONE'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipment_care_status_idx" ON "shipment_care" USING btree ("care_status", "follow_up_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipment_care_owner_idx" ON "shipment_care" USING btree ("owner_id", "care_status");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "carrier_action_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "shipment_id" text NOT NULL REFERENCES "shipments"("id") ON DELETE CASCADE,
  "order_number" text NOT NULL DEFAULT '',
  "action_key" text NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING',
  "idempotency_key" text NOT NULL UNIQUE,
  "payload" jsonb,
  "response" jsonb,
  "error" text,
  "actor_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "actor_email" text NOT NULL DEFAULT '',
  "note" text NOT NULL DEFAULT '',
  "sent_at" timestamp with time zone,
  "ack_at" timestamp with time zone,
  "confirmed_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "carrier_action_status_check" CHECK ("status" IN ('PENDING', 'SENT', 'ACK', 'SUCCESS', 'FAILED', 'UNSUPPORTED', 'MANUAL_REQUIRED', 'MANUAL_DONE'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "carrier_action_shipment_idx" ON "carrier_action_requests" USING btree ("shipment_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "carrier_action_status_idx" ON "carrier_action_requests" USING btree ("status", "created_at");
