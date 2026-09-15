-- SỔ LỖ LŨY KẾ THEO TỪNG MKTer.
--
-- VÌ SAO CẦN BẢNG NÀY. Bảng lương đang tính hoa hồng cá nhân bằng `max(LN cá nhân, 0) × %`. Cái
-- `max(…, 0)` ấy đúng ở chỗ không trả tiền âm cho người ta, nhưng nó cũng VỨT MẤT con số âm:
-- tháng lỗ 10 triệu và tháng hoà vốn cho ra cùng một kết quả là 0. Nên tháng sau lãi 15 triệu thì
-- người ấy ăn hoa hồng trên đủ 15 triệu như chưa từng có tháng lỗ.
--
-- Chủ shop chốt 15/09/2026: số âm phải chuyển sang tháng sau và được bù hết trước khi tính hoa
-- hồng được trả. Muốn thế thì con số âm phải TỒN TẠI ở đâu đó — hôm nay nó không tồn tại ở bất kỳ
-- đâu trong kho mã.
--
-- VÌ SAO LÀ MỘT BẢNG, KHÔNG PHẢI TÍNH LẠI MỖI LẦN MỞ. Tính lại được, nhưng chỉ khi mọi tháng
-- trước đều còn ra đúng con số cũ — mà chính đó là thứ không giữ được: đổi một tỷ lệ, sửa một quy
-- kết fanpage, nhập thêm một phiếu kho, và số dư của tháng ĐÃ TRẢ TIỀN đổi theo. Số dư mang sang
-- là một NGHĨA VỤ đã phát sinh, không phải một phép tính chạy lại được.
--
-- GRAIN: MỘT NGƯỜI, MỘT THÁNG LỊCH VIỆT NAM. Cố ý không theo kỳ lương tuỳ ý — xem 7 ngày hay một
-- quý không được tạo thêm số dư, vì số dư là một chuỗi TUẦN TỰ theo tháng.
--
-- CHỈ THÊM BẢNG. Không đụng bảng nào đang có, KHÔNG backfill, KHÔNG đặt số dư mặc định cho ai
-- (AGENTS.md mục 35). Bảng rỗng sau khi triển khai; mọi màn hình chạy y như trước cho tới khi chủ
-- shop khai số dư mở sổ hoặc chốt tháng đầu tiên. Đặt số dư 0 cho tất cả là KHẲNG ĐỊNH rằng không
-- ai còn lỗ — một khẳng định không có căn cứ, và nó trả tiền thật ra ngoài.
CREATE TABLE IF NOT EXISTS "marketer_profit_carryover" (
  "id" text PRIMARY KEY NOT NULL,
  -- Khoá nhân sự trong sổ lương (settings: payroll.employees), KHÔNG phải users.id: sổ lương là
  -- nơi khai % hoa hồng, và một MKTer có thể chưa có tài khoản ERP. Đổi tên / email / fanpage
  -- không được chuyển lỗ sang người khác.
  "employee_id" text NOT NULL,
  "month_key" text NOT NULL,
  "opening_balance" integer NOT NULL,
  -- `PREV_MONTH` = tháng trước đã chốt · `OPENING_DECLARATION` = chủ shop khai số dư mở sổ, có
  -- nguồn. Không có giá trị nào nghĩa là "đoán", nên danh sách này ĐÓNG.
  "opening_source" text NOT NULL,
  "real_profit" integer NOT NULL,
  "loss_applied" integer DEFAULT 0 NOT NULL,
  "commission_base" integer NOT NULL,
  -- Tỷ lệ nhân 100 để giữ số nguyên (10% ⇒ 1000). Lưu lại để số hoa hồng trong ảnh chụp cũ vẫn
  -- giải thích được sau khi chủ shop đổi tỷ lệ.
  "commission_rate_bp" integer NOT NULL,
  -- GIỮ DẤU, chỉ để theo dõi. KHÔNG phải khoản phải trả và KHÔNG được cộng dồn thành một khoản nợ:
  -- −1 triệu tháng 8 cộng −0,4 triệu tháng 9 KHÔNG thành nợ −1,4 triệu. Chỉ số dư LỢI NHUẬN
  -- (`closing_balance`) mới chuyển kỳ.
  "signed_commission" integer NOT NULL,
  "payable_commission" integer NOT NULL,
  "closing_balance" integer NOT NULL,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "snapshot" jsonb,
  "calc_version" integer DEFAULT 1 NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "finalized_at" timestamp with time zone,
  "finalized_by" text,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "marketer_carryover_status_check" CHECK ("status" IN ('DRAFT', 'FINAL')),
  CONSTRAINT "marketer_carryover_month_format" CHECK ("month_key" ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT "marketer_carryover_source_check" CHECK ("opening_source" IN ('PREV_MONTH', 'OPENING_DECLARATION')),
  -- Số dư là LỖ CHƯA BÙ, theo định nghĩa ≤ 0. Một số dương ở đây nghĩa là "lãi mang sang" — mà lãi
  -- đã được trả hoa hồng ở tháng nó phát sinh, chuyển tiếp là trả hai lần.
  CONSTRAINT "marketer_carryover_opening_check" CHECK ("opening_balance" <= 0),
  CONSTRAINT "marketer_carryover_closing_check" CHECK ("closing_balance" <= 0),
  CONSTRAINT "marketer_carryover_base_check" CHECK ("commission_base" >= 0),
  CONSTRAINT "marketer_carryover_payable_check" CHECK ("payable_commission" >= 0),
  CONSTRAINT "marketer_carryover_applied_check" CHECK ("loss_applied" >= 0),
  -- Chốt mà không có ảnh chụp thì "chốt" không có nghĩa gì (cùng luật với `payroll_periods`).
  CONSTRAINT "marketer_carryover_final_check" CHECK ("status" = 'DRAFT' OR ("snapshot" IS NOT NULL AND "finalized_at" IS NOT NULL))
);
--> statement-breakpoint
-- MỘT người + MỘT tháng = MỘT dòng, và khoá này KHÔNG kèm `calc_version`: đổi phiên bản phép tính
-- không được sinh thêm một dòng chính thức thứ hai cho cùng một nghĩa vụ. Mở trang, xuất CSV, chạy
-- lại job hay hai yêu cầu chốt đồng thời đều va vào đúng khoá này.
CREATE UNIQUE INDEX IF NOT EXISTS "marketer_carryover_uq" ON "marketer_profit_carryover" ("employee_id","month_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketer_carryover_month_idx" ON "marketer_profit_carryover" ("month_key");--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketer_profit_carryover" ADD CONSTRAINT "marketer_carryover_finalized_by_users_id_fk"
    FOREIGN KEY ("finalized_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "marketer_profit_carryover" ADD CONSTRAINT "marketer_carryover_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
