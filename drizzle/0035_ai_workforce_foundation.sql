-- Nền tảng nhân sự AI + miền bán hàng: 13 bảng MỚI, THUẦN BỔ SUNG.
-- Không câu lệnh nào đụng tới bảng đang chạy (đơn hàng, vận đơn, tiền, tồn kho).
-- Chín câu lệnh drizzle-kit sinh thêm cho notifications / shipments / shipment_events đã bị bỏ:
-- chúng đã chạy ở 0033 và 0034 rồi, chỉ xuất hiện lại vì ảnh chụp lược đồ 0034 trong kho bị lệch.
-- Ảnh chụp 0035 ghi đúng trạng thái thật nên các migration sau sẽ không sinh lại chúng nữa.

CREATE TABLE "ai_agent_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"version" integer NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"allowed_tools" text[] DEFAULT '{}'::text[] NOT NULL,
	"routing" jsonb,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"mode" text DEFAULT 'SHADOW' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"active_version_id" text,
	"subscribes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_agents_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "ai_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"agent_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text DEFAULT '' NOT NULL,
	"subject_id" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"payload" jsonb,
	"decided_by_user_id" text,
	"decided_by_name" text DEFAULT '' NOT NULL,
	"decided_at" timestamp with time zone,
	"note" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_errors" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"agent_key" text DEFAULT '' NOT NULL,
	"run_id" text,
	"subject_type" text DEFAULT '' NOT NULL,
	"subject_id" text DEFAULT '' NOT NULL,
	"message" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"error" text,
	"dedupe_key" text,
	"occurred_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"delivery_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_model_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"tier" text DEFAULT 'ECONOMY' NOT NULL,
	"step" text DEFAULT '' NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_vnd" integer,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"ok" boolean DEFAULT true NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"agent_version_id" text,
	"task_id" text,
	"event_id" text,
	"mode" text DEFAULT 'SHADOW' NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"subject_type" text DEFAULT '' NOT NULL,
	"subject_id" text DEFAULT '' NOT NULL,
	"input" jsonb,
	"state_before" jsonb,
	"state_after" jsonb,
	"understanding" jsonb,
	"decision" jsonb,
	"suggested_reply" text DEFAULT '' NOT NULL,
	"tier" text DEFAULT 'RULE' NOT NULL,
	"escalation_reason" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_vnd" integer,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"event_id" text,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"payload" jsonb,
	"dedupe_key" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_tool_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"tool" text NOT NULL,
	"outcome" text DEFAULT 'OK' NOT NULL,
	"args" jsonb,
	"result" jsonb,
	"error" text,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text DEFAULT 'PANCAKE' NOT NULL,
	"page_id" text DEFAULT '' NOT NULL,
	"external_id" text NOT NULL,
	"customer_id" text,
	"pancake_customer_id" text DEFAULT '' NOT NULL,
	"customer_name" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"stage" text DEFAULT 'NEW_LEAD' NOT NULL,
	"state" jsonb,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"order_id" text,
	"human_takeover_at" timestamp with time zone,
	"takeover_reason" text DEFAULT '' NOT NULL,
	"takeover_by_user_id" text,
	"last_customer_message_at" timestamp with time zone,
	"last_shop_message_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_followups" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text,
	"due_at" timestamp with time zone NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"suggested_message" text DEFAULT '' NOT NULL,
	"done_at" timestamp with time zone,
	"done_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"external_id" text DEFAULT '' NOT NULL,
	"direction" text DEFAULT 'IN' NOT NULL,
	"from_page" boolean DEFAULT false NOT NULL,
	"from_agent" boolean DEFAULT false NOT NULL,
	"from_name" text DEFAULT '' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"has_attachment" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_suggestions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"conversation_id" text NOT NULL,
	"trigger_message_id" text,
	"stage_before" text DEFAULT '' NOT NULL,
	"stage_after" text DEFAULT '' NOT NULL,
	"action" text DEFAULT 'NO_ACTION' NOT NULL,
	"suggested_reply" text DEFAULT '' NOT NULL,
	"confidence" double precision,
	"sent" boolean DEFAULT false NOT NULL,
	"human_reply" text DEFAULT '' NOT NULL,
	"human_replied_at" timestamp with time zone,
	"verdict" text,
	"verdict_note" text DEFAULT '' NOT NULL,
	"verdict_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_agent_versions" ADD CONSTRAINT "ai_agent_versions_agent_id_ai_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_approvals" ADD CONSTRAINT "ai_approvals_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_approvals" ADD CONSTRAINT "ai_approvals_agent_id_ai_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_approvals" ADD CONSTRAINT "ai_approvals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_errors" ADD CONSTRAINT "ai_errors_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_model_calls" ADD CONSTRAINT "ai_model_calls_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_agent_id_ai_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_agent_version_id_ai_agent_versions_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "public"."ai_agent_versions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_task_id_ai_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."ai_tasks"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_event_id_ai_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."ai_events"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_agent_id_ai_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_event_id_ai_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."ai_events"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD CONSTRAINT "sales_conversations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD CONSTRAINT "sales_conversations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD CONSTRAINT "sales_conversations_takeover_by_user_id_users_id_fk" FOREIGN KEY ("takeover_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_followups" ADD CONSTRAINT "sales_followups_conversation_id_sales_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."sales_conversations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_followups" ADD CONSTRAINT "sales_followups_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_followups" ADD CONSTRAINT "sales_followups_done_by_user_id_users_id_fk" FOREIGN KEY ("done_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_messages" ADD CONSTRAINT "sales_messages_conversation_id_sales_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."sales_conversations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_suggestions" ADD CONSTRAINT "sales_suggestions_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_suggestions" ADD CONSTRAINT "sales_suggestions_conversation_id_sales_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."sales_conversations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_suggestions" ADD CONSTRAINT "sales_suggestions_trigger_message_id_sales_messages_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "public"."sales_messages"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales_suggestions" ADD CONSTRAINT "sales_suggestions_verdict_by_user_id_users_id_fk" FOREIGN KEY ("verdict_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_agent_versions_uq" ON "ai_agent_versions" USING btree ("agent_id","version");
--> statement-breakpoint
CREATE INDEX "ai_agents_mode_idx" ON "ai_agents" USING btree ("mode");
--> statement-breakpoint
CREATE INDEX "ai_approvals_status_idx" ON "ai_approvals" USING btree ("status","created_at");
--> statement-breakpoint
CREATE INDEX "ai_errors_scope_idx" ON "ai_errors" USING btree ("scope","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_events_dedupe_uq" ON "ai_events" USING btree ("dedupe_key");
--> statement-breakpoint
CREATE INDEX "ai_events_status_idx" ON "ai_events" USING btree ("status","created_at");
--> statement-breakpoint
CREATE INDEX "ai_events_subject_idx" ON "ai_events" USING btree ("subject_type","subject_id");
--> statement-breakpoint
CREATE INDEX "ai_model_calls_run_idx" ON "ai_model_calls" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "ai_model_calls_created_idx" ON "ai_model_calls" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "ai_runs_agent_started_idx" ON "ai_runs" USING btree ("agent_id","started_at");
--> statement-breakpoint
CREATE INDEX "ai_runs_subject_idx" ON "ai_runs" USING btree ("subject_type","subject_id");
--> statement-breakpoint
CREATE INDEX "ai_runs_status_idx" ON "ai_runs" USING btree ("status","started_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_tasks_dedupe_uq" ON "ai_tasks" USING btree ("dedupe_key");
--> statement-breakpoint
CREATE INDEX "ai_tasks_status_idx" ON "ai_tasks" USING btree ("status","created_at");
--> statement-breakpoint
CREATE INDEX "ai_tasks_agent_idx" ON "ai_tasks" USING btree ("agent_id","created_at");
--> statement-breakpoint
CREATE INDEX "ai_tool_calls_run_idx" ON "ai_tool_calls" USING btree ("run_id","seq");
--> statement-breakpoint
CREATE INDEX "ai_tool_calls_tool_idx" ON "ai_tool_calls" USING btree ("tool","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "sales_conversations_external_uq" ON "sales_conversations" USING btree ("page_id","external_id");
--> statement-breakpoint
CREATE INDEX "sales_conversations_stage_idx" ON "sales_conversations" USING btree ("stage","updated_at");
--> statement-breakpoint
CREATE INDEX "sales_conversations_takeover_idx" ON "sales_conversations" USING btree ("human_takeover_at");
--> statement-breakpoint
CREATE INDEX "sales_followups_due_idx" ON "sales_followups" USING btree ("status","due_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "sales_messages_external_uq" ON "sales_messages" USING btree ("conversation_id","external_id");
--> statement-breakpoint
CREATE INDEX "sales_messages_conv_idx" ON "sales_messages" USING btree ("conversation_id","sent_at");
--> statement-breakpoint
CREATE INDEX "sales_suggestions_conv_idx" ON "sales_suggestions" USING btree ("conversation_id","created_at");
--> statement-breakpoint
CREATE INDEX "sales_suggestions_verdict_idx" ON "sales_suggestions" USING btree ("verdict","created_at");
