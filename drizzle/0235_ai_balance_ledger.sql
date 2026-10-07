-- 0235 · SỐ DƯ AI + PHIẾU NẠP QR (docs/saas/AI_BALANCE_V1.md · quyết định chủ shop 08/10/2026).
--
--  · `platform_ai_accounts`: một dòng mỗi tổ chức (trạng thái + ngưỡng báo số dư thấp). KHÔNG có cột số dư — số dư là
--    TỔNG sổ cái, dựng lại được bất cứ lúc nào.
--  · `platform_ai_ledger_entries`: sổ cái CHỈ GHI THÊM; khoá chống trùng duy nhất toàn sổ ⇒ webhook gửi lại bao nhiêu lần
--    cũng cộng đúng một lần. Lớp tiền CASH (khách chuyển) tách khỏi PROMO (nền tảng tặng). Dấu tiền theo loại dòng.
--  · `platform_payment_intents`: phiếu nạp động (số tiền + mã `ERPNAP…` nằm sẵn trong VietQR).
--  · `platform_billing_payments`: thêm `payment_intent_id` + hai kết quả của tiền nạp — MỘT bảng ghi mỗi giao dịch ngân
--    hàng đúng một lần (khoá `bank_ref`), dù là tiền thuê bao hay tiền nạp.
--  · Chỉ CỘNG THÊM; không backfill, không đụng dòng cũ. Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "platform_ai_accounts" (
	"org_code" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"low_balance_vnd" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_ai_accounts_status_check" CHECK ("platform_ai_accounts"."status" IN ('ACTIVE','FROZEN')),
	CONSTRAINT "platform_ai_accounts_low_check" CHECK ("platform_ai_accounts"."low_balance_vnd" IS NULL OR "platform_ai_accounts"."low_balance_vnd" BETWEEN 0 AND 100000000)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_ai_ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"org_code" text NOT NULL,
	"entry_type" text NOT NULL,
	"funds_class" text NOT NULL,
	"amount_vnd" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"source_type" text NOT NULL,
	"source_ref" text,
	"price_version_key" text,
	"unit_price_vnd" integer,
	"units" integer,
	"note" text,
	"actor_user_id" text,
	"actor_email" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_ai_ledger_entries_type_check" CHECK ("platform_ai_ledger_entries"."entry_type" IN ('TOPUP','PROMO_CREDIT','AI_USAGE','REFUND','ADJUSTMENT','EXPIRY')),
	CONSTRAINT "platform_ai_ledger_entries_class_check" CHECK ("platform_ai_ledger_entries"."funds_class" IN ('CASH','PROMO')),
	CONSTRAINT "platform_ai_ledger_entries_source_check" CHECK ("platform_ai_ledger_entries"."source_type" IN ('PAYMENT_INTENT','BANK_PAYMENT','AI_CUSTOMER','OPERATOR','SYSTEM')),
	CONSTRAINT "platform_ai_ledger_entries_sign_check" CHECK (("platform_ai_ledger_entries"."entry_type" = 'TOPUP' AND "platform_ai_ledger_entries"."funds_class" = 'CASH' AND "platform_ai_ledger_entries"."amount_vnd" > 0) OR ("platform_ai_ledger_entries"."entry_type" = 'PROMO_CREDIT' AND "platform_ai_ledger_entries"."funds_class" = 'PROMO' AND "platform_ai_ledger_entries"."amount_vnd" > 0) OR ("platform_ai_ledger_entries"."entry_type" = 'REFUND' AND "platform_ai_ledger_entries"."funds_class" = 'CASH' AND "platform_ai_ledger_entries"."amount_vnd" < 0) OR ("platform_ai_ledger_entries"."entry_type" IN ('AI_USAGE','EXPIRY') AND "platform_ai_ledger_entries"."amount_vnd" < 0) OR ("platform_ai_ledger_entries"."entry_type" = 'ADJUSTMENT' AND "platform_ai_ledger_entries"."amount_vnd" <> 0)),
	CONSTRAINT "platform_ai_ledger_entries_max_check" CHECK (abs("platform_ai_ledger_entries"."amount_vnd") <= 1000000000)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_ai_ledger_entries_idem_key" ON "platform_ai_ledger_entries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_ai_ledger_entries_org_idx" ON "platform_ai_ledger_entries" USING btree ("org_code","occurred_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_payment_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"org_code" text NOT NULL,
	"purpose" text DEFAULT 'AI_TOPUP' NOT NULL,
	"provider" text DEFAULT 'SEPAY_BANK_TRANSFER' NOT NULL,
	"amount_vnd" integer NOT NULL,
	"reference_code" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"paid_amount_vnd" integer,
	"bank_ref" text,
	"ledger_entry_id" text,
	"created_by_user_id" text,
	"created_by_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_payment_intents_purpose_check" CHECK ("platform_payment_intents"."purpose" IN ('AI_TOPUP')),
	CONSTRAINT "platform_payment_intents_provider_check" CHECK ("platform_payment_intents"."provider" IN ('SEPAY_BANK_TRANSFER')),
	CONSTRAINT "platform_payment_intents_status_check" CHECK ("platform_payment_intents"."status" IN ('PENDING','PAID','EXPIRED','CANCELLED')),
	CONSTRAINT "platform_payment_intents_amount_check" CHECK ("platform_payment_intents"."amount_vnd" > 0),
	CONSTRAINT "platform_payment_intents_code_check" CHECK ("platform_payment_intents"."reference_code" ~ '^ERPNAP[2-9A-HJ-NP-Z]{6}$'),
	CONSTRAINT "platform_payment_intents_paid_check" CHECK (("platform_payment_intents"."status" = 'PAID') = ("platform_payment_intents"."paid_at" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_payment_intents_reference_key" ON "platform_payment_intents" USING btree ("reference_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_payment_intents_org_idx" ON "platform_payment_intents" USING btree ("org_code","created_at");--> statement-breakpoint
ALTER TABLE "platform_billing_payments" ADD COLUMN IF NOT EXISTS "payment_intent_id" text;--> statement-breakpoint
ALTER TABLE "platform_billing_payments" DROP CONSTRAINT IF EXISTS "platform_billing_payments_outcome_check";--> statement-breakpoint
ALTER TABLE "platform_billing_payments" ADD CONSTRAINT "platform_billing_payments_outcome_check" CHECK ("platform_billing_payments"."outcome" IN ('MATCHED','UNDERPAID','INVOICE_NOT_OPEN','NO_INVOICE','TOPUP_CREDITED','TOPUP_CREDITED_REVIEW','TOPUP_HELD'));
