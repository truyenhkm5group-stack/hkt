-- ═══════════ CHÍNH SÁCH LƯƠNG CHUNG CHO TOÀN CÔNG TY ═══════════
--
-- VÌ SAO CẦN PHẦN NÀY. Bảng lương hôm nay khai cơ chế trả tiền bằng ĐÚNG BỐN Ô trên hồ sơ nhân sự
-- ở `settings` (`payroll.employees`): lương cứng, % LN tổng, % LN cá nhân, % doanh thu. Bốn ô ấy
-- sinh ra cho MKTer và chỉ vừa với MKTer. Một bạn kho ăn theo ngày công, một thợ may ăn theo sản
-- phẩm, một bạn CSKH ăn lương cứng + KPI — không ai khai được bằng bốn ô đó. Cách duy nhất để đỡ
-- họ trong kiến trúc cũ là thêm `if` vào lõi phép tính, và mỗi chức danh mới là một lần sửa lõi,
-- tức một lần có thể làm sai tiền của người khác.
--
-- Nên cơ chế trả tiền chuyển từ BỐN Ô CỨNG sang DỮ LIỆU: chính sách → phiên bản → thành phần.
-- Thêm chức danh mới = khai một chính sách trên màn hình, không sửa một dòng mã nào.
--
-- ─── CHỈ THÊM. KHÔNG ĐỤNG MỘT DÒNG DỮ LIỆU NÀO ĐANG CÓ ───
--
-- Bảy bảng mới, và một cột mới có MẶC ĐỊNH trên `marketer_profit_carryover`. Không đổi kiểu, không
-- xoá cột, không đổi tên, KHÔNG backfill, KHÔNG đặt chính sách mặc định cho ai (AGENTS.md mục 35).
-- `settings: payroll.employees` giữ nguyên và vẫn là đường tính lương cho mọi người CHƯA gán chính
-- sách — nên ngay sau khi áp migration này, mọi con số của mọi kỳ vẫn y hệt hôm qua. Chuyển một
-- người sang máy mới là một lần chủ shop bấm, không phải một lượt migration im lặng.
--
-- Viết tay và idempotent như 0033–0090.

-- ─────────── 1. CHÍNH SÁCH LƯƠNG ───────────
CREATE TABLE IF NOT EXISTS "salary_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"department_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "salary_policies_code_unique" UNIQUE("code")
);--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "salary_policies" ADD CONSTRAINT "salary_policies_department_id_departments_id_fk"
		FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "salary_policies" ADD CONSTRAINT "salary_policies_created_by_users_id_fk"
		FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "salary_policies_active_idx" ON "salary_policies" USING btree ("active","sort_order");--> statement-breakpoint

