-- 0137 · COMPANY OS · AGENT A2 — Ý TƯỞNG MARKETING NỐI VỀ MẪU.
--
-- Một cột NULL được trên `marketing_ideas`: mẫu (`product_models`) được đăng ký TỪ ý tưởng này bằng nút
-- "Đăng ký thành mẫu" trên trang ý tưởng. Xoá mẫu thì ý tưởng KHÔNG mất, chỉ rơi về "chưa đăng ký"
-- (ON DELETE SET NULL) — ý tưởng là chỗ làm việc của đội marketing, không đi theo vòng đời của mẫu.
--
-- KHÔNG BACKFILL (AGENTS.md mục 35, 8.8): đoán mẫu cho ý tưởng cũ theo nội dung chữ là bịa một liên
-- kết. Ý tưởng cũ để NULL cho tới khi có người bấm.
-- Viết tay và idempotent như 0033–0134.

ALTER TABLE "marketing_ideas" ADD COLUMN IF NOT EXISTS "model_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketing_ideas" ADD CONSTRAINT "marketing_ideas_model_id_product_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."product_models"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketing_ideas_model_idx" ON "marketing_ideas" ("model_id");
