CREATE TABLE "fb_ads" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"adset_id" text,
	"campaign_id" text,
	"campaign_name" text DEFAULT '' NOT NULL,
	"account_id" text,
	"status" text DEFAULT '' NOT NULL,
	"missing" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "fb_ads_campaign_idx" ON "fb_ads" USING btree ("campaign_id");