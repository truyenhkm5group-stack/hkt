-- 0264 · SĂN KHÁCH SỈ — NỀN TẢNG EMAIL Ở CHẾ ĐỘ CHẠY THỬ (E1 AI B2B Sales Agent, 27/10/2026 · docs/verticals/wholesale-lead-hunter.md §4e).
--
-- CSDL của tổ chức. Viết tay, idempotent. CHỈ THÊM ba bảng mới — không thêm / đổi / xoá cột nào của bảng mã đang đọc, không gieo
-- dòng nào, không backfill.
--  · wholesale_email_outbox: hộp thư đi, một dòng một thư. Khoá chống gửi trùng (lead + mẫu + bước + email) UNIQUE trừ thư CHẠY
--    THỬ đã gửi. Duyệt = khoá tài khoản + băm nội dung lúc duyệt, dùng một lần.
--  · wholesale_email_events: sổ sự kiện CHỈ THÊM; provider_event_id UNIQUE chống trùng webhook / thư phản hồi đọc lại.
--  · wholesale_unsubscribe_tokens: token huỷ đăng ký, chỉ lưu BĂM, một token một thư.
-- Lead không xoá được khi còn thư / sự kiện / token (restrict): vết liên hệ không được biến mất theo một lượt dọn dữ liệu.
CREATE TABLE IF NOT EXISTS "wholesale_email_outbox" (
  "id" text PRIMARY KEY NOT NULL,
  "lead_id" text NOT NULL,
  "campaign_id" text,
  "source_outreach_id" text,
  "to_email" text NOT NULL,
  "recipient_domain" text,
  "subject" text NOT NULL,
  "body_text" text NOT NULL,
  "language" text DEFAULT 'vi' NOT NULL,
  "template_key" text NOT NULL,
  "sequence_step" integer DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "blocked_reason" text,
  "idempotency_key" text NOT NULL,
  "prepared_by" text NOT NULL,
  "ai_model" text,
  "created_by_user_id" text,
  "approved_by_user_id" text,
  "approved_at" timestamp with time zone,
  "approved_hash" text,
  "approval_used_at" timestamp with time zone,
  "mode" text,
  "provider" text,
  "provider_message_id" text,
  "message_id_header" text,
  "thread_id" text,
  "in_reply_to" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "last_error" text,
  "scheduled_at" timestamp with time zone,
  "sent_at" timestamp with time zone,
  "cancelled_by_user_id" text,
  "cancelled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wholesale_email_outbox_status_check" CHECK ("status" IN ('DRAFT','APPROVED','QUEUED','SENDING','SENT','FAILED','CANCELLED','BLOCKED')),
  CONSTRAINT "wholesale_email_outbox_prepared_check" CHECK ("prepared_by" IN ('AI','USER')),
  CONSTRAINT "wholesale_email_outbox_mode_check" CHECK ("mode" IS NULL OR "mode" IN ('DRY_RUN','LIVE')),
  CONSTRAINT "wholesale_email_outbox_template_check" CHECK ("template_key" IN ('OPENER_D0','FOLLOWUP')),
  CONSTRAINT "wholesale_email_outbox_step_check" CHECK ("sequence_step" >= 0 AND "attempts" >= 0),
  CONSTRAINT "wholesale_email_outbox_sent_check" CHECK ("status" <> 'SENT' OR ("sent_at" IS NOT NULL AND "mode" IS NOT NULL AND "approval_used_at" IS NOT NULL)),
  CONSTRAINT "wholesale_email_outbox_blocked_check" CHECK ("status" <> 'BLOCKED' OR length(btrim(coalesce("blocked_reason", ''))) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wholesale_email_outbox_idem_uq" ON "wholesale_email_outbox" USING btree ("idempotency_key") WHERE "wholesale_email_outbox"."mode" IS DISTINCT FROM 'DRY_RUN';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_email_outbox_due_idx" ON "wholesale_email_outbox" USING btree ("status", "next_attempt_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_email_outbox_lead_idx" ON "wholesale_email_outbox" USING btree ("lead_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_email_outbox_msgid_idx" ON "wholesale_email_outbox" USING btree ("message_id_header");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_email_outbox" ADD CONSTRAINT "wholesale_email_outbox_lead_id_wholesale_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."wholesale_leads"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_email_outbox" ADD CONSTRAINT "wholesale_email_outbox_campaign_id_wholesale_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."wholesale_campaigns"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_email_outbox" ADD CONSTRAINT "wholesale_email_outbox_source_outreach_id_wholesale_outreach_items_id_fk" FOREIGN KEY ("source_outreach_id") REFERENCES "public"."wholesale_outreach_items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_email_outbox" ADD CONSTRAINT "wholesale_email_outbox_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_email_outbox" ADD CONSTRAINT "wholesale_email_outbox_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_email_outbox" ADD CONSTRAINT "wholesale_email_outbox_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wholesale_email_events" (
  "id" text PRIMARY KEY NOT NULL,
  "outbox_id" text,
  "lead_id" text NOT NULL,
  "kind" text NOT NULL,
  "provider_event_id" text,
  "meta" jsonb,
  "actor_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wholesale_email_events_kind_check" CHECK ("kind" IN ('QUEUED','SENT','DELIVERED','BOUNCE_HARD','BOUNCE_SOFT','COMPLAINT','REPLY','UNSUBSCRIBE','BLOCKED','FAILED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wholesale_email_events_provider_uq" ON "wholesale_email_events" USING btree ("provider_event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_email_events_lead_idx" ON "wholesale_email_events" USING btree ("lead_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_email_events_outbox_idx" ON "wholesale_email_events" USING btree ("outbox_id", "created_at");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_email_events" ADD CONSTRAINT "wholesale_email_events_outbox_id_wholesale_email_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."wholesale_email_outbox"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_email_events" ADD CONSTRAINT "wholesale_email_events_lead_id_wholesale_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."wholesale_leads"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_email_events" ADD CONSTRAINT "wholesale_email_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wholesale_unsubscribe_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "token_hash" text NOT NULL,
  "lead_id" text NOT NULL,
  "email" text NOT NULL,
  "outbox_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "used_at" timestamp with time zone,
  "used_via" text,
  CONSTRAINT "wholesale_unsubscribe_tokens_via_check" CHECK ("used_via" IS NULL OR "used_via" IN ('ONE_CLICK','PAGE'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wholesale_unsubscribe_tokens_hash_uq" ON "wholesale_unsubscribe_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wholesale_unsubscribe_tokens_outbox_uq" ON "wholesale_unsubscribe_tokens" USING btree ("outbox_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_unsubscribe_tokens_lead_idx" ON "wholesale_unsubscribe_tokens" USING btree ("lead_id");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_unsubscribe_tokens" ADD CONSTRAINT "wholesale_unsubscribe_tokens_lead_id_wholesale_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."wholesale_leads"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_unsubscribe_tokens" ADD CONSTRAINT "wholesale_unsubscribe_tokens_outbox_id_wholesale_email_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."wholesale_email_outbox"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
