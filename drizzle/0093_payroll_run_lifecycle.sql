-- ═══════════ VÒNG ĐỜI KỲ LƯƠNG: SÁU TRẠNG THÁI THAY CHO HAI ═══════════
--
-- VÌ SAO. `payroll_periods.status` chỉ có `DRAFT` và `FINAL`. Hai giá trị ấy đủ để giữ lời hứa
-- quan trọng nhất — kỳ đã chốt là bất biến — nhưng chúng GỘP MẤT bốn câu hỏi mà chủ shop thật sự
-- hỏi khi trả lương:
--
--   · số đã tính xong chưa?           → CALCULATED
--   · ai đang soát?                   → UNDER_REVIEW
--   · AI ĐÃ DUYỆT con số này?         → APPROVED
--   · tiền đã ra khỏi tài khoản chưa? → PAID
--
-- Câu thứ ba là câu quan trọng nhất: DUYỆT là một chữ ký, không phải một lượt bấm. Nó phải có tên
-- người, có mốc, có dấu vết riêng — không lẫn vào lượt chụp ảnh (`finalized_by`), vì người KHAI số
-- và người DUYỆT số không nên là một.
--
-- ─── `FINAL` KHÔNG BỊ VIẾT LẠI, VÀ ĐÓ LÀ ĐIỂM QUAN TRỌNG NHẤT CỦA MIGRATION NÀY ───
--
-- Production đang có những dòng `status = 'FINAL'` — đó là các kỳ ĐÃ TRẢ TIỀN. Viết đè cột trạng
-- thái của chúng thành 'LOCKED' "cho sạch bảng" là sửa dữ liệu của một kỳ bất biến, đúng thứ
-- AGENTS.md mục 21 cấm. Nên `FINAL` ở lại trong ràng buộc CHECK và được ĐỌC như `LOCKED`
-- (`normalizePayrollStatus` trong `lib/constants/payroll-lifecycle.ts`). Không mất gì, không đụng
-- một dòng nào, KHÔNG backfill.
--
-- CHỈ CỘNG THÊM: bảy cột có mặc định, và nới một ràng buộc CHECK. Không đổi kiểu, không xoá cột.
-- Viết tay và idempotent như 0033–0092.

ALTER TABLE "payroll_periods" ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD COLUMN IF NOT EXISTS "approved_by" text;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD COLUMN IF NOT EXISTS "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD COLUMN IF NOT EXISTS "locked_by" text;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD COLUMN IF NOT EXISTS "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD COLUMN IF NOT EXISTS "paid_by" text;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD COLUMN IF NOT EXISTS "status_reason" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD COLUMN IF NOT EXISTS "calc_runs" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_approved_by_users_id_fk"
		FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_locked_by_users_id_fk"
		FOREIGN KEY ("locked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_paid_by_users_id_fk"
		FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Nới danh sách trạng thái. `FINAL` GIỮ LẠI — xem khối đầu file.
ALTER TABLE "payroll_periods" DROP CONSTRAINT IF EXISTS "payroll_periods_status_check";--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_status_check"
	CHECK ("payroll_periods"."status" IN ('DRAFT', 'CALCULATED', 'UNDER_REVIEW', 'APPROVED', 'LOCKED', 'PAID', 'FINAL'));--> statement-breakpoint

-- Đã duyệt / khoá / trả thì phải biết AI và LÚC NÀO. Một chữ ký không có tên là một chữ ký trống,
-- và sáu tháng sau không ai trả lời được "ai đồng ý con số này".
--
-- Dòng `FINAL` CŨ không có `locked_at`, nên ba ràng buộc dưới đây cố ý KHÔNG nhắc tới `FINAL`:
-- bắt chúng phải có mốc là bắt migration đi bịa một mốc thời gian không có thật (AGENTS.md mục 35).
ALTER TABLE "payroll_periods" DROP CONSTRAINT IF EXISTS "payroll_periods_approved_check";--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_approved_check"
	CHECK ("payroll_periods"."status" NOT IN ('APPROVED', 'LOCKED', 'PAID') OR "payroll_periods"."approved_at" IS NOT NULL);--> statement-breakpoint

ALTER TABLE "payroll_periods" DROP CONSTRAINT IF EXISTS "payroll_periods_locked_check";--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_locked_check"
	CHECK ("payroll_periods"."status" NOT IN ('LOCKED', 'PAID') OR "payroll_periods"."locked_at" IS NOT NULL);--> statement-breakpoint

ALTER TABLE "payroll_periods" DROP CONSTRAINT IF EXISTS "payroll_periods_paid_check";--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_paid_check"
	CHECK ("payroll_periods"."status" <> 'PAID' OR "payroll_periods"."paid_at" IS NOT NULL);
