CREATE TABLE "stock_receipt_items" (
	"id" text PRIMARY KEY NOT NULL,
	"receipt_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'RECEIPT' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"supplier" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"total_quantity" integer DEFAULT 0 NOT NULL,
	"total_cost" integer DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stock_receipt_items" ADD CONSTRAINT "stock_receipt_items_receipt_id_stock_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."stock_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipt_items" ADD CONSTRAINT "stock_receipt_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_receipt_items_receipt_idx" ON "stock_receipt_items" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "stock_receipt_items_variant_idx" ON "stock_receipt_items" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "stock_receipts_received_idx" ON "stock_receipts" USING btree ("received_at");