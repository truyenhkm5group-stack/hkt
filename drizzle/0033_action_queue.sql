-- IDEMPOTENT: chạy lại được sau khi một migration trước đó thất bại giữa chừng.
--
-- HÀNG ĐỢI VIỆC: "Cần xử lý" cũ chỉ là danh sách đọc rồi bỏ vì không có ai cầm việc.
-- Ba cột dưới đây tách ba trạng thái khác nhau: ĐÃ ĐỌC (readBy, đã có) · ĐÃ TIẾP NHẬN
-- (acknowledged_*) · ĐÃ XONG (resolved_at, đã có). Người nhận việc là assigned_to.
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "assigned_to" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "acknowledged_by" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "acknowledged_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_assigned_to_users_id_fk"
    FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_acknowledged_by_users_id_fk"
    FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_assigned_idx" ON "notifications" USING btree ("assigned_to","resolved_at");
