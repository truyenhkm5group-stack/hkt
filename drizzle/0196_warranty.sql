-- 0196 · BẢO HÀNH & ĐỔI TRẢ THEO SERIAL (module `warranty` — docs/verticals/household.md).
--
--  · `warranty_cards`: phiếu bảo hành — khách · sản phẩm (mẫu mã, tên chụp lại) · serial (tuỳ chọn) · ngày mua · số tháng ⇒ hạn.
--    Một serial chỉ thuộc MỘT phiếu đang hiệu lực (chỉ mục duy nhất có điều kiện). Huỷ phiếu bắt buộc lý do.
--  · `warranty_claims`: ca bảo hành — mở (mô tả lỗi) → đang xử lý → xong (cách xử lý) / từ chối (lý do). "Còn bảo hành" KHÔNG
--    lưu: tính lúc đọc từ ngày mở ca so với hạn của phiếu. Chi phí / tiền thu khách: NULL = chưa biết, không phải 0.
--  · Module MỚI mặc định TẮT ở tổ chức nhà (như `appointments` ở 0190).
--  · CSDL mọi tổ chức. Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "warranty_cards" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "variant_id" text,
  "product_name" text NOT NULL,
  "serial" text,
  "order_id" text,
  "purchased_on" date NOT NULL,
  "months" integer NOT NULL,
  "expires_on" date NOT NULL,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "void_reason" text,
  "note" text DEFAULT '' NOT NULL,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "warranty_cards_months_check" CHECK ("months" BETWEEN 1 AND 120),
  CONSTRAINT "warranty_cards_expiry_check" CHECK ("expires_on" > "purchased_on"),
  CONSTRAINT "warranty_cards_status_check" CHECK ("status" IN ('ACTIVE','VOID')),
  CONSTRAINT "warranty_cards_void_check" CHECK ("status" <> 'VOID' OR length(btrim(coalesce("void_reason", ''))) >= 3),
  CONSTRAINT "warranty_cards_serial_check" CHECK ("serial" IS NULL OR length(btrim("serial")) BETWEEN 1 AND 80),
  CONSTRAINT "warranty_cards_name_check" CHECK (length(trim("product_name")) BETWEEN 1 AND 200)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "warranty_cards_customer_idx" ON "warranty_cards" ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "warranty_cards_serial_active_uq" ON "warranty_cards" (lower("serial")) WHERE "serial" IS NOT NULL AND "status" = 'ACTIVE';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "warranty_claims" (
  "id" text PRIMARY KEY NOT NULL,
  "card_id" text NOT NULL REFERENCES "warranty_cards"("id") ON DELETE CASCADE,
  "opened_at" timestamp with time zone DEFAULT now() NOT NULL,
  "issue" text NOT NULL,
  "status" text DEFAULT 'OPEN' NOT NULL,
  "resolution" text,
  "reject_reason" text,
  "cost_vnd" integer,
  "charged_vnd" integer,
  "assignee_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "closed_at" timestamp with time zone,
  "note" text DEFAULT '' NOT NULL,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "warranty_claims_issue_check" CHECK (length(btrim("issue")) BETWEEN 5 AND 1000),
  CONSTRAINT "warranty_claims_status_check" CHECK ("status" IN ('OPEN','IN_PROGRESS','DONE','REJECTED')),
  CONSTRAINT "warranty_claims_resolution_check" CHECK ("resolution" IS NULL OR "resolution" IN ('REPAIRED','REPLACED','REFUNDED','RETURNED_TO_SUPPLIER','NO_FAULT')),
  CONSTRAINT "warranty_claims_done_check" CHECK ("status" <> 'DONE' OR "resolution" IS NOT NULL),
  CONSTRAINT "warranty_claims_reject_check" CHECK ("status" <> 'REJECTED' OR length(btrim(coalesce("reject_reason", ''))) >= 3),
  CONSTRAINT "warranty_claims_money_check" CHECK (("cost_vnd" IS NULL OR "cost_vnd" >= 0) AND ("charged_vnd" IS NULL OR "charged_vnd" >= 0))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "warranty_claims_card_idx" ON "warranty_claims" ("card_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "warranty_claims_status_idx" ON "warranty_claims" ("status", "opened_at");--> statement-breakpoint
INSERT INTO "platform_organization_modules" ("organization_id", "module_key", "enabled", "features", "config", "disabled_at", "updated_by")
SELECT "id", 'warranty', false, '{}'::jsonb, '{}'::jsonb, now(), 'system:0196'
FROM "platform_organizations" WHERE "is_home"
ON CONFLICT ("organization_id", "module_key") DO NOTHING;
