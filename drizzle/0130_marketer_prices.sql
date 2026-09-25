-- 0130 · GIÁ BÁO MKT THEO MÃ (có ngày hiệu lực) + NGÀY GHI PHẠT XƯỞNG.
--
-- Chủ shop chốt 25/09/2026: giá báo MKT là MỘT giá cho mỗi mã (gần hết vòng đời có thể hạ để xả
-- tồn), thay giá vốn ở PHẦN CỦA MKT — lợi nhuận danh nghĩa theo MKT và lương — từ tháng 9/2026; tiền
-- phạt xưởng cộng lại cho MKT phụ trách mã. Luật: lib/constants/marketer-price.ts.
--
-- 0129 đặt giá báo lên LÔ; nay chuyển sang bảng theo MÃ. Dòng lô nào đã ghi giá báo thì CHÉP sang
-- (hiệu lực từ ngày đặt lô) rồi mới bỏ cột — đây là chuyển chỗ dữ liệu người đã nhập, không phải
-- đoán dữ liệu mới. Lô chưa khớp sản phẩm (product_id NULL) không có mã để gắn nên không chép.
-- `penalty_at` KHÔNG backfill: phạt ghi trước bản này để trống ngày, màn hình nói ra (mục 35).
-- Viết tay và idempotent như 0033–0129.

CREATE TABLE IF NOT EXISTS "marketer_prices" (
  "id" text PRIMARY KEY NOT NULL,
  "product_id" text NOT NULL,
  "product_code" text DEFAULT '' NOT NULL,
  "price" integer NOT NULL,
  "effective_from" timestamp with time zone NOT NULL,
  "reason" text DEFAULT '' NOT NULL,
  "set_by_user_id" text,
  "set_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "marketer_prices_price_check" CHECK ("price" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketer_prices" ADD CONSTRAINT "marketer_prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketer_prices" ADD CONSTRAINT "marketer_prices_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "marketer_prices_product_from_uq" ON "marketer_prices" ("product_id", "effective_from");
--> statement-breakpoint
ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "penalty_at" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'production_batches' AND column_name = 'marketer_price') THEN
    INSERT INTO "marketer_prices" ("id", "product_id", "product_code", "price", "effective_from", "reason", "set_by")
    SELECT gen_random_uuid()::text, b."product_id", b."product_code", b."marketer_price", b."ordered_at",
           'Chuyển từ giá báo ghi trên ' || b."product_code" || ' lô ' || b."batch_no", b."created_by"
    FROM "production_batches" b
    WHERE b."marketer_price" IS NOT NULL AND b."product_id" IS NOT NULL
    ON CONFLICT ("product_id", "effective_from") DO NOTHING;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "production_batches" DROP CONSTRAINT IF EXISTS "production_batches_price_check";
--> statement-breakpoint
ALTER TABLE "production_batches" DROP COLUMN IF EXISTS "marketer_price";
--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_price_check" CHECK (("labor_unit_price" IS NULL OR "labor_unit_price" >= 0) AND "workshop_penalty" >= 0);
