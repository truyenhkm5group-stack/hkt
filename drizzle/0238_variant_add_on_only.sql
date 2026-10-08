-- 0238 · MẪU MÃ CHỈ BÁN KÈM (chủ shop HSLC 09/10/2026: «có SKU 0,5kg nhưng không báo giá từ 0,5kg, chỉ bán khi khách mua
-- kèm»). Cờ trên mẫu mã; mặc định FALSE ⇒ mọi mẫu mã đang có giữ nguyên hành vi. Chỉ CỘNG THÊM, idempotent.

ALTER TABLE "product_variants" ADD COLUMN IF NOT EXISTS "add_on_only" boolean DEFAULT false NOT NULL;
