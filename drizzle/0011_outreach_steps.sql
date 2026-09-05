ALTER TABLE "outreach_targets" ADD COLUMN "step" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD COLUMN "sent_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD COLUMN "next_at" timestamp with time zone;