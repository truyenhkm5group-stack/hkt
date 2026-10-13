-- ═══════ GIÁ VỐN THỰC TẾ = GIÁ BÁO MKT HIỆN TẠI (chủ shop chốt 13/10/2026) ═══════
--
-- Thêm căn cứ giá vốn 'MARKETER_PRICE' cho canonical_order_outcome: đơn mà MỌI dòng có giá báo MKT
-- đang hiệu lực mang căn cứ này và KHÔNG đóng băng giá vốn ghi nhận (lib/queries/canonical-outcome.ts,
-- lib/queries/current-marketer-cost.ts, docs/cost-center.md mục 5).
--
-- CHỈ NỚI RÀNG BUỘC — không đổi dữ liệu nào. Viết tay, idempotent: DROP IF EXISTS rồi ADD NOT VALID
-- (cùng mẫu với 0059), nên chạy lại không hỏng và không quét lại bảng.
ALTER TABLE "canonical_order_outcome" DROP CONSTRAINT IF EXISTS "canonical_cogs_basis_check";--> statement-breakpoint
ALTER TABLE "canonical_order_outcome" ADD CONSTRAINT "canonical_cogs_basis_check"
  CHECK ("cogs_basis" IS NULL OR "cogs_basis" IN ('MARKETER_PRICE', 'RECEIPT_BEFORE', 'RECEIPT_AFTER', 'PROVISIONAL', 'NONE')) NOT VALID;
--> statement-breakpoint
-- Định giá hàng hoàn huỷ bỏ đi CÙNG bậc thang (lib/queries/return-dispositions.ts::pickUnitCost) ⇒ thêm
-- căn cứ 'MARKETER_PRICE'. Mọi vế khác của ràng buộc giữ NGUYÊN VĂN như 0137.
ALTER TABLE "return_dispositions" DROP CONSTRAINT IF EXISTS "return_dispositions_value_check";--> statement-breakpoint
ALTER TABLE "return_dispositions" ADD CONSTRAINT "return_dispositions_value_check" CHECK (("disposition" = 'WRITE_OFF' OR ("unit_cost_estimate" IS NULL AND "value_estimate" IS NULL AND "cost_basis" IS NULL)) AND ("value_estimate" IS NULL OR "value_estimate" >= 0) AND ("cost_basis" IS NULL OR "cost_basis" IN ('MARKETER_PRICE', 'RECEIPT', 'ORDER_SNAPSHOT', 'VARIANT_DEFAULT', 'UNKNOWN'))) NOT VALID;
