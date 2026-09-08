-- IDEMPOTENT: chạy lại được sau khi một migration trước đó thất bại giữa chừng.
--
-- Gói tin webhook: tách MỐC SỰ KIỆN khỏi GIỜ NHẬN, và chống trùng lần gửi lại.
-- Viettel Post thử lại tối đa 5 lần cho cùng một sự việc; trước đây mỗi lần thử lại đẻ thêm một
-- dòng nên con số "đã nhận / đã xử lý" trên trang Kết nối dữ liệu không đọc được nữa.
--
-- Chỉ chứa thay đổi của migration này. (Bản sinh tự động của drizzle-kit gộp cả những migration
-- 0027–0031 vốn viết tay và chưa có snapshot; giữ nguyên bản đó sẽ CREATE TABLE đè lên bảng đang
-- chạy ở production.)
ALTER TABLE "webhook_events" ADD COLUMN IF NOT EXISTS "occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN IF NOT EXISTS "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN IF NOT EXISTS "delivery_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Dòng cũ đều có dedupe_key = NULL; Postgres cho phép nhiều NULL trong unique index nên không
-- migration nào phải đụng vào dữ liệu lịch sử.
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_dedupe_uq" ON "webhook_events" USING btree ("dedupe_key");
