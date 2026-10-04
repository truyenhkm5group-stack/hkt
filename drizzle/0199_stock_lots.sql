-- 0199 · LÔ & HẠN DÙNG (module `lots` — docs/verticals/food-lots.md).
--
--  · `stock_lots`: lớp GẮN THÊM lên MỘT dòng phiếu kho dương (nhập / tái nhập / điều chỉnh tăng): mã lô · hạn dùng · ngày sản
--    xuất (tuỳ chọn) · số lượng. Tổng các lô của một dòng không vượt số của dòng (kiểm ở đường ghi sau khoá tư vấn theo dòng).
--  · Lô KHÔNG tham gia phép tính tồn nào (luật 10): tồn thực tế vẫn chỉ đọc từ phiếu kho − đã xuất. «Lô còn bao nhiêu» là ước
--    tính lúc đọc. Xoá phiếu ⇒ xoá dòng ⇒ xoá lô (cascade) — lô không sống lâu hơn chứng từ của nó.
--  · Module MỚI mặc định TẮT ở tổ chức nhà (như `stays` ở 0197).
--  · CSDL mọi tổ chức. Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "stock_lots" (
  "id" text PRIMARY KEY NOT NULL,
  "receipt_item_id" text NOT NULL REFERENCES "stock_receipt_items"("id") ON DELETE CASCADE,
  "variant_id" text NOT NULL REFERENCES "product_variants"("id") ON DELETE CASCADE,
  "lot_code" text NOT NULL,
  "expires_on" date NOT NULL,
  "produced_on" date,
  "quantity" integer NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "stock_lots_qty_check" CHECK ("quantity" > 0),
  CONSTRAINT "stock_lots_code_check" CHECK (length(btrim("lot_code")) BETWEEN 1 AND 60),
  CONSTRAINT "stock_lots_dates_check" CHECK ("produced_on" IS NULL OR "produced_on" <= "expires_on")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_lots_item_code_uq" ON "stock_lots" ("receipt_item_id", lower("lot_code"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_lots_variant_idx" ON "stock_lots" ("variant_id", "expires_on");--> statement-breakpoint
INSERT INTO "platform_organization_modules" ("organization_id", "module_key", "enabled", "features", "config", "disabled_at", "updated_by")
SELECT "id", 'lots', false, '{}'::jsonb, '{}'::jsonb, now(), 'system:0199'
FROM "platform_organizations" WHERE "is_home"
ON CONFLICT ("organization_id", "module_key") DO NOTHING;
