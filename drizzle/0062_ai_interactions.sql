-- Nhật ký tương tác AI Copilot: ai hỏi, ở đâu, model nào, tool nào, hành động nào đề nghị / đã chạy, chi phí.
CREATE TABLE IF NOT EXISTS "ai_interactions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "user_email" text NOT NULL DEFAULT '',
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "route" text NOT NULL DEFAULT '',
  "entity_type" text NOT NULL DEFAULT '',
  "entity_id" text NOT NULL DEFAULT '',
  "prompt" text NOT NULL DEFAULT '',
  "answer" text NOT NULL DEFAULT '',
  "tool_calls" jsonb,
  "actions_proposed" jsonb,
  "actions_executed" jsonb,
  "usage" jsonb,
  "cost_usd" text NOT NULL DEFAULT '0',
  "latency_ms" integer NOT NULL DEFAULT 0,
  "rounds" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'OK',
  "error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ai_interactions_status_check" CHECK ("status" IN ('OK', 'NEEDS_CONFIRMATION', 'REFUSED', 'ERROR'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_interactions_user_idx" ON "ai_interactions" USING btree ("user_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_interactions_entity_idx" ON "ai_interactions" USING btree ("entity_type", "entity_id", "created_at");
