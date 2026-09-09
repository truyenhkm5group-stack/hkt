-- Thẩm quyền chi phí & đối chiếu ngân hàng.
--
-- Viết tay, KHÔNG dùng drizzle-kit: chuỗi snapshot của kho đứt ở 0032 nên bản sinh tự động dựng lại
-- cả những thay đổi mà 0033–0043 đã áp, chạy lên production sẽ lỗi "đã tồn tại".
--
-- TƯƠNG THÍCH NGƯỢC: chỉ THÊM cột có giá trị mặc định, không đổi/không xoá cột nào. Mọi dòng cũ
-- nhận `cost_source = 'MANUAL'` và `linked_type = ''` — đúng hành vi hiện tại, không viết lại lịch sử.

ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "cost_source" text DEFAULT 'MANUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "reason" text DEFAULT '' NOT NULL;--> statement-breakpoint

ALTER TABLE "bank_transactions" ADD COLUMN IF NOT EXISTS "linked_type" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN IF NOT EXISTS "linked_id" text DEFAULT '' NOT NULL;--> statement-breakpoint

-- Ràng buộc thêm sau khi cột đã có giá trị mặc định cho mọi dòng cũ, nên không dòng nào vi phạm.
DO $$ BEGIN
  ALTER TABLE "expenses" ADD CONSTRAINT "expenses_cost_source_check"
    CHECK ("expenses"."cost_source" IN ('MANUAL', 'MANUAL_ADJUSTMENT', 'BANK_IMPORT', 'PAYROLL'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "expenses" ADD CONSTRAINT "expenses_adjustment_reason_check"
    CHECK ("expenses"."cost_source" <> 'MANUAL_ADJUSTMENT' OR length(trim("expenses"."reason")) > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_txn_linked_check"
    CHECK ("bank_transactions"."linked_type" IN ('', 'EXPENSE', 'COD_BATCH', 'STOCK_RECEIPT', 'AD_SPEND'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_txn_linked_pair_check"
    CHECK (("bank_transactions"."linked_type" = '' AND "bank_transactions"."linked_id" = '')
        OR ("bank_transactions"."linked_type" <> '' AND length("bank_transactions"."linked_id") > 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "bank_txn_linked_idx" ON "bank_transactions" USING btree ("linked_type","linked_id");
