-- 0263 · BÁO GIÁ SỈ TẤT ĐỊNH (docs/tech/hslc-b2b-sales-agent.md · P1b — engine `lib/wholesale/quotation-engine.ts`).
--
-- Chỉ TẠO hai bảng mới ở CSDL của tổ chức + hai trigger bất biến; không đổi bảng nào mã đang đọc, không gieo dòng nào. Idempotent.
--  · wholesale_quotations: một PHIÊN BẢN báo giá. Sửa = phiên bản mới (cùng `code`, version + 1, parent trỏ bản trước, tối đa
--    MỘT bản kế mỗi bản — chỉ mục duy nhất `parent_quotation_id`). `request_key` duy nhất ⇒ bấm hai lần không đẻ hai bản.
--    Tiền là số nguyên VND (bigint); tiền tệ khác chưa có nguồn tỷ giá ⇒ CHECK chỉ 'VND'. Ship / thuế NULL = CHƯA KHAI, không
--    phải 0, và có số thì phải có căn cứ. `snapshot` = toàn bộ đầu vào + kết quả lúc lập — bản in đọc từ đây.
--  · wholesale_quotation_lines: dòng của một phiên bản. `unit_price` NULL = không có giá sỉ (báo giá mang chặn);
--    `stock_available_at_quote` NULL = tồn CHƯA BIẾT (không phải 0).
--  · Trigger: dòng không bao giờ được UPDATE; phiên bản chỉ được đổi cột trạng thái / mốc / người thao tác — tiền, dòng, ảnh
--    chụp, bên nhận, hạn hiệu lực là BẤT BIẾN (giống kỳ đã chốt, AGENTS.md luật 21). Cột khoá người dùng được phép về NULL vì
--    FK `ON DELETE SET NULL` khi xoá tài khoản.
CREATE TABLE IF NOT EXISTS "wholesale_quotations" (
  "id" text PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "parent_quotation_id" text,
  "request_key" text NOT NULL,
  "lead_id" text,
  "customer_id" text,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "currency" text DEFAULT 'VND' NOT NULL,
  "price_list_id" text,
  "price_version" text NOT NULL,
  "subtotal" bigint NOT NULL,
  "discount" bigint DEFAULT 0 NOT NULL,
  "shipping" bigint,
  "shipping_source" text DEFAULT '' NOT NULL,
  "tax" bigint,
  "tax_source" text DEFAULT '' NOT NULL,
  "total" bigint NOT NULL,
  "valid_until" date NOT NULL,
  "incoterm" text,
  "notes" text DEFAULT '' NOT NULL,
  "requires_approval" boolean DEFAULT false NOT NULL,
  "blocker_count" integer DEFAULT 0 NOT NULL,
  "snapshot" jsonb NOT NULL,
  "created_by_user_id" text,
  "created_by_name" text DEFAULT '' NOT NULL,
  "approved_by_user_id" text,
  "approved_at" timestamp with time zone,
  "sent_by_user_id" text,
  "sent_at" timestamp with time zone,
  "accepted_at" timestamp with time zone,
  "rejected_at" timestamp with time zone,
  "decided_by_user_id" text,
  "decision_note" text DEFAULT '' NOT NULL,
  "superseded_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wholesale_quotations_party_check" CHECK ("lead_id" IS NOT NULL OR "customer_id" IS NOT NULL),
  CONSTRAINT "wholesale_quotations_status_check" CHECK ("status" IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED')),
  CONSTRAINT "wholesale_quotations_currency_check" CHECK ("currency" = 'VND'),
  CONSTRAINT "wholesale_quotations_version_check" CHECK ("version" >= 1 AND ("version" = 1) = ("parent_quotation_id" IS NULL)),
  CONSTRAINT "wholesale_quotations_amounts_check" CHECK ("subtotal" >= 0 AND "discount" >= 0 AND ("shipping" IS NULL OR "shipping" >= 0) AND ("tax" IS NULL OR "tax" >= 0) AND "total" >= 0),
  CONSTRAINT "wholesale_quotations_shipping_source_check" CHECK ("shipping" IS NULL OR length(trim("shipping_source")) >= 1),
  CONSTRAINT "wholesale_quotations_tax_source_check" CHECK ("tax" IS NULL OR length(trim("tax_source")) >= 1),
  CONSTRAINT "wholesale_quotations_incoterm_check" CHECK ("incoterm" IS NULL OR "incoterm" IN ('EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'FAS', 'FOB', 'CFR', 'CIF')),
  CONSTRAINT "wholesale_quotations_snapshot_check" CHECK (jsonb_typeof("snapshot") = 'object'),
  CONSTRAINT "wholesale_quotations_self_approval_check" CHECK ("approved_by_user_id" IS NULL OR "created_by_user_id" IS NULL OR "approved_by_user_id" <> "created_by_user_id"),
  CONSTRAINT "wholesale_quotations_approved_check" CHECK ("status" <> 'APPROVED' OR "approved_at" IS NOT NULL),
  CONSTRAINT "wholesale_quotations_sent_check" CHECK ("status" NOT IN ('SENT', 'ACCEPTED', 'REJECTED') OR "sent_at" IS NOT NULL),
  CONSTRAINT "wholesale_quotations_accepted_check" CHECK ("status" <> 'ACCEPTED' OR "accepted_at" IS NOT NULL),
  CONSTRAINT "wholesale_quotations_rejected_check" CHECK ("status" <> 'REJECTED' OR "rejected_at" IS NOT NULL),
  CONSTRAINT "wholesale_quotations_superseded_check" CHECK ("status" <> 'SUPERSEDED' OR "superseded_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wholesale_quotations_code_version_uq" ON "wholesale_quotations" USING btree ("code", "version");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wholesale_quotations_request_key_uq" ON "wholesale_quotations" USING btree ("request_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wholesale_quotations_parent_uq" ON "wholesale_quotations" USING btree ("parent_quotation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_quotations_status_idx" ON "wholesale_quotations" USING btree ("status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_quotations_lead_idx" ON "wholesale_quotations" USING btree ("lead_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_quotations_customer_idx" ON "wholesale_quotations" USING btree ("customer_id");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_quotations" ADD CONSTRAINT "wholesale_quotations_parent_quotation_id_wholesale_quotations_id_fk" FOREIGN KEY ("parent_quotation_id") REFERENCES "public"."wholesale_quotations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_quotations" ADD CONSTRAINT "wholesale_quotations_lead_id_wholesale_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."wholesale_leads"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_quotations" ADD CONSTRAINT "wholesale_quotations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_quotations" ADD CONSTRAINT "wholesale_quotations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_quotations" ADD CONSTRAINT "wholesale_quotations_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_quotations" ADD CONSTRAINT "wholesale_quotations_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_quotations" ADD CONSTRAINT "wholesale_quotations_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wholesale_quotation_lines" (
  "id" text PRIMARY KEY NOT NULL,
  "quotation_id" text NOT NULL,
  "line_no" integer NOT NULL,
  "variant_id" text NOT NULL,
  "product_name" text DEFAULT '' NOT NULL,
  "sku" text DEFAULT '' NOT NULL,
  "quantity" integer NOT NULL,
  "unit_price" bigint,
  "price_source" text,
  "price_list_id" text,
  "tier_min_qty" integer,
  "line_discount" bigint DEFAULT 0 NOT NULL,
  "line_total" bigint,
  "stock_available_at_quote" integer,
  "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wholesale_quotation_lines_qty_check" CHECK ("quantity" BETWEEN 1 AND 100000),
  CONSTRAINT "wholesale_quotation_lines_price_check" CHECK ("unit_price" IS NULL OR "unit_price" > 0),
  CONSTRAINT "wholesale_quotation_lines_source_check" CHECK ("price_source" IS NULL OR "price_source" IN ('CUSTOMER_LIST', 'DEFAULT_LIST')),
  CONSTRAINT "wholesale_quotation_lines_discount_check" CHECK ("line_discount" >= 0 AND ("line_total" IS NULL OR "line_total" >= 0)),
  CONSTRAINT "wholesale_quotation_lines_warnings_check" CHECK (jsonb_typeof("warnings") = 'array')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wholesale_quotation_lines_no_uq" ON "wholesale_quotation_lines" USING btree ("quotation_id", "line_no");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_quotation_lines_variant_idx" ON "wholesale_quotation_lines" USING btree ("variant_id");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_quotation_lines" ADD CONSTRAINT "wholesale_quotation_lines_quotation_id_wholesale_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."wholesale_quotations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "wholesale_quotations_immutable_trg"() RETURNS trigger AS $$
BEGIN
	IF ROW(NEW."code", NEW."version", NEW."parent_quotation_id", NEW."request_key", NEW."lead_id", NEW."customer_id", NEW."currency", NEW."price_list_id", NEW."price_version",
	       NEW."subtotal", NEW."discount", NEW."shipping", NEW."shipping_source", NEW."tax", NEW."tax_source", NEW."total", NEW."valid_until", NEW."incoterm", NEW."notes",
	       NEW."requires_approval", NEW."blocker_count", NEW."snapshot", NEW."created_by_name", NEW."created_at")
	   IS DISTINCT FROM
	   ROW(OLD."code", OLD."version", OLD."parent_quotation_id", OLD."request_key", OLD."lead_id", OLD."customer_id", OLD."currency", OLD."price_list_id", OLD."price_version",
	       OLD."subtotal", OLD."discount", OLD."shipping", OLD."shipping_source", OLD."tax", OLD."tax_source", OLD."total", OLD."valid_until", OLD."incoterm", OLD."notes",
	       OLD."requires_approval", OLD."blocker_count", OLD."snapshot", OLD."created_by_name", OLD."created_at") THEN
		RAISE EXCEPTION 'wholesale_quotations: phiên bản báo giá là BẤT BIẾN — sửa nội dung thì tạo phiên bản mới (%).', OLD."code" USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "wholesale_quotations_immutable" ON "wholesale_quotations";
--> statement-breakpoint
CREATE TRIGGER "wholesale_quotations_immutable" BEFORE UPDATE ON "wholesale_quotations" FOR EACH ROW
	EXECUTE FUNCTION "wholesale_quotations_immutable_trg"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "wholesale_quotation_lines_immutable_trg"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'wholesale_quotation_lines: dòng báo giá là BẤT BIẾN — sửa thì tạo phiên bản mới.' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "wholesale_quotation_lines_immutable" ON "wholesale_quotation_lines";
--> statement-breakpoint
CREATE TRIGGER "wholesale_quotation_lines_immutable" BEFORE UPDATE ON "wholesale_quotation_lines" FOR EACH ROW
	EXECUTE FUNCTION "wholesale_quotation_lines_immutable_trg"();
