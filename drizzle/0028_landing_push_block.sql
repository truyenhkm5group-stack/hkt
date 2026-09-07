-- IDEMPOTENT. Lý do dòng landing chưa gửi POS được (thiếu mẫu mã / SĐT / địa chỉ không đủ tỉnh thành).
ALTER TABLE "landing_orders" ADD COLUMN IF NOT EXISTS "push_block" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landing_orders_push_block_idx" ON "landing_orders" USING btree ("push_block");
