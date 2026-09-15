-- ═══════════ QUY KẾT ĐƠN LANDING PAGE BẰNG TRACKING QUẢNG CÁO ═══════════
--
-- Đơn landing không mang `page_id` của Pancake, nên tới bản này chúng nằm trọn trong nhóm
-- `NO_PAGE`: doanh thu thật, tiền quảng cáo thật, mà không thuộc về ai. Form landing lại CÓ
-- tracking — đo production 15/09/2026: 321/371 dòng có chuỗi utm khớp TUYỆT ĐỐI một tên chiến
-- dịch trong `ad_spends`, và 321 dòng ấy ra đúng một TKQC và đúng một marketer.
--
-- Hai thay đổi, cả hai đều CỘNG THÊM, không đụng đường quy kết Messenger đang chạy:
--   1. `order_attributions` khai thêm NGUỒN quy kết và FANPAGE SUY RA (khác hẳn `source_page_id`
--      chép thẳng từ Pancake — không được phép giả mạo ô ấy);
--   2. bảng `landing_attributions` giữ BẰNG CHỨNG của từng đơn landing: utm đã chụp, mẩu quảng
--      cáo, chiến dịch, tài khoản quảng cáo, và câu giải thích đọc được.
--
-- Idempotent: chạy lại bao nhiêu lần cũng ra một trạng thái.

ALTER TABLE "order_attributions" ADD COLUMN IF NOT EXISTS "attribution_source" text NOT NULL DEFAULT 'PANCAKE_PAGE';
--> statement-breakpoint
ALTER TABLE "order_attributions" ADD COLUMN IF NOT EXISTS "attributed_page_id" text;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "order_attributions"
    ADD CONSTRAINT "order_attribution_source_check"
    CHECK ("attribution_source" IN ('PANCAKE_PAGE', 'LANDING_UTM'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- Fanpage SUY RA chỉ có nghĩa khi đơn được quy kết bằng tracking landing. Không có ràng buộc này
-- thì một lần ghi nhầm sẽ đặt "page suy ra" lên một đơn Messenger vốn đã có page thật, và hai ô
-- nói hai chuyện khác nhau về cùng một đơn.
DO $$ BEGIN
  ALTER TABLE "order_attributions"
    ADD CONSTRAINT "order_attribution_inferred_page_check"
    CHECK ("attributed_page_id" IS NULL OR "attribution_source" = 'LANDING_UTM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "order_attribution_source_idx" ON "order_attributions" ("attribution_source");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "landing_attributions" (
  "id" text PRIMARY KEY NOT NULL,
  "order_id" text NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "landing_order_id" text REFERENCES "landing_orders"("id") ON DELETE SET NULL,
  -- Bậc bằng chứng đã dùng: AD_ID · ADSET_ID · CAMPAIGN_NAME. NULL = chưa kết luận được.
  "tier" text,
  -- Vì sao chưa quy kết được, khi `marketer_id` rỗng. NULL = đã quy kết.
  "gap" text,
  "marketer_id" text,
  "ad_account_id" text,
  "campaign_id" text,
  "adset_id" text,
  "ad_id" text,
  -- Fanpage suy ra từ mẩu quảng cáo (`story_id`), NULL là câu trả lời hợp lệ.
  "page_id" text,
  -- Ảnh chụp toàn bộ ô tracking đã đọc, giữ nguyên văn để sáu tháng sau còn kiểm lại được.
  "utm" jsonb,
  "landing_url" text,
  -- Mã hàng mà tên chiến dịch nói tới. CHỈ để đối chiếu — mã hàng của đơn đọc từ dòng hàng thật.
  "campaign_product_code" text,
  -- Chiến dịch nói một mã, đơn lại là mã khác. Không sửa đơn; đánh dấu để rà.
  "product_mismatch" boolean NOT NULL DEFAULT false,
  "evidence" text NOT NULL DEFAULT '',
  "rule_version" integer NOT NULL DEFAULT 1,
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- MỘT ĐƠN MỘT DÒNG — chính là thứ làm phép đối soát idempotent: chạy lại bao nhiêu lần cũng không
-- có đường nào cộng doanh thu hai lần.
CREATE UNIQUE INDEX IF NOT EXISTS "landing_attribution_order_uq" ON "landing_attributions" ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landing_attribution_marketer_idx" ON "landing_attributions" ("marketer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landing_attribution_campaign_idx" ON "landing_attributions" ("campaign_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landing_attribution_tier_idx" ON "landing_attributions" ("tier");
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "landing_attributions"
    ADD CONSTRAINT "landing_attribution_tier_check"
    CHECK ("tier" IS NULL OR "tier" IN ('AD_ID', 'ADSET_ID', 'CAMPAIGN_NAME'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "landing_attributions"
    ADD CONSTRAINT "landing_attribution_gap_check"
    CHECK ("gap" IS NULL OR "gap" IN ('NO_TRACKING', 'NO_MATCH', 'AMBIGUOUS_MARKETER', 'NO_MARKETER_DECLARED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- KẾT LUẬN ĐI CÙNG CĂN CỨ: có người thì phải có bậc bằng chứng và câu giải thích; chưa có người
-- thì phải nói được vì sao. Không dòng nào được vừa trống người vừa trống lý do.
DO $$ BEGIN
  ALTER TABLE "landing_attributions"
    ADD CONSTRAINT "landing_attribution_evidence_check"
    CHECK (("marketer_id" IS NOT NULL AND "tier" IS NOT NULL AND "evidence" <> '' AND "gap" IS NULL)
        OR ("marketer_id" IS NULL AND "gap" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
