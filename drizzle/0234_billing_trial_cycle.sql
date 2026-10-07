-- 0234 · DÙNG THỬ CÓ MỐC HẾT HẠN TƯỜNG MINH + GHIM GIÁ LÚC CẤP PHÁT (sứ mệnh saas-l5-billing-trial · docs/saas/PRICING_V1.md §II.7).
--
--  · Kiểm toán 07/10/2026: bot AI không dừng khi hết dùng thử — số ngày dùng thử là hằng toàn cục (`TRIAL_DAYS = 7`) và hạn dùng
--    thử chỉ tồn tại gián tiếp qua `paid_through` (mà chỉ được ghi khi nền tảng đã khai tài khoản nhận tiền). Khách người vận hành
--    tạo thì bước BILLING bị bỏ qua hẳn.
--  · `trial_started_at` / `trial_ends_at` / `trial_days`: điều khoản dùng thử của THUÊ BAO, chụp từ phiên bản giá lúc cấp phát
--    (`platform_plan_prices.trial_days`). `trial_ends_at` là MỐC (timestamptz), cổng AI so trực tiếp với giờ hiện tại.
--    NULL = không dùng thử / dòng cũ: KHÔNG backfill — tổ chức dùng thử từ trước bản này đọc `paid_through` như hôm nay.
--  · Ghim phiên bản giá lúc cấp phát có nguồn riêng `PROVISIONING` (trước đây chỉ có MIGRATION_0228 · INVOICE_PAID · OPERATOR · TEST).
--  · Kỳ tính tiền = tháng lịch giờ VN (trùng kỳ của đồng hồ khách AI) — không thêm bảng chu kỳ: kỳ là hàm của thời điểm
--    (`lib/pricing/meter.ts::usagePeriodOf`), không phải dữ liệu cần lưu.
--  · Bảng chung (mặt phẳng điều khiển có ở mọi CSDL). Viết tay, idempotent.

ALTER TABLE "platform_subscriptions" ADD COLUMN IF NOT EXISTS "trial_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "platform_subscriptions" ADD COLUMN IF NOT EXISTS "trial_ends_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "platform_subscriptions" ADD COLUMN IF NOT EXISTS "trial_days" integer;
--> statement-breakpoint
ALTER TABLE "platform_subscriptions" DROP CONSTRAINT IF EXISTS "platform_subscriptions_trial_check";
--> statement-breakpoint
ALTER TABLE "platform_subscriptions" ADD CONSTRAINT "platform_subscriptions_trial_check" CHECK (("trial_days" IS NULL OR "trial_days" BETWEEN 1 AND 90) AND ("trial_ends_at" IS NULL OR "trial_started_at" IS NULL OR "trial_ends_at" > "trial_started_at"));
--> statement-breakpoint
ALTER TABLE "platform_price_pins" DROP CONSTRAINT IF EXISTS "platform_price_pins_source_check";
--> statement-breakpoint
ALTER TABLE "platform_price_pins" ADD CONSTRAINT "platform_price_pins_source_check" CHECK ("source" IN ('MIGRATION_0228','INVOICE_PAID','OPERATOR','TEST','PROVISIONING'));
