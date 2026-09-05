CREATE TABLE "outreach_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"segment" text NOT NULL,
	"page_id" text DEFAULT '' NOT NULL,
	"conversation_id" text DEFAULT '' NOT NULL,
	"pancake_customer_id" text DEFAULT '' NOT NULL,
	"customer_id" text,
	"order_id" text,
	"customer_name" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"context" text DEFAULT '' NOT NULL,
	"suggestions" text DEFAULT '' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"last_activity_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"sent_by" text DEFAULT '' NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outreach_targets_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD CONSTRAINT "outreach_targets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD CONSTRAINT "outreach_targets_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outreach_segment_status_idx" ON "outreach_targets" USING btree ("segment","status","created_at");