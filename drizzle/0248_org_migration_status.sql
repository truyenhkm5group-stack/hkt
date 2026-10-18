-- 0248 · TRẠNG THÁI LƯỢT MIGRATE CỦA TỪNG TỔ CHỨC — mặt phẳng điều khiển, chỉ thật ở CSDL NHÀ (chủ shop 18/10/2026).
--
-- VÌ SAO: deploy 18/10/2026 — bước kiểm (scripts/verify-migrations.ts) và ứng dụng vừa khởi động cùng mở (= migrate) CSDL `qa`. Hai
-- tiến trình lấy cùng khoá tư vấn; bên thua chờ 120 giây rồi báo «Tiến trình khác đang migrate…» như thể đó là kết quả migrate của tổ
-- chức, trong khi lượt THẬT chạy ở tiến trình kia và không nơi nào ghi lại nó kết thúc ra sao. Bảng này là nơi ghi đó: mỗi tổ chức MỘT
-- dòng, chỉ người điều phối (tiến trình đang cầm khoá) ghi, mọi tiến trình khác đọc để chờ ĐÚNG lượt đang chạy và báo ĐÚNG kết quả của nó
-- (db/migrate.ts::coordinateOrgMigration, lib/constants/org-migrate-coordination.ts).
--
-- Bảng chạy qua MỌI CSDL như mọi migration; bản ở CSDL tổ chức không bao giờ được ghi và bị dọn mỗi lần mở (migrateOrganizationDb).
-- Chỉ TẠO bảng mới — không đổi bảng nào mã đang đọc — nên có trong sổ phục vụ lược đồ cũ (lib/constants/migration-serve-compat.ts).
-- Không gieo dòng nào. Idempotent.
CREATE TABLE IF NOT EXISTS "platform_org_migration_status" (
  "org_code" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "state" text NOT NULL,
  "holder_role" text NOT NULL,
  "holder_pid" integer NOT NULL,
  "holder_host" text NOT NULL,
  "holder_token" text,
  "started_at" timestamp with time zone NOT NULL,
  "deadline_at" timestamp with time zone NOT NULL,
  "finished_at" timestamp with time zone,
  "target_tag" text,
  "missing_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "timed_out" boolean DEFAULT false NOT NULL,
  "reason" text,
  "takeover_of" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_org_migration_status_state_check" CHECK ("state" IN ('RUNNING','DONE','DEGRADED','FAILED')),
  CONSTRAINT "platform_org_migration_status_role_check" CHECK ("holder_role" IN ('APP','VERIFY','SCRIPT')),
  CONSTRAINT "platform_org_migration_status_finished_check" CHECK (("state" = 'RUNNING') = ("finished_at" IS NULL)),
  CONSTRAINT "platform_org_migration_status_deadline_check" CHECK ("deadline_at" > "started_at"),
  CONSTRAINT "platform_org_migration_status_missing_check" CHECK (jsonb_typeof("missing_tags") = 'array'),
  CONSTRAINT "platform_org_migration_status_host_check" CHECK (length("holder_host") <= 120),
  CONSTRAINT "platform_org_migration_status_token_check" CHECK ("holder_token" IS NULL OR length("holder_token") <= 64),
  CONSTRAINT "platform_org_migration_status_reason_check" CHECK ("reason" IS NULL OR length("reason") <= 500),
  CONSTRAINT "platform_org_migration_status_takeover_check" CHECK ("takeover_of" IS NULL OR length("takeover_of") <= 300)
);
