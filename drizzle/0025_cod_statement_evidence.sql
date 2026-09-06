-- IDEMPOTENT: chi tiết bảng kê Viettel Post là chứng từ gốc của tiền COD.
-- Chỉ thêm cột nullable + index, không ghi lại dữ liệu cũ.
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "cod_statement_ref" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "cod_statement_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipments_cod_statement_idx" ON "shipments" USING btree ("cod_statement_ref");