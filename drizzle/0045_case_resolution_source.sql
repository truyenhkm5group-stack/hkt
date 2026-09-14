-- AI ĐÓNG VIỆC, VÀ VÌ SAO ĐÓNG.
--
-- Trước đây "điều kiện tự hết" và "có người làm xong" đều chỉ ghi `resolved_at`, nên hai chuyện
-- khác hẳn nhau trông y hệt nhau. Production 09/09/2026 có 3.896 việc đã đóng mà không ai trả lời
-- được bao nhiêu là công của đội — lấy con số đó đo năng suất là đo nhầm.
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "resolved_by" text;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "resolution" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notifications"
    ADD CONSTRAINT "notifications_resolved_by_users_id_fk"
    FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
-- Dòng lịch sử: đã đóng nhưng KHÔNG biết ai đóng. Ghi đúng là chưa biết, không gán bừa cho hệ thống
-- cũng không gán bừa cho người — suy đoán ngược ở đây sẽ thổi phồng hoặc bóp méo năng suất của đội.
UPDATE "notifications" SET "resolution" = 'UNKNOWN' WHERE "resolved_at" IS NOT NULL AND "resolution" IS NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_resolution_check"
    CHECK ("resolution" IS NULL OR "resolution" IN ('MANUAL', 'AUTO', 'STALE', 'UNKNOWN')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_resolution_shape_check"
    CHECK (("resolved_at" IS NULL) = ("resolution" IS NULL)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_resolver_check"
    CHECK ("resolved_by" IS NULL OR "resolution" = 'MANUAL') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_resolution_idx" ON "notifications" ("resolution", "resolved_at");
