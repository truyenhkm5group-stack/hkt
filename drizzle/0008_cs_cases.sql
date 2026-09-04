CREATE TABLE "cs_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text,
	"customer_id" text,
	"kind" text DEFAULT 'OTHER' NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"source" text DEFAULT 'MANUAL' NOT NULL,
	"title" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"customer_name" text DEFAULT '' NOT NULL,
	"customer_phone" text DEFAULT '' NOT NULL,
	"assignee" text DEFAULT '' NOT NULL,
	"resolution" text DEFAULT '' NOT NULL,
	"dedupe_key" text,
	"created_by" text DEFAULT '' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cs_cases_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "cs_cases" ADD CONSTRAINT "cs_cases_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cs_cases" ADD CONSTRAINT "cs_cases_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cs_cases_status_idx" ON "cs_cases" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "cs_cases_order_idx" ON "cs_cases" USING btree ("order_id");