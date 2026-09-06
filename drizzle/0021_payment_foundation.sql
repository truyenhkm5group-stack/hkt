-- P0.1 — nền tảng chứng từ thanh toán.
-- Toàn bộ file được viết IDEMPOTENT: chạy lại sau một lần thất bại giữa chừng phải thành công,
-- vì docker-entrypoint.sh chạy `drizzle-kit migrate` với `set -e` — migration lỗi làm container
-- thoát và restart vô hạn, và migration thất bại thì journal không ghi nên lần sau chạy lại từ đầu.
-- Ba CHECK trên shipment_events dùng NOT VALID: chỉ áp cho dòng mới, không quét toàn bảng và
-- không giữ khoá ACCESS EXCLUSIVE lâu khi ứng dụng khởi động (dữ liệu cũ đều NULL nên vẫn hợp lệ).
CREATE TABLE IF NOT EXISTS "payment_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"source" text NOT NULL,
	"source_namespace" text NOT NULL,
	"source_reference" text NOT NULL,
	"source_line_key" text NOT NULL,
	"document_locator" text NOT NULL,
	"document_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_evidence_source_check" CHECK ("payment_evidence"."source" IN ('BANK_STATEMENT', 'VTP_COD_STATEMENT', 'MANUAL_DOCUMENT')),
	CONSTRAINT "payment_evidence_identity_check" CHECK (length(trim("payment_evidence"."source_namespace")) > 0 AND length(trim("payment_evidence"."source_reference")) > 0 AND length(trim("payment_evidence"."source_line_key")) > 0 AND length(trim("payment_evidence"."document_locator")) > 0 AND length(trim("payment_evidence"."created_by")) > 0 AND "payment_evidence"."document_hash" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("payment_evidence"."payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text,
	"shipment_id" text,
	"coverage" text NOT NULL,
	"covered_through" timestamp with time zone NOT NULL,
	"ledger_fingerprint" text NOT NULL,
	"evidence_reference" text NOT NULL,
	"reviewed_by" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text NOT NULL,
	CONSTRAINT "payment_reviews_target_check" CHECK ("payment_reviews"."order_id" IS NOT NULL OR "payment_reviews"."shipment_id" IS NOT NULL),
	CONSTRAINT "payment_reviews_coverage_check" CHECK ("payment_reviews"."coverage" IN ('PARTIAL', 'COMPLETE', 'DISPUTED')),
	CONSTRAINT "payment_reviews_identity_check" CHECK (length(trim("payment_reviews"."evidence_reference")) > 0 AND length(trim("payment_reviews"."reviewed_by")) > 0 AND length(trim("payment_reviews"."note")) > 0 AND "payment_reviews"."ledger_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text,
	"shipment_id" text,
	"transaction_type" text NOT NULL,
	"amount" bigint,
	"currency" text DEFAULT 'VND' NOT NULL,
	"direction" text NOT NULL,
	"verification_status" text DEFAULT 'PENDING' NOT NULL,
	"source" text NOT NULL,
	"source_namespace" text NOT NULL,
	"source_reference" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"reverses_transaction_id" text,
	"reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "payment_transactions_target_check" CHECK ("payment_transactions"."order_id" IS NOT NULL OR "payment_transactions"."shipment_id" IS NOT NULL),
	CONSTRAINT "payment_transactions_amount_check" CHECK ("payment_transactions"."amount" >= 0),
	CONSTRAINT "payment_transactions_currency_check" CHECK ("payment_transactions"."currency" = 'VND'),
	CONSTRAINT "payment_transactions_type_check" CHECK ("payment_transactions"."transaction_type" IN ('COD_RECEIVED', 'PREPAID', 'BANK_TRANSFER', 'REFUND', 'ADJUSTMENT', 'REVERSAL')),
	CONSTRAINT "payment_transactions_direction_check" CHECK ("payment_transactions"."direction" IN ('INFLOW', 'OUTFLOW') AND ("payment_transactions"."transaction_type" <> 'REFUND' OR "payment_transactions"."direction" = 'OUTFLOW') AND ("payment_transactions"."transaction_type" NOT IN ('COD_RECEIVED', 'PREPAID', 'BANK_TRANSFER') OR "payment_transactions"."direction" = 'INFLOW')),
	CONSTRAINT "payment_transactions_status_check" CHECK ("payment_transactions"."verification_status" IN ('PENDING', 'VERIFIED', 'REJECTED', 'DISPUTED')),
	CONSTRAINT "payment_transactions_verified_check" CHECK ("payment_transactions"."verification_status" <> 'VERIFIED' OR ("payment_transactions"."amount" IS NOT NULL AND "payment_transactions"."verified_at" IS NOT NULL AND "payment_transactions"."verified_by" IS NOT NULL AND length(trim("payment_transactions"."verified_by")) > 0)),
	CONSTRAINT "payment_transactions_reversal_check" CHECK (("payment_transactions"."transaction_type" = 'REVERSAL') = ("payment_transactions"."reverses_transaction_id" IS NOT NULL) AND "payment_transactions"."reverses_transaction_id" IS DISTINCT FROM "payment_transactions"."id"),
	CONSTRAINT "payment_transactions_reason_check" CHECK (("payment_transactions"."transaction_type" NOT IN ('REFUND', 'ADJUSTMENT', 'REVERSAL') AND "payment_transactions"."verification_status" <> 'DISPUTED') OR ("payment_transactions"."reason" IS NOT NULL AND length(trim("payment_transactions"."reason")) > 0)),
	CONSTRAINT "payment_transactions_identity_check" CHECK (length(trim("payment_transactions"."source")) > 0 AND length(trim("payment_transactions"."source_namespace")) > 0 AND length(trim("payment_transactions"."source_reference")) > 0 AND length(trim("payment_transactions"."idempotency_key")) > 0 AND length(trim("payment_transactions"."created_by")) > 0 AND "payment_transactions"."request_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "shipment_events" ADD COLUMN IF NOT EXISTS "normalized_stage" "shipment_stage";--> statement-breakpoint
ALTER TABLE "shipment_events" ADD COLUMN IF NOT EXISTS "leg_type" text;--> statement-breakpoint
ALTER TABLE "shipment_events" ADD COLUMN IF NOT EXISTS "verification_status" text;--> statement-breakpoint
ALTER TABLE "shipment_events" ADD COLUMN IF NOT EXISTS "source_reference" text;--> statement-breakpoint
ALTER TABLE "shipment_events" ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipment_events" ADD COLUMN IF NOT EXISTS "verified_by" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_evidence" ADD CONSTRAINT "payment_evidence_transaction_id_payment_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."payment_transactions"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_reviews" ADD CONSTRAINT "payment_reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_reviews" ADD CONSTRAINT "payment_reviews_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_reversal_fk" FOREIGN KEY ("reverses_transaction_id") REFERENCES "public"."payment_transactions"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_evidence_transaction_idx" ON "payment_evidence" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_evidence_source_uq" ON "payment_evidence" USING btree ("source","source_namespace","source_reference","source_line_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_evidence_document_uq" ON "payment_evidence" USING btree ("document_hash","source_line_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_reviews_order_idx" ON "payment_reviews" USING btree ("order_id","reviewed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_reviews_shipment_idx" ON "payment_reviews" USING btree ("shipment_id","reviewed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_transactions_order_idx" ON "payment_transactions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_transactions_shipment_idx" ON "payment_transactions" USING btree ("shipment_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transactions_idempotency_uq" ON "payment_transactions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transactions_reversal_uq" ON "payment_transactions" USING btree ("reverses_transaction_id");--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_leg_check" CHECK ("shipment_events"."leg_type" IN ('OUTBOUND', 'RETURN', 'UNKNOWN')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_verification_check" CHECK ("shipment_events"."verification_status" IN ('PENDING', 'VERIFIED', 'REJECTED', 'DISPUTED')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_verified_check" CHECK ("shipment_events"."verification_status" IS DISTINCT FROM 'VERIFIED' OR (
      "shipment_events"."normalized_stage" IS NOT NULL AND "shipment_events"."normalized_stage" <> 'UNKNOWN'
      AND "shipment_events"."leg_type" IS NOT NULL AND "shipment_events"."leg_type" IN ('OUTBOUND', 'RETURN')
      AND "shipment_events"."source" IN ('VTP_WEBHOOK', 'VTP_POLL', 'VTP_IMPORT', 'MANUAL')
      AND "shipment_events"."source_reference" IS NOT NULL AND length(trim("shipment_events"."source_reference")) > 0
      AND "shipment_events"."verified_at" IS NOT NULL AND "shipment_events"."verified_by" IS NOT NULL AND length(trim("shipment_events"."verified_by")) > 0)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;
