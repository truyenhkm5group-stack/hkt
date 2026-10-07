-- 0232 · CÀI WORKER MỘT NÚT + THU HỒI KHOÁ CŨ CỦA `dogfood-1` (docs/tech-control-plane/README.md mục 15).
--
--  · CỘNG THÊM: bảng `tech_worker_enrollments` (mã ghi danh dùng MỘT lần, hạn ngắn, chỉ lưu băm) và các cột
--    nullable / có mặc định trên `tech_workers` (mốc xoay / thu hồi / ghi danh / gỡ, báo cáo tự kiểm, lệnh sửa).
--  · THU HỒI khoá của `dogfood-1`: khoá đó đã hiện ra màn hình và đi qua đường "dán vào PowerShell" — coi như đã lộ.
--    Điều kiện CHẶT: đúng mã `dogfood-1`, CHƯA từng ghi danh bằng bộ cài, tạo TRƯỚC lượt deploy này (`now()` của
--    migration = mốc deploy), và chưa bị thu hồi. KHÔNG xét nhịp tim: khoá đã hiện ra màn hình là lộ, dù đã dùng hay
--    chưa (review bảo mật PR #631; production đo 07/10 06:08Z: chưa từng nhịp tim, 0 lượt chạy). Băm mới là băm của một chuỗi NGẪU NHIÊN
--    không ai giữ (thoả CHECK `^[0-9a-f]{64}$`), `secret_revoked_at` chặn xác thực kể cả khi băm khớp. Không xoá dòng.
--    Chạy lại không đổi gì (`secret_revoked_at IS NULL` + khoá chống trùng của sự kiện). Sau deploy chủ shop bấm
--    «Tải bộ cài» cho `dogfood-1`: bộ cài đổi mã ⇒ xoay khoá, bật lại worker.
--  · Viết tay, idempotent.

ALTER TABLE "tech_workers" ADD COLUMN IF NOT EXISTS "secret_rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tech_workers" ADD COLUMN IF NOT EXISTS "secret_revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tech_workers" ADD COLUMN IF NOT EXISTS "enrolled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tech_workers" ADD COLUMN IF NOT EXISTS "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tech_workers" ADD COLUMN IF NOT EXISTS "diagnostics" jsonb;--> statement-breakpoint
ALTER TABLE "tech_workers" ADD COLUMN IF NOT EXISTS "diagnostics_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tech_workers" ADD COLUMN IF NOT EXISTS "repair_command" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_workers" ADD COLUMN IF NOT EXISTS "repair_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tech_workers" DROP CONSTRAINT IF EXISTS "tech_workers_repair_check";--> statement-breakpoint
ALTER TABLE "tech_workers" ADD CONSTRAINT "tech_workers_repair_check" CHECK ("tech_workers"."repair_command" IN ('','RERUN_SELF_CHECK','REFRESH_REPO','PRUNE_WORKTREES','RESTART_LOOP'));--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tech_worker_enrollments" (
	"id" text PRIMARY KEY NOT NULL,
	"worker_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"used_from_host" text DEFAULT '' NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tech_worker_enrollments_worker_id_tech_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "tech_workers"("id") ON DELETE cascade,
	CONSTRAINT "tech_worker_enrollments_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE set null,
	CONSTRAINT "tech_worker_enrollments_code_check" CHECK ("tech_worker_enrollments"."code_hash" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tech_worker_enrollments_code_uq" ON "tech_worker_enrollments" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tech_worker_enrollments_worker_idx" ON "tech_worker_enrollments" USING btree ("worker_id","created_at");--> statement-breakpoint

WITH "thu_hoi" AS (
	UPDATE "tech_workers" SET
		"secret_hash" = encode(sha256(convert_to('revoked:' || "id" || ':' || gen_random_uuid()::text || ':' || clock_timestamp()::text, 'UTF8')), 'hex'),
		"secret_revoked_at" = now(),
		"enabled" = false,
		"disabled_reason" = 'Khoá cũ có thể đã lộ — tạo lại bằng bộ cài',
		"updated_at" = now()
	WHERE "key" = 'dogfood-1'
		AND "enrolled_at" IS NULL
		AND "secret_revoked_at" IS NULL
		AND "created_at" < now()
	RETURNING "id"
)
INSERT INTO "tech_events" ("id", "name", "subject_type", "subject_id", "payload", "actor_kind", "actor_name", "dedupe_key")
SELECT gen_random_uuid()::text, 'worker.secret_revoked', 'WORKER', "id",
	jsonb_build_object('key', 'dogfood-1', 'migration', '0232', 'reason', 'Khoá cũ có thể đã lộ — tạo lại bằng bộ cài'),
	'SYSTEM', 'migration:0232', 'worker.secret_revoked:0232:' || "id"
FROM "thu_hoi"
ON CONFLICT ("dedupe_key") DO NOTHING;
