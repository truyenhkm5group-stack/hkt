-- KỲ LƯƠNG: NHÁP THÌ TÍNH SỐNG, ĐÃ CHỐT THÌ BẤT BIẾN.
--
-- VÌ SAO CẦN BẢNG NÀY. Trước bản này bảng lương KHÔNG có danh tính kỳ: mở `/payroll` là tính lại
-- từ đầu, mỗi lần. Nên mọi thứ nằm sau con số đều trôi — đổi một tỷ lệ thưởng, đổi người phụ trách
-- một fanpage, nhập thêm một phiếu kho, và bảng lương của THÁNG TRƯỚC đổi theo, SAU KHI tiền đã
-- trả. Không chỗ nào ghi lại shop đã trả bao nhiêu, theo cơ sở nào, với tỷ lệ nào.
--
-- Cùng hình dạng, cùng lý do và cùng bộ ràng buộc với `review_cycles` (AGENTS.md mục 21):
-- `DRAFT` tính sống mỗi lần mở · `FINAL` đọc `snapshot`, KHÔNG truy vấn lại.
--
-- CHỈ THÊM BẢNG. Không đụng một bảng nào đang có, không backfill, không đặt mặc định cho dữ liệu
-- cũ: chưa có kỳ nào được chốt thì bảng này rỗng và mọi màn hình chạy y như trước.
CREATE TABLE IF NOT EXISTS "payroll_periods" (
  "id" text PRIMARY KEY NOT NULL,
  -- Khoá tự nhiên đọc được bằng mắt: `2026-09-01..2026-09-30`.
  "period_key" text NOT NULL,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  -- CSDL chỉ chặn giá trị lạ. Luật "cơ sở nào ĐƯỢC PHÉP chốt lương" nằm ở
  -- lib/constants/payroll.ts::PAYROLL_BASIS_ELIGIBILITY — khai ở hai nơi là mở đường cho hai nơi
  -- nói hai điều khác nhau.
  "basis" text NOT NULL,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  -- Ảnh chụp đủ để DỰNG LẠI CÂU TRẢ LỜI, không chỉ đủ để in một con số: cơ sở đã dùng, tỷ lệ của
  -- từng người TẠI LÚC CHỐT, lương cứng khai và phần thuộc kỳ, độ phủ nguồn quy kết, nguyên văn
  -- cảnh báo của máy chi phí.
  "snapshot" jsonb,
  -- Tách khỏi nội dung: đổi CÔNG THỨC thì ảnh cũ vẫn đọc được và biết nó dựng bằng công thức nào.
  "calc_version" integer DEFAULT 1 NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "finalized_at" timestamp with time zone,
  "finalized_by" text,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payroll_periods_status_check" CHECK ("status" IN ('DRAFT', 'FINAL')),
  CONSTRAINT "payroll_periods_basis_check" CHECK ("basis" IN ('profit1', 'profit2', 'cash', 'nominal')),
  CONSTRAINT "payroll_periods_range_check" CHECK ("period_end" >= "period_start"),
  -- Chốt mà không có ảnh chụp thì "chốt" không có nghĩa gì: lần mở sau vẫn tính lại.
  CONSTRAINT "payroll_periods_final_check" CHECK ("status" = 'DRAFT' OR ("snapshot" IS NOT NULL AND "finalized_at" IS NOT NULL))
);
--> statement-breakpoint
-- MỘT kỳ + MỘT cơ sở = MỘT dòng. Hai bản chốt cùng kỳ bằng hai cơ sở là hai câu trả lời khác nhau
-- cho cùng một câu hỏi, và không ai biết cái nào đã dùng để trả tiền.
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_periods_uq" ON "payroll_periods" ("period_key","basis");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_periods_start_idx" ON "payroll_periods" ("period_start");--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_finalized_by_users_id_fk"
    FOREIGN KEY ("finalized_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
