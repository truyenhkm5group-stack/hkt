-- 0213 · THÔNG BÁO ĐẨY (PWA): đăng ký nhận thông báo của từng trình duyệt / máy (lib/push/service.ts · docs/platform/pwa.md).
--
--  · Mỗi endpoint (máy chủ đẩy của trình duyệt) một dòng, thuộc người bấm bật trên máy đó. Chết ⇒ ứng dụng xoá dòng.
--  · Bảng của CSDL tổ chức. Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "endpoint" text NOT NULL,
  "p256dh" text NOT NULL,
  "auth" text NOT NULL,
  "user_agent" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_ok_at" timestamp with time zone,
  "last_error" text
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_endpoint_key" ON "push_subscriptions" ("endpoint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_subscriptions_user_idx" ON "push_subscriptions" ("user_id");
