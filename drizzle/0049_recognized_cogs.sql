-- GIA VON DA CHOT CHO KY DA GHI NHAN.
--
-- ORDER_COGS lay "phieu nhap gan nhat tinh theo HOM NAY", nen nhap mot lo moi co the doi loi nhuan
-- cua ky da chot. Cot recognized_cogs ghi MOT LAN luc don duoc ghi nhan giao thanh cong roi khong
-- doi nua.
--
-- Do tren production 09/09/2026: shop chi co 2 phieu nhap, ca hai ngay 03/09, trong khi don giao som
-- nhat tu 22/01; khong dong hang nao co gia von Pancake, khong mau ma nao co gia nhap. Nen 368/407
-- don da giao dang mang can cu suy nguoc tu phieu lap SAU ngay giao — tong 58 trieu.
--
-- CO Y KHONG dung lai lich su ve "gia von tai thoi diem giao": lam vay se dua 368 don ve 0d va thoi
-- loi nhuan lich su len 58 trieu. Giu nguyen con so hien tai, nhung GAN NHAN chua xac minh.
ALTER TABLE "canonical_order_outcome" ADD COLUMN IF NOT EXISTS "recognized_cogs" integer;
--> statement-breakpoint
ALTER TABLE "canonical_order_outcome" ADD COLUMN IF NOT EXISTS "recognized_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "canonical_order_outcome" ADD COLUMN IF NOT EXISTS "cogs_basis" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "canonical_order_outcome" ADD CONSTRAINT "canonical_cogs_basis_check"
    CHECK ("cogs_basis" IS NULL OR "cogs_basis" IN ('RECEIPT_BEFORE', 'RECEIPT_AFTER', 'NONE')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canonical_cogs_basis_idx" ON "canonical_order_outcome" ("cogs_basis");
