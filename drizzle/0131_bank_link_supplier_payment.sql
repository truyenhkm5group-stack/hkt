-- 0131 · SỔ NGÂN HÀNG NỐI ĐƯỢC TỚI ĐỢT THANH TOÁN XƯỞNG MAY / NHÀ VẢI.
--
-- Chủ shop yêu cầu (25/09/2026) ghép các giao dịch trả xưởng may / nhà vải trên sao kê vào phần
-- thanh toán ở Sổ đặt xưởng. Một loại chứng từ đích mới: `SUPPLIER_PAYMENT` (= `supplier_payments.id`).
-- Như mọi mối nối khác, đây là ĐỐI CHIẾU chứ không phải ghi nhận chi phí (AGENTS.md mục 17): giá vốn
-- vẫn đi theo phiếu kho, sổ đặt xưởng là công nợ.
--
-- CHỈ NỚI HAI RÀNG BUỘC danh sách loại (bảng mối nối + ảnh chụp `linked_type`). Không đụng một dòng
-- nào đã có. Viết tay và idempotent như 0033–0130.

ALTER TABLE "bank_transaction_links" DROP CONSTRAINT IF EXISTS "bank_txn_links_target_type_check";
--> statement-breakpoint
ALTER TABLE "bank_transaction_links" ADD CONSTRAINT "bank_txn_links_target_type_check"
  CHECK ("target_type" IN ('EXPENSE', 'COD_BATCH', 'STOCK_RECEIPT', 'AD_SPEND', 'PAYROLL_PERIOD', 'BANK_TRANSACTION', 'SUPPLIER_PAYMENT'));
--> statement-breakpoint
ALTER TABLE "bank_transactions" DROP CONSTRAINT IF EXISTS "bank_txn_linked_check";
--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_txn_linked_check"
  CHECK ("linked_type" IN ('', 'EXPENSE', 'COD_BATCH', 'STOCK_RECEIPT', 'AD_SPEND', 'PAYROLL_PERIOD', 'BANK_TRANSACTION', 'SUPPLIER_PAYMENT'));
