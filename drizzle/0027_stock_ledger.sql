-- IDEMPOTENT: chạy lại được sau khi một migration trước đó thất bại giữa chừng.
-- Sổ kho: phiếu tái nhập hàng hoàn cần truy nguyên về vận đơn nào đã thực sự về tới kho.
ALTER TABLE "stock_receipt_items" ADD COLUMN IF NOT EXISTS "shipment_id" text;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "stock_receipt_items" ADD CONSTRAINT "stock_receipt_items_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_receipt_items_shipment_idx" ON "stock_receipt_items" USING btree ("shipment_id");
