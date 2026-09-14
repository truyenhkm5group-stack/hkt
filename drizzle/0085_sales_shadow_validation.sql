-- ĐÁNH SỐ LẠI 14/09/2026: tệp này từng là `0036_sales_shadow_validation` — xem phần đầu của
-- `0084_ai_workforce_foundation.sql` để biết vì sao.
-- Đối chiếu nhân sự AI với nhân viên thật ở nấc chạy ngầm: 1 bảng mới + 11 cột thêm.
-- THUẦN BỔ SUNG, chỉ chạm bảng ai_* và sales_* do chính nền tảng AI sở hữu.
-- Không câu lệnh nào đụng tới đơn hàng, vận đơn, tiền hay tồn kho.

CREATE TABLE "sales_review_labels" (
	"id" text PRIMARY KEY NOT NULL,
	"suggestion_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"product_ok" boolean,
	"color_ok" boolean,
	"size_ok" boolean,
	"phone_ok" boolean,
	"address_ok" boolean,
	"intent_ok" boolean,
	"purchase_intent_ok" boolean,
	"confirmation_ok" boolean,
	"next_action_quality" text,
	"hallucination" boolean,
	"hallucination_note" text DEFAULT '' NOT NULL,
	"reply_usable" boolean,
	"note" text DEFAULT '' NOT NULL,
	"reviewer_user_id" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_model_calls" ADD COLUMN "cached_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_model_calls" ADD COLUMN "pricing_version" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "cached_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "pricing_version" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_messages" ADD COLUMN "attachment_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_messages" ADD COLUMN "sender_type" text DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_messages" ADD COLUMN "platform" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_messages" ADD COLUMN "ingest_source" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_messages" ADD COLUMN "content_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_suggestions" ADD COLUMN "human_reply_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_suggestions" ADD COLUMN "human_response_seconds" integer;--> statement-breakpoint
ALTER TABLE "sales_review_labels" ADD CONSTRAINT "sales_review_labels_suggestion_id_sales_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."sales_suggestions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_review_labels" ADD CONSTRAINT "sales_review_labels_conversation_id_sales_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."sales_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_review_labels" ADD CONSTRAINT "sales_review_labels_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_review_labels_suggestion_uq" ON "sales_review_labels" USING btree ("suggestion_id");--> statement-breakpoint
CREATE INDEX "sales_review_labels_conv_idx" ON "sales_review_labels" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "sales_messages_hash_idx" ON "sales_messages" USING btree ("conversation_id","content_hash");