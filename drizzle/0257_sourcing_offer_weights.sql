-- 0257 · TÌM HÀNG NGUỒN — CÂN NẶNG MỘT CÁI CỦA MẪU NGUỒN (SRC-4, docs/tech/ai-sourcing.md §3.3, Tech Lead duyệt 23/10/2026).
--
-- Chỉ TẠO một bảng mới ở CSDL của tổ chức (chỉ thêm dòng — lần ghi mới nhất là cân nặng đang dùng), không thêm cột vào bảng cũ:
-- câu chèn của drizzle liệt kê mọi cột của lược đồ, nên một cột mới trên sourcing_offer_snapshots làm hỏng «chụp giá» ở tổ chức
-- chưa áp. Không gieo dòng nào. Idempotent.
CREATE TABLE IF NOT EXISTS "sourcing_offer_weights" (
  "id" text PRIMARY KEY NOT NULL,
  "offer_id" text NOT NULL,
  "grams" integer NOT NULL,
  "source" text DEFAULT 'MANUAL' NOT NULL,
  "captured_at" timestamp with time zone DEFAULT now() NOT NULL,
  "captured_by" text,
  CONSTRAINT "sourcing_offer_weights_grams_check" CHECK ("grams" BETWEEN 1 AND 100000),
  CONSTRAINT "sourcing_offer_weights_source_check" CHECK ("source" IN ('MANUAL', 'API', 'UNKNOWN'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sourcing_offer_weights_offer_idx" ON "sourcing_offer_weights" USING btree ("offer_id", "captured_at");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_offer_weights" ADD CONSTRAINT "sourcing_offer_weights_offer_id_sourcing_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."sourcing_offers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sourcing_offer_weights" ADD CONSTRAINT "sourcing_offer_weights_captured_by_users_id_fk" FOREIGN KEY ("captured_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
