-- 0127 · SỔ ĐƠN CHỜ HÀNG: ghi lại đơn nào ERP kết luận "chờ hàng", từ lúc nào tới lúc nào.
-- Chủ shop yêu cầu 25/09/2026: thống kê số đơn thiếu hàng THEO NGÀY và GTC của đơn từng chờ hàng.
--
-- CHỈ THÊM BẢNG MỚI. Không backfill (AGENTS.md mục 35): phép phân bổ thiếu hàng chưa từng được ghi,
-- nên ngày trước lần ghi đầu tiên là CHƯA ĐO — bảng sinh ra RỖNG là đúng sự thật.
-- Viết tay và idempotent như 0033–0126 (không dùng db:generate).
CREATE TABLE IF NOT EXISTS "stock_wait_log" (
  "order_id" text PRIMARY KEY NOT NULL,
  "first_seen_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL,
  "cleared_at" timestamp with time zone,
  "max_short_units" integer DEFAULT 0 NOT NULL,
  "short_labels" text DEFAULT '' NOT NULL,
  "episodes" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "stock_wait_log" ADD CONSTRAINT "stock_wait_log_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_wait_log_first_seen_idx" ON "stock_wait_log" ("first_seen_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_wait_log_open_idx" ON "stock_wait_log" ("order_id") WHERE "cleared_at" is null;
