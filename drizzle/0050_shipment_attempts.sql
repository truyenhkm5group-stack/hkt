-- MOT DON CO THE CO NHIEU LAN GUI.
--
-- Rang buoc UNIQUE(order_id) tu migration 0000 ep mot don chi co mot van don. Cai gia khong nhin
-- thay: khi Pancake bao mot ma van don MOI cho don da co van don, duong dong bo GHI DE len dong cu —
-- lan gui dau tien bien mat khoi so, khong canh bao. Giao that bai roi gui lai, huy roi tao lai, gui
-- hang thay the: ca ba deu mat dau.
--
-- Bo rang buoc di kem nghia vu: moi duong tinh TIEN phai chuyen sang grain DON. Hai viec do di cung
-- mot lan phat hanh.
ALTER TABLE "shipments" DROP CONSTRAINT IF EXISTS "shipments_order_id_unique";
--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "attempt_no" integer;
--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "direction" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "shipments" ADD CONSTRAINT "shipments_direction_check"
    CHECK ("direction" IS NULL OR "direction" IN ('OUTBOUND', 'RETURN', 'REPLACEMENT')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
-- Du lieu cu: moi van don gan don deu la lan gui dau, chieu di. Van don khong gan don (chieu hoan do
-- Viettel Post tao) de nguyen NULL — chung khong thuoc mot lan gui nao cua don.
UPDATE "shipments" SET "attempt_no" = 1, "direction" = 'OUTBOUND'
WHERE "order_id" IS NOT NULL AND "attempt_no" IS NULL;
--> statement-breakpoint
-- Mot don khong duoc co hai lan gui cung so thu tu.
CREATE UNIQUE INDEX IF NOT EXISTS "shipments_order_attempt_uq"
  ON "shipments" ("order_id", "attempt_no") WHERE "order_id" IS NOT NULL AND "attempt_no" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipments_direction_idx" ON "shipments" ("direction");
