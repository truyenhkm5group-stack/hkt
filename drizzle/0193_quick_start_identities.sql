-- 0193 · GIA NHẬP NHANH: ĐĂNG NHẬP BẰNG SĐT + CHỈ MỤC DANH TÍNH TOÀN NỀN TẢNG (docs/platform/quick-start.md).
--
--  · `users.phone`: SĐT di động VN chuẩn hoá `84xxxxxxxxx` — đăng nhập được bằng SĐT. Duy nhất trong tổ chức. Không backfill.
--  · `platform_identities`: email / SĐT / tài khoản Google / Facebook ⇒ (tổ chức, tài khoản). Nhờ nó khách đăng nhập ở
--    trang chung mà KHÔNG phải nhớ mã tổ chức. Chỉ là chỉ mục: mật khẩu, quyền, khoá vẫn đọc ở CSDL tổ chức mỗi lượt.
--    Ghi dần khi đăng nhập thành công — không quét CSDL của tổ chức nào lúc migrate.
--  · Viết tay, idempotent.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_phone_key" ON "users" ("phone") WHERE "phone" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_identities" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "value" text NOT NULL,
  "org_code" text NOT NULL,
  "user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  CONSTRAINT "platform_identities_kind_check" CHECK ("kind" IN ('EMAIL','PHONE','GOOGLE','FACEBOOK'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_identities_kind_value_org_key" ON "platform_identities" ("kind","value","org_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_identities_org_user_idx" ON "platform_identities" ("org_code","user_id");
