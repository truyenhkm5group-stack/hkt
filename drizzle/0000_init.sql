CREATE TYPE "public"."cod_status" AS ENUM('NOT_APPLICABLE', 'PENDING', 'COLLECTED', 'RECONCILED', 'PAID_TO_BANK', 'DISPUTED');--> statement-breakpoint
CREATE TYPE "public"."expense_category" AS ENUM('ADS', 'SHIPPING', 'RETURN_FEE', 'SALARY', 'RENT', 'SOFTWARE', 'PACKAGING', 'PURCHASE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."order_stage" AS ENUM('NEW', 'WAITING', 'CONFIRMED', 'PACKING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'PAID', 'RETURNING', 'PARTIAL_RETURN', 'RETURNED', 'CANCELLED', 'DELETED');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('ADMIN', 'MANAGER', 'ACCOUNTANT', 'WAREHOUSE', 'CS', 'MARKETING', 'VIEWER');--> statement-breakpoint
CREATE TYPE "public"."shipment_stage" AS ENUM('PENDING', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED', 'RETURNING', 'RETURNED', 'CANCELLED', 'UNKNOWN');--> statement-breakpoint
CREATE TABLE "ad_spends" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"campaign" text DEFAULT '' NOT NULL,
	"spend" integer NOT NULL,
	"leads" integer DEFAULT 0 NOT NULL,
	"orders" integer DEFAULT 0 NOT NULL,
	"revenue" integer DEFAULT 0 NOT NULL,
	"spend_date" timestamp with time zone NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"user_email" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text DEFAULT '' NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cod_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"carrier" text DEFAULT 'Viettel Post' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"total_amount" integer DEFAULT 0 NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"pancake_id" text,
	"name" text NOT NULL,
	"phone" text,
	"phones" text[] DEFAULT '{}'::text[] NOT NULL,
	"emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"gender" text,
	"date_of_birth" timestamp with time zone,
	"level" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"order_count" integer DEFAULT 0 NOT NULL,
	"succeed_order_count" integer DEFAULT 0 NOT NULL,
	"returned_order_count" integer DEFAULT 0 NOT NULL,
	"purchased_amount" integer DEFAULT 0 NOT NULL,
	"reward_point" integer DEFAULT 0 NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"province" text DEFAULT '' NOT NULL,
	"addresses" jsonb,
	"fb_id" text,
	"conversation_link" text,
	"is_block" boolean DEFAULT false NOT NULL,
	"last_order_at" timestamp with time zone,
	"inserted_at" timestamp with time zone,
	"updated_at_external" timestamp with time zone,
	"raw" jsonb,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_pancake_id_unique" UNIQUE("pancake_id")
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" text PRIMARY KEY NOT NULL,
	"category" "expense_category" DEFAULT 'OTHER' NOT NULL,
	"description" text NOT NULL,
	"amount" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_tokens" (
	"provider" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone,
	"meta" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_histories" (
	"id" text PRIMARY KEY NOT NULL,
	"variant_id" text,
	"warehouse_id" text,
	"quantity" integer DEFAULT 0 NOT NULL,
	"remain_quantity" integer DEFAULT 0 NOT NULL,
	"avg_price" double precision,
	"type" text DEFAULT '' NOT NULL,
	"table_name" text,
	"ref_display_id" text,
	"editor_name" text,
	"inserted_at" timestamp with time zone NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"variant_id" text,
	"product_id" text,
	"product_name" text DEFAULT '' NOT NULL,
	"variation_detail" text DEFAULT '' NOT NULL,
	"sku" text DEFAULT '' NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price" integer DEFAULT 0 NOT NULL,
	"unit_cost" integer DEFAULT 0 NOT NULL,
	"discount_each" integer DEFAULT 0 NOT NULL,
	"total_discount" integer DEFAULT 0 NOT NULL,
	"is_bonus" boolean DEFAULT false NOT NULL,
	"return_quantity" integer DEFAULT 0 NOT NULL,
	"line_total" integer DEFAULT 0 NOT NULL,
	"weight" integer DEFAULT 0 NOT NULL,
	"image" text
);
--> statement-breakpoint
CREATE TABLE "order_returns" (
	"id" text PRIMARY KEY NOT NULL,
	"display_id" integer,
	"order_id" text,
	"order_to_returned_id" text,
	"status" integer DEFAULT 0 NOT NULL,
	"status_name" text DEFAULT '' NOT NULL,
	"returned_fee" integer DEFAULT 0 NOT NULL,
	"discount" integer DEFAULT 0 NOT NULL,
	"is_exchange" boolean DEFAULT false NOT NULL,
	"bill_full_name" text DEFAULT '' NOT NULL,
	"bill_phone" text DEFAULT '' NOT NULL,
	"items" jsonb,
	"inserted_at" timestamp with time zone NOT NULL,
	"updated_at_external" timestamp with time zone,
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_status_history" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"status" integer NOT NULL,
	"old_status" integer,
	"editor_name" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"system_id" integer,
	"display_id" integer,
	"custom_id" text,
	"shop_id" text,
	"status" integer DEFAULT 0 NOT NULL,
	"status_name" text DEFAULT '' NOT NULL,
	"stage" "order_stage" DEFAULT 'NEW' NOT NULL,
	"sub_status" integer,
	"customer_id" text,
	"bill_full_name" text DEFAULT '' NOT NULL,
	"bill_phone" text DEFAULT '' NOT NULL,
	"bill_email" text DEFAULT '' NOT NULL,
	"ship_full_name" text DEFAULT '' NOT NULL,
	"ship_phone" text DEFAULT '' NOT NULL,
	"ship_address" text DEFAULT '' NOT NULL,
	"ship_full_address" text DEFAULT '' NOT NULL,
	"ship_province" text DEFAULT '' NOT NULL,
	"ship_district" text DEFAULT '' NOT NULL,
	"ship_commune" text DEFAULT '' NOT NULL,
	"total_price" integer DEFAULT 0 NOT NULL,
	"total_price_after_discount" integer DEFAULT 0 NOT NULL,
	"total_discount" integer DEFAULT 0 NOT NULL,
	"shipping_fee" integer DEFAULT 0 NOT NULL,
	"partner_fee" integer DEFAULT 0 NOT NULL,
	"customer_pay_fee" boolean DEFAULT false NOT NULL,
	"is_free_shipping" boolean DEFAULT false NOT NULL,
	"cod" integer DEFAULT 0 NOT NULL,
	"money_to_collect" integer DEFAULT 0 NOT NULL,
	"prepaid" integer DEFAULT 0 NOT NULL,
	"transfer_money" integer DEFAULT 0 NOT NULL,
	"cash" integer DEFAULT 0 NOT NULL,
	"surcharge" integer DEFAULT 0 NOT NULL,
	"tax" integer DEFAULT 0 NOT NULL,
	"fee_marketplace" integer DEFAULT 0 NOT NULL,
	"return_fee" integer DEFAULT 0 NOT NULL,
	"exchange_value" integer DEFAULT 0 NOT NULL,
	"is_exchange_order" boolean DEFAULT false NOT NULL,
	"is_livestream" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'Khác' NOT NULL,
	"account_name" text DEFAULT '' NOT NULL,
	"page_id" text,
	"post_id" text,
	"ad_id" text,
	"marketplace_id" text,
	"seller_name" text DEFAULT '' NOT NULL,
	"care_name" text DEFAULT '' NOT NULL,
	"marketer_name" text DEFAULT '' NOT NULL,
	"creator_name" text DEFAULT '' NOT NULL,
	"warehouse_id" text,
	"note" text DEFAULT '' NOT NULL,
	"note_print" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"items_count" integer DEFAULT 0 NOT NULL,
	"total_quantity" integer DEFAULT 0 NOT NULL,
	"cogs" integer DEFAULT 0 NOT NULL,
	"returned_reason" text,
	"inserted_at" timestamp with time zone NOT NULL,
	"updated_at_external" timestamp with time zone,
	"last_update_status_at" timestamp with time zone,
	"time_send_partner" timestamp with time zone,
	"estimate_delivery_date" timestamp with time zone,
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"sku" text DEFAULT '' NOT NULL,
	"barcode" text,
	"custom_id" text,
	"attributes" jsonb,
	"detail" text DEFAULT '' NOT NULL,
	"color" text DEFAULT '' NOT NULL,
	"size" text DEFAULT '' NOT NULL,
	"images" text[] DEFAULT '{}'::text[] NOT NULL,
	"weight" integer DEFAULT 0 NOT NULL,
	"retail_price" integer DEFAULT 0 NOT NULL,
	"retail_price_after_discount" integer DEFAULT 0 NOT NULL,
	"last_imported_price" integer DEFAULT 0 NOT NULL,
	"avg_imported_price" double precision DEFAULT 0 NOT NULL,
	"remain_quantity" integer DEFAULT 0 NOT NULL,
	"actual_remain_quantity" integer DEFAULT 0 NOT NULL,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"is_locked" boolean DEFAULT false NOT NULL,
	"is_removed" boolean DEFAULT false NOT NULL,
	"inserted_at" timestamp with time zone,
	"updated_at_external" timestamp with time zone,
	"raw" jsonb,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"custom_id" text,
	"display_id" integer,
	"image" text,
	"categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_published" boolean,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"is_removed" boolean DEFAULT false NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"inserted_at" timestamp with time zone,
	"raw" jsonb,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_events" (
	"id" text PRIMARY KEY NOT NULL,
	"shipment_id" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"status_name" text DEFAULT '' NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text,
	"carrier" text DEFAULT '' NOT NULL,
	"partner_id" integer,
	"tracking_code" text,
	"vtp_order_number" text,
	"order_reference" text,
	"partner_status" text,
	"stage" "shipment_stage" DEFAULT 'PENDING' NOT NULL,
	"vtp_status" integer,
	"vtp_status_name" text,
	"vtp_status_date" timestamp with time zone,
	"vtp_location" text,
	"vtp_note" text,
	"vtp_reason_code" integer,
	"service" text,
	"weight" integer,
	"expected_delivery" text,
	"cod_amount" integer DEFAULT 0 NOT NULL,
	"cod_collected" integer DEFAULT 0 NOT NULL,
	"cod_fee" integer DEFAULT 0 NOT NULL,
	"shipping_fee" integer DEFAULT 0 NOT NULL,
	"cod_status" "cod_status" DEFAULT 'PENDING' NOT NULL,
	"cod_reconciled_at" timestamp with time zone,
	"cod_paid_to_bank_at" timestamp with time zone,
	"cod_batch_id" text,
	"receiver_name" text DEFAULT '' NOT NULL,
	"receiver_phone" text DEFAULT '' NOT NULL,
	"receiver_address" text DEFAULT '' NOT NULL,
	"picked_up_at" timestamp with time zone,
	"first_delivery_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"returned_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"is_final" boolean DEFAULT false NOT NULL,
	"last_vtp_sync_at" timestamp with time zone,
	"last_pancake_sync_at" timestamp with time zone,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "shipments_vtp_order_number_unique" UNIQUE("vtp_order_number")
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"job" text NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"trigger" text DEFAULT 'MANUAL' NOT NULL,
	"actor" text DEFAULT 'system' NOT NULL,
	"imported" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "role" DEFAULT 'VIEWER' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "variant_stocks" (
	"id" text PRIMARY KEY NOT NULL,
	"variant_id" text NOT NULL,
	"warehouse_id" text NOT NULL,
	"remain_quantity" integer DEFAULT 0 NOT NULL,
	"actual_remain_quantity" integer DEFAULT 0 NOT NULL,
	"total_quantity" integer DEFAULT 0 NOT NULL,
	"pending_quantity" integer DEFAULT 0 NOT NULL,
	"returning_quantity" integer DEFAULT 0 NOT NULL,
	"waiting_quantity" integer DEFAULT 0 NOT NULL,
	"selling_avg" double precision,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"full_address" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"province_id" text,
	"district_id" text,
	"commune_id" text,
	"custom_id" text,
	"allow_create_order" boolean DEFAULT true NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"event_type" text DEFAULT '' NOT NULL,
	"external_id" text,
	"payload" jsonb NOT NULL,
	"headers" jsonb,
	"status" text DEFAULT 'RECEIVED' NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_histories" ADD CONSTRAINT "inventory_histories_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_histories" ADD CONSTRAINT "inventory_histories_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_cod_batch_id_cod_batches_id_fk" FOREIGN KEY ("cod_batch_id") REFERENCES "public"."cod_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_stocks" ADD CONSTRAINT "variant_stocks_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_stocks" ADD CONSTRAINT "variant_stocks_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_spends_platform_date_idx" ON "ad_spends" USING btree ("platform","spend_date");--> statement-breakpoint
CREATE INDEX "ad_spends_date_idx" ON "ad_spends" USING btree ("spend_date");--> statement-breakpoint
CREATE INDEX "audit_entity_created_idx" ON "audit_logs" USING btree ("entity","created_at");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "cod_batches_received_idx" ON "cod_batches" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "customers_phone_idx" ON "customers" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "customers_name_idx" ON "customers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "customers_updated_ext_idx" ON "customers" USING btree ("updated_at_external");--> statement-breakpoint
CREATE INDEX "expenses_cat_occurred_idx" ON "expenses" USING btree ("category","occurred_at");--> statement-breakpoint
CREATE INDEX "expenses_occurred_idx" ON "expenses" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "inv_hist_variant_idx" ON "inventory_histories" USING btree ("variant_id","inserted_at");--> statement-breakpoint
CREATE INDEX "inv_hist_inserted_idx" ON "inventory_histories" USING btree ("inserted_at");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_variant_idx" ON "order_items" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "order_returns_inserted_idx" ON "order_returns" USING btree ("inserted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_status_history_uq" ON "order_status_history" USING btree ("order_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "order_status_history_order_idx" ON "order_status_history" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_stage_inserted_idx" ON "orders" USING btree ("stage","inserted_at");--> statement-breakpoint
CREATE INDEX "orders_inserted_idx" ON "orders" USING btree ("inserted_at");--> statement-breakpoint
CREATE INDEX "orders_updated_ext_idx" ON "orders" USING btree ("updated_at_external");--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "orders_source_idx" ON "orders" USING btree ("source");--> statement-breakpoint
CREATE INDEX "orders_system_idx" ON "orders" USING btree ("system_id");--> statement-breakpoint
CREATE INDEX "orders_bill_phone_idx" ON "orders" USING btree ("bill_phone");--> statement-breakpoint
CREATE INDEX "variants_sku_idx" ON "product_variants" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "variants_product_idx" ON "product_variants" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "variants_remain_idx" ON "product_variants" USING btree ("remain_quantity");--> statement-breakpoint
CREATE INDEX "products_name_idx" ON "products" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_events_uq" ON "shipment_events" USING btree ("shipment_id","source","status","occurred_at");--> statement-breakpoint
CREATE INDEX "shipment_events_shipment_idx" ON "shipment_events" USING btree ("shipment_id","occurred_at");--> statement-breakpoint
CREATE INDEX "shipments_stage_idx" ON "shipments" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "shipments_cod_status_idx" ON "shipments" USING btree ("cod_status");--> statement-breakpoint
CREATE INDEX "shipments_carrier_idx" ON "shipments" USING btree ("carrier");--> statement-breakpoint
CREATE INDEX "shipments_tracking_idx" ON "shipments" USING btree ("tracking_code");--> statement-breakpoint
CREATE INDEX "shipments_final_sync_idx" ON "shipments" USING btree ("is_final","last_vtp_sync_at");--> statement-breakpoint
CREATE INDEX "sync_runs_source_started_idx" ON "sync_runs" USING btree ("source","started_at");--> statement-breakpoint
CREATE INDEX "sync_runs_started_idx" ON "sync_runs" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "variant_stocks_variant_warehouse_uq" ON "variant_stocks" USING btree ("variant_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "variant_stocks_warehouse_idx" ON "variant_stocks" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "webhook_events_source_received_idx" ON "webhook_events" USING btree ("source","received_at");--> statement-breakpoint
CREATE INDEX "webhook_events_status_idx" ON "webhook_events" USING btree ("status");