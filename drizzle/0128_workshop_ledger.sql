-- 0128 · SỔ ĐẶT XƯỞNG: lô sản xuất, đợt xưởng trả hàng, đợt đặt / nhập vải, đợt thanh toán.
-- Thay bảng tính "BÁO CÁO ĐẶT HÀNG" (trang Thành phẩm + trang Vải). Luật tính: lib/constants/workshop-ledger.ts.
--
-- CHỈ THÊM BẢNG MỚI. Không đụng một dòng nào đã có, không backfill (AGENTS.md mục 35): lịch sử trên
-- bảng tính do người nhập lại, ERP không đoán hộ. Bốn bảng này là CÔNG NỢ và GIÁ THÀNH — không bảng
-- nào được đọc bởi báo cáo lợi nhuận (giá vốn đi theo phiếu kho, mục 15).
-- Viết tay và idempotent như 0033–0127 (không dùng db:generate).

CREATE TABLE IF NOT EXISTS "production_batches" (
  "id" text PRIMARY KEY NOT NULL,
  "product_id" text,
  "product_code" text NOT NULL,
  "product_name" text DEFAULT '' NOT NULL,
  "batch_no" integer NOT NULL,
  "supplier" text DEFAULT '' NOT NULL,
  "supplier_id" text,
  "production_order_id" text,
  "ordered_at" timestamp with time zone NOT NULL,
  "ordered_qty" integer NOT NULL,
  -- NULL = CHƯA CHỐT số lượng thanh toán với xưởng (không phải 0).
  "agreed_qty" integer,
  "due_date" timestamp with time zone,
  -- NULL = CHƯA BIẾT đơn giá (không phải 0đ).
  "labor_unit_price" integer,
  "adjustment" integer DEFAULT 0 NOT NULL,
  "adjustment_note" text DEFAULT '' NOT NULL,
  "fabric_source" text DEFAULT 'SHOP' NOT NULL,
  "status" text DEFAULT 'OPEN' NOT NULL,
  "done_at" timestamp with time zone,
  "note" text DEFAULT '' NOT NULL,
  "created_by_user_id" text,
  "created_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "production_batches_status_check" CHECK ("status" IN ('OPEN', 'DONE', 'CANCELLED')),
  CONSTRAINT "production_batches_fabric_source_check" CHECK ("fabric_source" IN ('SHOP', 'WORKSHOP')),
  CONSTRAINT "production_batches_qty_check" CHECK ("ordered_qty" >= 0 AND "batch_no" > 0 AND ("agreed_qty" IS NULL OR "agreed_qty" >= 0)),
  CONSTRAINT "production_batches_price_check" CHECK ("labor_unit_price" IS NULL OR "labor_unit_price" >= 0),
  CONSTRAINT "production_batches_code_check" CHECK (length(trim("product_code")) > 0)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_production_order_id_production_orders_id_fk" FOREIGN KEY ("production_order_id") REFERENCES "public"."production_orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
-- Danh tính của lô = mã hàng + số lô. Trùng thì tiền trả xưởng không biết đi về lô nào.
CREATE UNIQUE INDEX IF NOT EXISTS "production_batches_code_no_uq" ON "production_batches" ("product_code", "batch_no");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_batches_ordered_idx" ON "production_batches" ("ordered_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "production_deliveries" (
  "id" text PRIMARY KEY NOT NULL,
  "batch_id" text NOT NULL,
  "delivered_at" timestamp with time zone NOT NULL,
  "quantity" integer NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "created_by_user_id" text,
  "created_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "production_deliveries_qty_check" CHECK ("quantity" <> 0)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "production_deliveries" ADD CONSTRAINT "production_deliveries_batch_id_production_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."production_batches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "production_deliveries" ADD CONSTRAINT "production_deliveries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_deliveries_batch_idx" ON "production_deliveries" ("batch_id", "delivered_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fabric_orders" (
  "id" text PRIMARY KEY NOT NULL,
  "product_id" text,
  "product_code" text DEFAULT '' NOT NULL,
  "batch_id" text,
  "supplier" text DEFAULT '' NOT NULL,
  "supplier_id" text,
  "description" text DEFAULT '' NOT NULL,
  "ordered_at" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone,
  "quantity" double precision,
  "unit" text DEFAULT '' NOT NULL,
  "unit_price" integer,
  "amount" integer NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "created_by_user_id" text,
  "created_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fabric_orders_amount_check" CHECK ("amount" >= 0 AND ("quantity" IS NULL OR "quantity" >= 0) AND ("unit_price" IS NULL OR "unit_price" >= 0))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "fabric_orders" ADD CONSTRAINT "fabric_orders_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "fabric_orders" ADD CONSTRAINT "fabric_orders_batch_id_production_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."production_batches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "fabric_orders" ADD CONSTRAINT "fabric_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "fabric_orders" ADD CONSTRAINT "fabric_orders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fabric_orders_batch_idx" ON "fabric_orders" ("batch_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fabric_orders_code_idx" ON "fabric_orders" ("product_code", "ordered_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "supplier_payments" (
  "id" text PRIMARY KEY NOT NULL,
  "batch_id" text,
  "fabric_order_id" text,
  "kind" text DEFAULT 'PAYMENT' NOT NULL,
  "amount" integer NOT NULL,
  "paid_at" timestamp with time zone NOT NULL,
  "method" text DEFAULT 'BANK' NOT NULL,
  "reference" text DEFAULT '' NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "created_by_user_id" text,
  "created_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Gắn ĐÚNG MỘT: một lô (xưởng may) hoặc một đợt vải (nhà vải). Không gắn gì là tiền trôi nổi.
  CONSTRAINT "supplier_payments_target_check" CHECK (("batch_id" IS NULL) <> ("fabric_order_id" IS NULL)),
  CONSTRAINT "supplier_payments_kind_check" CHECK ("kind" IN ('DEPOSIT', 'PAYMENT', 'REFUND')),
  CONSTRAINT "supplier_payments_method_check" CHECK ("method" IN ('BANK', 'CASH', 'OTHER')),
  CONSTRAINT "supplier_payments_amount_check" CHECK ("amount" > 0)
);
--> statement-breakpoint
-- RESTRICT: xoá một lô / đợt vải đã có tiền trả là xoá luôn dấu vết tiền đã đi.
DO $$ BEGIN
  ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_batch_id_production_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."production_batches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_fabric_order_id_fabric_orders_id_fk" FOREIGN KEY ("fabric_order_id") REFERENCES "public"."fabric_orders"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_payments_batch_idx" ON "supplier_payments" ("batch_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_payments_fabric_idx" ON "supplier_payments" ("fabric_order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_payments_paid_idx" ON "supplier_payments" ("paid_at");
