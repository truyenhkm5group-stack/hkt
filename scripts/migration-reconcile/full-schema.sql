CREATE TYPE "public"."approval_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED');--> statement-breakpoint
CREATE TYPE "public"."idea_status" AS ENUM('NEW', 'REVIEWING', 'CHANGES', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "access_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"base_role" "role" DEFAULT 'VIEWER' NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_scope" text DEFAULT 'ALL' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_roles_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "action_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"notification_id" text NOT NULL,
	"case_type" text NOT NULL,
	"team" text DEFAULT '' NOT NULL,
	"entity_type" text DEFAULT '' NOT NULL,
	"entity_id" text DEFAULT '' NOT NULL,
	"actor_id" text,
	"actor_email" text DEFAULT '' NOT NULL,
	"detected_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone NOT NULL,
	"hours_to_close" integer,
	"money_at_risk" bigint,
	"outcome_at_close" text,
	"recovered_value" integer,
	"recovered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "ai_interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"user_email" text DEFAULT '' NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"route" text DEFAULT '' NOT NULL,
	"entity_type" text DEFAULT '' NOT NULL,
	"entity_id" text DEFAULT '' NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"answer" text DEFAULT '' NOT NULL,
	"tool_calls" jsonb,
	"actions_proposed" jsonb,
	"actions_executed" jsonb,
	"usage" jsonb,
	"cost_usd" text DEFAULT '0' NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"rounds" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'OK' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_interactions_status_check" CHECK ("ai_interactions"."status" IN ('OK', 'NEEDS_CONFIRMATION', 'REFUSED', 'ERROR'))
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
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_vnd" integer,
	"pricing_version" text DEFAULT '' NOT NULL,
	"input_price_vnd_per_million" integer,
	"cached_input_price_vnd_per_million" integer,
	"output_price_vnd_per_million" integer,
	"currency" text DEFAULT 'VND' NOT NULL,
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
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_vnd" integer,
	"pricing_version" text DEFAULT '' NOT NULL,
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
CREATE TABLE "approval_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"group" text NOT NULL,
	"action" text NOT NULL,
	"entity" text DEFAULT '' NOT NULL,
	"entity_id" text DEFAULT '' NOT NULL,
	"amount" bigint,
	"summary" text NOT NULL,
	"payload" jsonb,
	"status" "approval_status" DEFAULT 'PENDING' NOT NULL,
	"requested_by" text,
	"requested_by_email" text DEFAULT '' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_by_email" text,
	"decided_at" timestamp with time zone,
	"note" text,
	"executed_at" timestamp with time zone,
	"execution_error" text,
	CONSTRAINT "approval_khac_nguoi" CHECK ("approval_requests"."decided_by" is null or "approval_requests"."decided_by" <> "approval_requests"."requested_by")
);
--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text DEFAULT '' NOT NULL,
	"gateway" text DEFAULT '' NOT NULL,
	"account_number" text NOT NULL,
	"sub_account" text DEFAULT '' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"currency" text DEFAULT 'VND' NOT NULL,
	"status" text DEFAULT 'UNCONFIRMED' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_accounts_status_check" CHECK ("bank_accounts"."status" IN ('ACTIVE', 'UNCONFIRMED', 'DISABLED'))
);
--> statement-breakpoint
CREATE TABLE "bank_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"direction" text DEFAULT 'ANY' NOT NULL,
	"match_counterparty" text DEFAULT '' NOT NULL,
	"match_description" text DEFAULT '' NOT NULL,
	"min_amount" integer DEFAULT 0 NOT NULL,
	"max_amount" integer DEFAULT 0 NOT NULL,
	"accounting_group" text NOT NULL,
	"category_code" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_rules_direction_check" CHECK ("bank_rules"."direction" IN ('IN', 'OUT', 'ANY')),
	CONSTRAINT "bank_rules_match_check" CHECK (length("bank_rules"."match_counterparty") > 0 OR length("bank_rules"."match_description") > 0 OR "bank_rules"."min_amount" > 0 OR "bank_rules"."max_amount" > 0),
	CONSTRAINT "bank_rules_amount_check" CHECK ("bank_rules"."max_amount" = 0 OR "bank_rules"."max_amount" >= "bank_rules"."min_amount")
);
--> statement-breakpoint
CREATE TABLE "bank_transaction_links" (
	"id" text PRIMARY KEY NOT NULL,
	"txn_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"amount" integer NOT NULL,
	"confidence" text DEFAULT 'MANUAL' NOT NULL,
	"method" text DEFAULT 'MANUAL' NOT NULL,
	"confirmed_by" text NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_txn_links_amount_check" CHECK ("bank_transaction_links"."amount" > 0),
	CONSTRAINT "bank_txn_links_target_type_check" CHECK ("bank_transaction_links"."target_type" IN ('EXPENSE', 'COD_BATCH', 'STOCK_RECEIPT', 'AD_SPEND', 'PAYROLL_PERIOD', 'BANK_TRANSACTION')),
	CONSTRAINT "bank_txn_links_confidence_check" CHECK ("bank_transaction_links"."confidence" IN ('EXACT', 'HIGH_CONFIDENCE', 'MANUAL')),
	CONSTRAINT "bank_txn_links_method_check" CHECK ("bank_transaction_links"."method" IN ('IDENTIFIER_MATCH', 'AMOUNT_DATE_MATCH', 'MANUAL', 'TRANSFER_PAIR')),
	CONSTRAINT "bank_txn_links_actor_check" CHECK (length(trim("bank_transaction_links"."confirmed_by")) > 0),
	CONSTRAINT "bank_txn_links_payroll_period_check" CHECK ("bank_transaction_links"."target_type" <> 'PAYROLL_PERIOD' OR "bank_transaction_links"."target_id" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "bank_txn_links_self_check" CHECK ("bank_transaction_links"."target_type" <> 'BANK_TRANSACTION' OR "bank_transaction_links"."target_id" <> "bank_transaction_links"."txn_id")
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"txn_at" timestamp with time zone NOT NULL,
	"amount" integer NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"counterparty" text DEFAULT '' NOT NULL,
	"bank_ref" text NOT NULL,
	"account" text DEFAULT '' NOT NULL,
	"accounting_group" text DEFAULT 'UNCLASSIFIED' NOT NULL,
	"category_code" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"rule_id" text,
	"classified_by" text DEFAULT '' NOT NULL,
	"classified_at" timestamp with time zone,
	"source" text DEFAULT 'IMPORT' NOT NULL,
	"provider" text DEFAULT '' NOT NULL,
	"provider_txn_id" text DEFAULT '' NOT NULL,
	"bank_account_id" text,
	"last_seen_source" text DEFAULT '' NOT NULL,
	"seen_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"balance_after" integer,
	"match_key" text DEFAULT '' NOT NULL,
	"linked_type" text DEFAULT '' NOT NULL,
	"linked_id" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_txn_linked_check" CHECK ("bank_transactions"."linked_type" IN ('', 'EXPENSE', 'COD_BATCH', 'STOCK_RECEIPT', 'AD_SPEND', 'PAYROLL_PERIOD', 'BANK_TRANSACTION')),
	CONSTRAINT "bank_txn_linked_pair_check" CHECK (("bank_transactions"."linked_type" = '' AND "bank_transactions"."linked_id" = '') OR ("bank_transactions"."linked_type" <> '' AND length("bank_transactions"."linked_id") > 0)),
	CONSTRAINT "bank_txn_amount_check" CHECK ("bank_transactions"."amount" <> 0),
	CONSTRAINT "bank_txn_source_check" CHECK ("bank_transactions"."source" IN ('IMPORT', 'MANUAL', 'WEBHOOK', 'API'))
);
--> statement-breakpoint
CREATE TABLE "bsc_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"scorecard_id" text NOT NULL,
	"perspective" text NOT NULL,
	"label" text NOT NULL,
	"metric_source" text DEFAULT 'MANUAL' NOT NULL,
	"unit" text DEFAULT 'NUMBER' NOT NULL,
	"direction" text DEFAULT 'UP' NOT NULL,
	"target" double precision,
	"manual_value" double precision,
	"manual_value_at" timestamp with time zone,
	"weight" double precision DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bsc_metrics_perspective_check" CHECK ("bsc_metrics"."perspective" IN ('FINANCIAL', 'CUSTOMER', 'INTERNAL_PROCESS', 'LEARNING_GROWTH')),
	CONSTRAINT "bsc_metrics_unit_check" CHECK ("bsc_metrics"."unit" IN ('NUMBER', 'VND', 'PERCENT', 'COUNT', 'DAYS', 'HOURS')),
	CONSTRAINT "bsc_metrics_direction_check" CHECK ("bsc_metrics"."direction" IN ('UP', 'DOWN')),
	CONSTRAINT "bsc_metrics_weight_check" CHECK ("bsc_metrics"."weight" > 0)
);
--> statement-breakpoint
CREATE TABLE "bsc_scorecards" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"department_id" text,
	"name" text NOT NULL,
	"period" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bsc_scorecards_scope_check" CHECK ("bsc_scorecards"."scope" IN ('COMPANY', 'DEPARTMENT')),
	CONSTRAINT "bsc_scorecards_dept_check" CHECK (("bsc_scorecards"."scope" = 'COMPANY') = ("bsc_scorecards"."department_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "canonical_order_outcome" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"shipment_id" text,
	"outcome" text NOT NULL,
	"cogs" integer DEFAULT 0 NOT NULL,
	"recognized_cogs" integer,
	"recognized_at" timestamp with time zone,
	"cogs_basis" text,
	"trued_up_at" timestamp with time zone,
	"trued_up_from" integer,
	"trued_up_from_basis" text,
	"logic_version" integer DEFAULT 1 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "care_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"shipment_id" text NOT NULL,
	"order_id" text,
	"actor_id" text,
	"actor_email" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"stage_at_action" text DEFAULT '' NOT NULL,
	"bucket_at_action" text DEFAULT '' NOT NULL,
	"cod_at_action" bigint,
	"event_age_hours_at_action" integer,
	"failed_attempts_at_action" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "care_business_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"care_case_id" text NOT NULL,
	"shipment_id" text NOT NULL,
	"actor_user_id" text,
	"actor_email" text DEFAULT '' NOT NULL,
	"owner_id_at_action" text,
	"action_type" text NOT NULL,
	"reason_code" text,
	"reason_note" text DEFAULT '' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"carrier_command_id" text,
	"carrier_result" text,
	"previous_care_status" text,
	"next_care_status" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "care_business_actions_type_check" CHECK ("care_business_actions"."action_type" IN ('APPROVE_RETURN', 'REQUEST_REDELIVERY', 'EXCHANGE', 'CONTINUE_MONITORING'))
);
--> statement-breakpoint
CREATE TABLE "care_case_events" (
	"id" text PRIMARY KEY NOT NULL,
	"shipment_id" text NOT NULL,
	"actor_id" text,
	"actor_email" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'UI' NOT NULL,
	"action" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"previous_status" text,
	"next_status" text,
	"previous_owner" text,
	"next_owner" text,
	"previous_owner_id" text,
	"next_owner_id" text,
	"follow_up_at" timestamp with time zone,
	"sla" jsonb,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "care_case_events_source_check" CHECK ("care_case_events"."source" IN ('UI', 'API', 'AI', 'SYSTEM'))
);
--> statement-breakpoint
CREATE TABLE "carrier_action_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"shipment_id" text NOT NULL,
	"order_number" text DEFAULT '' NOT NULL,
	"action_key" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb,
	"raw_request" jsonb,
	"response" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"actor_id" text,
	"actor_email" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"sent_at" timestamp with time zone,
	"ack_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carrier_action_requests_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "carrier_action_status_check" CHECK ("carrier_action_requests"."status" IN ('PENDING', 'SENT', 'ACKNOWLEDGED', 'SUCCESS', 'FAILED', 'UNSUPPORTED', 'MANUAL_REQUIRED', 'MANUAL_DONE'))
);
--> statement-breakpoint
CREATE TABLE "conversation_funnel" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"pancake_customer_id" text DEFAULT '' NOT NULL,
	"customer_name" text DEFAULT '' NOT NULL,
	"phone" text,
	"first_customer_message_at" timestamp with time zone,
	"first_shop_reply_at" timestamp with time zone,
	"last_customer_message_at" timestamp with time zone,
	"last_shop_message_at" timestamp with time zone,
	"customer_message_count" integer DEFAULT 0 NOT NULL,
	"shop_message_count" integer DEFAULT 0 NOT NULL,
	"phone_at" timestamp with time zone,
	"address_at" timestamp with time zone,
	"address_text" text DEFAULT '' NOT NULL,
	"info_complete_at" timestamp with time zone,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"owner_name" text DEFAULT '' NOT NULL,
	"matched_order_id" text,
	"match_basis" text DEFAULT 'NONE' NOT NULL,
	"match_candidates" integer DEFAULT 0 NOT NULL,
	"matched_order_at" timestamp with time zone,
	"truncated" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_scan_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scan_window_from" timestamp with time zone,
	"evidence" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_funnel_match_basis_check" CHECK ("conversation_funnel"."match_basis" IN ('BY_CONVERSATION','BY_PHONE_UNIQUE','AMBIGUOUS','NONE'))
);
--> statement-breakpoint
CREATE TABLE "cs_case_events" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"actor_id" text,
	"actor_email" text DEFAULT '' NOT NULL,
	"actor_name" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'UI' NOT NULL,
	"action" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"previous_status" text,
	"next_status" text,
	"previous_assignee" text,
	"next_assignee" text,
	"follow_up_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "department_members" (
	"id" text PRIMARY KEY NOT NULL,
	"department_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role_in_dept" text DEFAULT 'MEMBER' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "department_members_role_check" CHECK ("department_members"."role_in_dept" IN ('LEAD', 'MEMBER'))
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"lead_user_id" text,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "fanpage_sales_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"pancake_page_id" text NOT NULL,
	"facebook_page_id" text DEFAULT '' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"ai_mode" text DEFAULT 'SHADOW' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"effective_from" timestamp with time zone,
	"active_product_id" text,
	"unit_price" integer,
	"shipping_fee" integer,
	"combo_pricing" jsonb,
	"free_ship_from" integer,
	"available_colors" text[] DEFAULT '{}'::text[] NOT NULL,
	"material" text DEFAULT '' NOT NULL,
	"cod_policy" text DEFAULT '' NOT NULL,
	"inspection_policy" text DEFAULT '' NOT NULL,
	"delivery_estimate" text DEFAULT '' NOT NULL,
	"exchange_policy_json" jsonb,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"approved_facts_json" jsonb,
	"knowledge_version" integer DEFAULT 1 NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hmt_return_reconciliation" (
	"id" text PRIMARY KEY NOT NULL,
	"workbook" text NOT NULL,
	"sheet" text NOT NULL,
	"sheet_role" text NOT NULL,
	"source_row" integer DEFAULT 0 NOT NULL,
	"tracking_raw" text DEFAULT '' NOT NULL,
	"tracking_key" text DEFAULT '' NOT NULL,
	"inheritance" text DEFAULT 'OWN_CELL' NOT NULL,
	"product_text" text DEFAULT '' NOT NULL,
	"product_code" text DEFAULT '' NOT NULL,
	"color" text DEFAULT '' NOT NULL,
	"size" text DEFAULT '' NOT NULL,
	"variant_id" text,
	"sku" text DEFAULT '' NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"shipment_id" text,
	"match_status" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"written" boolean DEFAULT false NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor_id" text,
	"actor_label" text DEFAULT '' NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolution" text,
	"resolved_shipment_id" text,
	"resolved_variant_id" text,
	"resolved_by" text DEFAULT '' NOT NULL,
	"resolved_by_user_id" text,
	"resolution_note" text DEFAULT '' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hmt_return_reconciliation_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "hmt_return_rec_status_check" CHECK ("hmt_return_reconciliation"."match_status" IN ('MATCHED', 'ALREADY_RECEIVED', 'AMBIGUOUS_TRACKING', 'AMBIGUOUS_SKU', 'SKU_MISMATCH', 'QUANTITY_CONFLICT', 'UNMATCHED_TRACKING', 'DUPLICATE_SOURCE_ROW', 'CONFLICT')),
	CONSTRAINT "hmt_return_rec_inheritance_check" CHECK ("hmt_return_reconciliation"."inheritance" IN ('OWN_CELL', 'MERGED_CELL', 'NONE')),
	CONSTRAINT "hmt_return_rec_written_check" CHECK ("hmt_return_reconciliation"."written" = false OR "hmt_return_reconciliation"."match_status" = 'MATCHED'),
	CONSTRAINT "hmt_return_rec_resolution_check" CHECK ("hmt_return_reconciliation"."resolution" IS NULL OR "hmt_return_reconciliation"."resolution" IN ('LINKED_SHIPMENT', 'RESOLVED_SKU', 'DISMISSED')),
	CONSTRAINT "hmt_return_rec_resolution_actor_check" CHECK ("hmt_return_reconciliation"."resolution" IS NULL OR ("hmt_return_reconciliation"."resolved_at" IS NOT NULL AND "hmt_return_reconciliation"."resolved_by" <> '' AND "hmt_return_reconciliation"."resolution_note" <> '')),
	CONSTRAINT "hmt_return_rec_resolution_target_check" CHECK ("hmt_return_reconciliation"."resolution" IS DISTINCT FROM 'LINKED_SHIPMENT' OR "hmt_return_reconciliation"."resolved_shipment_id" IS NOT NULL),
	CONSTRAINT "hmt_return_rec_resolution_sku_check" CHECK ("hmt_return_reconciliation"."resolution" IS DISTINCT FROM 'RESOLVED_SKU' OR "hmt_return_reconciliation"."resolved_variant_id" IS NOT NULL),
	CONSTRAINT "hmt_return_rec_resolution_written_check" CHECK ("hmt_return_reconciliation"."resolution" IS NULL OR "hmt_return_reconciliation"."written" = false)
);
--> statement-breakpoint
CREATE TABLE "hmt_workbooks" (
	"id" text PRIMARY KEY NOT NULL,
	"filename" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" integer DEFAULT 0 NOT NULL,
	"content" text NOT NULL,
	"uploaded_by_user_id" text,
	"uploaded_by" text DEFAULT '' NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketing_idea_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"idea_id" text NOT NULL,
	"author_email" text DEFAULT '' NOT NULL,
	"author_name" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"status_set" "idea_status",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketing_idea_images" (
	"id" text PRIMARY KEY NOT NULL,
	"idea_id" text NOT NULL,
	"content_type" text DEFAULT 'image/jpeg' NOT NULL,
	"bytes" integer DEFAULT 0 NOT NULL,
	"data" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketing_ideas" (
	"id" text PRIMARY KEY NOT NULL,
	"marketer_id" text,
	"marketer_name" text DEFAULT '' NOT NULL,
	"idea_date" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"status" "idea_status" DEFAULT 'NEW' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"metric_key" text NOT NULL,
	"scope" text NOT NULL,
	"scope_ref" text,
	"target" double precision NOT NULL,
	"target_max" double precision,
	"warning_at" double precision,
	"critical_at" double precision,
	"period_kind" text DEFAULT 'ANY' NOT NULL,
	"effective_to" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"owner_department" text,
	"note" text DEFAULT '' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"set_by" text,
	"set_by_email" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_targets_scope_check" CHECK ("metric_targets"."scope" IN ('COMPANY', 'DEPARTMENT', 'POSITION', 'USER')),
	CONSTRAINT "metric_targets_period_check" CHECK ("metric_targets"."period_kind" IN ('ANY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR')),
	CONSTRAINT "metric_targets_window_check" CHECK ("metric_targets"."effective_to" IS NULL OR "metric_targets"."effective_to" > "metric_targets"."effective_from"),
	CONSTRAINT "metric_targets_range_check" CHECK ("metric_targets"."target_max" IS NULL OR "metric_targets"."target_max" > "metric_targets"."target"),
	CONSTRAINT "metric_targets_version_check" CHECK ("metric_targets"."version" >= 1),
	CONSTRAINT "metric_targets_ref_check" CHECK (("metric_targets"."scope" = 'COMPANY' AND "metric_targets"."scope_ref" IS NULL) OR ("metric_targets"."scope" <> 'COMPANY' AND "metric_targets"."scope_ref" IS NOT NULL AND length(trim("metric_targets"."scope_ref")) > 0))
);
--> statement-breakpoint
CREATE TABLE "okr_checkins" (
	"id" text PRIMARY KEY NOT NULL,
	"key_result_id" text NOT NULL,
	"value" double precision,
	"confidence" text DEFAULT 'UNKNOWN' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'MANUAL' NOT NULL,
	"actor_id" text,
	"actor_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "okr_checkins_source_check" CHECK ("okr_checkins"."source" IN ('MANUAL', 'AUTO'))
);
--> statement-breakpoint
CREATE TABLE "okr_key_results" (
	"id" text PRIMARY KEY NOT NULL,
	"objective_id" text NOT NULL,
	"title" text NOT NULL,
	"metric_source" text DEFAULT 'MANUAL' NOT NULL,
	"unit" text DEFAULT 'NUMBER' NOT NULL,
	"direction" text DEFAULT 'UP' NOT NULL,
	"baseline" double precision,
	"target" double precision NOT NULL,
	"current" double precision,
	"current_at" timestamp with time zone,
	"confidence" text DEFAULT 'UNKNOWN' NOT NULL,
	"owner_user_id" text,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "okr_key_results_unit_check" CHECK ("okr_key_results"."unit" IN ('NUMBER', 'VND', 'PERCENT', 'COUNT', 'DAYS', 'HOURS')),
	CONSTRAINT "okr_key_results_direction_check" CHECK ("okr_key_results"."direction" IN ('UP', 'DOWN')),
	CONSTRAINT "okr_key_results_confidence_check" CHECK ("okr_key_results"."confidence" IN ('ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'UNKNOWN')),
	CONSTRAINT "okr_key_results_target_check" CHECK ("okr_key_results"."baseline" IS NULL OR "okr_key_results"."target" <> "okr_key_results"."baseline")
);
--> statement-breakpoint
CREATE TABLE "okr_objectives" (
	"id" text PRIMARY KEY NOT NULL,
	"level" text NOT NULL,
	"department_id" text,
	"owner_user_id" text,
	"parent_id" text,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"period" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "okr_objectives_level_check" CHECK ("okr_objectives"."level" IN ('COMPANY', 'DEPARTMENT', 'INDIVIDUAL')),
	CONSTRAINT "okr_objectives_status_check" CHECK ("okr_objectives"."status" IN ('DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED')),
	CONSTRAINT "okr_objectives_scope_check" CHECK ("okr_objectives"."level" = 'COMPANY' OR "okr_objectives"."department_id" IS NOT NULL OR "okr_objectives"."owner_user_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "order_field_provenance" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text,
	"field" text NOT NULL,
	"value" text DEFAULT '' NOT NULL,
	"source_type" text NOT NULL,
	"claim" text NOT NULL,
	"source_message_id" text,
	"source_reference" text DEFAULT '' NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"confidence" double precision,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "performance_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"period" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"subject_label" text DEFAULT '' NOT NULL,
	"department_code" text DEFAULT '' NOT NULL,
	"metric_key" text NOT NULL,
	"metric_label" text NOT NULL,
	"value" double precision,
	"unit" text NOT NULL,
	"sample" integer DEFAULT 0 NOT NULL,
	"denominator_label" text DEFAULT '' NOT NULL,
	"confidence" text NOT NULL,
	"linkage" text NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"attribution" text DEFAULT '' NOT NULL,
	"basis" text DEFAULT '' NOT NULL,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"definition_version" integer DEFAULT 1 NOT NULL,
	"source_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"department_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positions_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "product_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"variant_id" text,
	"category" text DEFAULT 'OTHER' NOT NULL,
	"body" text NOT NULL,
	"actor_user_id" text,
	"actor_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_notes_category_check" CHECK ("product_notes"."category" IN ('QUALITY', 'SIZING', 'SUPPLIER', 'PRICING', 'PACKAGING', 'OTHER')),
	CONSTRAINT "product_notes_body_check" CHECK (length(btrim("product_notes"."body")) > 0)
);
--> statement-breakpoint
CREATE TABLE "return_inspection_items" (
	"id" text PRIMARY KEY NOT NULL,
	"inspection_id" text NOT NULL,
	"shipment_id" text NOT NULL,
	"expected_variant_id" text,
	"expected_sku" text DEFAULT '' NOT NULL,
	"expected_name" text DEFAULT '' NOT NULL,
	"expected_color" text DEFAULT '' NOT NULL,
	"expected_size" text DEFAULT '' NOT NULL,
	"expected_qty" integer DEFAULT 0 NOT NULL,
	"actual_variant_id" text,
	"actual_sku" text DEFAULT '' NOT NULL,
	"actual_qty" integer DEFAULT 0 NOT NULL,
	"condition" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"inspected_by" text DEFAULT '' NOT NULL,
	"inspected_by_user_id" text,
	"inspected_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_inspection_items_condition_check" CHECK ("return_inspection_items"."condition" IN ('OK', 'SHORT', 'WRONG_ITEM', 'DAMAGED', 'DIRTY', 'UNSELLABLE', 'OTHER')),
	CONSTRAINT "return_inspection_items_qty_check" CHECK ("return_inspection_items"."expected_qty" >= 0 AND "return_inspection_items"."actual_qty" >= 0),
	CONSTRAINT "return_inspection_items_reason_check" CHECK ("return_inspection_items"."condition" = 'OK' OR length(trim("return_inspection_items"."note")) > 0)
);
--> statement-breakpoint
CREATE TABLE "return_inspections" (
	"id" text PRIMARY KEY NOT NULL,
	"shipment_id" text NOT NULL,
	"order_id" text,
	"status" text DEFAULT 'RECEIVED' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"received_by" text DEFAULT '' NOT NULL,
	"received_by_user_id" text,
	"inspected_at" timestamp with time zone,
	"inspected_by" text,
	"inspected_by_user_id" text,
	"condition" text,
	"restock_qty" integer DEFAULT 0 NOT NULL,
	"unsellable_qty" integer DEFAULT 0 NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"stock_receipt_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_inspections_shipment_id_unique" UNIQUE("shipment_id"),
	CONSTRAINT "return_inspections_status_check" CHECK ("return_inspections"."status" IN ('RECEIVED', 'INSPECTED')),
	CONSTRAINT "return_inspections_condition_check" CHECK ("return_inspections"."condition" IS NULL OR "return_inspections"."condition" IN ('RESTOCKABLE', 'UNSELLABLE', 'DAMAGED', 'MISSING', 'WRONG_ITEM')),
	CONSTRAINT "return_inspections_inspected_check" CHECK ("return_inspections"."status" <> 'INSPECTED' OR ("return_inspections"."condition" IS NOT NULL AND "return_inspections"."inspected_at" IS NOT NULL AND "return_inspections"."inspected_by" IS NOT NULL AND length(trim("return_inspections"."inspected_by")) > 0)),
	CONSTRAINT "return_inspections_reason_check" CHECK ("return_inspections"."condition" IS NULL OR "return_inspections"."condition" = 'RESTOCKABLE' OR length(trim("return_inspections"."note")) > 0),
	CONSTRAINT "return_inspections_qty_check" CHECK ("return_inspections"."restock_qty" >= 0 AND "return_inspections"."unsellable_qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "review_cycles" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"department_id" text,
	"period" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"snapshot" jsonb,
	"snapshot_version" integer DEFAULT 1 NOT NULL,
	"highlights" text DEFAULT '' NOT NULL,
	"issues" text DEFAULT '' NOT NULL,
	"next_actions" text DEFAULT '' NOT NULL,
	"finalized_at" timestamp with time zone,
	"finalized_by" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_cycles_kind_check" CHECK ("review_cycles"."kind" IN ('WEEKLY', 'MONTHLY', 'QUARTERLY')),
	CONSTRAINT "review_cycles_scope_check" CHECK ("review_cycles"."scope" IN ('COMPANY', 'DEPARTMENT')),
	CONSTRAINT "review_cycles_dept_check" CHECK (("review_cycles"."scope" = 'COMPANY') = ("review_cycles"."department_id" IS NULL)),
	CONSTRAINT "review_cycles_status_check" CHECK ("review_cycles"."status" IN ('DRAFT', 'FINAL')),
	CONSTRAINT "review_cycles_final_check" CHECK ("review_cycles"."status" = 'DRAFT' OR ("review_cycles"."snapshot" IS NOT NULL AND "review_cycles"."finalized_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "sales_ad_product_map" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"ad_key" text NOT NULL,
	"key_kind" text DEFAULT 'AD' NOT NULL,
	"product_id" text,
	"variant_id" text,
	"source" text DEFAULT 'AD_DESCRIPTION' NOT NULL,
	"confidence" double precision DEFAULT 0 NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"ad_description" text DEFAULT '' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"source_type" text DEFAULT '' NOT NULL,
	"source_kind" text DEFAULT '' NOT NULL,
	"source_id" text DEFAULT '' NOT NULL,
	"sales_profile_id" text,
	"sales_profile_version" integer,
	"active_product_id" text,
	"test_product_id" text,
	"offer_snapshot" jsonb,
	"size_rule_version" text DEFAULT '' NOT NULL,
	"policy_version" integer,
	"knowledge_version" integer,
	"source_rule_id" text,
	"classification_source" text DEFAULT '' NOT NULL,
	"classification_confidence" double precision,
	"classified_at" timestamp with time zone,
	"last_customer_message_at" timestamp with time zone,
	"last_shop_message_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_copilot_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"suggestion_id" text,
	"run_id" text,
	"page_id" text DEFAULT '' NOT NULL,
	"action" text NOT NULL,
	"suggested_text" text DEFAULT '' NOT NULL,
	"final_text" text DEFAULT '' NOT NULL,
	"edited" boolean,
	"edit_distance" integer,
	"reject_reason" text,
	"note" text DEFAULT '' NOT NULL,
	"send_status" text DEFAULT 'NONE' NOT NULL,
	"pancake_message_id" text DEFAULT '' NOT NULL,
	"send_error" text DEFAULT '' NOT NULL,
	"review_seconds" integer,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verified" boolean,
	"verify_note" text DEFAULT '' NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "sales_ingest_cursors" (
	"page_id" text PRIMARY KEY NOT NULL,
	"last_message_at" timestamp with time zone,
	"last_message_external_id" text DEFAULT '' NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"last_error" text DEFAULT '' NOT NULL,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"messages_ingested" integer DEFAULT 0 NOT NULL,
	"conversations_seen" integer DEFAULT 0 NOT NULL,
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
	"attachment_count" integer DEFAULT 0 NOT NULL,
	"sender_type" text DEFAULT 'UNKNOWN' NOT NULL,
	"platform" text DEFAULT '' NOT NULL,
	"ingest_source" text DEFAULT '' NOT NULL,
	"content_hash" text DEFAULT '' NOT NULL,
	"ad_id" text DEFAULT '' NOT NULL,
	"post_url" text DEFAULT '' NOT NULL,
	"ad_description" text DEFAULT '' NOT NULL,
	"attachment_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"ad_media_url" text DEFAULT '' NOT NULL,
	"sent_at" timestamp with time zone,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_product_resolutions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"conversation_id" text NOT NULL,
	"message_id" text,
	"product_id" text,
	"variant_id" text,
	"product_code" text DEFAULT '' NOT NULL,
	"source" text NOT NULL,
	"confidence" double precision DEFAULT 0 NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_regression_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"case_key" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"page_id" text DEFAULT '' NOT NULL,
	"source_suggestion_id" text,
	"source_conversation_id" text,
	"input" jsonb NOT NULL,
	"expected" jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
	"verdict" text,
	"reason_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"expected_behavior" text DEFAULT '' NOT NULL,
	"reviewer_user_id" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_source_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"pancake_page_id" text NOT NULL,
	"source_kind" text DEFAULT 'AD' NOT NULL,
	"source_id" text NOT NULL,
	"source_type" text NOT NULL,
	"product_id" text,
	"test_product_id" text,
	"note" text DEFAULT '' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"production_action" text DEFAULT 'NO_SEND' NOT NULL,
	"evaluation_only" boolean DEFAULT false NOT NULL,
	"suggested_reply" text DEFAULT '' NOT NULL,
	"facts_json" jsonb,
	"confidence" double precision,
	"sent" boolean DEFAULT false NOT NULL,
	"human_reply" text DEFAULT '' NOT NULL,
	"human_replied_at" timestamp with time zone,
	"human_reply_count" integer DEFAULT 0 NOT NULL,
	"human_response_seconds" integer,
	"verdict" text,
	"verdict_note" text DEFAULT '' NOT NULL,
	"verdict_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_care" (
	"id" text PRIMARY KEY NOT NULL,
	"shipment_id" text NOT NULL,
	"episode_no" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"care_status" text DEFAULT 'NEW' NOT NULL,
	"entry_carrier_state" text,
	"source_trigger" text,
	"order_id" text,
	"tracking_number" text,
	"priority" text,
	"owner_id" text,
	"owner_email" text DEFAULT '' NOT NULL,
	"follow_up_at" timestamp with time zone,
	"last_note" text DEFAULT '' NOT NULL,
	"last_note_at" timestamp with time zone,
	"last_note_by" text DEFAULT '' NOT NULL,
	"first_response_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"assigned_at" timestamp with time zone,
	"first_action_at" timestamp with time zone,
	"last_action_at" timestamp with time zone,
	"outcome_at" timestamp with time zone,
	"resolution" text,
	"final_carrier_state" text,
	"final_logistics_outcome" text,
	"care_outcome" text,
	"owner_at_resolution" text,
	"initial_owner_id" text,
	"replacement_order_id" text,
	"replacement_shipment_id" text,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_care_outcome_check" CHECK ("shipment_care"."care_outcome" IS NULL OR "shipment_care"."care_outcome" IN ('RESCUED_DIRECT', 'RESCUED_EXCHANGE', 'RESCUE_FAILED', 'PENDING', 'UNATTRIBUTED')),
	CONSTRAINT "shipment_care_status_check" CHECK ("shipment_care"."care_status" IN ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_CARRIER', 'WAITING_REDELIVERY', 'RESOLVED', 'ESCALATED', 'CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "shipment_return_reasons" (
	"id" text PRIMARY KEY NOT NULL,
	"shipment_id" text NOT NULL,
	"reason" text NOT NULL,
	"reason_group" text DEFAULT 'UNKNOWN' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"inferred_reason" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'MANUAL' NOT NULL,
	"confidence" text DEFAULT 'CONFIRMED' NOT NULL,
	"actor_id" text,
	"actor_email" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_return_reasons_shipment_id_unique" UNIQUE("shipment_id"),
	CONSTRAINT "shipment_return_reasons_source_check" CHECK ("shipment_return_reasons"."source" IN ('MANUAL', 'AUTO', 'IMPORT'))
);
--> statement-breakpoint
CREATE TABLE "test_market_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"test_product_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text,
	"customer_interest" boolean,
	"purchase_intent" boolean,
	"asked_price" boolean,
	"price_objection" boolean,
	"requested_color" text DEFAULT '' NOT NULL,
	"requested_size" text DEFAULT '' NOT NULL,
	"height_cm" integer,
	"weight_kg" integer,
	"bust_cm" integer,
	"waist_cm" integer,
	"hip_cm" integer,
	"material_question" boolean,
	"size_question" boolean,
	"shipping_question" boolean,
	"liked_design" boolean,
	"disliked_design" boolean,
	"ready_to_buy" boolean,
	"customer_feedback" text DEFAULT '' NOT NULL,
	"objection_category" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_product_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"test_code" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"pancake_page_id" text DEFAULT '' NOT NULL,
	"source_id" text DEFAULT '' NOT NULL,
	"images" text[] DEFAULT '{}'::text[] NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"material" text DEFAULT '' NOT NULL,
	"colors" text[] DEFAULT '{}'::text[] NOT NULL,
	"measurements" jsonb,
	"price" integer,
	"shipping_fee" integer,
	"combo_pricing" jsonb,
	"free_ship_from" integer,
	"cod_policy" text DEFAULT '' NOT NULL,
	"inspection_policy" text DEFAULT '' NOT NULL,
	"delivery_estimate" text DEFAULT '' NOT NULL,
	"exchange_policy_json" jsonb,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"promotion" text DEFAULT '' NOT NULL,
	"shipping_policy" text DEFAULT '' NOT NULL,
	"knowledge_version" integer DEFAULT 1 NOT NULL,
	"approved_facts_json" jsonb,
	"note" text DEFAULT '' NOT NULL,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"owner_user_id" text,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"promoted_product_id" text,
	"ai_reply_enabled" boolean DEFAULT true NOT NULL,
	"allow_quote_price" boolean DEFAULT true NOT NULL,
	"allow_answer_material" boolean DEFAULT true NOT NULL,
	"allow_ask_size" boolean DEFAULT true NOT NULL,
	"allow_collect_preference" boolean DEFAULT true NOT NULL,
	"allow_collect_intent" boolean DEFAULT true NOT NULL,
	"allow_collect_phone" boolean DEFAULT true NOT NULL,
	"allow_collect_address" boolean DEFAULT true NOT NULL,
	"allow_offer_product" boolean DEFAULT true NOT NULL,
	"allow_auto_order_create" boolean DEFAULT false NOT NULL,
	"allow_confirm_order" boolean DEFAULT false NOT NULL,
	"allow_promotion" boolean DEFAULT false NOT NULL,
	"allow_upsell" boolean DEFAULT false NOT NULL,
	"allow_follow_up" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_item_events" (
	"id" text PRIMARY KEY NOT NULL,
	"work_key" text NOT NULL,
	"work_item_id" text,
	"actor_id" text,
	"actor_email" text DEFAULT '' NOT NULL,
	"actor_name" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'UI' NOT NULL,
	"action" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"previous_status" text,
	"next_status" text,
	"previous_assignee" text,
	"next_assignee" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_item_events_source_check" CHECK ("work_item_events"."source" IN ('UI', 'API', 'SYSTEM', 'RECURRENCE'))
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" text PRIMARY KEY NOT NULL,
	"source_type" text NOT NULL,
	"source_key" text NOT NULL,
	"authority" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"department_id" text,
	"assignee_id" text,
	"assigned_by" text,
	"assigned_at" timestamp with time zone,
	"owner_id" text,
	"status" text,
	"priority" text,
	"due_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_by" text,
	"snoozed_until" timestamp with time zone,
	"blocked_reason" text DEFAULT '' NOT NULL,
	"recurrence_id" text,
	"occurrence_key" text DEFAULT '' NOT NULL,
	"business_entity" text DEFAULT 'NONE' NOT NULL,
	"business_entity_id" text DEFAULT '' NOT NULL,
	"money_at_risk" bigint,
	"money_recoverable" bigint,
	"money_confidence" text DEFAULT 'UNKNOWN' NOT NULL,
	"money_basis" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"creation_source" text DEFAULT 'MANUAL' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_items_authority_enum_check" CHECK ("work_items"."authority" IN ('SOURCE', 'WORK')),
	CONSTRAINT "work_items_authority_check" CHECK (("work_items"."authority" = 'WORK') = ("work_items"."status" IS NOT NULL)),
	CONSTRAINT "work_items_status_check" CHECK ("work_items"."status" IS NULL OR "work_items"."status" IN ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'WAITING', 'DONE', 'CANCELLED')),
	CONSTRAINT "work_items_priority_check" CHECK ("work_items"."priority" IS NULL OR "work_items"."priority" IN ('URGENT', 'HIGH', 'NORMAL', 'LOW')),
	CONSTRAINT "work_items_money_confidence_check" CHECK ("work_items"."money_confidence" IN ('MEASURED', 'ESTIMATED', 'UNKNOWN')),
	CONSTRAINT "work_items_money_basis_check" CHECK ("work_items"."money_confidence" = 'UNKNOWN' OR length(btrim("work_items"."money_basis")) > 0),
	CONSTRAINT "work_items_blocked_reason_check" CHECK ("work_items"."status" IS DISTINCT FROM 'BLOCKED' OR length(btrim("work_items"."blocked_reason")) > 0),
	CONSTRAINT "work_items_creation_source_check" CHECK ("work_items"."creation_source" IN ('AUTO', 'MANUAL', 'RECURRING'))
);
--> statement-breakpoint
CREATE TABLE "work_recurrences" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"department_id" text,
	"assignee_id" text,
	"owner_id" text,
	"priority" text DEFAULT 'NORMAL' NOT NULL,
	"cadence" text NOT NULL,
	"cadence_day" integer,
	"hour_of_day" integer DEFAULT 8 NOT NULL,
	"due_in_hours" integer DEFAULT 24 NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_generated_key" text DEFAULT '' NOT NULL,
	"last_generated_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_recurrences_cadence_check" CHECK ("work_recurrences"."cadence" IN ('DAILY', 'WEEKDAYS', 'WEEKLY', 'MONTHLY')),
	CONSTRAINT "work_recurrences_priority_check" CHECK ("work_recurrences"."priority" IN ('URGENT', 'HIGH', 'NORMAL', 'LOW')),
	CONSTRAINT "work_recurrences_hour_check" CHECK ("work_recurrences"."hour_of_day" BETWEEN 0 AND 23),
	CONSTRAINT "work_recurrences_day_check" CHECK ("work_recurrences"."cadence_day" IS NULL OR ("work_recurrences"."cadence" = 'WEEKLY' AND "work_recurrences"."cadence_day" BETWEEN 1 AND 7) OR ("work_recurrences"."cadence" = 'MONTHLY' AND "work_recurrences"."cadence_day" BETWEEN 1 AND 28))
);
--> statement-breakpoint
ALTER TABLE "shipments" DROP CONSTRAINT "shipments_order_id_unique";--> statement-breakpoint
ALTER TABLE "shipment_events" DROP CONSTRAINT "shipment_events_verified_check";--> statement-breakpoint
ALTER TABLE "cs_cases" ADD COLUMN "assignee_user_id" text;--> statement-breakpoint
ALTER TABLE "cs_cases" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "cs_cases" ADD COLUMN "info_complete_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cs_cases" ADD COLUMN "follow_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cs_cases" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "cs_cases" ADD COLUMN "semantic" jsonb;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "allocation_method" text DEFAULT 'EVENT_DATE' NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "needs_allocation_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "cost_source" text DEFAULT 'MANUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "reason" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fb_ads" ADD COLUMN "post_id" text;--> statement-breakpoint
ALTER TABLE "fb_ads" ADD COLUMN "story_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "resolved_by" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "assigned_to" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "acknowledged_by" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "started_by" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "ignored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "ignored_by" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "ignored_reason" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "utm_campaign" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "utm_source" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "referral_code" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "attribution_captured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD COLUMN "error_kind" text;--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "attempt_no" integer;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "direction" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "tracking_capability" text DEFAULT 'UNKNOWN_CAPABILITY' NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "capability_probes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "access_role_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "position_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "data_scope" text DEFAULT 'ALL' NOT NULL;--> statement-breakpoint
ALTER TABLE "action_evidence" ADD CONSTRAINT "action_evidence_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agent_versions" ADD CONSTRAINT "ai_agent_versions_agent_id_ai_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_approvals" ADD CONSTRAINT "ai_approvals_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_approvals" ADD CONSTRAINT "ai_approvals_agent_id_ai_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_approvals" ADD CONSTRAINT "ai_approvals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_errors" ADD CONSTRAINT "ai_errors_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_interactions" ADD CONSTRAINT "ai_interactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_model_calls" ADD CONSTRAINT "ai_model_calls_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_agent_id_ai_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_agent_version_id_ai_agent_versions_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "public"."ai_agent_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_task_id_ai_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."ai_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_event_id_ai_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."ai_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_agent_id_ai_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_event_id_ai_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."ai_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transaction_links" ADD CONSTRAINT "bank_txn_links_txn_fk" FOREIGN KEY ("txn_id") REFERENCES "public"."bank_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bsc_metrics" ADD CONSTRAINT "bsc_metrics_scorecard_id_bsc_scorecards_id_fk" FOREIGN KEY ("scorecard_id") REFERENCES "public"."bsc_scorecards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bsc_scorecards" ADD CONSTRAINT "bsc_scorecards_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bsc_scorecards" ADD CONSTRAINT "bsc_scorecards_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_order_outcome" ADD CONSTRAINT "canonical_order_outcome_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_order_outcome" ADD CONSTRAINT "canonical_order_outcome_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_actions" ADD CONSTRAINT "care_actions_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_actions" ADD CONSTRAINT "care_actions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_actions" ADD CONSTRAINT "care_actions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_business_actions" ADD CONSTRAINT "care_business_actions_care_case_id_shipment_care_id_fk" FOREIGN KEY ("care_case_id") REFERENCES "public"."shipment_care"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_business_actions" ADD CONSTRAINT "care_business_actions_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_business_actions" ADD CONSTRAINT "care_business_actions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_business_actions" ADD CONSTRAINT "care_business_actions_owner_id_at_action_users_id_fk" FOREIGN KEY ("owner_id_at_action") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_business_actions" ADD CONSTRAINT "care_business_actions_carrier_command_id_carrier_action_requests_id_fk" FOREIGN KEY ("carrier_command_id") REFERENCES "public"."carrier_action_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_case_events" ADD CONSTRAINT "care_case_events_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_case_events" ADD CONSTRAINT "care_case_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_case_events" ADD CONSTRAINT "care_case_events_previous_owner_id_users_id_fk" FOREIGN KEY ("previous_owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_case_events" ADD CONSTRAINT "care_case_events_next_owner_id_users_id_fk" FOREIGN KEY ("next_owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_action_requests" ADD CONSTRAINT "carrier_action_requests_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_action_requests" ADD CONSTRAINT "carrier_action_requests_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_funnel" ADD CONSTRAINT "conversation_funnel_matched_order_id_orders_id_fk" FOREIGN KEY ("matched_order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cs_case_events" ADD CONSTRAINT "cs_case_events_case_id_cs_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cs_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cs_case_events" ADD CONSTRAINT "cs_case_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_lead_user_id_users_id_fk" FOREIGN KEY ("lead_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanpage_sales_profiles" ADD CONSTRAINT "fanpage_sales_profiles_active_product_id_products_id_fk" FOREIGN KEY ("active_product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanpage_sales_profiles" ADD CONSTRAINT "fanpage_sales_profiles_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hmt_return_reconciliation" ADD CONSTRAINT "hmt_return_reconciliation_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hmt_return_reconciliation" ADD CONSTRAINT "hmt_return_reconciliation_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hmt_return_reconciliation" ADD CONSTRAINT "hmt_return_reconciliation_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hmt_return_reconciliation" ADD CONSTRAINT "hmt_return_reconciliation_resolved_shipment_id_shipments_id_fk" FOREIGN KEY ("resolved_shipment_id") REFERENCES "public"."shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hmt_return_reconciliation" ADD CONSTRAINT "hmt_return_reconciliation_resolved_variant_id_product_variants_id_fk" FOREIGN KEY ("resolved_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hmt_return_reconciliation" ADD CONSTRAINT "hmt_return_reconciliation_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hmt_workbooks" ADD CONSTRAINT "hmt_workbooks_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_idea_comments" ADD CONSTRAINT "marketing_idea_comments_idea_id_marketing_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."marketing_ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_idea_images" ADD CONSTRAINT "marketing_idea_images_idea_id_marketing_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."marketing_ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_targets" ADD CONSTRAINT "metric_targets_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_checkins" ADD CONSTRAINT "okr_checkins_key_result_id_okr_key_results_id_fk" FOREIGN KEY ("key_result_id") REFERENCES "public"."okr_key_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_checkins" ADD CONSTRAINT "okr_checkins_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_key_results" ADD CONSTRAINT "okr_key_results_objective_id_okr_objectives_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."okr_objectives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_key_results" ADD CONSTRAINT "okr_key_results_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_objectives" ADD CONSTRAINT "okr_objectives_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_objectives" ADD CONSTRAINT "okr_objectives_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_objectives" ADD CONSTRAINT "okr_objectives_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_objectives" ADD CONSTRAINT "okr_objectives_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."okr_objectives"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_field_provenance" ADD CONSTRAINT "order_field_provenance_conversation_id_sales_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."sales_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_field_provenance" ADD CONSTRAINT "order_field_provenance_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_field_provenance" ADD CONSTRAINT "order_field_provenance_source_message_id_sales_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."sales_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_notes" ADD CONSTRAINT "product_notes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_notes" ADD CONSTRAINT "product_notes_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_notes" ADD CONSTRAINT "product_notes_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_inspection_items" ADD CONSTRAINT "return_inspection_items_inspection_id_return_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."return_inspections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_inspection_items" ADD CONSTRAINT "return_inspection_items_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_inspection_items" ADD CONSTRAINT "return_inspection_items_expected_variant_id_product_variants_id_fk" FOREIGN KEY ("expected_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_inspection_items" ADD CONSTRAINT "return_inspection_items_actual_variant_id_product_variants_id_fk" FOREIGN KEY ("actual_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_inspection_items" ADD CONSTRAINT "return_inspection_items_inspected_by_user_id_users_id_fk" FOREIGN KEY ("inspected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_inspections" ADD CONSTRAINT "return_inspections_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_inspections" ADD CONSTRAINT "return_inspections_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_inspections" ADD CONSTRAINT "return_inspections_received_by_user_id_users_id_fk" FOREIGN KEY ("received_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_inspections" ADD CONSTRAINT "return_inspections_inspected_by_user_id_users_id_fk" FOREIGN KEY ("inspected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_inspections" ADD CONSTRAINT "return_inspections_stock_receipt_id_stock_receipts_id_fk" FOREIGN KEY ("stock_receipt_id") REFERENCES "public"."stock_receipts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_cycles" ADD CONSTRAINT "review_cycles_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_cycles" ADD CONSTRAINT "review_cycles_finalized_by_users_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_cycles" ADD CONSTRAINT "review_cycles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_ad_product_map" ADD CONSTRAINT "sales_ad_product_map_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_ad_product_map" ADD CONSTRAINT "sales_ad_product_map_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_ad_product_map" ADD CONSTRAINT "sales_ad_product_map_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD CONSTRAINT "sales_conversations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD CONSTRAINT "sales_conversations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD CONSTRAINT "sales_conversations_takeover_by_user_id_users_id_fk" FOREIGN KEY ("takeover_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD CONSTRAINT "sales_conversations_sales_profile_id_fanpage_sales_profiles_id_fk" FOREIGN KEY ("sales_profile_id") REFERENCES "public"."fanpage_sales_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD CONSTRAINT "sales_conversations_active_product_id_products_id_fk" FOREIGN KEY ("active_product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD CONSTRAINT "sales_conversations_test_product_id_test_product_profiles_id_fk" FOREIGN KEY ("test_product_id") REFERENCES "public"."test_product_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD CONSTRAINT "sales_conversations_source_rule_id_sales_source_rules_id_fk" FOREIGN KEY ("source_rule_id") REFERENCES "public"."sales_source_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_copilot_actions" ADD CONSTRAINT "sales_copilot_actions_conversation_id_sales_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."sales_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_copilot_actions" ADD CONSTRAINT "sales_copilot_actions_suggestion_id_sales_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."sales_suggestions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_copilot_actions" ADD CONSTRAINT "sales_copilot_actions_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_copilot_actions" ADD CONSTRAINT "sales_copilot_actions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_followups" ADD CONSTRAINT "sales_followups_conversation_id_sales_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."sales_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_followups" ADD CONSTRAINT "sales_followups_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_followups" ADD CONSTRAINT "sales_followups_done_by_user_id_users_id_fk" FOREIGN KEY ("done_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_messages" ADD CONSTRAINT "sales_messages_conversation_id_sales_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."sales_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_product_resolutions" ADD CONSTRAINT "sales_product_resolutions_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_product_resolutions" ADD CONSTRAINT "sales_product_resolutions_conversation_id_sales_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."sales_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_product_resolutions" ADD CONSTRAINT "sales_product_resolutions_message_id_sales_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."sales_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_product_resolutions" ADD CONSTRAINT "sales_product_resolutions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_product_resolutions" ADD CONSTRAINT "sales_product_resolutions_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_regression_cases" ADD CONSTRAINT "sales_regression_cases_source_suggestion_id_sales_suggestions_id_fk" FOREIGN KEY ("source_suggestion_id") REFERENCES "public"."sales_suggestions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_regression_cases" ADD CONSTRAINT "sales_regression_cases_source_conversation_id_sales_conversations_id_fk" FOREIGN KEY ("source_conversation_id") REFERENCES "public"."sales_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_regression_cases" ADD CONSTRAINT "sales_regression_cases_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_review_labels" ADD CONSTRAINT "sales_review_labels_suggestion_id_sales_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."sales_suggestions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_review_labels" ADD CONSTRAINT "sales_review_labels_conversation_id_sales_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."sales_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_review_labels" ADD CONSTRAINT "sales_review_labels_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_source_rules" ADD CONSTRAINT "sales_source_rules_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_source_rules" ADD CONSTRAINT "sales_source_rules_test_product_id_test_product_profiles_id_fk" FOREIGN KEY ("test_product_id") REFERENCES "public"."test_product_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_source_rules" ADD CONSTRAINT "sales_source_rules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_suggestions" ADD CONSTRAINT "sales_suggestions_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_suggestions" ADD CONSTRAINT "sales_suggestions_conversation_id_sales_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."sales_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_suggestions" ADD CONSTRAINT "sales_suggestions_trigger_message_id_sales_messages_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "public"."sales_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_suggestions" ADD CONSTRAINT "sales_suggestions_verdict_by_user_id_users_id_fk" FOREIGN KEY ("verdict_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_care" ADD CONSTRAINT "shipment_care_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_care" ADD CONSTRAINT "shipment_care_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_care" ADD CONSTRAINT "shipment_care_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_care" ADD CONSTRAINT "shipment_care_owner_at_resolution_users_id_fk" FOREIGN KEY ("owner_at_resolution") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_care" ADD CONSTRAINT "shipment_care_initial_owner_id_users_id_fk" FOREIGN KEY ("initial_owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_care" ADD CONSTRAINT "shipment_care_replacement_order_id_orders_id_fk" FOREIGN KEY ("replacement_order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_care" ADD CONSTRAINT "shipment_care_replacement_shipment_id_shipments_id_fk" FOREIGN KEY ("replacement_shipment_id") REFERENCES "public"."shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_return_reasons" ADD CONSTRAINT "shipment_return_reasons_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_return_reasons" ADD CONSTRAINT "shipment_return_reasons_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_market_signals" ADD CONSTRAINT "test_market_signals_test_product_id_test_product_profiles_id_fk" FOREIGN KEY ("test_product_id") REFERENCES "public"."test_product_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_market_signals" ADD CONSTRAINT "test_market_signals_conversation_id_sales_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."sales_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_market_signals" ADD CONSTRAINT "test_market_signals_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_product_profiles" ADD CONSTRAINT "test_product_profiles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_product_profiles" ADD CONSTRAINT "test_product_profiles_promoted_product_id_products_id_fk" FOREIGN KEY ("promoted_product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_events" ADD CONSTRAINT "work_item_events_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_events" ADD CONSTRAINT "work_item_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_recurrences" ADD CONSTRAINT "work_recurrences_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_recurrences" ADD CONSTRAINT "work_recurrences_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_recurrences" ADD CONSTRAINT "work_recurrences_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_recurrences" ADD CONSTRAINT "work_recurrences_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_roles_active_idx" ON "access_roles" USING btree ("active","sort_order");--> statement-breakpoint
CREATE INDEX "action_evidence_actor_idx" ON "action_evidence" USING btree ("actor_id","completed_at");--> statement-breakpoint
CREATE INDEX "action_evidence_type_idx" ON "action_evidence" USING btree ("case_type","completed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "action_evidence_notification_idx" ON "action_evidence" USING btree ("notification_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_agent_versions_uq" ON "ai_agent_versions" USING btree ("agent_id","version");--> statement-breakpoint
CREATE INDEX "ai_agents_mode_idx" ON "ai_agents" USING btree ("mode");--> statement-breakpoint
CREATE INDEX "ai_approvals_status_idx" ON "ai_approvals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ai_errors_scope_idx" ON "ai_errors" USING btree ("scope","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_events_dedupe_uq" ON "ai_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "ai_events_status_idx" ON "ai_events" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ai_events_subject_idx" ON "ai_events" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "ai_interactions_user_idx" ON "ai_interactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_interactions_entity_idx" ON "ai_interactions" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_model_calls_run_idx" ON "ai_model_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ai_model_calls_created_idx" ON "ai_model_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_runs_agent_started_idx" ON "ai_runs" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE INDEX "ai_runs_subject_idx" ON "ai_runs" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "ai_runs_status_idx" ON "ai_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_tasks_dedupe_uq" ON "ai_tasks" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "ai_tasks_status_idx" ON "ai_tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ai_tasks_agent_idx" ON "ai_tasks" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_tool_calls_run_idx" ON "ai_tool_calls" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "ai_tool_calls_tool_idx" ON "ai_tool_calls" USING btree ("tool","created_at");--> statement-breakpoint
CREATE INDEX "approval_status_idx" ON "approval_requests" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "approval_group_idx" ON "approval_requests" USING btree ("group","status");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_natural_uq" ON "bank_accounts" USING btree ("provider","gateway","account_number","sub_account");--> statement-breakpoint
CREATE INDEX "bank_accounts_status_idx" ON "bank_accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bank_rules_priority_idx" ON "bank_rules" USING btree ("enabled","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_txn_links_uq" ON "bank_transaction_links" USING btree ("txn_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "bank_txn_links_txn_idx" ON "bank_transaction_links" USING btree ("txn_id");--> statement-breakpoint
CREATE INDEX "bank_txn_links_target_idx" ON "bank_transaction_links" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_txn_ref_idx" ON "bank_transactions" USING btree ("bank_ref");--> statement-breakpoint
CREATE INDEX "bank_txn_at_idx" ON "bank_transactions" USING btree ("txn_at");--> statement-breakpoint
CREATE INDEX "bank_txn_group_idx" ON "bank_transactions" USING btree ("accounting_group","txn_at");--> statement-breakpoint
CREATE INDEX "bank_txn_linked_idx" ON "bank_transactions" USING btree ("linked_type","linked_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_txn_provider_uq" ON "bank_transactions" USING btree ("provider","provider_txn_id") WHERE "bank_transactions"."provider_txn_id" <> '';--> statement-breakpoint
CREATE INDEX "bank_txn_match_idx" ON "bank_transactions" USING btree ("match_key");--> statement-breakpoint
CREATE INDEX "bank_txn_account_idx" ON "bank_transactions" USING btree ("bank_account_id","txn_at");--> statement-breakpoint
CREATE INDEX "bsc_metrics_card_idx" ON "bsc_metrics" USING btree ("scorecard_id","perspective","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "bsc_scorecards_uq" ON "bsc_scorecards" USING btree ("scope","department_id","period");--> statement-breakpoint
CREATE INDEX "canonical_outcome_order_idx" ON "canonical_order_outcome" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "canonical_outcome_value_idx" ON "canonical_order_outcome" USING btree ("outcome");--> statement-breakpoint
CREATE INDEX "canonical_outcome_version_idx" ON "canonical_order_outcome" USING btree ("logic_version");--> statement-breakpoint
CREATE INDEX "care_actions_shipment_idx" ON "care_actions" USING btree ("shipment_id","created_at");--> statement-breakpoint
CREATE INDEX "care_actions_created_idx" ON "care_actions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "care_business_actions_case_idx" ON "care_business_actions" USING btree ("care_case_id","created_at");--> statement-breakpoint
CREATE INDEX "care_business_actions_actor_idx" ON "care_business_actions" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "care_business_actions_shipment_idx" ON "care_business_actions" USING btree ("shipment_id","created_at");--> statement-breakpoint
CREATE INDEX "care_case_events_shipment_idx" ON "care_case_events" USING btree ("shipment_id","created_at");--> statement-breakpoint
CREATE INDEX "care_case_events_actor_idx" ON "care_case_events" USING btree ("actor_email","created_at");--> statement-breakpoint
CREATE INDEX "carrier_action_shipment_idx" ON "carrier_action_requests" USING btree ("shipment_id","created_at");--> statement-breakpoint
CREATE INDEX "carrier_action_status_idx" ON "carrier_action_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_funnel_uq" ON "conversation_funnel" USING btree ("page_id","conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_funnel_first_msg_idx" ON "conversation_funnel" USING btree ("first_customer_message_at");--> statement-breakpoint
CREATE INDEX "conversation_funnel_info_idx" ON "conversation_funnel" USING btree ("info_complete_at");--> statement-breakpoint
CREATE INDEX "conversation_funnel_order_idx" ON "conversation_funnel" USING btree ("matched_order_id");--> statement-breakpoint
CREATE INDEX "conversation_funnel_unanswered_idx" ON "conversation_funnel" USING btree ("first_shop_reply_at","last_customer_message_at");--> statement-breakpoint
CREATE INDEX "cs_case_events_case_idx" ON "cs_case_events" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "cs_case_events_actor_idx" ON "cs_case_events" USING btree ("actor_email","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "department_members_uq" ON "department_members" USING btree ("department_id","user_id");--> statement-breakpoint
CREATE INDEX "department_members_user_idx" ON "department_members" USING btree ("user_id","active");--> statement-breakpoint
CREATE INDEX "departments_active_idx" ON "departments" USING btree ("active","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "fanpage_sales_profiles_page_uq" ON "fanpage_sales_profiles" USING btree ("pancake_page_id");--> statement-breakpoint
CREATE INDEX "hmt_return_rec_shipment_idx" ON "hmt_return_reconciliation" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "hmt_return_rec_status_idx" ON "hmt_return_reconciliation" USING btree ("match_status");--> statement-breakpoint
CREATE INDEX "hmt_return_rec_tracking_idx" ON "hmt_return_reconciliation" USING btree ("tracking_key");--> statement-breakpoint
CREATE INDEX "hmt_return_rec_resolution_idx" ON "hmt_return_reconciliation" USING btree ("resolution","match_status");--> statement-breakpoint
CREATE UNIQUE INDEX "hmt_workbooks_sha_uq" ON "hmt_workbooks" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "hmt_workbooks_created_idx" ON "hmt_workbooks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "marketing_idea_comments_idea_idx" ON "marketing_idea_comments" USING btree ("idea_id","created_at");--> statement-breakpoint
CREATE INDEX "marketing_idea_images_idea_idx" ON "marketing_idea_images" USING btree ("idea_id","sort_order");--> statement-breakpoint
CREATE INDEX "marketing_ideas_date_idx" ON "marketing_ideas" USING btree ("idea_date");--> statement-breakpoint
CREATE INDEX "marketing_ideas_status_idx" ON "marketing_ideas" USING btree ("status");--> statement-breakpoint
CREATE INDEX "marketing_ideas_marketer_idx" ON "marketing_ideas" USING btree ("marketer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_targets_uq" ON "metric_targets" USING btree ("metric_key","scope",coalesce("scope_ref", ''),"period_kind","effective_from");--> statement-breakpoint
CREATE INDEX "metric_targets_lookup_idx" ON "metric_targets" USING btree ("metric_key","effective_from");--> statement-breakpoint
CREATE INDEX "okr_checkins_kr_idx" ON "okr_checkins" USING btree ("key_result_id","created_at");--> statement-breakpoint
CREATE INDEX "okr_key_results_objective_idx" ON "okr_key_results" USING btree ("objective_id","sort_order");--> statement-breakpoint
CREATE INDEX "okr_objectives_period_idx" ON "okr_objectives" USING btree ("period","level");--> statement-breakpoint
CREATE INDEX "okr_objectives_dept_idx" ON "okr_objectives" USING btree ("department_id","period");--> statement-breakpoint
CREATE INDEX "okr_objectives_owner_idx" ON "okr_objectives" USING btree ("owner_user_id","period");--> statement-breakpoint
CREATE INDEX "order_field_provenance_conv_idx" ON "order_field_provenance" USING btree ("conversation_id","field","created_at");--> statement-breakpoint
CREATE INDEX "order_field_provenance_run_idx" ON "order_field_provenance" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "performance_snapshots_uq" ON "performance_snapshots" USING btree ("period","subject_type","subject_id","metric_key");--> statement-breakpoint
CREATE INDEX "performance_snapshots_subject_idx" ON "performance_snapshots" USING btree ("subject_type","subject_id","metric_key","period_start");--> statement-breakpoint
CREATE INDEX "performance_snapshots_period_idx" ON "performance_snapshots" USING btree ("kind","period_start");--> statement-breakpoint
CREATE INDEX "positions_active_idx" ON "positions" USING btree ("active","sort_order");--> statement-breakpoint
CREATE INDEX "product_notes_product_idx" ON "product_notes" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE INDEX "return_inspection_items_inspection_idx" ON "return_inspection_items" USING btree ("inspection_id");--> statement-breakpoint
CREATE INDEX "return_inspection_items_shipment_idx" ON "return_inspection_items" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "return_inspection_items_variant_idx" ON "return_inspection_items" USING btree ("expected_variant_id");--> statement-breakpoint
CREATE INDEX "return_inspections_status_idx" ON "return_inspections" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "return_inspections_order_idx" ON "return_inspections" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_cycles_uq" ON "review_cycles" USING btree ("kind","scope","department_id","period");--> statement-breakpoint
CREATE INDEX "review_cycles_period_idx" ON "review_cycles" USING btree ("period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_ad_product_map_uq" ON "sales_ad_product_map" USING btree ("page_id","ad_key");--> statement-breakpoint
CREATE INDEX "sales_ad_product_map_product_idx" ON "sales_ad_product_map" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_conversations_external_uq" ON "sales_conversations" USING btree ("page_id","external_id");--> statement-breakpoint
CREATE INDEX "sales_conversations_stage_idx" ON "sales_conversations" USING btree ("stage","updated_at");--> statement-breakpoint
CREATE INDEX "sales_conversations_takeover_idx" ON "sales_conversations" USING btree ("human_takeover_at");--> statement-breakpoint
CREATE INDEX "sales_copilot_actions_conv_idx" ON "sales_copilot_actions" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "sales_copilot_actions_actor_idx" ON "sales_copilot_actions" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "sales_copilot_actions_action_idx" ON "sales_copilot_actions" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "sales_followups_due_idx" ON "sales_followups" USING btree ("status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_messages_external_uq" ON "sales_messages" USING btree ("conversation_id","external_id");--> statement-breakpoint
CREATE INDEX "sales_messages_conv_idx" ON "sales_messages" USING btree ("conversation_id","sent_at");--> statement-breakpoint
CREATE INDEX "sales_messages_hash_idx" ON "sales_messages" USING btree ("conversation_id","content_hash");--> statement-breakpoint
CREATE INDEX "sales_messages_ad_idx" ON "sales_messages" USING btree ("ad_id");--> statement-breakpoint
CREATE INDEX "sales_product_resolutions_conv_idx" ON "sales_product_resolutions" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "sales_product_resolutions_source_idx" ON "sales_product_resolutions" USING btree ("source");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_regression_cases_key_uq" ON "sales_regression_cases" USING btree ("case_key");--> statement-breakpoint
CREATE INDEX "sales_regression_cases_active_idx" ON "sales_regression_cases" USING btree ("active","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_review_labels_suggestion_uq" ON "sales_review_labels" USING btree ("suggestion_id");--> statement-breakpoint
CREATE INDEX "sales_review_labels_conv_idx" ON "sales_review_labels" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_source_rules_uq" ON "sales_source_rules" USING btree ("pancake_page_id","source_id");--> statement-breakpoint
CREATE INDEX "sales_suggestions_conv_idx" ON "sales_suggestions" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "sales_suggestions_verdict_idx" ON "sales_suggestions" USING btree ("verdict","created_at");--> statement-breakpoint
CREATE INDEX "shipment_care_status_idx" ON "shipment_care" USING btree ("care_status","follow_up_at");--> statement-breakpoint
CREATE INDEX "shipment_care_owner_idx" ON "shipment_care" USING btree ("owner_id","care_status");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_care_active_uidx" ON "shipment_care" USING btree ("shipment_id") WHERE "shipment_care"."active";--> statement-breakpoint
CREATE INDEX "shipment_care_outcome_idx" ON "shipment_care" USING btree ("care_outcome","outcome_at");--> statement-breakpoint
CREATE INDEX "shipment_care_resolution_owner_idx" ON "shipment_care" USING btree ("owner_at_resolution","outcome_at");--> statement-breakpoint
CREATE INDEX "shipment_return_reasons_reason_idx" ON "shipment_return_reasons" USING btree ("reason");--> statement-breakpoint
CREATE INDEX "shipment_return_reasons_group_idx" ON "shipment_return_reasons" USING btree ("reason_group");--> statement-breakpoint
CREATE UNIQUE INDEX "test_market_signals_conv_uq" ON "test_market_signals" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "test_market_signals_test_idx" ON "test_market_signals" USING btree ("test_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "test_product_profiles_code_uq" ON "test_product_profiles" USING btree ("test_code");--> statement-breakpoint
CREATE INDEX "work_item_events_key_idx" ON "work_item_events" USING btree ("work_key","created_at");--> statement-breakpoint
CREATE INDEX "work_item_events_actor_idx" ON "work_item_events" USING btree ("actor_email","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_items_source_uq" ON "work_items" USING btree ("source_type","source_key");--> statement-breakpoint
CREATE INDEX "work_items_assignee_idx" ON "work_items" USING btree ("assignee_id","status");--> statement-breakpoint
CREATE INDEX "work_items_department_idx" ON "work_items" USING btree ("department_id","status");--> statement-breakpoint
CREATE INDEX "work_items_due_idx" ON "work_items" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "work_items_recurrence_idx" ON "work_items" USING btree ("recurrence_id","occurrence_key");--> statement-breakpoint
CREATE INDEX "work_recurrences_active_idx" ON "work_recurrences" USING btree ("active");--> statement-breakpoint
ALTER TABLE "cs_cases" ADD CONSTRAINT "cs_cases_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cs_cases" ADD CONSTRAINT "cs_cases_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_ignored_by_users_id_fk" FOREIGN KEY ("ignored_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_access_role_id_access_roles_id_fk" FOREIGN KEY ("access_role_id") REFERENCES "public"."access_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_entity_id_idx" ON "audit_logs" USING btree ("entity_id","created_at");--> statement-breakpoint
CREATE INDEX "cs_cases_follow_up_idx" ON "cs_cases" USING btree ("follow_up_at");--> statement-breakpoint
CREATE INDEX "expenses_period_idx" ON "expenses" USING btree ("period_start","period_end");--> statement-breakpoint
CREATE INDEX "fb_ads_post_idx" ON "fb_ads" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "notifications_assigned_idx" ON "notifications" USING btree ("assigned_to","resolved_at");--> statement-breakpoint
CREATE INDEX "notifications_workflow_idx" ON "notifications" USING btree ("resolved_at","ignored_at","started_at");--> statement-breakpoint
CREATE INDEX "orders_ship_province_idx" ON "orders" USING btree ("ship_province") WHERE "orders"."ship_province" <> '';--> statement-breakpoint
CREATE INDEX "shipment_events_delivered_idx" ON "shipment_events" USING btree ("shipment_id") WHERE "shipment_events"."normalized_stage" = 'DELIVERED';--> statement-breakpoint
CREATE INDEX "shipments_created_idx" ON "shipments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "shipments_capability_idx" ON "shipments" USING btree ("tracking_capability","is_final");--> statement-breakpoint
CREATE INDEX "shipments_cod_overdue_idx" ON "shipments" USING btree ("delivered_at") WHERE "shipments"."stage" = 'DELIVERED' and "shipments"."cod_collected" = 0;--> statement-breakpoint
CREATE INDEX "shipments_order_reference_lookup_idx" ON "shipments" USING btree ("order_reference") WHERE "shipments"."order_reference" is not null;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_cost_source_check" CHECK ("expenses"."cost_source" IN ('MANUAL', 'MANUAL_ADJUSTMENT', 'BANK_IMPORT', 'PAYROLL'));--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_adjustment_reason_check" CHECK ("expenses"."cost_source" <> 'MANUAL_ADJUSTMENT' OR length(trim("expenses"."reason")) > 0);--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_allocation_check" CHECK ("expenses"."allocation_method" IN ('EVENT_DATE', 'PERIOD_PRORATA', 'ORDER_ATTRIBUTED', 'ACTUAL_DATED_SPEND'));--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_period_check" CHECK ("expenses"."allocation_method" <> 'PERIOD_PRORATA' OR (
      "expenses"."period_start" IS NOT NULL AND "expenses"."period_end" IS NOT NULL AND "expenses"."period_end" >= "expenses"."period_start"));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_resolution_check" CHECK ("notifications"."resolution" IS NULL OR "notifications"."resolution" IN ('MANUAL', 'AUTO', 'STALE', 'UNKNOWN'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_resolution_shape_check" CHECK (("notifications"."resolved_at" IS NULL) = ("notifications"."resolution" IS NULL));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_resolver_check" CHECK ("notifications"."resolved_by" IS NULL OR "notifications"."resolution" = 'MANUAL');--> statement-breakpoint
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_verified_check" CHECK ("shipment_events"."verification_status" IS DISTINCT FROM 'VERIFIED' OR (
      "shipment_events"."normalized_stage" IS NOT NULL AND "shipment_events"."normalized_stage" <> 'UNKNOWN'
      AND "shipment_events"."leg_type" IS NOT NULL AND "shipment_events"."leg_type" IN ('OUTBOUND', 'RETURN')
      AND "shipment_events"."source" IN ('VTP_WEBHOOK', 'VTP_POLL', 'VTP_IMPORT', 'MANUAL', 'VTP_UI_MANUAL_VERIFICATION')
      AND "shipment_events"."source_reference" IS NOT NULL AND length(trim("shipment_events"."source_reference")) > 0
      AND "shipment_events"."verified_at" IS NOT NULL AND "shipment_events"."verified_by" IS NOT NULL AND length(trim("shipment_events"."verified_by")) > 0));