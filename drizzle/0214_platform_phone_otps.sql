-- 0214 · MÃ XÁC MINH SĐT KHI ĐĂNG KÝ QUA ZALO ZNS (lib/onboarding/phone-otp.ts · docs/platform/phone-otp.md).
--
--  · Mỗi lần gửi một dòng; mã và IP chỉ lưu BĂM. Cũng là nguồn đếm trần gửi (mỗi tin ZNS là tiền thật).
--  · Bảng mặt phẳng điều khiển: chỉ bản ở CSDL nhà là thật. Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "platform_phone_otps" (
  "id" text PRIMARY KEY NOT NULL,
  "phone" text NOT NULL,
  "code_hash" text NOT NULL,
  "ip_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "consumed_at" timestamp with time zone,
  "status" text NOT NULL,
  "error" text,
  CONSTRAINT "platform_phone_otps_status_check" CHECK ("status" in ('SENT','FAILED'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_phone_otps_phone_at_idx" ON "platform_phone_otps" ("phone","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_phone_otps_ip_at_idx" ON "platform_phone_otps" ("ip_hash","created_at");
