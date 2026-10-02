-- 0188 · BẢNG GIÁ SỈ + ĐIỀU KHOẢN BÁN CỦA KHÁCH (docs/verticals/price-lists-receivables.md).
--
--  · `price_lists` + `price_list_items`: bảng giá theo nhóm khách (đại lý, khách sỉ, CTV…) với bậc số lượng
--    (`min_quantity`). Tối đa MỘT bảng mặc định đang bật — áp cho khách chưa gán bảng nào. Không có dòng cho mẫu mã ⇒
--    rơi về giá lẻ của mẫu mã, KHÔNG phải giá 0.
--  · `customer_trade_terms`: bảng riêng thay vì thêm cột vào `customers` — `customers` là bảng ĐỒNG BỘ từ Pancake ở tổ
--    chức nhà; điều khoản bán là dữ liệu của ERP. `credit_limit` / `payment_terms_days` NULL = CHƯA KHAI (không giới
--    hạn, không tính quá hạn), không phải 0.
--  · Công nợ KHÔNG có bảng: nó là Σ (số phải trả − Σ chứng từ còn hiệu lực) của đơn tay chưa huỷ, đọc từ `order_payments`
--    (ORDER_OUTCOME.md mục 11.1). Thu nợ gộp ghi ĐÚNG các phiếu thu theo từng đơn.
--  · CSDL mọi tổ chức. Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "price_lists" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "price_lists_name_check" CHECK (length(trim("name")) BETWEEN 1 AND 80)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_lists_one_default" ON "price_lists" ("is_default") WHERE "is_default" AND "active";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_lists_name_key" ON "price_lists" (lower("name"));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_list_items" (
  "id" text PRIMARY KEY NOT NULL,
  "price_list_id" text NOT NULL REFERENCES "price_lists"("id") ON DELETE CASCADE,
  "variant_id" text NOT NULL,
  "min_quantity" integer DEFAULT 1 NOT NULL,
  "unit_price" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "price_list_items_min_quantity_check" CHECK ("min_quantity" BETWEEN 1 AND 100000),
  CONSTRAINT "price_list_items_unit_price_check" CHECK ("unit_price" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_list_items_tier_key" ON "price_list_items" ("price_list_id", "variant_id", "min_quantity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_list_items_variant_idx" ON "price_list_items" ("variant_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_trade_terms" (
  "customer_id" text PRIMARY KEY NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "price_list_id" text REFERENCES "price_lists"("id") ON DELETE SET NULL,
  "credit_limit" integer,
  "payment_terms_days" integer,
  "updated_by_user_id" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customer_trade_terms_credit_check" CHECK ("credit_limit" IS NULL OR "credit_limit" >= 0),
  CONSTRAINT "customer_trade_terms_terms_check" CHECK ("payment_terms_days" IS NULL OR "payment_terms_days" BETWEEN 0 AND 365)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_trade_terms_price_list_idx" ON "customer_trade_terms" ("price_list_id");
