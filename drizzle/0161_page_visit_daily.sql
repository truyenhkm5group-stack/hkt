-- 0161 · LƯỢT MỞ TRANG THEO NGÀY (lib/constants/page-usage.ts).
--
--  · CHỈ THÊM: một bảng mới, không bảng nào bị đổi, không dữ liệu nào được chèn. Bảng rỗng = chưa đo
--    (màn hình in "chưa có số đo", KHÔNG in 0 lượt).
--  · KHÔNG có cột người: mỗi dòng là (ngày VN, mục trang đã khai, số lượt).
-- Viết tay và idempotent như 0033–0155.

CREATE TABLE IF NOT EXISTS "page_visit_daily" (
  "day" text NOT NULL,
  "page_key" text NOT NULL,
  "visits" integer DEFAULT 0 NOT NULL,
  "last_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "page_visit_daily_day_check" CHECK ("day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  CONSTRAINT "page_visit_daily_visits_check" CHECK ("visits" >= 0),
  CONSTRAINT "page_visit_daily_key_check" CHECK (length("page_key") between 1 and 120)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "page_visit_daily_pk" ON "page_visit_daily" ("day","page_key");
