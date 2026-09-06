-- IDEMPOTENT: chạy lại được sau khi một migration trước đó thất bại giữa chừng.
-- Kho thực nhận hàng hoàn. Chỉ thêm cột nullable + index; không ghi lại dữ liệu cũ.
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "return_received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "return_received_by" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "return_received_note" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipments_return_received_idx" ON "shipments" USING btree ("return_received_at");