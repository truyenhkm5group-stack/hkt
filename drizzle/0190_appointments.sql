-- 0190 · LỊCH HẸN & LIỆU TRÌNH (module `appointments` — docs/verticals/appointments.md).
--
--  · `customer_packages`: liệu trình N buổi khách trả trước. Số buổi đã dùng / đang giữ KHÔNG lưu — đếm lúc đọc từ lịch hẹn.
--  · `appointments`: khách · dịch vụ (mẫu mã, tên chụp lại) · kỹ thuật viên (khoá tài khoản) · [bắt đầu, kết thúc) · trạng thái
--    · liệu trình (nếu dùng). Chặn trùng giờ của một kỹ thuật viên ở máy chủ (khoá tư vấn theo người trong giao dịch).
--  · Module MỚI mặc định TẮT ở tổ chức nhà (như `ai_sales` ở 0180) — tổ chức nhà không bán dịch vụ theo lịch.
--  · CSDL mọi tổ chức. Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "customer_packages" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "variant_id" text,
  "name" text NOT NULL,
  "total_sessions" integer NOT NULL,
  "order_id" text,
  "expires_on" date,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customer_packages_sessions_check" CHECK ("total_sessions" BETWEEN 1 AND 500),
  CONSTRAINT "customer_packages_status_check" CHECK ("status" IN ('ACTIVE','CLOSED')),
  CONSTRAINT "customer_packages_name_check" CHECK (length(trim("name")) BETWEEN 1 AND 120)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_packages_customer_idx" ON "customer_packages" ("customer_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "appointments" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "variant_id" text,
  "service_name" text NOT NULL,
  "staff_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone NOT NULL,
  "status" text DEFAULT 'BOOKED' NOT NULL,
  "package_id" text REFERENCES "customer_packages"("id") ON DELETE SET NULL,
  "note" text DEFAULT '' NOT NULL,
  "cancel_reason" text,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "status_changed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "appointments_time_check" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "appointments_status_check" CHECK ("status" IN ('BOOKED','CONFIRMED','CHECKED_IN','DONE','NO_SHOW','CANCELLED')),
  CONSTRAINT "appointments_cancel_check" CHECK ("status" <> 'CANCELLED' OR length(btrim(coalesce("cancel_reason", ''))) >= 3)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_starts_idx" ON "appointments" ("starts_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_staff_starts_idx" ON "appointments" ("staff_user_id", "starts_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_customer_idx" ON "appointments" ("customer_id", "starts_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_package_idx" ON "appointments" ("package_id");--> statement-breakpoint
INSERT INTO "platform_organization_modules" ("organization_id", "module_key", "enabled", "features", "config", "disabled_at", "updated_by")
SELECT "id", 'appointments', false, '{}'::jsonb, '{}'::jsonb, now(), 'system:0190'
FROM "platform_organizations" WHERE "is_home"
ON CONFLICT ("organization_id", "module_key") DO NOTHING;
