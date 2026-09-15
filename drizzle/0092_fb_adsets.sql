-- ═══════ NHÓM QUẢNG CÁO: MẮT XÍCH CÒN THIẾU GIỮA TRACKING LANDING VÀ CHIẾN DỊCH ═══════
--
-- Đo production 15/09/2026: 29/31 đơn landing còn treo mang một dãy 18 chữ số ở ô `utm_source`.
-- Graph API khai cả 10 mã ấy là ADSET, thuộc cùng một tài khoản quảng cáo, mỗi mã có một chiến
-- dịch cha — và cả 10 chiến dịch cha ĐỀU đã có trong `ad_spends` với đúng một marketer.
--
-- ERP không nối được chỉ vì thiếu đúng một bảng tra `adset_id → campaign_id`:
--   · `fb_ads` chỉ tra `ad_id` có trong `orders.ad_id`, mà đơn landing không mang `ad_id`;
--   · `ad_spends` chỉ có số liệu ở mức CHIẾN DỊCH, nên `adset_id` không bao giờ khớp ở đó.
--
-- CHỈ CỘNG THÊM một bảng. Không đụng `fb_ads`, `ad_spends`, chi tiêu hay thanh toán.
CREATE TABLE IF NOT EXISTS "fb_adsets" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL DEFAULT '',
  "campaign_id" text,
  "account_id" text,
  "status" text NOT NULL DEFAULT '',
  "missing" boolean NOT NULL DEFAULT false,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fb_adsets_campaign_idx" ON "fb_adsets" ("campaign_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fb_adsets_account_idx" ON "fb_adsets" ("account_id");
