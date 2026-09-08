-- IDEMPOTENT: chạy lại được sau khi một migration trước đó thất bại giữa chừng.
--
-- HÀNG ĐỢI VIỆC — HAI TRẠNG THÁI CÒN THIẾU.
--
-- Trước đây một việc chỉ có ba trạng thái: chưa ai nhận · đã tiếp nhận · đã xong. Thiếu hai trạng
-- thái mà thực tế vận hành luôn có:
--
--   ĐANG LÀM  — đã bắt tay vào, chưa xong. Gộp chung với "đã tiếp nhận" thì không biết việc nào
--               đang chạy, việc nào chỉ mới có người giơ tay.
--   BỎ QUA    — đã xem và quyết định KHÔNG làm, kèm LÝ DO. Trước đây người vận hành buộc phải bấm
--               "đã xong" cho việc mình cố tình không làm, biến số "đã xong" thành số vô nghĩa.
--
-- "Bỏ qua" bắt buộc có lý do và người bỏ qua: một việc bị gạt đi không có lý do là bằng chứng bị
-- xoá lặng lẽ, đúng thứ mà đặc tả cấm.
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "started_at" timestamptz;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "started_by" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "ignored_at" timestamptz;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "ignored_by" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "ignored_reason" text NOT NULL DEFAULT '';--> statement-breakpoint

DO $$
BEGIN
  ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_started_by_users_id_fk";
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_started_by_users_id_fk"
    FOREIGN KEY ("started_by") REFERENCES "users"("id") ON DELETE set null;
  ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_ignored_by_users_id_fk";
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_ignored_by_users_id_fk"
    FOREIGN KEY ("ignored_by") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
END $$;--> statement-breakpoint

-- Bỏ qua thì PHẢI có lý do. NOT VALID: không quét lại lịch sử, chỉ ràng buộc từ nay về sau.
DO $$
BEGIN
  ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_ignored_check";
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_ignored_check"
    CHECK ("notifications"."ignored_at" IS NULL OR length(trim("notifications"."ignored_reason")) > 0) NOT VALID;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "notifications_workflow_idx" ON "notifications" USING btree ("resolved_at","ignored_at","started_at");
