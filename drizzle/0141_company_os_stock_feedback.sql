-- 0141 · COMPANY OS · AGENT X — HAI LOẠI ĐỀ XUẤT MỚI CỦA BUỒNG LÁI: VÒNG PHẢN HỒI TỒN → CREATIVE / QUẢNG CÁO.
--
-- `recommendation_decisions.kind` có CHECK liệt kê đúng `OWNER_DECISION_KINDS` (0139 dựng, 0140 của Agent T thêm
-- `MODEL_EARLY_TOPIC`). Bản này liệt kê HỢP của cả hai cộng hai loại mới
-- (`SCALE_STOCK_RISK` — đừng tăng ngân sách khi sắp hết hàng; `STOCK_PUSH` — tồn chậm, đẩy bằng creative /
-- khách cũ) phải được CHECK nhận, nếu không một cú bấm Chấp nhận / Bỏ qua / Nhắc lại trên hai loại ấy bị CSDL
-- từ chối. Chỉ đổi CHECK: không thêm cột, không đụng dòng nào (bảng append-only, không backfill — mục 8.8).
--
-- GỘP NHÁNH: migration ÁP SAU CÙNG luôn phải liệt kê HỢP mọi loại (bài kiểm `tests/company-os-cockpit.test.ts`
-- so CHECK của migration muộn nhất với hằng số và đỏ khi thiếu một loại). Viết tay và idempotent như 0033–0140:
-- DROP IF EXISTS rồi ADD — chạy lại ra đúng một ràng buộc.

ALTER TABLE "recommendation_decisions" DROP CONSTRAINT IF EXISTS "recommendation_decisions_kind_check";
--> statement-breakpoint
ALTER TABLE "recommendation_decisions" ADD CONSTRAINT "recommendation_decisions_kind_check" CHECK ("kind" IN ('APPROVAL', 'SAMPLE_REVIEW', 'TOPIC_DECISION', 'ADS_CUT', 'SCALE_STOCK_RISK', 'INVENTORY_STOCKOUT', 'PRODUCTION_LATE', 'INVENTORY_REORDER', 'MODEL_SCALE', 'MODEL_EARLY_TOPIC', 'INVENTORY_CLEARANCE', 'STOCK_PUSH'));
