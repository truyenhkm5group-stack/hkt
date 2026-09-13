-- ═══════════ CHỨNG TỪ CỦA MỘT LƯỢT GỬI ═══════════
--
-- `outreach_targets` trước đây chỉ giữ `status` và một ô `error` dạng chữ. Nghĩa là:
--
--  · không biết lượt gửi nào được nhà cung cấp CHẤP NHẬN (không có mã tin của họ);
--  · không biết một dòng đã thử mấy lần — nên không phân biệt được "lỗi một lần" với "lỗi mãi";
--  · và không phân loại được lỗi, nên nút "gửi lại" mời người dùng thử lại cả những lỗi mà thử
--    lại chắc chắn vô ích (chính sách cửa sổ 24 giờ của Meta).
--
-- Bốn cột thêm vào đều NULLABLE và không mặc định: dòng cũ KHÔNG được đoán. Một dòng đã gửi từ
-- trước mà điền đại `attempt_count = 1` là bịa ra một con số chưa ai đo.

ALTER TABLE "outreach_targets" ADD COLUMN IF NOT EXISTS "provider_message_id" text;
--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD COLUMN IF NOT EXISTS "accepted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD COLUMN IF NOT EXISTS "error_kind" text;
--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD COLUMN IF NOT EXISTS "attempt_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- Trạng thái là danh sách ĐÓNG. `SENDING` là trạng thái mới: một dòng đang được một lượt gửi GIỮ
-- CHỖ. Không có nó thì hai lần bấm cùng lúc đều thấy dòng ở `PENDING` và đều gửi — khách nhận hai
-- tin giống hệt nhau.
DO $$
BEGIN
  ALTER TABLE "outreach_targets" DROP CONSTRAINT IF EXISTS "outreach_targets_status_check";
  ALTER TABLE "outreach_targets" ADD CONSTRAINT "outreach_targets_status_check"
    CHECK ("status" IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED', 'CONVERTED', 'REPLIED'));
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outreach_targets_attempt_check') THEN
    ALTER TABLE "outreach_targets" ADD CONSTRAINT "outreach_targets_attempt_check" CHECK ("attempt_count" >= 0);
  END IF;
END $$;
