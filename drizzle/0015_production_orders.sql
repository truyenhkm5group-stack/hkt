CREATE TABLE "production_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"product_id" text,
	"product_code" text DEFAULT '' NOT NULL,
	"product_name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"colors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sizes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cells" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_qty" integer DEFAULT 0 NOT NULL,
	"unit_cost" integer DEFAULT 0 NOT NULL,
	"supplier" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"due_date" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_orders_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "production_orders_product_idx" ON "production_orders" USING btree ("product_id","created_at");