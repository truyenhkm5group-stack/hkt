-- 0262 · FACEBOOK FRIEND CRM — lát 1 (chủ shop HSLC, docs/verticals/facebook-friend-crm.md).
--
-- CSDL của tổ chức. Idempotent. CHỈ TẠO hai bảng mới, không đụng cột của bảng nào đang có, không gieo dòng nào.
--  · customer_fb_connections: MỘT dòng mỗi khách — link trang Facebook cá nhân do NGƯỜI dán (không bao giờ suy từ PSID),
--    trạng thái kết bạn, nhân viên phụ trách, ngày chăm sóc tiếp, cờ «không liên hệ» (bắt buộc có lý do).
--  · customer_fb_connection_events: nhật ký CHỈ THÊM, người làm đi bằng users.id (luật 34; NULL = máy).
CREATE TABLE IF NOT EXISTS "customer_fb_connections" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL,
  "fb_profile_url" text,
  "fb_url_source" text DEFAULT 'NONE' NOT NULL,
  "fb_url_set_by_user_id" text,
  "fb_url_set_at" timestamp with time zone,
  "connection_status" text DEFAULT 'NOT_ASKED' NOT NULL,
  "care_owner_user_id" text,
  "next_care_on" date,
  "do_not_contact" boolean DEFAULT false NOT NULL,
  "do_not_contact_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customer_fb_connections_source_check" CHECK ("fb_url_source" IN ('CUSTOMER_PROVIDED', 'STAFF_VERIFIED_FROM_PANCAKE', 'NONE')),
  CONSTRAINT "customer_fb_connections_url_source_check" CHECK (("fb_profile_url" IS NULL) = ("fb_url_source" = 'NONE')),
  CONSTRAINT "customer_fb_connections_status_check" CHECK ("connection_status" IN ('NOT_ASKED', 'CONSENTED', 'INVITE_SENT', 'FRIENDS', 'DECLINED')),
  CONSTRAINT "customer_fb_connections_dnc_check" CHECK (NOT "do_not_contact" OR length(btrim(coalesce("do_not_contact_reason", ''))) > 0)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customer_fb_connections" ADD CONSTRAINT "customer_fb_connections_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customer_fb_connections" ADD CONSTRAINT "customer_fb_connections_fb_url_set_by_user_id_users_id_fk" FOREIGN KEY ("fb_url_set_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customer_fb_connections" ADD CONSTRAINT "customer_fb_connections_care_owner_user_id_users_id_fk" FOREIGN KEY ("care_owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_fb_connections_customer_uq" ON "customer_fb_connections" USING btree ("customer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_fb_connections_owner_idx" ON "customer_fb_connections" USING btree ("care_owner_user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_fb_connection_events" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL,
  "kind" text NOT NULL,
  "from_value" text,
  "to_value" text,
  "note" text DEFAULT '' NOT NULL,
  "actor_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customer_fb_connection_events_kind_check" CHECK ("kind" IN ('URL_SET', 'URL_CLEARED', 'STATUS_CHANGED', 'OWNER_CHANGED', 'NEXT_CARE_SET', 'DNC_SET', 'DNC_CLEARED', 'CONSENT_RECORDED'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customer_fb_connection_events" ADD CONSTRAINT "customer_fb_connection_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customer_fb_connection_events" ADD CONSTRAINT "customer_fb_connection_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_fb_connection_events_customer_idx" ON "customer_fb_connection_events" USING btree ("customer_id","created_at");
