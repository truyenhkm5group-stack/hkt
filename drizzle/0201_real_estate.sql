-- 0201 · BẢNG HÀNG BẤT ĐỘNG SẢN — giỏ hàng căn, giữ chỗ có hạn, cọc, ký bán (module `real_estate` — docs/verticals/real-estate.md).
--
--  · `re_projects`: dự án; `hold_hours` = số giờ một lượt giữ chỗ còn hiệu lực — BẮT BUỘC khai khi tạo dự án (quyết định kinh
--    doanh, luật 38: không có mặc định).
--  · `re_units`: căn của dự án (mã duy nhất trong dự án). Giá / diện tích NULL = chưa công bố. Khoá (chủ đầu tư rút căn) và đã
--    bán là hai mốc riêng có lý do / số hợp đồng. Trạng thái căn KHÔNG lưu cột — tính lúc đọc.
--  · `re_holds`: lượt giữ chỗ của MỘT sale cho MỘT khách, có hạn. Chỉ mục duy nhất có điều kiện: mỗi căn nhiều nhất MỘT dòng
--    ACTIVE — đường ghi chuyển dòng quá hạn sang EXPIRED trước khi giữ mới, nên «hai sale giữ trùng một căn» bị chặn ở CSDL.
--  · `re_deposits`: cọc; mỗi căn nhiều nhất MỘT khoản ACTIVE. Hoàn / khách bỏ cọc cần lý do; ký bán chuyển cọc thành CONVERTED.
--  · Module MỚI mặc định TẮT ở tổ chức nhà. CSDL mọi tổ chức. Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "re_projects" (
  "id" text PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "hold_hours" integer NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "re_projects_hold_check" CHECK ("hold_hours" BETWEEN 1 AND 720),
  CONSTRAINT "re_projects_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 160),
  CONSTRAINT "re_projects_code_check" CHECK (length(btrim("code")) BETWEEN 1 AND 40)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "re_projects_code_uq" ON "re_projects" (lower("code"));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "re_units" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "re_projects"("id") ON DELETE CASCADE,
  "code" text NOT NULL,
  "block" text DEFAULT '' NOT NULL,
  "floor" text DEFAULT '' NOT NULL,
  "area_m2" double precision,
  "list_price" bigint,
  "note" text DEFAULT '' NOT NULL,
  "locked_at" timestamp with time zone,
  "locked_reason" text,
  "sold_at" timestamp with time zone,
  "sold_contract" text,
  "sold_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "re_units_code_check" CHECK (length(btrim("code")) BETWEEN 1 AND 40),
  CONSTRAINT "re_units_area_check" CHECK ("area_m2" IS NULL OR "area_m2" > 0),
  CONSTRAINT "re_units_price_check" CHECK ("list_price" IS NULL OR "list_price" >= 0),
  CONSTRAINT "re_units_lock_check" CHECK ("locked_at" IS NULL OR length(btrim(coalesce("locked_reason", ''))) >= 3),
  CONSTRAINT "re_units_sold_check" CHECK ("sold_at" IS NULL OR length(btrim(coalesce("sold_contract", ''))) >= 1)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "re_units_project_code_uq" ON "re_units" ("project_id", lower("code"));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "re_holds" (
  "id" text PRIMARY KEY NOT NULL,
  "unit_id" text NOT NULL REFERENCES "re_units"("id") ON DELETE CASCADE,
  "sale_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "sale_name" text DEFAULT '' NOT NULL,
  "customer_name" text NOT NULL,
  "customer_phone" text DEFAULT '' NOT NULL,
  "held_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "closed_at" timestamp with time zone,
  "close_reason" text,
  CONSTRAINT "re_holds_status_check" CHECK ("status" IN ('ACTIVE','RELEASED','EXPIRED','CONVERTED')),
  CONSTRAINT "re_holds_window_check" CHECK ("expires_at" > "held_at"),
  CONSTRAINT "re_holds_customer_check" CHECK (length(btrim("customer_name")) BETWEEN 1 AND 160)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "re_holds_one_active_uq" ON "re_holds" ("unit_id") WHERE "status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "re_holds_sale_idx" ON "re_holds" ("sale_user_id", "status");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "re_deposits" (
  "id" text PRIMARY KEY NOT NULL,
  "unit_id" text NOT NULL REFERENCES "re_units"("id") ON DELETE CASCADE,
  "hold_id" text REFERENCES "re_holds"("id") ON DELETE SET NULL,
  "sale_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "sale_name" text DEFAULT '' NOT NULL,
  "customer_name" text NOT NULL,
  "customer_phone" text DEFAULT '' NOT NULL,
  "amount" bigint NOT NULL,
  "deposited_at" timestamp with time zone DEFAULT now() NOT NULL,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "closed_at" timestamp with time zone,
  "close_reason" text,
  CONSTRAINT "re_deposits_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "re_deposits_status_check" CHECK ("status" IN ('ACTIVE','REFUNDED','FORFEITED','CONVERTED')),
  CONSTRAINT "re_deposits_close_check" CHECK ("status" NOT IN ('REFUNDED','FORFEITED') OR length(btrim(coalesce("close_reason", ''))) >= 3),
  CONSTRAINT "re_deposits_customer_check" CHECK (length(btrim("customer_name")) BETWEEN 1 AND 160)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "re_deposits_one_active_uq" ON "re_deposits" ("unit_id") WHERE "status" = 'ACTIVE';--> statement-breakpoint
INSERT INTO "platform_organization_modules" ("organization_id", "module_key", "enabled", "features", "config", "disabled_at", "updated_by")
SELECT "id", 'real_estate', false, '{}'::jsonb, '{}'::jsonb, now(), 'system:0201'
FROM "platform_organizations" WHERE "is_home"
ON CONFLICT ("organization_id", "module_key") DO NOTHING;
