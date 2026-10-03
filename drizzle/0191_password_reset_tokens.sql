-- 0191 · LIÊN KẾT ĐẶT LẠI MẬT KHẨU (docs/platform/password-reset.md).
--
--  · Một dòng = một liên kết `/reset/<mã tổ chức>/<mã>` dùng MỘT lần, hết hạn sau 24 giờ. Chỉ giữ `sha256` của mã — lộ bảng
--    không lộ liên kết nào dùng được (cùng cách với `user_invites`).
--  · Người tạo: quản trị tổ chức (`users:manage`) cho người trong tổ chức, hoặc người vận hành nền tảng cho quản trị của
--    khách (`created_via`). Người được đặt lại tự chọn mật khẩu — không ai khác biết nó.
--  · CSDL mọi tổ chức. Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "created_via" text NOT NULL,
  "created_by_user_id" text,
  "created_by_email" text,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "password_reset_tokens_via_check" CHECK ("created_via" IN ('ORG_ADMIN','PLATFORM'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tokens_token_uq" ON "password_reset_tokens" ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "password_reset_tokens_user_idx" ON "password_reset_tokens" ("user_id");
