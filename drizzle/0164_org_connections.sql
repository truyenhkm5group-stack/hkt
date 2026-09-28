-- 0164 · KẾT NỐI THEO TỔ CHỨC (docs/platform/phase-9-contracts.md §2).
--
--  · CHỈ THÊM một bảng trong CSDL tổ chức: `org_connections` (connector do CHÍNH tổ chức khai, bí mật mã hoá
--    AES-256-GCM ở tầng ứng dụng — cột `secrets_enc` chỉ chứa bản mã). Không dòng nào được chèn: tổ chức nhà (VNX)
--    giữ nguyên credential ở biến môi trường / `settings` (quyết định X7), bảng này của VNX rỗng cho tới khi người bấm.
--  · `status = 'ACTIVE'` chỉ khi lượt kiểm tra gần nhất ĐẠT — ràng buộc ở CSDL, không chỉ ở mã.
-- Viết tay và idempotent như các migration trước.

CREATE TABLE IF NOT EXISTS "org_connections" (
  "id" text PRIMARY KEY NOT NULL,
  "org_code" text NOT NULL,
  "connector_key" text NOT NULL,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "secrets_enc" bytea,
  "secrets_key_id" text,
  "secret_hints" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "last_test_at" timestamp with time zone,
  "last_test_ok" boolean,
  "last_test_message" text,
  "activated_at" timestamp with time zone,
  "activated_by" text,
  "created_by" text,
  "updated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "org_connections_status_check" CHECK ("status" in ('DRAFT','ACTIVE','DISABLED')),
  CONSTRAINT "org_connections_active_tested_check" CHECK ("status" <> 'ACTIVE' or "last_test_ok" = true),
  CONSTRAINT "org_connections_key_check" CHECK ("connector_key" ~ '^[a-z][a-z0-9-]{1,60}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_connections_connector_uq" ON "org_connections" ("connector_key");
