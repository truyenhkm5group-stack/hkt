-- 0236 · TÍN HIỆU VẬN HÀNH CHO TỪNG KHÁCH (LAUNCH SPRINT §11 «Observability before sales» · sứ mệnh saas-ops-signals).
--
--  · `platform_org_health`: GƯƠNG kết luận sức khoẻ của từng tổ chức (Facebook · webhook · AI · gửi tin · đơn không hợp lệ · ghi đơn ·
--    hạn mức) — job `sales-health` đã TÍNH sẵn trong CSDL tổ chức, nay ghi kết luận ở CSDL nhà để người vận hành đọc một câu.
--    Mỗi (tổ chức, kiểm) MỘT dòng; kiểm hết lỗi thì về OK, không xoá.
--  · `platform_auth_failures`: lỗi đăng nhập / liên kết đặt mật khẩu / liên kết mời CÓ LÝ DO. Không mật khẩu, không email thô
--    (HMAC + bản che bắt buộc chứa «***»), IP chỉ băm; THROTTLED một dòng mỗi cửa sổ khoá (`dedupe_key` duy nhất).
--  · `platform_ai_usage.error_class`: lớp lỗi của dòng ERROR / trần hạn mức của dòng BLOCKED_QUOTA. NULL = chưa phân loại —
--    KHÔNG backfill dòng cũ (AGENTS 35 · 8.8).
--  · KHÔNG gieo dòng nào (kể cả `platform_settings`): mốc «đo từ …» của màn hình dựng TỪ CHÍNH DỮ LIỆU (dòng sớm nhất của hai bảng
--    mới — lib/platform/ops-signals.ts), không từ một dòng ghi tay lúc migrate.
--  · Chỉ CỘNG THÊM. Viết tay, idempotent (ảnh chụp drizzle cũ từ 0032 — không dùng `db:generate`).

CREATE TABLE IF NOT EXISTS "platform_org_health" (
	"org_code" text NOT NULL,
	"check_key" text NOT NULL,
	"level" text NOT NULL,
	"count_24h" integer,
	"count_7d" integer,
	"last_at" timestamp with time zone,
	"last_reason" text,
	"correlation_id" text,
	"detail" text,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"measured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_org_health_pkey" PRIMARY KEY ("org_code", "check_key"),
	CONSTRAINT "platform_org_health_key_check" CHECK ("platform_org_health"."check_key" IN ('FB_CONNECTION','WEBHOOK','AI','SEND','ORDER_VALIDATION','ORDER_WRITE','QUOTA')),
	CONSTRAINT "platform_org_health_level_check" CHECK ("platform_org_health"."level" IN ('OK','WARNING','CRITICAL','UNKNOWN','NA')),
	CONSTRAINT "platform_org_health_counts_check" CHECK (("platform_org_health"."count_24h" IS NULL OR "platform_org_health"."count_24h" >= 0) AND ("platform_org_health"."count_7d" IS NULL OR "platform_org_health"."count_7d" >= 0)),
	CONSTRAINT "platform_org_health_reason_check" CHECK ("platform_org_health"."last_reason" IS NULL OR "platform_org_health"."last_reason" ~ '^[A-Z][A-Z0-9_]{1,40}$'),
	CONSTRAINT "platform_org_health_detail_check" CHECK ("platform_org_health"."detail" IS NULL OR length("platform_org_health"."detail") <= 300),
	CONSTRAINT "platform_org_health_correlation_check" CHECK ("platform_org_health"."correlation_id" IS NULL OR length("platform_org_health"."correlation_id") <= 200)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_auth_failures" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_code" text,
	"flow" text NOT NULL,
	"reason_code" text NOT NULL,
	"identifier_hash" text,
	"identifier_masked" text,
	"ip_hash" text,
	"dedupe_key" text,
	CONSTRAINT "platform_auth_failures_flow_check" CHECK ("platform_auth_failures"."flow" IN ('LOGIN','RESET_LINK','INVITE')),
	CONSTRAINT "platform_auth_failures_reason_check" CHECK ("platform_auth_failures"."reason_code" IN ('NO_IDENTITY','BAD_PASSWORD','USER_INACTIVE','ORG_INACTIVE','ORG_NOT_FOUND','THROTTLED','RESET_LINK_INVALID','RESET_LINK_EXPIRED','RESET_LINK_USED','RESET_LINK_REVOKED','INVITE_INVALID','INVITE_EXPIRED','INVITE_USED','INVITE_REVOKED')),
	CONSTRAINT "platform_auth_failures_hash_check" CHECK (("platform_auth_failures"."identifier_hash" IS NULL OR "platform_auth_failures"."identifier_hash" ~ '^[0-9a-f]{64}$') AND ("platform_auth_failures"."ip_hash" IS NULL OR "platform_auth_failures"."ip_hash" ~ '^[0-9a-f]{64}$') AND ("platform_auth_failures"."dedupe_key" IS NULL OR "platform_auth_failures"."dedupe_key" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "platform_auth_failures_masked_check" CHECK ("platform_auth_failures"."identifier_masked" IS NULL OR (length("platform_auth_failures"."identifier_masked") <= 80 AND position('***' in "platform_auth_failures"."identifier_masked") > 0))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_auth_failures_org_at_idx" ON "platform_auth_failures" USING btree ("org_code","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_auth_failures_at_idx" ON "platform_auth_failures" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_auth_failures_dedupe_key" ON "platform_auth_failures" USING btree ("dedupe_key") WHERE "platform_auth_failures"."dedupe_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_ai_usage" ADD COLUMN IF NOT EXISTS "error_class" text;--> statement-breakpoint
ALTER TABLE "platform_ai_usage" DROP CONSTRAINT IF EXISTS "platform_ai_usage_error_class_check";--> statement-breakpoint
ALTER TABLE "platform_ai_usage" ADD CONSTRAINT "platform_ai_usage_error_class_check" CHECK ("platform_ai_usage"."error_class" IS NULL OR "platform_ai_usage"."error_class" IN ('CREDIT','AUTH','RATE_LIMIT','MODEL_UNAVAILABLE','SERVER_ERROR','TIMEOUT','INVALID_REQUEST','OTHER','REQUESTS_DAY','REQUESTS_MONTH','COST_HARD','NO_PLATFORM_CREDIT','PLATFORM_CREDIT_USED','PLAN_UNREADABLE'));
