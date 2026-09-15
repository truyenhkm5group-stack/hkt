-- ═══════════ ĐẦU VÀO NHẬP TAY: ĐƠN VỊ, TRẠNG THÁI, NGƯỜI DUYỆT ═══════════
--
-- VÌ SAO. `payroll_inputs` đang giữ giá trị và người NHẬP, nhưng không giữ ba thứ mà một con số
-- nhập tay cần để dùng được cho việc trả tiền:
--
--  · ĐƠN VỊ — sổ đăng ký (`PAYROLL_INPUTS`) đã khai đơn vị của từng đại lượng, nhưng đó là đơn vị
--    HÔM NAY. Ngày nào sổ đổi đơn vị của một đại lượng (giờ → ca chẳng hạn), những dòng đã nhập
--    lặng lẽ đổi nghĩa. Cột này là ẢNH CHỤP tại lúc nhập, không phải một nguồn thứ hai.
--  · TRẠNG THÁI — "đã gõ vào" khác "đã có người soát". Gộp hai thứ ấy là coi một con số vừa gõ là
--    đã được duyệt.
--  · NGƯỜI DUYỆT — với chính sách đòi duyệt, thiếu cột này thì không trả lời được "ai đồng ý con
--    số ngày công này". Và một chữ ký không có tên là một chữ ký trống.
--
-- CHỈ CỘNG THÊM: năm cột có mặc định + hai ràng buộc CHECK. Dòng đã có giữ nguyên `ENTERED` và
-- đơn vị rỗng — KHÔNG backfill đơn vị, vì đoán đơn vị của một con số đã nhập là đoán ý người nhập.
-- Viết tay và idempotent như 0033–0096.

ALTER TABLE "payroll_inputs" ADD COLUMN IF NOT EXISTS "unit" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_inputs" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'ENTERED' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_inputs" ADD COLUMN IF NOT EXISTS "approved_by" text;--> statement-breakpoint
ALTER TABLE "payroll_inputs" ADD COLUMN IF NOT EXISTS "approved_by_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_inputs" ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "payroll_inputs" ADD CONSTRAINT "payroll_inputs_approved_by_users_id_fk"
		FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

ALTER TABLE "payroll_inputs" DROP CONSTRAINT IF EXISTS "payroll_inputs_status_check";--> statement-breakpoint
ALTER TABLE "payroll_inputs" ADD CONSTRAINT "payroll_inputs_status_check"
	CHECK ("payroll_inputs"."status" IN ('ENTERED', 'APPROVED'));--> statement-breakpoint

-- Đã duyệt thì phải biết AI và LÚC NÀO — cùng luật với kỳ lương.
ALTER TABLE "payroll_inputs" DROP CONSTRAINT IF EXISTS "payroll_inputs_approved_check";--> statement-breakpoint
ALTER TABLE "payroll_inputs" ADD CONSTRAINT "payroll_inputs_approved_check"
	CHECK ("payroll_inputs"."status" <> 'APPROVED' OR "payroll_inputs"."approved_at" IS NOT NULL);
