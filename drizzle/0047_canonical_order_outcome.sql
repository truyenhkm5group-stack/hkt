-- LỚP TĂNG TỐC CHO KẾT QUẢ ĐƠN. KHÔNG phải nguồn sự thật.
--
-- Đo trên production 09/09/2026: ORDER_OUTCOME tốn ~2,4ms mỗi đơn, nên mỗi báo cáo trả ~6 giây chỉ
-- để dựng lại cùng một kết luận cho 2.426 đơn; trang chủ mất 30–47 giây. Bảng này lưu kết quả của
-- CHÍNH biểu thức đó để báo cáo khỏi tính lại.
--
-- Grain (đơn × vận đơn) là CỐ Ý: mọi báo cáo hiện nay đều LEFT JOIN shipments rồi tính cho từng
-- dòng. Vật chất hoá ở grain khác sẽ đổi con số.
CREATE TABLE IF NOT EXISTS "canonical_order_outcome" (
  "id" text PRIMARY KEY NOT NULL,
  "order_id" text NOT NULL,
  "shipment_id" text,
  "outcome" text NOT NULL,
  "logic_version" integer DEFAULT 1 NOT NULL,
  "computed_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "canonical_order_outcome" ADD CONSTRAINT "canonical_order_outcome_order_id_fk"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "canonical_order_outcome" ADD CONSTRAINT "canonical_order_outcome_shipment_id_fk"
    FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
-- MỘT dòng cho mỗi (đơn, vận đơn). `coalesce` vì NULL không tự loại trùng trong chỉ mục duy nhất,
-- mà đơn chưa có vận đơn thì cũng chỉ được có đúng một dòng.
CREATE UNIQUE INDEX IF NOT EXISTS "canonical_order_outcome_uq"
  ON "canonical_order_outcome" ("order_id", (coalesce("shipment_id", '')));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canonical_outcome_order_idx" ON "canonical_order_outcome" ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canonical_outcome_value_idx" ON "canonical_order_outcome" ("outcome");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canonical_outcome_version_idx" ON "canonical_order_outcome" ("logic_version");
