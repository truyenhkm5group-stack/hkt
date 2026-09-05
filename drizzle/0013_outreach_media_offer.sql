ALTER TABLE "outreach_targets" ADD COLUMN "media_urls" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD COLUMN "offer" text DEFAULT '' NOT NULL;