-- 0198 · LƯU TRÚ NGẮN NGÀY — Airbnb / homestay (module `stays` — docs/verticals/homestay.md).
--
--  · `stay_units`: phòng / căn cho thuê. `ical_token` = phần bí mật của đường dẫn lịch .ics ERP phát cho kênh (đổi được khi lộ).
--  · `stay_bookings`: một đặt phòng chiếm khoảng NỬA MỞ [check_in, check_out). Nguồn `ICAL` = nhập từ lịch của kênh, khoá tự
--    nhiên (phòng, kênh, UID của kênh); `MANUAL` = gõ trong ERP. Trùng phòng KHÔNG chặn ở CSDL (hai kênh có thể bán trùng thật —
--    phải HIỆN ra để xử lý, không được nuốt mất); đường ghi tay tự chặn. Tiền NULL = chưa biết (iCal không mang giá).
--  · `stay_turnovers`: dọn phòng xong cho (phòng, ngày) — một dòng mỗi lần dọn, ai dọn đi bằng khoá tài khoản.
--  · `stay_ical_imports`: sổ mỗi lượt nhập lịch (kể cả chạy thử) — trả lời «ai đã nhập tệp nào và nó đổi gì».
--  · Module MỚI mặc định TẮT ở tổ chức nhà (như `warranty` ở 0196).
--  · CSDL mọi tổ chức. Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "stay_units" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "code" text NOT NULL,
  "capacity" integer,
  "address" text DEFAULT '' NOT NULL,
  "owner_name" text DEFAULT '' NOT NULL,
  "ical_token" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "stay_units_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 120),
  CONSTRAINT "stay_units_code_check" CHECK (length(btrim("code")) BETWEEN 1 AND 20),
  CONSTRAINT "stay_units_capacity_check" CHECK ("capacity" IS NULL OR "capacity" BETWEEN 1 AND 100),
  CONSTRAINT "stay_units_token_check" CHECK (length("ical_token") >= 24)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stay_units_code_uq" ON "stay_units" (lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stay_units_ical_token_uq" ON "stay_units" ("ical_token");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stay_bookings" (
  "id" text PRIMARY KEY NOT NULL,
  "unit_id" text NOT NULL REFERENCES "stay_units"("id") ON DELETE CASCADE,
  "check_in" date NOT NULL,
  "check_out" date NOT NULL,
  "channel" text NOT NULL,
  "status" text DEFAULT 'CONFIRMED' NOT NULL,
  "source" text DEFAULT 'MANUAL' NOT NULL,
  "external_uid" text,
  "summary" text DEFAULT '' NOT NULL,
  "guest_name" text DEFAULT '' NOT NULL,
  "guest_phone" text DEFAULT '' NOT NULL,
  "guests" integer,
  "amount_vnd" integer,
  "note" text DEFAULT '' NOT NULL,
  "cancel_reason" text,
  "cancelled_at" timestamp with time zone,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "stay_bookings_dates_check" CHECK ("check_out" > "check_in" AND "check_out" - "check_in" <= 365),
  CONSTRAINT "stay_bookings_channel_check" CHECK ("channel" IN ('AIRBNB','BOOKING','AGODA','TRAVELOKA','DIRECT','OTHER')),
  CONSTRAINT "stay_bookings_status_check" CHECK ("status" IN ('CONFIRMED','BLOCKED','CANCELLED')),
  CONSTRAINT "stay_bookings_source_check" CHECK ("source" IN ('MANUAL','ICAL')),
  CONSTRAINT "stay_bookings_uid_check" CHECK (("source" = 'ICAL') = ("external_uid" IS NOT NULL)),
  CONSTRAINT "stay_bookings_cancel_check" CHECK ("status" <> 'CANCELLED' OR length(btrim(coalesce("cancel_reason", ''))) >= 3),
  CONSTRAINT "stay_bookings_money_check" CHECK ("amount_vnd" IS NULL OR "amount_vnd" >= 0),
  CONSTRAINT "stay_bookings_guests_check" CHECK ("guests" IS NULL OR "guests" BETWEEN 1 AND 100)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stay_bookings_uid_uq" ON "stay_bookings" ("unit_id", "channel", "external_uid") WHERE "external_uid" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stay_bookings_unit_dates_idx" ON "stay_bookings" ("unit_id", "check_in", "check_out");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stay_bookings_checkout_idx" ON "stay_bookings" ("check_out");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stay_turnovers" (
  "unit_id" text NOT NULL REFERENCES "stay_units"("id") ON DELETE CASCADE,
  "day" date NOT NULL,
  "done_at" timestamp with time zone DEFAULT now() NOT NULL,
  "done_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "done_by_name" text DEFAULT '' NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  CONSTRAINT "stay_turnovers_pk" PRIMARY KEY ("unit_id", "day")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stay_ical_imports" (
  "id" text PRIMARY KEY NOT NULL,
  "unit_id" text NOT NULL REFERENCES "stay_units"("id") ON DELETE CASCADE,
  "channel" text NOT NULL,
  "applied" boolean NOT NULL,
  "checksum" text NOT NULL,
  "events" integer NOT NULL,
  "skipped" integer NOT NULL,
  "created" integer NOT NULL,
  "updated" integer NOT NULL,
  "cancelled" integer NOT NULL,
  "unchanged" integer NOT NULL,
  "by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "by_name" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stay_ical_imports_unit_idx" ON "stay_ical_imports" ("unit_id", "created_at");--> statement-breakpoint
INSERT INTO "platform_organization_modules" ("organization_id", "module_key", "enabled", "features", "config", "disabled_at", "updated_by")
SELECT "id", 'stays', false, '{}'::jsonb, '{}'::jsonb, now(), 'system:0198'
FROM "platform_organizations" WHERE "is_home"
ON CONFLICT ("organization_id", "module_key") DO NOTHING;
