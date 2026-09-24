-- 0125 · LƯƠNG TỰ ĐỘNG: gửi phiếu cho nhân viên xác nhận, hộp thư cá nhân, lệnh chuyển có mã VietQR.
-- Đặc tả: docs/payroll-autopilot.md. Chủ shop chốt 25/09/2026: chốt số ngày 01, trả lương ngày 15.
--
-- CHỈ THÊM BẢNG MỚI. Không đụng một dòng nào đã có, không backfill (AGENTS.md mục 35): chưa kỳ nào
-- được gửi phiếu, chưa lệnh chuyển nào được lập, nên ba bảng sinh ra RỖNG là đúng sự thật.
-- Viết tay và idempotent như 0033–0124 (không dùng db:generate — xem ghi chú trong AGENTS.md mục 4).

-- ═══ HỘP THƯ CÁ NHÂN ═══
-- `notifications` là hàng đợi CHUNG của cả shop (ai có quyền cảnh báo cũng thấy mọi dòng). Phiếu lương
-- là tin của MỘT người: không được nằm trong hàng đợi chung, và không được gửi vào nhóm Lark.
CREATE TABLE IF NOT EXISTS "user_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "body" text DEFAULT '' NOT NULL,
  "href" text DEFAULT '' NOT NULL,
  -- Khoá chống gửi trùng: job chạy mỗi giờ, một tin chỉ được đẻ ra một lần.
  "dedupe_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "read_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_messages" ADD CONSTRAINT "user_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_messages_dedupe_uq" ON "user_messages" ("dedupe_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_messages_inbox_idx" ON "user_messages" ("user_id", "read_at", "created_at");
--> statement-breakpoint

-- ═══ PHIẾU LƯƠNG ĐÃ GỬI VÀ LỜI XÁC NHẬN ═══
-- Một dòng = một người, trong MỘT LƯỢT GỬI (`round` = số lượt tính của kỳ lúc gửi). Tính lại kỳ sau khi
-- đã gửi thì lượt cũ giữ nguyên làm lịch sử và lượt mới gửi lại — lời xác nhận đi theo ĐÚNG con số
-- người ấy đã nhìn thấy, không trôi sang con số mới.
CREATE TABLE IF NOT EXISTS "payroll_confirmations" (
  "id" text PRIMARY KEY NOT NULL,
  "period_key" text NOT NULL,
  "basis" text NOT NULL,
  "round" integer NOT NULL,
  "employee_id" text NOT NULL,
  "employee_name" text DEFAULT '' NOT NULL,
  -- Người nhận do MÁY CHỦ khớp từ email hồ sơ ↔ tài khoản (AGENTS.md mục 34). NULL = hồ sơ chưa nối
  -- được tài khoản ERP nào nên không gửi được — màn hình nói ra, không giả vờ đã gửi.
  "recipient_user_id" text,
  -- Thực nhận lúc gửi (ảnh chụp). NULL = CHƯA BIẾT (không bao giờ xảy ra với kỳ đã tính, nhưng không ép 0).
  "amount" integer,
  "status" text DEFAULT 'PENDING' NOT NULL,
  "sent_at" timestamp with time zone NOT NULL,
  "deadline_at" timestamp with time zone NOT NULL,
  "responded_at" timestamp with time zone,
  "responded_by" text,
  "note" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payroll_confirmations_status_check" CHECK ("status" IN ('PENDING', 'CONFIRMED', 'DISPUTED')),
  -- Đã trả lời thì phải có mốc; chưa trả lời thì không được có. "Hết hạn không trả lời" KHÔNG phải một
  -- trạng thái ghi vào đây — nó tính lúc đọc từ `deadline_at`, nên luôn đúng tới từng giây.
  CONSTRAINT "payroll_confirmations_response_check" CHECK (("status" = 'PENDING') = ("responded_at" IS NULL)),
  -- Khiếu nại không lý do thì người sửa chỉ biết là "có gì đó sai".
  CONSTRAINT "payroll_confirmations_dispute_check" CHECK ("status" <> 'DISPUTED' OR length(trim("note")) >= 3)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payroll_confirmations" ADD CONSTRAINT "payroll_confirmations_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payroll_confirmations" ADD CONSTRAINT "payroll_confirmations_responded_by_users_id_fk" FOREIGN KEY ("responded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_confirmations_uq" ON "payroll_confirmations" ("period_key", "basis", "round", "employee_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_confirmations_recipient_idx" ON "payroll_confirmations" ("recipient_user_id", "sent_at");
--> statement-breakpoint

-- ═══ LỆNH CHUYỂN LƯƠNG ═══
-- Một dòng = một người trong một kỳ đã KHOÁ. Ngân hàng + số tài khoản + tên CHỤP LẠI lúc lập: sửa hồ
-- sơ sau khi đã trả không được làm đổi chứng từ của lần trả ấy.
CREATE TABLE IF NOT EXISTS "payroll_payout_lines" (
  "id" text PRIMARY KEY NOT NULL,
  "period_key" text NOT NULL,
  "basis" text NOT NULL,
  "employee_id" text NOT NULL,
  "employee_name" text DEFAULT '' NOT NULL,
  "amount" integer NOT NULL,
  "bank_bin" text DEFAULT '' NOT NULL,
  "bank_name" text DEFAULT '' NOT NULL,
  "account_number" text DEFAULT '' NOT NULL,
  "account_name" text DEFAULT '' NOT NULL,
  -- Nội dung chuyển khoản riêng của dòng này — ERP khớp tiền ra với đúng người bằng nó.
  "transfer_note" text NOT NULL,
  -- Tài khoản khác lần trả gần nhất của cùng người — người bấm chuyển phải nhìn thấy.
  "account_changed" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'PENDING' NOT NULL,
  -- Dòng sao kê đã chứng minh tiền đi. Không có nó thì không có "đã trả" ở mức dòng.
  "bank_txn_id" text,
  "paid_at" timestamp with time zone,
  -- `auto:exact` khi máy khớp, email người khi người chọn dòng sao kê.
  "matched_by" text DEFAULT '' NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payroll_payout_lines_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "payroll_payout_lines_status_check" CHECK ("status" IN ('PENDING', 'PAID', 'CANCELLED')),
  -- "Đã trả" phải truy được về chứng từ ngân hàng (AGENTS.md mục 8.7).
  CONSTRAINT "payroll_payout_lines_paid_check" CHECK ("status" <> 'PAID' OR ("paid_at" IS NOT NULL AND "bank_txn_id" IS NOT NULL))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payroll_payout_lines" ADD CONSTRAINT "payroll_payout_lines_bank_txn_id_bank_transactions_id_fk" FOREIGN KEY ("bank_txn_id") REFERENCES "public"."bank_transactions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "payroll_payout_lines" ADD CONSTRAINT "payroll_payout_lines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_payout_lines_uq" ON "payroll_payout_lines" ("period_key", "basis", "employee_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_payout_lines_note_uq" ON "payroll_payout_lines" ("transfer_note");
--> statement-breakpoint
-- Một dòng sao kê chỉ trả cho MỘT dòng lương: hai dòng cùng trỏ một lần chuyển là trả một, khai hai.
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_payout_lines_txn_uq" ON "payroll_payout_lines" ("bank_txn_id") WHERE "bank_txn_id" IS NOT NULL;
