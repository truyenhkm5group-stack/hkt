-- 0165 · BLUEPRINT + MẪU NGÀNH (docs/platform/phase-7-contracts.md mục 3).
--
--  · CHỈ THÊM hai bảng trong CSDL tổ chức: `blueprint_installs` (mỗi lượt cài / nâng phiên bản một gói: ai, lúc nào,
--    kế hoạch đã chạy, kết quả từng bước) và `blueprint_items` (mỗi mục gói đã sinh ra: băm của mục trong GÓI và băm
--    của thực thể NGAY SAU khi cài — hai vế của phép so ba chiều X4).
--  · Không dòng nào được chèn: không mẫu nào tự cài (luật 23). Không bảng cũ nào bị đổi.
--  · Lượt cài hỏng giữa chừng vẫn giữ dòng `FAILED` và các mục đã xong — chạy lại thì các mục đó thành UNCHANGED.
-- Viết tay và idempotent như các migration trước.

CREATE TABLE IF NOT EXISTS "blueprint_installs" (
  "id" text PRIMARY KEY NOT NULL,
  "blueprint_key" text NOT NULL,
  "version" text NOT NULL,
  "status" text DEFAULT 'RUNNING' NOT NULL,
  "installed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "installed_by" text,
  "installed_by_email" text,
  "plan" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "result" jsonb,
  "error" text,
  CONSTRAINT "blueprint_installs_status_check" CHECK ("status" in ('RUNNING','DONE','FAILED')),
  CONSTRAINT "blueprint_installs_key_check" CHECK ("blueprint_key" ~ '^[a-z][a-z0-9-]{1,40}$'),
  CONSTRAINT "blueprint_installs_version_check" CHECK ("version" ~ '^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blueprint_installs_key_idx" ON "blueprint_installs" ("blueprint_key","installed_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "blueprint_items" (
  "install_id" text NOT NULL REFERENCES "blueprint_installs"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "key" text NOT NULL,
  "template_hash" text NOT NULL,
  "applied_hash" text,
  "action" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "blueprint_items_kind_check" CHECK ("kind" in ('module','role','object','field','status','form','list','page','workflow','setting','ai')),
  CONSTRAINT "blueprint_items_action_check" CHECK ("action" in ('CREATE','UPDATE','UNCHANGED','SKIP_CUSTOMIZED','SKIP_DELETED','CONFLICT'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "blueprint_items_pk" ON "blueprint_items" ("install_id","kind","key");
