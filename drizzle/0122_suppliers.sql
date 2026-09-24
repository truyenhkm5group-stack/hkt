-- ═══════════ DANH MỤC XƯỞNG / NHÀ CUNG CẤP ═══════════
--
-- Trước đây "xưởng" là ô chữ tự do ở `production_orders.supplier` và `stock_receipts.supplier`, nên
-- thời gian giao và giá nhập theo TỪNG xưởng chỉ ghép được bằng chữ (AGENTS.md mục 39: nối yếu).
--
-- THUẦN BỔ SUNG: một bảng mới + một cột `supplier_id` (NULL được) ở hai bảng. KHÔNG backfill (mục 35):
-- dòng cũ giữ `supplier_id` NULL, và chỉ được quy về xưởng LÚC ĐỌC khi tên của nó khớp ĐÚNG MỘT xưởng
-- (tên hoặc tên gọi khác) trong danh mục. Ô chữ cũ vẫn giữ nguyên làm ảnh chụp tên lúc ghi.
CREATE TABLE IF NOT EXISTS "suppliers" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "phone" text DEFAULT '' NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "suppliers_name_uq" ON "suppliers" (lower("name"));
--> statement-breakpoint
ALTER TABLE "production_orders" ADD COLUMN IF NOT EXISTS "supplier_id" text REFERENCES "suppliers"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD COLUMN IF NOT EXISTS "supplier_id" text REFERENCES "suppliers"("id") ON DELETE SET NULL;
