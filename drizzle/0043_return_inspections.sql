-- IDEMPOTENT: chạy lại được sau khi một migration trước đó thất bại giữa chừng.
--
-- KIỂM HÀNG HOÀN — tách vòng đời thật ra khỏi một ô ngày duy nhất.
--
-- Đo trên production 09/09/2026: 445 vận đơn ở trạng thái HOÀN mà kho chưa xác nhận, 497 món, và
-- KHÔNG kiện nào có phiếu tái nhập. Cơ chế cũ chỉ có một mốc `shipments.return_received_at`, và khi
-- bấm xác nhận thì cộng NGUYÊN số đã xuất trở lại tồn.
--
-- Vấn đề: một kiện hàng về có thể thiếu món, rách, bẩn. Cộng nguyên số đã xuất là ghi vào sổ một
-- lượng hàng không có thật, và phần chênh đó nằm im trong số tồn — không ai tìm ra được.
--
-- Bảng này ghi lại đúng những gì người kiểm thấy: đếm được bao nhiêu, bán lại được bao nhiêu, hỏng
-- bao nhiêu, và vì sao. Chỉ phần BÁN LẠI ĐƯỢC mới sinh phiếu tái nhập.
--
-- KHÔNG đụng tới `shipments.return_received_at`: cơ chế cũ vẫn chạy nguyên vẹn cho dữ liệu cũ.
CREATE TABLE IF NOT EXISTS "return_inspections" (
  "id" text PRIMARY KEY NOT NULL,
  "shipment_id" text NOT NULL,
  "order_id" text,
  "status" text NOT NULL DEFAULT 'RECEIVED',
  "received_at" timestamptz NOT NULL,
  "received_by" text NOT NULL DEFAULT '',
  "inspected_at" timestamptz,
  "inspected_by" text,
  "condition" text,
  "restock_qty" integer NOT NULL DEFAULT 0,
  "unsellable_qty" integer NOT NULL DEFAULT 0,
  "note" text NOT NULL DEFAULT '',
  "stock_receipt_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "return_inspections_shipment_uq" ON "return_inspections" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_inspections_status_idx" ON "return_inspections" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_inspections_order_idx" ON "return_inspections" USING btree ("order_id");--> statement-breakpoint

DO $$
BEGIN
  ALTER TABLE "return_inspections" DROP CONSTRAINT IF EXISTS "return_inspections_shipment_id_shipments_id_fk";
  ALTER TABLE "return_inspections" ADD CONSTRAINT "return_inspections_shipment_id_shipments_id_fk"
    FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE cascade;
  ALTER TABLE "return_inspections" DROP CONSTRAINT IF EXISTS "return_inspections_order_id_orders_id_fk";
  ALTER TABLE "return_inspections" ADD CONSTRAINT "return_inspections_order_id_orders_id_fk"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE set null;
  ALTER TABLE "return_inspections" DROP CONSTRAINT IF EXISTS "return_inspections_stock_receipt_id_stock_receipts_id_fk";
  ALTER TABLE "return_inspections" ADD CONSTRAINT "return_inspections_stock_receipt_id_stock_receipts_id_fk"
    FOREIGN KEY ("stock_receipt_id") REFERENCES "stock_receipts"("id") ON DELETE set null;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
END $$;--> statement-breakpoint

-- Ràng buộc nghiệp vụ. NOT VALID: không quét lại bảng (bảng mới nên rỗng), và không chặn dữ liệu cũ.
DO $$
BEGIN
  ALTER TABLE "return_inspections" DROP CONSTRAINT IF EXISTS "return_inspections_status_check";
  ALTER TABLE "return_inspections" ADD CONSTRAINT "return_inspections_status_check"
    CHECK ("status" IN ('RECEIVED', 'INSPECTED')) NOT VALID;
  ALTER TABLE "return_inspections" DROP CONSTRAINT IF EXISTS "return_inspections_condition_check";
  ALTER TABLE "return_inspections" ADD CONSTRAINT "return_inspections_condition_check"
    CHECK ("condition" IS NULL OR "condition" IN ('RESTOCKABLE', 'UNSELLABLE', 'DAMAGED', 'MISSING')) NOT VALID;
  -- Đã kiểm thì PHẢI biết ai kiểm và kết luận gì.
  ALTER TABLE "return_inspections" DROP CONSTRAINT IF EXISTS "return_inspections_inspected_check";
  ALTER TABLE "return_inspections" ADD CONSTRAINT "return_inspections_inspected_check"
    CHECK ("status" <> 'INSPECTED' OR ("condition" IS NOT NULL AND "inspected_at" IS NOT NULL AND "inspected_by" IS NOT NULL AND length(trim("inspected_by")) > 0)) NOT VALID;
  -- Kết luận KHÔNG bán được thì phải nói vì sao, nếu không phần hàng mất biến mất không dấu vết.
  ALTER TABLE "return_inspections" DROP CONSTRAINT IF EXISTS "return_inspections_reason_check";
  ALTER TABLE "return_inspections" ADD CONSTRAINT "return_inspections_reason_check"
    CHECK ("condition" IS NULL OR "condition" = 'RESTOCKABLE' OR length(trim("note")) > 0) NOT VALID;
  ALTER TABLE "return_inspections" DROP CONSTRAINT IF EXISTS "return_inspections_qty_check";
  ALTER TABLE "return_inspections" ADD CONSTRAINT "return_inspections_qty_check"
    CHECK ("restock_qty" >= 0 AND "unsellable_qty" >= 0) NOT VALID;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
END $$;
