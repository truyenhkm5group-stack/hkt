-- 0136 · COMPANY OS · AGENT E — KẾT CỤC CỦA HÀNG HOÀN KHÔNG TÁI NHẬP.
--
-- Sổ GHI THÊM `return_dispositions`: món hàng hoàn đã kiểm là không bán ngay được (hỏng · bẩn · sai
-- hàng · không bán được) đi tiếp tới đâu — sửa / giặt lại, nhập lại tồn sau khi sửa, huỷ bỏ, trả
-- xưởng. Mỗi dòng là quyết định của MỘT NGƯỜI (khoá tài khoản bắt buộc, AGENTS.md mục 34).
--
-- KHÔNG BACKFILL (mục 8.8, 35): món đã kiểm trước bản này không có dòng nào và hiện ra là "Chưa quyết"
-- — gieo một kết cục cho chúng là bịa quyết định của người. Nhập lại tồn chỉ qua phiếu RETURN
-- (`stock_receipt_id`), huỷ bỏ không ghi sổ kho. Luật: lib/constants/return-disposition.ts.
-- Viết tay và idempotent như 0033–0132.

CREATE TABLE IF NOT EXISTS "return_dispositions" (
  "id" text PRIMARY KEY NOT NULL,
  "inspection_id" text NOT NULL,
  "inspection_item_id" text,
  "subject_key" text NOT NULL,
  "disposition" text NOT NULL,
  "qty" integer NOT NULL,
  "variant_id" text,
  "stock_receipt_id" text,
  "unit_cost_estimate" integer,
  "cost_basis" text,
  "value_estimate" integer,
  "note" text DEFAULT '' NOT NULL,
  "actor_user_id" text NOT NULL,
  "actor_name" text DEFAULT '' NOT NULL,
  "request_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "return_dispositions_request_key_unique" UNIQUE("request_key"),
  CONSTRAINT "return_dispositions_disposition_check" CHECK ("disposition" IN ('PENDING_DECISION', 'REWORK', 'RESTOCK_AFTER_REWORK', 'WRITE_OFF', 'RETURN_TO_SUPPLIER')),
  CONSTRAINT "return_dispositions_qty_check" CHECK ("qty" > 0),
  CONSTRAINT "return_dispositions_subject_check" CHECK (("inspection_item_id" IS NULL AND "subject_key" = 'parcel:' || "inspection_id") OR ("inspection_item_id" IS NOT NULL AND "subject_key" = 'item:' || "inspection_item_id")),
  CONSTRAINT "return_dispositions_receipt_check" CHECK (("disposition" = 'RESTOCK_AFTER_REWORK') = ("stock_receipt_id" IS NOT NULL)),
  CONSTRAINT "return_dispositions_note_check" CHECK ("disposition" <> 'WRITE_OFF' OR length(trim("note")) > 0),
  CONSTRAINT "return_dispositions_value_check" CHECK (("disposition" = 'WRITE_OFF' OR ("unit_cost_estimate" IS NULL AND "value_estimate" IS NULL AND "cost_basis" IS NULL)) AND ("value_estimate" IS NULL OR "value_estimate" >= 0) AND ("cost_basis" IS NULL OR "cost_basis" IN ('RECEIPT', 'ORDER_SNAPSHOT', 'VARIANT_DEFAULT', 'UNKNOWN')))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "return_dispositions" ADD CONSTRAINT "return_dispositions_inspection_id_return_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."return_inspections"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "return_dispositions" ADD CONSTRAINT "return_dispositions_inspection_item_id_return_inspection_items_id_fk" FOREIGN KEY ("inspection_item_id") REFERENCES "public"."return_inspection_items"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "return_dispositions" ADD CONSTRAINT "return_dispositions_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "return_dispositions" ADD CONSTRAINT "return_dispositions_stock_receipt_id_stock_receipts_id_fk" FOREIGN KEY ("stock_receipt_id") REFERENCES "public"."stock_receipts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "return_dispositions" ADD CONSTRAINT "return_dispositions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_dispositions_subject_idx" ON "return_dispositions" ("subject_key", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_dispositions_inspection_idx" ON "return_dispositions" ("inspection_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_dispositions_variant_idx" ON "return_dispositions" ("variant_id");
