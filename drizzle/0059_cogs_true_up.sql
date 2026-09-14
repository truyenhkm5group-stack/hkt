-- Giá vốn kỳ đã chốt được phép chốt lại ĐÚNG MỘT LẦN khi có chứng từ mạnh hơn (phiếu nhập kho),
-- có nhật ký, rồi đóng băng. Ba cột ghi lại lần chốt đó để truy nguyên.
ALTER TABLE "canonical_order_outcome" ADD COLUMN IF NOT EXISTS "trued_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "canonical_order_outcome" ADD COLUMN IF NOT EXISTS "trued_up_from" integer;--> statement-breakpoint
ALTER TABLE "canonical_order_outcome" ADD COLUMN IF NOT EXISTS "trued_up_from_basis" text;--> statement-breakpoint
-- Thêm căn cứ PROVISIONAL (giá vốn Pancake / giá nhập mẫu mã khi chưa có phiếu nhập).
ALTER TABLE "canonical_order_outcome" DROP CONSTRAINT IF EXISTS "canonical_cogs_basis_check";--> statement-breakpoint
ALTER TABLE "canonical_order_outcome" ADD CONSTRAINT "canonical_cogs_basis_check"
  CHECK ("cogs_basis" IS NULL OR "cogs_basis" IN ('RECEIPT_BEFORE', 'RECEIPT_AFTER', 'PROVISIONAL', 'NONE')) NOT VALID;--> statement-breakpoint
-- Đơn đã giao mà KHÔNG có nguồn giá vốn nào: 0 nghĩa là CHƯA BIẾT, không phải miễn phí. Báo cáo đọc
-- coalesce(recognized_cogs, cogs) nên tổng không đổi; chỉ ý nghĩa của ô trống được nói đúng.
UPDATE "canonical_order_outcome" SET "recognized_cogs" = NULL WHERE "cogs_basis" = 'NONE' AND "recognized_cogs" = 0;
