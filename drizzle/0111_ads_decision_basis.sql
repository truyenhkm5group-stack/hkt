-- Căn cứ của một khuyến nghị quảng cáo: SỐ ĐO hay LỢI NHUẬN TẠM TÍNH.
--
-- Bảng quyết định nay kết luận được cả khi đơn chưa ngã ngũ (mô hình bán trước: đo 22/09/2026 thì
-- 425/425 dòng cấp chiến dịch đều "chưa đủ dữ liệu"), bằng cách đổi CĂN CỨ sang lợi nhuận tạm tính
-- thay vì từ chối kết luận. Cùng một chữ "CẮT" trên hai căn cứ khác nhau không phải cùng một kết
-- luận, nên căn cứ phải đi vào sổ cùng với kết luận.
--
-- Mặc định 'ACTUAL' cho dòng cũ: luật cũ chỉ kết luận khi đã đủ độ chín, nên đó là lời khai ĐÚNG
-- về cách chúng được sinh ra — không phải một phép backfill đoán mò.

ALTER TABLE "ads_decision_ledger" ADD COLUMN IF NOT EXISTS "basis" text NOT NULL DEFAULT 'ACTUAL';--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "ads_decision_ledger"
    ADD CONSTRAINT "ads_decision_ledger_basis_check" CHECK ("basis" IN ('ACTUAL', 'PROJECTED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
