-- ═══════ HỆ ĐIỀU HÀNH CÔNG VIỆC (Work OS): PHÒNG BAN · LỚP CÔNG VIỆC · OKR · BSC · KỲ REVIEW ═══════
--
-- Đặc tả: `docs/work-management-os.md`.
--
-- CHỈ CỘNG THÊM. Mười một bảng mới, không cột nào bị xoá hay đổi kiểu, không dòng dữ liệu nào đang
-- có bị viết lại. Không bảng nghiệp vụ nào (`orders`, `shipments`, `cs_cases`, `bank_transactions`…)
-- bị đụng tới — đó là điều kiện tiên quyết của cả bản này: **hàng đợi công việc là PHÉP CHIẾU lên
-- việc đã tồn tại, không phải bản sao.**
--
-- Viết tay và idempotent (`IF NOT EXISTS`) như 0033–0068: ảnh chụp `drizzle/meta/*_snapshot.json`
-- đã cũ từ 0032 nên `drizzle-kit generate` sinh ra một bản dựng lại TOÀN BỘ lược đồ, chạy lên
-- production sẽ hỏng ngay câu lệnh đầu tiên.
--
-- ─── VÌ SAO KHÔNG CÓ BẢNG "TASK" CHỨA MỌI VIỆC ───
--
-- Cám dỗ là chép mỗi case CSKH / mỗi kiện care / mỗi dòng tiền chưa phân loại thành một dòng
-- `work_items`. Làm thế là lập tức có HAI nơi giữ trạng thái cho cùng một sự việc, và sẽ tới ngày
-- `cs_cases.status = 'DONE'` đứng cạnh `work_items.status = 'IN_PROGRESS'`. Không job đồng bộ nào
-- cứu được: job nào cũng trễ, và trễ nghĩa là sai.
--
-- Nên `work_items` chỉ có dòng khi (a) đó là việc TAY / ĐỊNH KỲ — không miền nào sở hữu, hoặc
-- (b) có người chạm vào một việc chiếu (giao cho ai, đặt hạn, hoãn, báo chặn). Ràng buộc
-- `work_items_authority_check` làm cho chuyện "dòng chiếu tự giữ trạng thái" thành BẤT KHẢ THI ở
-- mức CSDL, không phải một quy ước người ta nhớ hay quên.


