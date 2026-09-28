-- 0169 · TỰ PHỤC VỤ: MÃ MỜI, LƯỢT ĐĂNG KÝ, GÓI + HẠN MỨC (docs/platform/phase-10-contracts.md §1, §5).
--
--  · CHỈ THÊM ba bảng của mặt phẳng điều khiển (chỉ có nghĩa ở CSDL NHÀ; bản sao trong CSDL tổ chức khác bị
--    `migrateOrganizationDb` xoá rỗng mỗi lần mở, như bốn bảng của 0152):
--      `platform_plans`            — gói dịch vụ + hạn mức (jsonb; `null` = không giới hạn).
--      `platform_signup_invites`   — mã mời dùng MỘT lần, có hạn. Chỉ lưu BĂM sha256 của mã, không bao giờ mã thô.
--      `platform_signup_attempts`  — mỗi lượt thử tạo tổ chức / nhập mã mời: nguồn để đếm trần theo IP (băm) và
--                                    theo ngày toàn nền tảng. Đếm từ BẢNG, không từ bộ nhớ tiến trình.
--  · Trạng thái tổ chức thêm `SETUP_FAILED` (dựng giữa chừng thì hỏng — người vận hành thấy ở /platform, CSDL KHÔNG
--    bị xoá tự động). Ràng buộc cũ được thay bằng tập lớn hơn: mọi dòng đang có vẫn hợp lệ.
--  · Gieo ba gói (`trial`, `standard`, `internal`) — DỮ LIỆU CẤU HÌNH của nền tảng, không phải dữ liệu khách.
--    `ON CONFLICT DO NOTHING`: người vận hành đã sửa hạn mức thì chạy lại không đè.
--  · Cột gói của tổ chức là `platform_organizations.plan` có sẵn từ 0152 ("chỗ cho gói dịch vụ") — không thêm
--    cột thứ hai. Không backfill: tổ chức nhà LUÔN là `internal` trong mã, tổ chức khác thiếu gói đọc là `trial`.
-- Viết tay và idempotent như các migration trước.

ALTER TABLE "platform_organizations" DROP CONSTRAINT IF EXISTS "platform_organizations_status_check";
--> statement-breakpoint
ALTER TABLE "platform_organizations" ADD CONSTRAINT "platform_organizations_status_check" CHECK ("status" in ('ACTIVE','SUSPENDED','ARCHIVED','SETUP_FAILED'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_plans" (
  "key" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_plans_key_check" CHECK ("key" ~ '^[a-z][a-z0-9-]{1,30}$')
);
--> statement-breakpoint
INSERT INTO "platform_plans" ("key", "name", "description", "limits", "position") VALUES
  ('trial', 'Dùng thử', 'Gói mặc định của tổ chức tự đăng ký: đủ để dựng và thử ERP với một nhóm nhỏ.', '{"users":3,"pages":5,"objects":2,"records":500,"workflows":5,"aiDraftsPerDay":10,"storageMb":50}'::jsonb, 10),
  ('standard', 'Tiêu chuẩn', 'Gói cho tổ chức vận hành thật.', '{"users":25,"pages":50,"objects":20,"records":50000,"workflows":50,"aiDraftsPerDay":100,"storageMb":2048}'::jsonb, 20),
  ('internal', 'Nội bộ', 'Tổ chức nhà và tổ chức nội bộ của nền tảng — không giới hạn.', '{"users":null,"pages":null,"objects":null,"records":null,"workflows":null,"aiDraftsPerDay":null,"storageMb":null}'::jsonb, 30)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_signup_invites" (
  "id" text PRIMARY KEY NOT NULL,
  "code_hash" text NOT NULL,
  "note" text,
  "plan_key" text,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_org" text,
  "created_by_user_id" text,
  "created_by_email" text,
  "used_at" timestamp with time zone,
  "organization_code" text,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "platform_signup_invites_hash_check" CHECK ("code_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "platform_signup_invites_used_check" CHECK (("used_at" IS NULL) = ("organization_code" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_signup_invites_hash_key" ON "platform_signup_invites" ("code_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_signup_attempts" (
  "id" text PRIMARY KEY NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "mode" text NOT NULL,
  "ip_hash" text NOT NULL,
  "organization_code" text,
  "outcome" text NOT NULL,
  "reason" text,
  CONSTRAINT "platform_signup_attempts_mode_check" CHECK ("mode" in ('invite','open','operator')),
  CONSTRAINT "platform_signup_attempts_outcome_check" CHECK ("outcome" in ('CREATED','FAILED','REJECTED','INVITE_REJECTED'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_signup_attempts_ip_at_idx" ON "platform_signup_attempts" ("ip_hash","at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_signup_attempts_at_idx" ON "platform_signup_attempts" ("at");
