-- 0267 · SỔ NGÂN HÀNG NỐI ĐƯỢC TIỀN KHÁCH CHUYỂN VỚI ĐƠN TẠO TAY (docs/tech/hslc-b2b-sales-agent.md · P5).
--
-- Chốt đơn sỉ: khách chuyển khoản tiền đơn. Một loại chứng từ đích mới: `ORDER` (= `orders.id` của đơn TẠO TAY).
-- Như mọi mối nối khác, đây là ĐỐI CHIẾU chứ không phải ghi nhận (AGENTS.md mục 17):
--  · nối KHÔNG tạo phiếu thu `order_payments`, KHÔNG đổi công nợ, KHÔNG đổi doanh thu;
--  · kết quả đơn vẫn chỉ theo ORDER_OUTCOME.
-- Người bấm «Nối» qua đúng hành động nối của sổ ngân hàng (`linkBankTransaction`, quyền bank:write).
--
-- CHỈ NỚI HAI RÀNG BUỘC danh sách loại (bảng mối nối + ảnh chụp `linked_type`), y như 0131. Không đụng một dòng nào đã có.
-- Viết tay, idempotent.

ALTER TABLE "bank_transaction_links" DROP CONSTRAINT IF EXISTS "bank_txn_links_target_type_check";
--> statement-breakpoint
ALTER TABLE "bank_transaction_links" ADD CONSTRAINT "bank_txn_links_target_type_check"
  CHECK ("target_type" IN ('EXPENSE', 'COD_BATCH', 'STOCK_RECEIPT', 'AD_SPEND', 'PAYROLL_PERIOD', 'BANK_TRANSACTION', 'SUPPLIER_PAYMENT', 'ORDER'));
--> statement-breakpoint
ALTER TABLE "bank_transactions" DROP CONSTRAINT IF EXISTS "bank_txn_linked_check";
--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_txn_linked_check"
  CHECK ("linked_type" IN ('', 'EXPENSE', 'COD_BATCH', 'STOCK_RECEIPT', 'AD_SPEND', 'PAYROLL_PERIOD', 'BANK_TRANSACTION', 'SUPPLIER_PAYMENT', 'ORDER'));