CREATE TABLE IF NOT EXISTS "departments" (
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
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "department_members" (
	"id" text PRIMARY KEY NOT NULL,
	"department_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role_in_dept" text DEFAULT 'MEMBER' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "department_members_role_check" CHECK ("department_members"."role_in_dept" IN ('LEAD', 'MEMBER'))
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "work_items" (
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
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "work_item_events" (
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
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "work_recurrences" (
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
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "okr_objectives" (
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
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "okr_key_results" (
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
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "okr_checkins" (
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
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "bsc_scorecards" (
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
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "bsc_metrics" (
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
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "review_cycles" (
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
);--> statement-breakpoint


-- ─── KHOÁ NGOẠI ───
-- Bọc trong DO $$ ... EXCEPTION WHEN duplicate_object $$ để chạy lại migration không đỏ (0034–0068).

DO $$ BEGIN
  ALTER TABLE "bsc_metrics" ADD CONSTRAINT "bsc_metrics_scorecard_id_bsc_scorecards_id_fk"
    FOREIGN KEY ("scorecard_id") REFERENCES "public"."bsc_scorecards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "bsc_scorecards" ADD CONSTRAINT "bsc_scorecards_department_id_departments_id_fk"
    FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "bsc_scorecards" ADD CONSTRAINT "bsc_scorecards_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "department_members" ADD CONSTRAINT "department_members_department_id_departments_id_fk"
    FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "department_members" ADD CONSTRAINT "department_members_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "departments" ADD CONSTRAINT "departments_lead_user_id_users_id_fk"
    FOREIGN KEY ("lead_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "okr_checkins" ADD CONSTRAINT "okr_checkins_key_result_id_okr_key_results_id_fk"
    FOREIGN KEY ("key_result_id") REFERENCES "public"."okr_key_results"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "okr_checkins" ADD CONSTRAINT "okr_checkins_actor_id_users_id_fk"
    FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "okr_key_results" ADD CONSTRAINT "okr_key_results_objective_id_okr_objectives_id_fk"
    FOREIGN KEY ("objective_id") REFERENCES "public"."okr_objectives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "okr_key_results" ADD CONSTRAINT "okr_key_results_owner_user_id_users_id_fk"
    FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "okr_objectives" ADD CONSTRAINT "okr_objectives_department_id_departments_id_fk"
    FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "okr_objectives" ADD CONSTRAINT "okr_objectives_owner_user_id_users_id_fk"
    FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "okr_objectives" ADD CONSTRAINT "okr_objectives_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "okr_objectives" ADD CONSTRAINT "okr_objectives_parent_fk"
    FOREIGN KEY ("parent_id") REFERENCES "public"."okr_objectives"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "review_cycles" ADD CONSTRAINT "review_cycles_department_id_departments_id_fk"
    FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "review_cycles" ADD CONSTRAINT "review_cycles_finalized_by_users_id_fk"
    FOREIGN KEY ("finalized_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "review_cycles" ADD CONSTRAINT "review_cycles_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "work_item_events" ADD CONSTRAINT "work_item_events_work_item_id_work_items_id_fk"
    FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "work_item_events" ADD CONSTRAINT "work_item_events_actor_id_users_id_fk"
    FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "work_items" ADD CONSTRAINT "work_items_department_id_departments_id_fk"
    FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "work_items" ADD CONSTRAINT "work_items_assignee_id_users_id_fk"
    FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "work_items" ADD CONSTRAINT "work_items_assigned_by_users_id_fk"
    FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "work_items" ADD CONSTRAINT "work_items_owner_id_users_id_fk"
    FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "work_items" ADD CONSTRAINT "work_items_completed_by_users_id_fk"
    FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "work_items" ADD CONSTRAINT "work_items_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "work_recurrences" ADD CONSTRAINT "work_recurrences_department_id_departments_id_fk"
    FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "work_recurrences" ADD CONSTRAINT "work_recurrences_assignee_id_users_id_fk"
    FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "work_recurrences" ADD CONSTRAINT "work_recurrences_owner_id_users_id_fk"
    FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "work_recurrences" ADD CONSTRAINT "work_recurrences_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint


-- ─── CHỈ MỤC ───

CREATE INDEX IF NOT EXISTS "bsc_metrics_card_idx" ON "bsc_metrics" USING btree ("scorecard_id","perspective","sort_order");--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "bsc_scorecards_uq" ON "bsc_scorecards" USING btree ("scope","department_id","period");--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "department_members_uq" ON "department_members" USING btree ("department_id","user_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "department_members_user_idx" ON "department_members" USING btree ("user_id","active");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "departments_active_idx" ON "departments" USING btree ("active","sort_order");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "okr_checkins_kr_idx" ON "okr_checkins" USING btree ("key_result_id","created_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "okr_key_results_objective_idx" ON "okr_key_results" USING btree ("objective_id","sort_order");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "okr_objectives_period_idx" ON "okr_objectives" USING btree ("period","level");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "okr_objectives_dept_idx" ON "okr_objectives" USING btree ("department_id","period");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "okr_objectives_owner_idx" ON "okr_objectives" USING btree ("owner_user_id","period");--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "review_cycles_uq" ON "review_cycles" USING btree ("kind","scope","department_id","period");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "review_cycles_period_idx" ON "review_cycles" USING btree ("period_start");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "work_item_events_key_idx" ON "work_item_events" USING btree ("work_key","created_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "work_item_events_actor_idx" ON "work_item_events" USING btree ("actor_email","created_at");--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "work_items_source_uq" ON "work_items" USING btree ("source_type","source_key");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "work_items_assignee_idx" ON "work_items" USING btree ("assignee_id","status");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "work_items_department_idx" ON "work_items" USING btree ("department_id","status");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "work_items_due_idx" ON "work_items" USING btree ("due_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "work_items_recurrence_idx" ON "work_items" USING btree ("recurrence_id","occurrence_key");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "work_recurrences_active_idx" ON "work_recurrences" USING btree ("active");--> statement-breakpoint


-- ─── BẢY PHÒNG BAN MẶC ĐỊNH ───
--
-- Gieo ở migration chứ không ở mã ứng dụng, vì phòng ban là thứ MỌI truy vấn công việc cần có để
-- trả lời "việc này của ai". Để trống rồi chờ người vào cấu hình thì hàng đợi mở lên lần đầu sẽ
-- rỗng, và người dùng kết luận tính năng hỏng.
--
-- `ON CONFLICT DO NOTHING` theo `code`: chạy lại migration, hoặc chủ shop đã tự đổi tên phòng, đều
-- không bị ghi đè. Mã phòng là khoá tự nhiên; tên hiển thị sửa thoải mái trên giao diện.
INSERT INTO "departments" ("id", "code", "name", "description", "sort_order", "active") VALUES
  (gen_random_uuid()::text, 'SALES',      'Kinh doanh & CSKH', 'Chốt đơn từ tin nhắn, chăm khách, xử lý case CSKH, bán chéo',                10, true),
  (gen_random_uuid()::text, 'LOGISTICS',  'Giao vận',          'Vận đơn, care kiện hàng, làm việc với Viettel Post',                          20, true),
  (gen_random_uuid()::text, 'WAREHOUSE',  'Kho',               'Đóng gói, xuất hàng, kiểm đếm hàng hoàn, tồn kho, đặt sản xuất',              30, true),
  (gen_random_uuid()::text, 'MARKETING',  'Marketing',         'Quảng cáo, nội dung, ý tưởng, hiệu quả chi tiêu',                             40, true),
  (gen_random_uuid()::text, 'FINANCE',    'Kế toán',           'Dòng tiền, đối soát COD, chi phí, lương, sổ ngân hàng',                       50, true),
  (gen_random_uuid()::text, 'MANAGEMENT', 'Ban điều hành',     'Nhìn chéo phòng ban, chốt mục tiêu, gỡ nút thắt, chất lượng dữ liệu',         60, true),
  (gen_random_uuid()::text, 'HR',         'Nhân sự',           'Tuyển dụng, đào tạo, chấm công, đánh giá',                                    70, true)
ON CONFLICT ("code") DO NOTHING;
