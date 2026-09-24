-- Vòng mẫu: thiết kế mới đủ MOQ (chủ shop chốt 24/09/2026: 50 đơn) ⇒ máy dựng NHÁP lệnh sản xuất
-- (docs/creative-loop.md §5h).
--
-- Viết tay, idempotent (AGENTS.md mục 4 — không dùng db:generate):
--  · `design_concepts` thêm bốn cột: `production_order_id` (nối thiết kế ↔ lệnh sản xuất), `moq_reached_at`
--    (mốc máy thấy đủ MOQ — KHOÁ LŨY ĐẲNG: đã có mốc thì không bao giờ dựng nháp thứ hai, kể cả khi người
--    xoá nháp), `moq_notified_at` (tin báo đã gửi) và `moq_snapshot` (căn cứ lúc dựng: số đơn theo từng
--    đường đếm, số lượng biết / chưa biết).
--  · `production_orders.unit_cost` bỏ NOT NULL: nháp của máy không có căn cứ giá gia công ⇒ `NULL` = CHƯA
--    BIẾT (mục 42), không phải 0đ. Mặc định 0 giữ nguyên nên đường lập lệnh tay không đổi; mọi chỗ đọc hiện
--    có đã coi 0 là "chưa nhập" và `sum()` bỏ qua `NULL`.
-- Không đụng dòng nào đã có, không backfill (mục 35): thiết kế cũ chưa từng được máy xét MOQ nên NULL là
-- đúng sự thật.
ALTER TABLE "design_concepts" ADD COLUMN IF NOT EXISTS "production_order_id" text;
--> statement-breakpoint
ALTER TABLE "design_concepts" ADD COLUMN IF NOT EXISTS "moq_reached_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "design_concepts" ADD COLUMN IF NOT EXISTS "moq_notified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "design_concepts" ADD COLUMN IF NOT EXISTS "moq_snapshot" jsonb;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "design_concepts" ADD CONSTRAINT "design_concepts_production_order_id_production_orders_id_fk" FOREIGN KEY ("production_order_id") REFERENCES "public"."production_orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "design_concepts_production_order_uq" ON "design_concepts" ("production_order_id") WHERE "production_order_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "production_orders" ALTER COLUMN "unit_cost" DROP NOT NULL;
