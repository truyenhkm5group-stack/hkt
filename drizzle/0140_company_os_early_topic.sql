-- 0140 · COMPANY OS · AGENT T — LOẠI ĐỀ XUẤT MỚI "MẪU TRIỂN VỌNG — CÂN NHẮC MỞ TOPIC SẢN XUẤT SỚM".
--
-- Quy tắc chủ shop 25/09/2026: topic sản xuất mở được cho mẫu có chỉ số tốt mà CHƯA thắng. Buồng lái
-- "Cần anh quyết" thêm loại `MODEL_EARLY_TOPIC`; sổ phản ứng `recommendation_decisions` (0139) có CHECK
-- trên cột `kind`, nên chấp nhận / bỏ qua / nhắc lại một dòng loại mới cần CHECK mở rộng — nếu không,
-- lượt ghi bị CSDL từ chối.
--
-- Chỉ thay CHECK: không cột mới, không backfill, không đụng dòng nào (mục 8.8, 35). Topic mở sớm ghi bối
-- cảnh vào `production_topics.evidence_snapshot` (jsonb có sẵn) — không cần migration.
-- Viết tay và idempotent như 0033–0139: DROP IF EXISTS rồi ADD — chạy lại ra đúng một ràng buộc.

ALTER TABLE "recommendation_decisions" DROP CONSTRAINT IF EXISTS "recommendation_decisions_kind_check";
--> statement-breakpoint
ALTER TABLE "recommendation_decisions" ADD CONSTRAINT "recommendation_decisions_kind_check" CHECK ("kind" IN ('APPROVAL', 'SAMPLE_REVIEW', 'TOPIC_DECISION', 'ADS_CUT', 'INVENTORY_STOCKOUT', 'PRODUCTION_LATE', 'INVENTORY_REORDER', 'MODEL_SCALE', 'MODEL_EARLY_TOPIC', 'INVENTORY_CLEARANCE'));
