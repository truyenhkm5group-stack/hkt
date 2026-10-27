-- 0261 · SĂN KHÁCH SỈ — CHẶN EMAIL + NHẬT KÝ ĐỒNG Ý LIÊN HỆ (P1a AI B2B Sales Agent, 27/10/2026 · docs/verticals/wholesale-lead-hunter.md §4b).
--
-- CSDL của tổ chức. Viết tay, idempotent. Không đổi / xoá cột nào mã đang đọc; không gieo dòng nào; không backfill.
--  · wholesale_suppressions.kind nhận thêm 'EMAIL' — chỉ NỚI, mọi dòng cũ vẫn hợp lệ.
--  · wholesale_lead_activities.kind nhận thêm 'CONSENT' (ghi / thu hồi đồng ý vào lịch sử lead) — chỉ NỚI, giữ đủ 16 giá trị của 0218.
--  · wholesale_leads: chỉ mục biểu thức lower(btrim(email)) cho khử trùng theo email (dòng cũ có thể còn chữ hoa).
--  · wholesale_contact_consents: bằng chứng cho phép liên hệ, CHỈ THÊM; thu hồi = điền revoked_at + lý do (không xoá).
--    Căn cứ là danh sách đóng; không có 'NONE' và không có "email công khai trên website".
ALTER TABLE "wholesale_suppressions" DROP CONSTRAINT IF EXISTS "wholesale_suppressions_kind_check";
--> statement-breakpoint
ALTER TABLE "wholesale_suppressions" ADD CONSTRAINT "wholesale_suppressions_kind_check" CHECK ("kind" IN ('PHONE','DOMAIN','PLACE','EMAIL'));
--> statement-breakpoint
ALTER TABLE "wholesale_lead_activities" DROP CONSTRAINT IF EXISTS "wholesale_lead_activities_kind_check";
--> statement-breakpoint
ALTER TABLE "wholesale_lead_activities" ADD CONSTRAINT "wholesale_lead_activities_kind_check" CHECK ("wholesale_lead_activities"."kind" IN ('DISCOVERED','IMPORTED','ENRICHED','SCORED','NOTE','CALL','CALL_INITIATED','ZALO','ZALO_OPENED','STATUS','ASSIGN','OUTREACH','OPPORTUNITY','CONVERT','EDIT','CAMPAIGN','CONSENT'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_leads_email_idx" ON "wholesale_leads" USING btree (lower(btrim("email")));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wholesale_contact_consents" (
  "id" text PRIMARY KEY NOT NULL,
  "lead_id" text NOT NULL,
  "channel" text NOT NULL,
  "contact_value" text NOT NULL,
  "basis" text NOT NULL,
  "evidence_text" text NOT NULL,
  "evidence_url" text,
  "source" text DEFAULT 'STAFF' NOT NULL,
  "recorded_by_user_id" text,
  "recorded_by_name" text DEFAULT '' NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoke_reason" text,
  "revoked_by_user_id" text,
  "revoked_by_name" text,
  CONSTRAINT "wholesale_contact_consents_channel_check" CHECK ("channel" IN ('EMAIL','PHONE','ZALO')),
  CONSTRAINT "wholesale_contact_consents_basis_check" CHECK ("basis" IN ('OPT_IN_FORM','REPLIED_INBOUND','VERBAL_CONSENT','EXISTING_CUSTOMER','B2B_PUBLIC_PROCUREMENT','OWNER_ATTESTED')),
  CONSTRAINT "wholesale_contact_consents_source_check" CHECK ("source" IN ('STAFF','IMPORT','SYSTEM')),
  CONSTRAINT "wholesale_contact_consents_evidence_check" CHECK (length(btrim("evidence_text")) >= 5),
  CONSTRAINT "wholesale_contact_consents_value_check" CHECK (length(btrim("contact_value")) >= 3),
  CONSTRAINT "wholesale_contact_consents_revoke_check" CHECK (("revoked_at" IS NULL AND "revoke_reason" IS NULL) OR ("revoked_at" IS NOT NULL AND length(btrim(coalesce("revoke_reason", ''))) >= 3))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_contact_consents_lead_idx" ON "wholesale_contact_consents" USING btree ("lead_id", "recorded_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_contact_consents_value_idx" ON "wholesale_contact_consents" USING btree ("channel", "contact_value");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_contact_consents" ADD CONSTRAINT "wholesale_contact_consents_lead_id_wholesale_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."wholesale_leads"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_contact_consents" ADD CONSTRAINT "wholesale_contact_consents_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_contact_consents" ADD CONSTRAINT "wholesale_contact_consents_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
