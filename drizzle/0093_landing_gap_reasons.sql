-- ═══════ LÝ DO TREO: DANH SÁCH Ở CSDL PHẢI ĐI CÙNG DANH SÁCH Ở MÃ NGUỒN ═══════
--
-- SỰ CỐ THẬT (15/09/2026, lượt đối soát sau khi tra nhóm quảng cáo): bản 0091 chốt cứng bốn lý do
-- treo và ba bậc bằng chứng vào hai ràng buộc CHECK. Bản sau mở rộng danh sách ấy TRONG MÃ NGUỒN
-- — thêm `META_ADSET_NOT_SYNCED`, `CAMPAIGN_NOT_SYNCED`, `NO_AD_SOURCE`… và bậc `CAMPAIGN_ID` —
-- nhưng KHÔNG mở rộng ràng buộc. Lượt đối soát chạy tới dòng đầu tiên mang lý do mới là hỏng cả
-- lượt ghi.
--
-- Bộ kiểm thử không bắt được vì các ca thử chỉ sinh ra những giá trị CŨ. Bài kiểm mới
-- (`tests/landing-attribution.test.ts`) nay ghi THỬ TỪNG giá trị trong `LANDING_GAP_REASONS` và
-- `LANDING_EVIDENCE_TIERS` xuống CSDL, nên hai danh sách không thể lệch nhau lần nữa mà vẫn xanh.
--
-- Chỉ NỚI ràng buộc, không đụng một dòng dữ liệu nào.

ALTER TABLE "landing_attributions" DROP CONSTRAINT IF EXISTS "landing_attribution_gap_check";
--> statement-breakpoint
ALTER TABLE "landing_attributions"
  ADD CONSTRAINT "landing_attribution_gap_check"
  CHECK ("gap" IS NULL OR "gap" IN (
    'NO_TRACKING',
    'NO_AD_SOURCE',
    'META_ADSET_NOT_SYNCED',
    'META_AD_NOT_SYNCED',
    'CAMPAIGN_NOT_SYNCED',
    'AD_ACCOUNT_UNRESOLVED',
    'HISTORICAL_OWNER_UNKNOWN',
    'AMBIGUOUS_MARKETER',
    'NO_MARKETER_DECLARED',
    'NO_MATCH'
  ));
--> statement-breakpoint
ALTER TABLE "landing_attributions" DROP CONSTRAINT IF EXISTS "landing_attribution_tier_check";
--> statement-breakpoint
ALTER TABLE "landing_attributions"
  ADD CONSTRAINT "landing_attribution_tier_check"
  CHECK ("tier" IS NULL OR "tier" IN ('AD_ID', 'ADSET_ID', 'CAMPAIGN_ID', 'CAMPAIGN_NAME'));
