CREATE TABLE "landing_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"row_key" text NOT NULL,
	"sheet_gid" text DEFAULT '' NOT NULL,
	"row_index" integer DEFAULT 0 NOT NULL,
	"submitted_at" timestamp with time zone,
	"customer_name" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"province" text DEFAULT '' NOT NULL,
	"product_text" text DEFAULT '' NOT NULL,
	"variant_text" text DEFAULT '' NOT NULL,
	"size_text" text DEFAULT '' NOT NULL,
	"color_text" text DEFAULT '' NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"price" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"sheet_status" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'NEW' NOT NULL,
	"variant_id" text,
	"variant_match_score" integer DEFAULT 0 NOT NULL,
	"order_id" text,
	"pancake_order_id" text,
	"pancake_system_id" integer,
	"pushed_at" timestamp with time zone,
	"push_error" text DEFAULT '' NOT NULL,
	"duplicates" jsonb,
	"risk" jsonb,
	"assignee" text DEFAULT '' NOT NULL,
	"internal_note" text DEFAULT '' NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landing_orders_row_key_unique" UNIQUE("row_key")
);
--> statement-breakpoint
ALTER TABLE "landing_orders" ADD CONSTRAINT "landing_orders_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_orders" ADD CONSTRAINT "landing_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "landing_orders_phone_idx" ON "landing_orders" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "landing_orders_status_idx" ON "landing_orders" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE INDEX "landing_orders_order_idx" ON "landing_orders" USING btree ("order_id");