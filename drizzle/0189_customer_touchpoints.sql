-- 0189 · SỔ LIÊN HỆ KHÁCH (nhắc mua lại — docs/verticals/reorder-reminders.md).
--
--  · Mỗi lần người bán gọi / nhắn / gặp khách là MỘT dòng, chỉ thêm: cách liên hệ, kết quả, ghi chú, hẹn liên hệ lại,
--    người làm (khoá `users.id` + ảnh chụp tên do máy chủ đọc — luật 34).
--  · KHÔNG có bảng "khách đến hạn mua lại": hạn là hàm của lịch sử đơn + chu kỳ, tính lúc đọc (lib/constants/reorder.ts).
--  · CSDL mọi tổ chức. Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "customer_touchpoints" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "outcome" text NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "next_contact_on" date,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "user_name" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customer_touchpoints_kind_check" CHECK ("kind" IN ('CALL','MESSAGE','VISIT','OTHER')),
  CONSTRAINT "customer_touchpoints_outcome_check" CHECK ("outcome" IN ('WILL_ORDER','NOT_NOW','NO_ANSWER','DECLINED','OTHER'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_touchpoints_customer_at_idx" ON "customer_touchpoints" ("customer_id", "at");
