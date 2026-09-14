-- IDEMPOTENT: chạy lại được sau khi một migration trước đó thất bại giữa chừng.
--
-- PHÂN BỔ CHI PHÍ THEO KHOẢNG BÁO CÁO.
--
-- Trước đây `expenses` chỉ có `occurred_at`, nên Báo cáo lợi nhuận cộng NGUYÊN khoản vào bất kỳ
-- khoảng nào chứa ngày đó. Tiền thuê 2.000.000đ/tháng ghi ngày 01/09 vào đủ 2.000.000đ khi xem tuần
-- 01–07/09 và bằng 0 khi xem tuần 08–14/09 — cả hai đều sai.
--
-- Thêm kỳ hiệu lực + phương pháp phân bổ. KHÔNG phá dữ liệu cũ: mọi dòng hiện có giữ nguyên hành vi
-- (`EVENT_DATE` = ghi trọn vào ngày phát sinh), nên không con số lịch sử nào bị viết lại lặng lẽ.
--
-- CỐ Ý KHÔNG tự suy ra kỳ cho các khoản cũ thuộc nhóm thuê mặt bằng / lương / phần mềm: đoán kỳ là
-- bịa chứng từ. Thay vào đó đánh dấu `needs_allocation_review` để chủ shop tự khai kỳ thật.
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "period_start" timestamptz;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "period_end" timestamptz;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "allocation_method" text NOT NULL DEFAULT 'EVENT_DATE';--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "needs_allocation_review" boolean NOT NULL DEFAULT false;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "expenses_period_idx" ON "expenses" USING btree ("period_start","period_end");--> statement-breakpoint

DO $$
BEGIN
  ALTER TABLE "expenses" DROP CONSTRAINT IF EXISTS "expenses_allocation_check";
  ALTER TABLE "expenses" ADD CONSTRAINT "expenses_allocation_check"
    CHECK ("expenses"."allocation_method" IN ('EVENT_DATE', 'PERIOD_PRORATA', 'ORDER_ATTRIBUTED', 'ACTUAL_DATED_SPEND')) NOT VALID;
  ALTER TABLE "expenses" DROP CONSTRAINT IF EXISTS "expenses_period_check";
  ALTER TABLE "expenses" ADD CONSTRAINT "expenses_period_check"
    CHECK ("expenses"."allocation_method" <> 'PERIOD_PRORATA' OR (
      "expenses"."period_start" IS NOT NULL AND "expenses"."period_end" IS NOT NULL
      AND "expenses"."period_end" >= "expenses"."period_start")) NOT VALID;
END $$;--> statement-breakpoint

-- Đánh dấu các khoản THEO KỲ chưa khai kỳ. Chỉ ĐÁNH DẤU, không đổi cách tính của chúng.
UPDATE "expenses" SET "needs_allocation_review" = true
WHERE "category" IN ('RENT', 'SALARY', 'SOFTWARE')
  AND "allocation_method" = 'EVENT_DATE'
  AND "period_start" IS NULL;
