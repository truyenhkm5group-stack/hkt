-- PHE DUYET HAI BUOC: viec rui ro thanh mot YEU CAU, chi chay khi co nguoi KHAC gat.
--
-- Bang nay la SO, khong phai hang doi tam: yeu cau bi tu choi van nam lai. Ai xin lam gi, ai khong
-- cho, luc nao — do moi la thu co gia tri khi can nhin lai.
--
-- Rang buoc quan trong nhat nam o cuoi tep: NGUOI DUYET PHAI KHAC NGUOI XIN. Ung dung da chan, day
-- la hang rao cuoi — vi mot duong ghi moi nao do trong tuong lai co the di vong qua tang ung dung.
DO $$ BEGIN
  CREATE TYPE "approval_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approval_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "group" text NOT NULL,
  "action" text NOT NULL,
  "entity" text DEFAULT '' NOT NULL,
  "entity_id" text DEFAULT '' NOT NULL,
  "amount" bigint,
  "summary" text NOT NULL,
  "payload" jsonb,
  "status" "approval_status" DEFAULT 'PENDING' NOT NULL,
  "requested_by" text,
  "requested_by_email" text DEFAULT '' NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_by" text,
  "decided_by_email" text,
  "decided_at" timestamp with time zone,
  "note" text,
  "executed_at" timestamp with time zone,
  "execution_error" text
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_users_id_fk"
    FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_users_id_fk"
    FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_status_idx" ON "approval_requests" ("status", "requested_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_group_idx" ON "approval_requests" ("group", "status");
--> statement-breakpoint
-- NGUOI XIN KHONG DUOC TU DUYET. Day la ly do ton tai cua ca co che; de o CSDL thi khong duong ghi
-- nao di vong qua duoc.
DO $$ BEGIN
  ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_khac_nguoi"
    CHECK ("decided_by" IS NULL OR "decided_by" <> "requested_by");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
