-- 0186 · SỔ GỬI TIN TỰ GỬI LẠI TIN HỎNG VÌ MẠNG (Telegram / Zalo / Lark).
--
--  · Đo 01/10/2026: máy chủ ERP (Việt Nam) chập chờn tới api.telegram.org — cùng một nhóm chat, 16:42 gửi được, 21:12
--    `ETIMEDOUT`. Tin «đơn mới» hỏng lúc mạng tắc trước đây nằm luôn ở `FAILED`, không ai gửi lại.
--  · `attempts`: số lần đã thử (dòng mới = 1). `next_retry_at`: mốc gửi lại — CHỈ đặt khi lỗi xảy ra TRƯỚC KHI yêu cầu rời
--    máy (không mở được kết nối ⇒ nhà cung cấp chắc chắn chưa nhận ⇒ gửi lại không thể trùng). Lịch 2 · 5 · 15 · 30 · 60 ·
--    120 phút, trong 6 giờ kể từ lúc tạo. Tin thử không hẹn gửi lại.
--  · CSDL mọi tổ chức. Viết tay và idempotent như các migration trước.

ALTER TABLE "messaging_deliveries" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "messaging_deliveries" ADD COLUMN IF NOT EXISTS "next_retry_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messaging_deliveries_retry_idx" ON "messaging_deliveries" ("status", "next_retry_at");
