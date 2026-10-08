-- 0236 · SỔ CHẤP THUẬN VĂN BẢN PHÁP LÝ (docs/legal/TECH_HANDOFF_LEGAL.md mục M-ACCEPT · lib/legal/acceptance.ts).
--
--  · Mỗi lần một người đồng ý một văn bản (Điều khoản · Chính sách · DPA) tại MỘT chỗ trên giao diện có dòng đồng ý thật,
--    một dòng. Không checkbox, không màn chặn — ghi ở backend đúng chỗ khách đã đồng ý hôm nay (dòng «Bằng việc tạo cửa
--    hàng…» ở /start).
--  · Không email thô (HMAC theo AUTH_SECRET), không IP thô (cùng phép băm với `platform_signup_attempts`).
--  · `content_sha256 NULL` = CHƯA BIẾT băm nội dung, không phải «không có nội dung».
--  · Không khoá ngoài tới tổ chức / tài khoản: đây là BẰNG CHỨNG, xoá tổ chức vẫn giữ (lib/platform/offboard.ts · KEEP).
--  · Chỉ CỘNG THÊM; KHÔNG backfill (AGENTS 35 — không đoán chấp thuận cho tổ chức tạo trước sổ). Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "platform_legal_acceptances" (
	"id" text PRIMARY KEY NOT NULL,
	"org_code" text,
	"organization_id" text,
	"account_id" text,
	"user_id" text,
	"email_hash" text,
	"document" text NOT NULL,
	"version" text NOT NULL,
	"content_sha256" text,
	"action" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash" text,
	"user_agent" text,
	"source" text NOT NULL,
	CONSTRAINT "platform_legal_acceptances_document_check" CHECK ("platform_legal_acceptances"."document" IN ('TERMS','PRIVACY','DPA')),
	CONSTRAINT "platform_legal_acceptances_action_check" CHECK ("platform_legal_acceptances"."action" IN ('SIGNUP','INVITE_ACCEPT','NOTICE_SEEN')),
	CONSTRAINT "platform_legal_acceptances_source_check" CHECK ("platform_legal_acceptances"."source" IN ('START_WIZARD','START_QUICK')),
	CONSTRAINT "platform_legal_acceptances_version_check" CHECK (length("platform_legal_acceptances"."version") BETWEEN 1 AND 40),
	CONSTRAINT "platform_legal_acceptances_sha_check" CHECK ("platform_legal_acceptances"."content_sha256" IS NULL OR "platform_legal_acceptances"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "platform_legal_acceptances_email_hash_check" CHECK ("platform_legal_acceptances"."email_hash" IS NULL OR "platform_legal_acceptances"."email_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "platform_legal_acceptances_ip_hash_check" CHECK ("platform_legal_acceptances"."ip_hash" IS NULL OR "platform_legal_acceptances"."ip_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "platform_legal_acceptances_ua_check" CHECK ("platform_legal_acceptances"."user_agent" IS NULL OR length("platform_legal_acceptances"."user_agent") <= 300)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_legal_acceptances_org_idx" ON "platform_legal_acceptances" USING btree ("org_code","accepted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_legal_acceptances_account_idx" ON "platform_legal_acceptances" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_legal_acceptances_signup_key" ON "platform_legal_acceptances" USING btree ("organization_id","document","version","action") WHERE "platform_legal_acceptances"."action" = 'SIGNUP' AND "platform_legal_acceptances"."organization_id" IS NOT NULL;
