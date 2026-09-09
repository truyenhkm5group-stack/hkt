-- Sổ giao dịch ngân hàng: dòng tiền thu/chi thực + quy tắc gán nhãn tự động.
-- Viết tay, KHÔNG dùng bản drizzle-kit sinh ra: chuỗi snapshot của kho bị đứt ở 0032 nên bản sinh
-- tự động dựng lại cả những thay đổi mà 0033–0041 đã áp, chạy lên production sẽ lỗi "đã tồn tại".
CREATE TABLE IF NOT EXISTS "bank_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"txn_at" timestamp with time zone NOT NULL,
	"amount" integer NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"counterparty" text DEFAULT '' NOT NULL,
	"bank_ref" text NOT NULL,
	"account" text DEFAULT '' NOT NULL,
	"accounting_group" text DEFAULT 'UNCLASSIFIED' NOT NULL,
	"category_code" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"rule_id" text,
	"classified_by" text DEFAULT '' NOT NULL,
	"classified_at" timestamp with time zone,
	"source" text DEFAULT 'IMPORT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_txn_amount_check" CHECK ("bank_transactions"."amount" <> 0),
	CONSTRAINT "bank_txn_source_check" CHECK ("bank_transactions"."source" IN ('IMPORT', 'MANUAL'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bank_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"direction" text DEFAULT 'ANY' NOT NULL,
	"match_counterparty" text DEFAULT '' NOT NULL,
	"match_description" text DEFAULT '' NOT NULL,
	"min_amount" integer DEFAULT 0 NOT NULL,
	"max_amount" integer DEFAULT 0 NOT NULL,
	"accounting_group" text NOT NULL,
	"category_code" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_rules_direction_check" CHECK ("bank_rules"."direction" IN ('IN', 'OUT', 'ANY')),
	CONSTRAINT "bank_rules_match_check" CHECK (length("bank_rules"."match_counterparty") > 0 OR length("bank_rules"."match_description") > 0 OR "bank_rules"."min_amount" > 0 OR "bank_rules"."max_amount" > 0),
	CONSTRAINT "bank_rules_amount_check" CHECK ("bank_rules"."max_amount" = 0 OR "bank_rules"."max_amount" >= "bank_rules"."min_amount")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bank_txn_ref_idx" ON "bank_transactions" USING btree ("bank_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_txn_at_idx" ON "bank_transactions" USING btree ("txn_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_txn_group_idx" ON "bank_transactions" USING btree ("accounting_group","txn_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_rules_priority_idx" ON "bank_rules" USING btree ("enabled","priority");
