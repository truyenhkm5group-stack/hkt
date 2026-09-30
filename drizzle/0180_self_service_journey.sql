-- 0180 · HÀNH TRÌNH TỰ PHỤC VỤ CỦA KHÁCH (docs/platform/self-service-journey.md).
--
-- Bốn bảng MỚI trong CSDL của MỖI tổ chức và bốn cột mới ở sổ tổ chức (mặt phẳng điều khiển, CSDL NHÀ). Không
-- đổi một dòng dữ liệu nào đã có, không backfill (AGENTS.md mục 8.8). Viết tay, idempotent như các migration trước.
--
--  · `messaging_deliveries` — sổ GỬI TIN ra nhóm chat của tổ chức (Lark / Telegram / hộp thử). Khoá chống trùng
--    `dedupe_key` UNIQUE, dòng được chèn TRƯỚC lượt gửi: lượt làm lại gặp dòng cũ và KHÔNG gửi lần hai
--    (at-most-once) — lib/messaging/service.ts.
--  · `sales_chat_conversations` / `sales_chat_messages` — hội thoại của chatbot bán hàng theo tổ chức. Tin nhắn
--    append-only, đánh số `seq` trong hội thoại (UNIQUE): hai lượt gửi đua nhau không chen vào giữa nhau.
--  · `user_invites` — lời mời người dùng. Chỉ lưu BĂM sha256 của mã mời; mã thô hiện đúng một lần lúc tạo.
--  · `platform_organizations.domain_slug` (tên miền con, UNIQUE khi có) · `publish_state` (`NULL` = không theo dõi —
--    tổ chức nhà / tổ chức có từ trước bản này; `DRAFT` · `PUBLISHED`) · `published_at` · `published_by`.
--  · Module mới `ai_sales` TẮT cho tổ chức nhà: sổ module của nhà mặc định BẬT mọi khoá thiếu dòng, và chatbot bán
--    hàng theo tổ chức không phải thứ VNX đang dùng (bot của nhà chạy trên Pancake). Bảng platform_* trong CSDL tổ
--    chức khác rỗng nên câu chèn là không-làm-gì ở đó.

CREATE TABLE IF NOT EXISTS "messaging_deliveries" (
  "id" text PRIMARY KEY NOT NULL,
  "dedupe_key" text NOT NULL,
  "connector_key" text NOT NULL,
  "destination" text,
  "event" text,
  "subject_type" text,
  "subject_id" text,
  "run_id" text,
  "is_test" boolean DEFAULT false NOT NULL,
  "title" text,
  "body" text NOT NULL,
  "status" text DEFAULT 'PENDING' NOT NULL,
  "provider_message_id" text,
  "error" text,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messaging_deliveries_dedupe_uq" ON "messaging_deliveries" ("dedupe_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messaging_deliveries_created_idx" ON "messaging_deliveries" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messaging_deliveries_subject_idx" ON "messaging_deliveries" ("subject_type", "subject_id");
--> statement-breakpoint
ALTER TABLE "messaging_deliveries" DROP CONSTRAINT IF EXISTS "messaging_deliveries_status_check";
--> statement-breakpoint
ALTER TABLE "messaging_deliveries" ADD CONSTRAINT "messaging_deliveries_status_check" CHECK ("status" IN ('PENDING','SENT','FAILED','UNKNOWN'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_chat_conversations" (
  "id" text PRIMARY KEY NOT NULL,
  "channel" text NOT NULL,
  "status" text DEFAULT 'OPEN' NOT NULL,
  "visitor_key" text,
  "customer_id" text,
  "draft_order_id" text,
  "order_id" text,
  "handoff_reason" text,
  "turns" integer DEFAULT 0 NOT NULL,
  "ai_calls" integer DEFAULT 0 NOT NULL,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "state" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_chat_conversations_created_idx" ON "sales_chat_conversations" ("created_at");
--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" DROP CONSTRAINT IF EXISTS "sales_chat_conversations_channel_check";
--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD CONSTRAINT "sales_chat_conversations_channel_check" CHECK ("channel" IN ('TEST','WEB'));
--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" DROP CONSTRAINT IF EXISTS "sales_chat_conversations_status_check";
--> statement-breakpoint
ALTER TABLE "sales_chat_conversations" ADD CONSTRAINT "sales_chat_conversations_status_check" CHECK ("status" IN ('OPEN','HANDOFF','CLOSED'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_chat_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "conversation_id" text NOT NULL REFERENCES "sales_chat_conversations"("id") ON DELETE CASCADE,
  "seq" integer NOT NULL,
  "role" text NOT NULL,
  "content" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_chat_messages_seq_uq" ON "sales_chat_messages" ("conversation_id", "seq");
--> statement-breakpoint
ALTER TABLE "sales_chat_messages" DROP CONSTRAINT IF EXISTS "sales_chat_messages_role_check";
--> statement-breakpoint
ALTER TABLE "sales_chat_messages" ADD CONSTRAINT "sales_chat_messages_role_check" CHECK ("role" IN ('user','assistant'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_invites" (
  "id" text PRIMARY KEY NOT NULL,
  "token_hash" text NOT NULL,
  "email" text NOT NULL,
  "role" text NOT NULL,
  "access_role_code" text,
  "invited_by" text,
  "invited_by_email" text,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "accepted_user_id" text,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_invites_token_uq" ON "user_invites" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_invites_email_idx" ON "user_invites" ("email");
--> statement-breakpoint
ALTER TABLE "platform_organizations" ADD COLUMN IF NOT EXISTS "domain_slug" text;
--> statement-breakpoint
ALTER TABLE "platform_organizations" ADD COLUMN IF NOT EXISTS "publish_state" text;
--> statement-breakpoint
ALTER TABLE "platform_organizations" ADD COLUMN IF NOT EXISTS "published_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "platform_organizations" ADD COLUMN IF NOT EXISTS "published_by" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_organizations_domain_slug_key" ON "platform_organizations" ("domain_slug") WHERE "domain_slug" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "platform_organizations" DROP CONSTRAINT IF EXISTS "platform_organizations_domain_slug_check";
--> statement-breakpoint
ALTER TABLE "platform_organizations" ADD CONSTRAINT "platform_organizations_domain_slug_check" CHECK ("domain_slug" IS NULL OR "domain_slug" ~ '^[a-z][a-z0-9-]{1,30}$');
--> statement-breakpoint
ALTER TABLE "platform_organizations" DROP CONSTRAINT IF EXISTS "platform_organizations_publish_state_check";
--> statement-breakpoint
ALTER TABLE "platform_organizations" ADD CONSTRAINT "platform_organizations_publish_state_check" CHECK ("publish_state" IS NULL OR "publish_state" IN ('DRAFT','PUBLISHED'));
--> statement-breakpoint
INSERT INTO "platform_organization_modules" ("organization_id", "module_key", "enabled", "features", "config", "disabled_at", "updated_by")
SELECT "id", 'ai_sales', false, '{}'::jsonb, '{}'::jsonb, now(), 'system:0180'
FROM "platform_organizations" WHERE "is_home"
ON CONFLICT ("organization_id", "module_key") DO NOTHING;
