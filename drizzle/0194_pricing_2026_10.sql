-- 0194 · BẢNG GIÁ 10/2026: GÓI CƠ BẢN, TẶNG 2 THÁNG KHI TRẢ NĂM, CREDIT AI DÙNG CHUNG, ĐƠN GIÁ MUA THÊM
-- (docs/platform/pricing.md — phép tính giá vốn ↔ giá bán và so thị trường).
--
--  · `platform_plans.yearly_free_months`: trả 12 tháng tặng N tháng — giảm giá là cột TƯỜNG MINH (luật 38).
--  · Gói MỚI `basic` «Cơ bản» 249.000/tháng — cửa vào cho shop nhỏ, đối đầu POS 249–330k.
--  · Credit AI dùng chung / tháng (USD, trần CỨNG chi phí AI của nền tảng): Dùng thử 1 · Cơ bản 1,5 · Khởi đầu 3 ·
--    Tăng trưởng 8 · Chuyên nghiệp 15. Chỉ có tác dụng khi nền tảng bật `PLATFORM_AI_ENABLED` (launch-gates mục D).
--  · Đơn giá mua thêm (0192) cho bốn gói bán — VND / một bước / tháng.
--  · MỌI lệnh sửa chỉ chạm ô CÒN NGUYÊN giá trị gieo: ô người vận hành đã sửa ở /platform không bị đè, chạy lại không đổi gì.
--  · Giá tháng của Khởi đầu / Tăng trưởng / Chuyên nghiệp GIỮ NGUYÊN 499.000 / 999.000 / 1.990.000. Hoá đơn đang mở giữ giá cũ.
--  · Viết tay, idempotent.

ALTER TABLE "platform_plans" ADD COLUMN IF NOT EXISTS "yearly_free_months" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_plans" DROP CONSTRAINT IF EXISTS "platform_plans_yearly_free_check";--> statement-breakpoint
ALTER TABLE "platform_plans" ADD CONSTRAINT "platform_plans_yearly_free_check" CHECK ("yearly_free_months" BETWEEN 0 AND 3);--> statement-breakpoint
INSERT INTO "platform_plans" ("key", "name", "description", "limits", "position", "price_vnd", "yearly_free_months", "addon_prices") VALUES
  ('basic', 'Cơ bản', 'Shop nhỏ bán qua Fanpage: chatbot AI trả lời khách, lên đơn, quản lý kho cơ bản.', '{"users":2,"pages":5,"objects":2,"records":2000,"workflows":5,"aiDraftsPerDay":10,"storageMb":512,"ai":{"requestsPerDay":20,"requestsPerMonth":300,"costUsdPerMonth":{"soft":15,"hard":30},"platformCreditUsdPerMonth":1.5}}'::jsonb, 11, 249000, 2, '{"users":79000,"storageMb":29000}'::jsonb)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
UPDATE "platform_plans" SET "yearly_free_months" = 2, "updated_at" = now() WHERE "key" IN ('starter','growth','pro') AND "yearly_free_months" = 0;--> statement-breakpoint
UPDATE "platform_plans" SET "limits" = jsonb_set("limits", '{ai,platformCreditUsdPerMonth}', '1'::jsonb), "updated_at" = now() WHERE "key" = 'trial' AND "limits" #>> '{ai,platformCreditUsdPerMonth}' = '0';--> statement-breakpoint
UPDATE "platform_plans" SET "limits" = jsonb_set("limits", '{ai,platformCreditUsdPerMonth}', '3'::jsonb), "updated_at" = now() WHERE "key" = 'starter' AND "limits" #>> '{ai,platformCreditUsdPerMonth}' = '0';--> statement-breakpoint
UPDATE "platform_plans" SET "limits" = jsonb_set("limits", '{ai,platformCreditUsdPerMonth}', '8'::jsonb), "updated_at" = now() WHERE "key" = 'growth' AND "limits" #>> '{ai,platformCreditUsdPerMonth}' = '0';--> statement-breakpoint
UPDATE "platform_plans" SET "limits" = jsonb_set("limits", '{ai,platformCreditUsdPerMonth}', '15'::jsonb), "updated_at" = now() WHERE "key" = 'pro' AND "limits" #>> '{ai,platformCreditUsdPerMonth}' = '0';--> statement-breakpoint
UPDATE "platform_plans" SET "addon_prices" = '{"users":79000,"pages":59000,"objects":59000,"records":19000,"workflows":59000,"storageMb":29000}'::jsonb, "updated_at" = now() WHERE "key" = 'starter' AND "addon_prices" = '{}'::jsonb;--> statement-breakpoint
UPDATE "platform_plans" SET "addon_prices" = '{"users":69000,"pages":49000,"objects":49000,"records":15000,"workflows":49000,"storageMb":25000}'::jsonb, "updated_at" = now() WHERE "key" = 'growth' AND "addon_prices" = '{}'::jsonb;--> statement-breakpoint
UPDATE "platform_plans" SET "addon_prices" = '{"users":59000,"pages":39000,"objects":39000,"records":9000,"workflows":39000,"storageMb":19000}'::jsonb, "updated_at" = now() WHERE "key" = 'pro' AND "addon_prices" = '{}'::jsonb;
