-- 0132 · COMPANY OS · AGENT D — PHIẾU NHẬP NỐI VỀ LỆNH SẢN XUẤT / LÔ XƯỞNG.
--
-- Hai cột NULL được trên `stock_receipts`: phiếu NHẬP HÀNG này nhận hàng của lệnh sản xuất nào và
-- của lô đặt xưởng nào. Xoá lệnh / lô thì phiếu KHÔNG mất, chỉ rơi về "chưa khai" (ON DELETE SET NULL)
-- — phiếu kho là chứng từ tồn, không được đi theo vòng đời của một bản kế hoạch.
--
-- KHÔNG BACKFILL (AGENTS.md mục 35): đoán lô cho phiếu cũ theo tên xưởng / ngày nhập là bịa một quy
-- kết. Phiếu cũ để NULL và màn hình in "—".
-- Viết tay và idempotent như 0033–0130.

ALTER TABLE "stock_receipts" ADD COLUMN IF NOT EXISTS "production_order_id" text;
--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD COLUMN IF NOT EXISTS "production_batch_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_production_order_id_production_orders_id_fk" FOREIGN KEY ("production_order_id") REFERENCES "public"."production_orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_production_batch_id_production_batches_id_fk" FOREIGN KEY ("production_batch_id") REFERENCES "public"."production_batches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_receipts_production_order_idx" ON "stock_receipts" ("production_order_id") WHERE "production_order_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_receipts_production_batch_idx" ON "stock_receipts" ("production_batch_id") WHERE "production_batch_id" IS NOT NULL;
