-- 0249 · PHÂN CÔNG MKTer ↔ MÃ SẢN PHẨM (nhiều-nhiều, OWNER / SUPPORT, có hiệu lực) và ĐIỀU KHOẢN THƯỞNG THEO MÃ (chủ shop 19/10/2026, Payroll V2).
--
-- VÌ SAO: thưởng theo mã cần biết AI phụ trách / đẩy cùng mã nào, TRONG KHOẢNG NÀO, với tỷ lệ nào — và phải giữ lịch sử khi đổi người
-- (không reset lỗ lũy kế của mã). Trước bản này chỉ có `payroll.config.productOwners` (một chủ mã, không mốc hiệu lực). Đặc tả:
-- docs/payroll-code-ledger.md. Chỉ TẠO hai bảng mới, không đổi bảng nào mã đang đọc. Không gieo dòng nào. Idempotent.
CREATE TABLE IF NOT EXISTS "product_marketer_assignments" (
  "id" text PRIMARY KEY NOT NULL,
  "product_id" text NOT NULL,
  "employee_id" text NOT NULL,
  "role" text NOT NULL,
  "owner_rate_bp" integer,
  "weight_method" text,
  "weight_bp" integer,
  "effective_from" timestamp with time zone NOT NULL,
  "effective_to" timestamp with time zone,
  "policy_ref" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'APPROVED' NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "created_by" text,
  "approved_by" text,
  "approved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "product_marketer_assignments_role_check" CHECK ("role" IN ('OWNER', 'SUPPORT')),
  CONSTRAINT "product_marketer_assignments_status_check" CHECK ("status" IN ('APPROVED', 'REVOKED')),
  CONSTRAINT "product_marketer_assignments_range_check" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
  CONSTRAINT "product_marketer_assignments_owner_check" CHECK ("role" <> 'OWNER' OR ("owner_rate_bp" IS NOT NULL AND "owner_rate_bp" BETWEEN 0 AND 10000 AND "weight_method" IS NULL AND "weight_bp" IS NULL)),
  CONSTRAINT "product_marketer_assignments_support_check" CHECK ("role" <> 'SUPPORT' OR ("owner_rate_bp" IS NULL AND "weight_method" IN ('MANUAL', 'AD_SPEND', 'ATTRIBUTED_REVENUE') AND (("weight_method" = 'MANUAL') = ("weight_bp" IS NOT NULL)) AND ("weight_bp" IS NULL OR "weight_bp" BETWEEN 0 AND 10000)))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_marketer_assignments" ADD CONSTRAINT "product_marketer_assignments_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_marketer_assignments" ADD CONSTRAINT "product_marketer_assignments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_marketer_assignments" ADD CONSTRAINT "product_marketer_assignments_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_marketer_assignments_product_idx" ON "product_marketer_assignments" USING btree ("product_id","effective_from");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_marketer_assignments_employee_idx" ON "product_marketer_assignments" USING btree ("employee_id","effective_from");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_bonus_terms" (
  "id" text PRIMARY KEY NOT NULL,
  "product_id" text,
  "support_pool_bp" integer NOT NULL,
  "max_bonus_amount" integer,
  "effective_from" timestamp with time zone NOT NULL,
  "effective_to" timestamp with time zone,
  "policy_ref" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'APPROVED' NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "created_by" text,
  "approved_by" text,
  "approved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "product_bonus_terms_status_check" CHECK ("status" IN ('APPROVED', 'REVOKED')),
  CONSTRAINT "product_bonus_terms_range_check" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
  CONSTRAINT "product_bonus_terms_pool_check" CHECK ("support_pool_bp" BETWEEN 0 AND 10000),
  CONSTRAINT "product_bonus_terms_cap_check" CHECK ("max_bonus_amount" IS NULL OR "max_bonus_amount" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_bonus_terms" ADD CONSTRAINT "product_bonus_terms_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_bonus_terms" ADD CONSTRAINT "product_bonus_terms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_bonus_terms" ADD CONSTRAINT "product_bonus_terms_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_bonus_terms_product_idx" ON "product_bonus_terms" USING btree ("product_id","effective_from");
