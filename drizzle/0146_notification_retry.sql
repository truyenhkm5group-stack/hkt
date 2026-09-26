-- 0146 · COMPANY OS · AGENT N — GỬI LẠI TIN CẢNH BÁO LARK / TELEGRAM HỎNG.
--
-- Trước bản này một dòng `notifications` gửi hỏng thì `notified_at` nằm NULL vĩnh viễn và không ai
-- gửi lại. Job `alerts` (không thêm lịch) nay thử lại trong cửa sổ, có trần và nhịp lùi
-- (`lib/constants/notification-retry.ts`). Ba cột ghi vết:
--
--  · `notify_attempts`        — số lần đã NHẬN gửi (kể cả lần đầu). NULL = chưa từng thử.
--  · `notify_last_attempt_at` — lúc nhận lượt thử gần nhất; cũng là khoá giữ chỗ (so-sánh-rồi-đổi)
--                               để hai lượt chạy đồng thời không gửi trùng.
--  · `notify_last_error`      — câu lỗi gần nhất, ĐÃ CHE URL / token (kho PUBLIC).
--
-- KHÔNG BACKFILL, KHÔNG DEFAULT (mục 8.8, 35): dòng cũ giữ NULL ⇒ KHÔNG BAO GIỜ được gửi lại — chúng đã
-- quá cửa sổ, và "chưa từng thử" khác "thử rồi hỏng". Viết tay, idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "notify_attempts" integer;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "notify_last_attempt_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "notify_last_error" text;
