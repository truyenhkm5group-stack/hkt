-- GIỮ ĐỊNH DANH QUY KẾT THÔ NGAY KHI NHẬN DỮ LIỆU.
--
-- Đo trên production 09/09/2026: Pancake gửi p_utm_campaign, p_utm_source, customer_referral_code
-- trên MỌI đơn (2.425/2.425) nhưng cả ba đều RỖNG — chưa có gì gắn mã theo dõi vào liên kết quảng
-- cáo. Ngày shop bắt đầu gắn, dữ liệu chảy về qua đúng ba trường này; không có cột thì nó chảy qua
-- rồi mất, và độ phủ quy kết đứng nguyên ở trần cũ mà không ai hiểu vì sao.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "utm_campaign" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "utm_source" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "referral_code" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "attribution_captured_at" timestamptz;
--> statement-breakpoint
-- Lấp lại từ dữ liệu THÔ đã lưu: không gọi lại API, không bịa. Hôm nay cả ba đều rỗng nên câu lệnh
-- này gần như không đụng dòng nào — nhưng nó đúng cho mọi đơn đã đồng bộ trước khi có cột.
UPDATE "orders" SET
  "utm_campaign"  = nullif(raw->>'p_utm_campaign', ''),
  "utm_source"    = nullif(raw->>'p_utm_source', ''),
  "referral_code" = nullif(raw->>'customer_referral_code', '')
WHERE raw IS NOT NULL
  AND (nullif(raw->>'p_utm_campaign','') IS NOT NULL
    OR nullif(raw->>'p_utm_source','') IS NOT NULL
    OR nullif(raw->>'customer_referral_code','') IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_utm_campaign_idx" ON "orders" ("utm_campaign") WHERE "utm_campaign" IS NOT NULL;
