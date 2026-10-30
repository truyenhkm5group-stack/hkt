-- 0265 · NHÁP EMAIL DO AI SOẠN (docs/tech/hslc-b2b-sales-agent.md · P2b — lib/wholesale/email-ai-draft.ts).
--
-- Chỉ TẠO một bảng mới ở CSDL của tổ chức. Không đổi bảng nào mã đang đọc, không gieo dòng nào. Idempotent.
-- Mỗi lượt «AI soạn nháp» là một dòng: chữ gốc AI, dữ kiện thật đã đưa cho AI, phán quyết của hàng rào bịa đặt, model và chi phí.
-- BLOCKED không bao giờ vào hộp thư đi. PROMOTED trỏ thư DRAFT ở wholesale_email_outbox (vẫn qua duyệt E1 + cổng chính sách),
-- kèm bản cuối người duyệt và tỷ lệ sửa. cost_usd NULL = chưa biết giá model, không phải 0.
CREATE TABLE IF NOT EXISTS "wholesale_email_ai_drafts" (
  "id" text PRIMARY KEY NOT NULL,
  "lead_id" text NOT NULL,
  "language" text NOT NULL,
  "subject" text NOT NULL,
  "body" text NOT NULL,
  "status" text NOT NULL,
  "violations" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "facts" jsonb NOT NULL,
  "model" text,
  "provider" text,
  "billing_source" text,
  "input_tokens" integer,
  "output_tokens" integer,
  "cost_usd" double precision,
  "requested_by_user_id" text,
  "reviewed_subject" text,
  "reviewed_body" text,
  "edit_ratio" double precision,
  "reviewed_by_user_id" text,
  "reviewed_at" timestamp with time zone,
  "outbox_id" text,
  "discarded_by_user_id" text,
  "discarded_at" timestamp with time zone,
  "discard_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "wholesale_email_ai_drafts_status_check" CHECK ("status" IN ('DRAFT','BLOCKED','PROMOTED','DISCARDED')),
  CONSTRAINT "wholesale_email_ai_drafts_language_check" CHECK ("language" IN ('vi','en')),
  CONSTRAINT "wholesale_email_ai_drafts_violations_check" CHECK (jsonb_typeof("violations") = 'array' AND ("status" <> 'BLOCKED' OR jsonb_array_length("violations") > 0)),
  CONSTRAINT "wholesale_email_ai_drafts_facts_check" CHECK (jsonb_typeof("facts") = 'object'),
  CONSTRAINT "wholesale_email_ai_drafts_promoted_check" CHECK ("status" <> 'PROMOTED' OR ("outbox_id" IS NOT NULL AND "reviewed_at" IS NOT NULL AND "reviewed_body" IS NOT NULL)),
  CONSTRAINT "wholesale_email_ai_drafts_discarded_check" CHECK ("status" <> 'DISCARDED' OR ("discarded_at" IS NOT NULL AND length(btrim(coalesce("discard_reason", ''))) >= 3)),
  CONSTRAINT "wholesale_email_ai_drafts_edit_ratio_check" CHECK ("edit_ratio" IS NULL OR ("edit_ratio" >= 0 AND "edit_ratio" <= 1)),
  CONSTRAINT "wholesale_email_ai_drafts_cost_check" CHECK ("cost_usd" IS NULL OR "cost_usd" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_email_ai_drafts_lead_idx" ON "wholesale_email_ai_drafts" USING btree ("lead_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wholesale_email_ai_drafts_created_idx" ON "wholesale_email_ai_drafts" USING btree ("created_at");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_email_ai_drafts" ADD CONSTRAINT "wholesale_email_ai_drafts_lead_id_wholesale_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."wholesale_leads"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_email_ai_drafts" ADD CONSTRAINT "wholesale_email_ai_drafts_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_email_ai_drafts" ADD CONSTRAINT "wholesale_email_ai_drafts_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_email_ai_drafts" ADD CONSTRAINT "wholesale_email_ai_drafts_outbox_id_wholesale_email_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."wholesale_email_outbox"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wholesale_email_ai_drafts" ADD CONSTRAINT "wholesale_email_ai_drafts_discarded_by_user_id_users_id_fk" FOREIGN KEY ("discarded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