-- ─────────── 2. PHIÊN BẢN — THỨ LÀM "ĐỔI TỶ LỆ THÁNG NÀY" THÔI VIẾT LẠI THÁNG TRƯỚC ───────────
--
-- Sửa tỷ lệ từ 01/09 KHÔNG được sửa dòng đang có; nó phải tạo một phiên bản MỚI và đóng bản cũ ở
-- 31/08. Kỳ tháng 8 mở lại sau đó vẫn đọc bản cũ và vẫn ra đúng con số đã trả (AGENTS.md mục 21).
--
-- `DRAFT` tuyệt đối không dùng để tính tiền; `RETIRED` vẫn phủ các kỳ trong khoảng hiệu lực cũ.
CREATE TABLE IF NOT EXISTS "salary_policy_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_id" text NOT NULL,
	"version" integer NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"activated_at" timestamp with time zone,
	"activated_by" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "salary_policy_versions_status_check" CHECK ("salary_policy_versions"."status" IN ('DRAFT', 'ACTIVE', 'RETIRED')),
	CONSTRAINT "salary_policy_versions_range_check" CHECK ("salary_policy_versions"."effective_to" IS NULL OR "salary_policy_versions"."effective_to" >= "salary_policy_versions"."effective_from")
);--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "salary_policy_versions" ADD CONSTRAINT "salary_policy_versions_policy_id_salary_policies_id_fk"
		FOREIGN KEY ("policy_id") REFERENCES "public"."salary_policies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "salary_policy_versions" ADD CONSTRAINT "salary_policy_versions_activated_by_users_id_fk"
		FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "salary_policy_versions" ADD CONSTRAINT "salary_policy_versions_created_by_users_id_fk"
		FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "salary_policy_versions_uq" ON "salary_policy_versions" USING btree ("policy_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "salary_policy_versions_eff_idx" ON "salary_policy_versions" USING btree ("policy_id","effective_from");--> statement-breakpoint

-- ─────────── 3. THÀNH PHẦN LƯƠNG — MỘT DÒNG Ở ĐÂY LÀ MỘT DÒNG TRÊN PHIẾU LƯƠNG ───────────
--
-- `calc` giữ tham số phép tính dạng JSON nhưng KHÔNG phải một ô tự do: hình dạng của nó là một tập
-- ĐÓNG (`PayrollCalcParams`), kiểm bằng zod ở server action. Cố ý không có `EXPRESSION` — một ô gõ
-- công thức rồi `eval` là cách nhanh nhất để một dòng chữ trong CSDL chạy mã tuỳ ý trên máy chủ.
--
-- Ràng buộc `carry_check` khoá ở mức CSDL điều mà `lib/constants/payroll-components.ts` khai: bù lỗ
-- chỉ có nghĩa trên đại lượng CÓ THỂ ÂM, tức lợi nhuận. Doanh thu, số đơn, giờ công, sản phẩm không
-- bao giờ âm — bật bù lỗ ở đó chỉ tạo ra một dòng sổ không bao giờ khác 0.
CREATE TABLE IF NOT EXISTS "salary_policy_components" (
	"id" text PRIMARY KEY NOT NULL,
	"version_id" text NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"calc_type" text NOT NULL,
	"basis_key" text,
	"calc" jsonb NOT NULL,
	"prorate" text DEFAULT 'NONE' NOT NULL,
	"rounding" text DEFAULT 'ROUND' NOT NULL,
	"min_amount" integer,
	"max_amount" integer,
	"carry_forward" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "salary_policy_components_carry_check" CHECK ("salary_policy_components"."carry_forward" = false OR "salary_policy_components"."basis_key" IN ('PROFIT_PERSONAL', 'PROFIT_SHOP')),
	CONSTRAINT "salary_policy_components_bound_check" CHECK ("salary_policy_components"."min_amount" IS NULL OR "salary_policy_components"."max_amount" IS NULL OR "salary_policy_components"."max_amount" >= "salary_policy_components"."min_amount")
);--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "salary_policy_components" ADD CONSTRAINT "salary_policy_components_version_id_salary_policy_versions_id_fk"
		FOREIGN KEY ("version_id") REFERENCES "public"."salary_policy_versions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- MỘT khoá thành phần trong MỘT phiên bản: hai dòng cùng `code` là hai khoản cùng tên trên một
-- phiếu lương, và phần gộp theo `code` ở máy tính sẽ cộng chúng thành một dòng không ai đối chiếu
-- lại được.
CREATE UNIQUE INDEX IF NOT EXISTS "salary_policy_components_uq" ON "salary_policy_components" USING btree ("version_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "salary_policy_components_version_idx" ON "salary_policy_components" USING btree ("version_id","sort_order");--> statement-breakpoint

-- ─────────── 4. PHÂN CÔNG LAO ĐỘNG — CÓ MỐC HIỆU LỰC ───────────
--
-- HÌNH THỨC LÀM VIỆC (`employment_type`) và NƠI LÀM VIỆC (`work_mode`) nằm ở đây, và chúng KHÔNG
-- phải công thức lương. Một người làm từ xa vẫn có thể ăn lương cứng, ăn theo giờ, ăn hoa hồng hay
-- ăn khoán — máy tính lương tuyệt đối không được đọc hai cột này để đoán ra công thức.
--
-- `employee_id` là khoá nhân sự trong sổ lương (`settings: payroll.employees`), cùng khoá mà
-- `marketer_profit_carryover` dùng. `user_id` nối về tài khoản khi có, để quy kết đi bằng KHOÁ chứ
-- không bằng ô chữ (AGENTS.md mục 34); `NULL` = CHƯA NỐI ĐƯỢC, không phải "không có ai".
CREATE TABLE IF NOT EXISTS "employment_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"user_id" text,
	"department_id" text,
	"position_id" text,
	"manager_user_id" text,
	"employment_type" text DEFAULT 'FULL_TIME' NOT NULL,
	"work_mode" text DEFAULT 'ONSITE' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"standard_work_days" integer,
	"cost_center" text DEFAULT '' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_assignments_type_check" CHECK ("employment_assignments"."employment_type" IN ('FULL_TIME', 'PART_TIME', 'CONTRACTOR')),
	CONSTRAINT "employment_assignments_mode_check" CHECK ("employment_assignments"."work_mode" IN ('ONSITE', 'REMOTE', 'HYBRID')),
	CONSTRAINT "employment_assignments_status_check" CHECK ("employment_assignments"."status" IN ('ACTIVE', 'ON_LEAVE', 'TERMINATED')),
	CONSTRAINT "employment_assignments_range_check" CHECK ("employment_assignments"."effective_to" IS NULL OR "employment_assignments"."effective_to" >= "employment_assignments"."effective_from")
);--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "employment_assignments" ADD CONSTRAINT "employment_assignments_user_id_users_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "employment_assignments" ADD CONSTRAINT "employment_assignments_department_id_departments_id_fk"
		FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "employment_assignments" ADD CONSTRAINT "employment_assignments_position_id_positions_id_fk"
		FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "employment_assignments" ADD CONSTRAINT "employment_assignments_manager_user_id_users_id_fk"
		FOREIGN KEY ("manager_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "employment_assignments" ADD CONSTRAINT "employment_assignments_created_by_users_id_fk"
		FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "employment_assignments_emp_idx" ON "employment_assignments" USING btree ("employee_id","effective_from");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "employment_assignments_dept_idx" ON "employment_assignments" USING btree ("department_id","effective_from");--> statement-breakpoint

-- ─────────── 5. GÁN CHÍNH SÁCH CHO NGƯỜI — ĐỔI LÀ THÊM DÒNG, KHÔNG SỬA DÒNG CŨ ───────────
CREATE TABLE IF NOT EXISTS "employee_policy_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_policy_assignments_range_check" CHECK ("employee_policy_assignments"."effective_to" IS NULL OR "employee_policy_assignments"."effective_to" >= "employee_policy_assignments"."effective_from")
);--> statement-breakpoint

-- `RESTRICT` cố ý: xoá một chính sách đang gán cho người là làm mồ côi mọi kỳ lương đã tính bằng
-- nó. Muốn ngừng dùng thì TẮT (`active = false`), không xoá.
DO $$ BEGIN
	ALTER TABLE "employee_policy_assignments" ADD CONSTRAINT "employee_policy_assignments_policy_id_salary_policies_id_fk"
		FOREIGN KEY ("policy_id") REFERENCES "public"."salary_policies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "employee_policy_assignments" ADD CONSTRAINT "employee_policy_assignments_created_by_users_id_fk"
		FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "employee_policy_assignments_emp_idx" ON "employee_policy_assignments" USING btree ("employee_id","effective_from");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "employee_policy_assignments_policy_idx" ON "employee_policy_assignments" USING btree ("policy_id");--> statement-breakpoint

-- ─────────── 6. ĐẦU VÀO NHẬP TAY: CHẤM CÔNG · KPI · SẢN LƯỢNG ───────────
--
-- ERP KHÔNG có bảng chấm công, không có bảng nghiệm thu sản lượng theo NGƯỜI, và chấm KPI là một
-- quyết định của người quản lý chứ không phải một truy vấn. Ba thứ ấy vào đây, mỗi dòng mang tên
-- người nhập và mốc thời gian.
--
-- Đây là chỗ thay cho cám dỗ "viết một truy vấn gần đúng rồi gọi nó là số đo": một ô trống nhìn
-- thấy được, có tên người phải điền, tốt hơn một con số không ai kiểm lại được (AGENTS.md mục 45).
--
-- Khoá tự nhiên (nhân sự, kỳ, đại lượng): nhập lại là SỬA, không phải thêm dòng thứ hai — nếu
-- không, mỗi lượt tính lại sẽ cộng dồn.
CREATE TABLE IF NOT EXISTS "payroll_inputs" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"period_key" text NOT NULL,
	"input_key" text NOT NULL,
	"value" double precision NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"entered_by" text,
	"entered_by_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "payroll_inputs" ADD CONSTRAINT "payroll_inputs_entered_by_users_id_fk"
		FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "payroll_inputs_uq" ON "payroll_inputs" USING btree ("employee_id","period_key","input_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_inputs_period_idx" ON "payroll_inputs" USING btree ("period_key");--> statement-breakpoint

-- ─────────── 7. ĐIỀU CHỈNH TAY: THƯỞNG NÓNG · TẠM ỨNG · KHẤU TRỪ ───────────
--
-- Số tiền luôn lưu DƯƠNG; dấu do `kind` quyết định — để người nhập không phải nhớ gõ dấu trừ, và
-- để một dấu trừ gõ nhầm không biến một khoản khấu trừ thành một khoản thưởng.
--
-- `reason` KHÔNG có mặc định rỗng: một khoản tiền không có lý do là một khoản không ai duyệt lại
-- được. Chứng từ về SAU khi kỳ đã chốt thì ghi vào kỳ SAU — kỳ đã chốt là bất biến, và đường duy
-- nhất để sửa nó là một dòng điều chỉnh ở kỳ kế tiếp, có dấu vết.
CREATE TABLE IF NOT EXISTS "payroll_adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"period_key" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"amount" integer NOT NULL,
	"reason" text NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_by_name" text DEFAULT '' NOT NULL,
	"approved_by" text,
	"approved_by_name" text DEFAULT '' NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_adjustments_amount_check" CHECK ("payroll_adjustments"."amount" >= 0),
	CONSTRAINT "payroll_adjustments_kind_check" CHECK ("payroll_adjustments"."kind" IN ('BONUS', 'ALLOWANCE', 'ADJUSTMENT', 'ADVANCE', 'DEDUCTION', 'REIMBURSEMENT'))
);--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_created_by_users_id_fk"
		FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_approved_by_users_id_fk"
		FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "payroll_adjustments_period_idx" ON "payroll_adjustments" USING btree ("period_key","employee_id");--> statement-breakpoint

-- ─────────── 8. TỔNG QUÁT HOÁ SỔ LỖ LŨY KẾ THEO KHOÁ THÀNH PHẦN ───────────
--
-- Trước bản này sổ chỉ phục vụ ĐÚNG MỘT khoản: hoa hồng theo lợi nhuận cá nhân của MKTer — nên
-- (nhân sự, tháng) là đủ. Nay một người có thể mang hai thành phần cùng bật bù lỗ, và hai nghĩa vụ
-- ấy là hai chuỗi số dư RIÊNG; gộp vào một dòng là bù lỗ của khoản này bằng lãi của khoản kia.
--
-- CỘT CÓ MẶC ĐỊNH nên mọi dòng ĐÃ CÓ giữ nguyên ý nghĩa và mọi chuỗi số dư đang chạy không đứt.
-- Không backfill gì khác, không đoán gì.
ALTER TABLE "marketer_profit_carryover" ADD COLUMN IF NOT EXISTS "component_code" text DEFAULT 'MARKETING_PROFIT' NOT NULL;--> statement-breakpoint

-- Khoá duy nhất nới từ (nhân sự, tháng) thành (nhân sự, tháng, thành phần). Đây KHÔNG phải nới
-- lỏng: mọi dòng đang có mang cùng một `component_code`, nên tập dòng hợp lệ hôm nay y hệt hôm qua.
DROP INDEX IF EXISTS "marketer_carryover_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "marketer_carryover_uq" ON "marketer_profit_carryover" USING btree ("employee_id","month_key","component_code");
