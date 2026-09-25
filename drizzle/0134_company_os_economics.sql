-- 0134 · COMPANY OS · AGENT F — ẢNH CHỤP LỢI NHUẬN DỰ PHÓNG TRONG SỔ QUYẾT ĐỊNH QUẢNG CÁO.
--
-- `ads_decision_ledger` đã lưu lợi nhuận ĐO ĐƯỢC (`profit_after_ads`) và CĂN CỨ (`basis`), nhưng
-- không lưu con số TẠM TÍNH mà một kết luận `PROJECTED` thật sự đứng trên. Thiếu nó thì không bao giờ
-- đo được độ chính xác dự báo: vài tuần sau cohort chín, mà con số máy đã dự phóng hôm ấy không còn
-- ở đâu. Ba cột chép thẳng từ dòng `buildDecisionRow` (lib/marketing/decision-ledger.ts) — không
-- công thức mới.
--
-- NULLABLE, KHÔNG MẶC ĐỊNH, KHÔNG BACKFILL (AGENTS.md mục 35, 8.8): dòng sổ cũ mang NULL = CHƯA
-- CHỤP. Dựng lại quá khứ là tính trên dữ liệu đã chín thêm — một con số khác với con số hôm ấy.
-- Viết tay và idempotent như 0033–0130.

ALTER TABLE "ads_decision_ledger" ADD COLUMN IF NOT EXISTS "projected_profit_after_ads" integer;
--> statement-breakpoint
ALTER TABLE "ads_decision_ledger" ADD COLUMN IF NOT EXISTS "projected_headroom" double precision;
--> statement-breakpoint
ALTER TABLE "ads_decision_ledger" ADD COLUMN IF NOT EXISTS "applied_delivery_rate" double precision;
