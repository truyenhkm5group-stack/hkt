-- 0143 · VÒNG MẪU — GEN TAY RA THIẾT KẾ MỚI (chủ shop 25/09/2026, `docs/creative-loop.md` §5i).
--
-- Chủ shop: "gen các mẫu mới hoàn toàn, sáng tạo từ các ảnh đầu vào (mẫu đã win và mẫu có chỉ số tốt),
-- không phải tạo mockup mới cho các mẫu cũ". Một lượt gen tay nay có HAI kiểu:
--
--   · `DESIGN` — người chọn các mã bán tốt làm cảm hứng; mỗi ảnh là MỘT THIẾT KẾ MỚI lai DNA của chúng
--     (`planDesigns`, cùng bộ máy của ô thiết kế trong lô). Bản mô tả thiết kế nằm ở
--     `creative_manual_gen_images.design`; `design_concepts` (mã `TK-…`) chỉ được tạo khi người "Đưa vào lô".
--   · `MOCKUP` — kiểu cũ: ảnh quảng cáo mới cho ĐÚNG sản phẩm trong ảnh thật (còn dùng cho đề xuất đẩy tồn).
--     Mọi lượt đã có trước bản này là `MOCKUP` — đúng với cái chúng đã làm, nên mặc định cột là `MOCKUP`
--     (không phải một lượt đoán ngược: đó là kiểu DUY NHẤT từng tồn tại).
--
-- Viết tay, idempotent như 0033–0142.

ALTER TABLE "creative_manual_gens" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'MOCKUP' NOT NULL;
--> statement-breakpoint
ALTER TABLE "creative_manual_gens" ADD COLUMN IF NOT EXISTS "inspiration_product_ids" text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
ALTER TABLE "creative_manual_gens" DROP CONSTRAINT IF EXISTS "creative_manual_gens_kind_check";
--> statement-breakpoint
ALTER TABLE "creative_manual_gens" ADD CONSTRAINT "creative_manual_gens_kind_check" CHECK ("kind" IN ('MOCKUP', 'DESIGN'));
--> statement-breakpoint
ALTER TABLE "creative_manual_gen_images" ADD COLUMN IF NOT EXISTS "design" jsonb;
