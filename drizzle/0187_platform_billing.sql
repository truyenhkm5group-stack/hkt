-- 0187 · THU PHÍ THUÊ BAO CỦA NỀN TẢNG (docs/platform/billing.md).
--
--  · `platform_plans.price_vnd`: giá MỘT THÁNG, số nguyên VND. `NULL` = gói KHÔNG BÁN (Dùng thử · Tiêu chuẩn cũ · Nội bộ)
--    — không phải "giá 0". Khách chỉ tự chọn được gói có giá.
--  · Ba gói bán gieo sẵn: Khởi đầu 499.000 · Tăng trưởng 999.000 · Chuyên nghiệp 1.990.000. Hạn mức là ĐỀ XUẤT ban đầu;
--    người vận hành sửa giá ở /platform không cần deploy. `ON CONFLICT DO NOTHING` ⇒ chạy lại không đè giá đã sửa.
--  · `platform_subscriptions`: MỘT dòng cho mỗi tổ chức đã bật thu phí. Tình trạng (còn hạn · quá hạn · chỉ xem) KHÔNG lưu —
--    nó là hàm của `paid_through` + `grace_days` + hôm nay, tính lúc đọc (lib/billing/rules.ts). Không có job nào phải chạy
--    đúng giờ để khoá hay mở khoá một tổ chức.
--  · `platform_invoices`: yêu cầu gia hạn; trả xong thì `paid_through` = `period_end`. Mỗi tổ chức tối đa MỘT hoá đơn đang mở.
--  · `platform_billing_payments`: mọi khoản tiền vào mang mã thanh toán, khớp hay không — tiền không khớp KHÔNG biến mất.
--    Khoá tự nhiên `bank_ref` (cùng khoá với `bank_transactions` của CSDL nhà) ⇒ đối chiếu lại bao nhiêu lần cũng không đếm đôi.
--  · Chỉ thật ở CSDL nhà; CSDL tổ chức xoá sạch mỗi lần mở (db/migrate.ts). Viết tay, idempotent.

ALTER TABLE "platform_plans" ADD COLUMN IF NOT EXISTS "price_vnd" integer;--> statement-breakpoint
ALTER TABLE "platform_plans" DROP CONSTRAINT IF EXISTS "platform_plans_price_check";--> statement-breakpoint
ALTER TABLE "platform_plans" ADD CONSTRAINT "platform_plans_price_check" CHECK ("price_vnd" IS NULL OR "price_vnd" > 0);--> statement-breakpoint
INSERT INTO "platform_plans" ("key", "name", "description", "limits", "position", "price_vnd") VALUES
  ('starter', 'Khởi đầu', 'Shop nhỏ mới lên hệ thống: vài nhân viên, một kênh bán.', '{"users":5,"pages":10,"objects":5,"records":5000,"workflows":10,"aiDraftsPerDay":20,"storageMb":1024,"ai":{"requestsPerDay":30,"requestsPerMonth":500,"costUsdPerMonth":{"soft":30,"hard":60},"platformCreditUsdPerMonth":0}}'::jsonb, 12, 499000),
  ('growth', 'Tăng trưởng', 'Shop đang chạy đều: nhiều nhân viên, chatbot và luật tự động làm việc hằng ngày.', '{"users":15,"pages":30,"objects":15,"records":30000,"workflows":30,"aiDraftsPerDay":50,"storageMb":5120,"ai":{"requestsPerDay":100,"requestsPerMonth":2000,"costUsdPerMonth":{"soft":100,"hard":200},"platformCreditUsdPerMonth":0}}'::jsonb, 14, 999000),
  ('pro', 'Chuyên nghiệp', 'Doanh nghiệp nhiều phòng ban, nhiều kho, dữ liệu lớn.', '{"users":40,"pages":100,"objects":40,"records":150000,"workflows":100,"aiDraftsPerDay":150,"storageMb":20480,"ai":{"requestsPerDay":300,"requestsPerMonth":6000,"costUsdPerMonth":{"soft":300,"hard":600},"platformCreditUsdPerMonth":0}}'::jsonb, 16, 1990000)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_subscriptions" (
  "org_code" text PRIMARY KEY NOT NULL,
  "billing_enabled" boolean DEFAULT false NOT NULL,
  "paid_through" date,
  "grace_days" integer DEFAULT 7 NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_subscriptions_grace_check" CHECK ("grace_days" BETWEEN 0 AND 60),
  CONSTRAINT "platform_subscriptions_enabled_check" CHECK ("billing_enabled" = false OR "paid_through" IS NOT NULL)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_invoices" (
  "id" text PRIMARY KEY NOT NULL,
  "org_code" text NOT NULL,
  "plan_key" text NOT NULL,
  "months" integer NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "list_amount_vnd" integer NOT NULL,
  "credit_vnd" integer DEFAULT 0 NOT NULL,
  "amount_vnd" integer NOT NULL,
  "transfer_code" text NOT NULL,
  "status" text DEFAULT 'OPEN' NOT NULL,
  "created_by_email" text,
  "paid_at" timestamp with time zone,
  "paid_amount_vnd" integer,
  "paid_source" text,
  "paid_ref" text,
  "paid_by_email" text,
  "void_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_invoices_status_check" CHECK ("status" IN ('OPEN','PAID','VOID')),
  CONSTRAINT "platform_invoices_months_check" CHECK ("months" BETWEEN 1 AND 12),
  CONSTRAINT "platform_invoices_amount_check" CHECK ("amount_vnd" > 0 AND "list_amount_vnd" > 0 AND "credit_vnd" >= 0 AND "amount_vnd" = "list_amount_vnd" - "credit_vnd"),
  CONSTRAINT "platform_invoices_period_check" CHECK ("period_end" >= "period_start"),
  CONSTRAINT "platform_invoices_paid_check" CHECK (("status" = 'PAID') = ("paid_at" IS NOT NULL)),
  CONSTRAINT "platform_invoices_source_check" CHECK ("paid_source" IS NULL OR "paid_source" IN ('BANK','MANUAL')),
  CONSTRAINT "platform_invoices_code_check" CHECK ("transfer_code" ~ '^ERPHD[0-9A-Z]{6}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_invoices_transfer_code_key" ON "platform_invoices" ("transfer_code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_invoices_one_open" ON "platform_invoices" ("org_code") WHERE "status" = 'OPEN';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_invoices_org_idx" ON "platform_invoices" ("org_code", "created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_billing_payments" (
  "id" text PRIMARY KEY NOT NULL,
  "bank_ref" text NOT NULL,
  "txn_at" timestamp with time zone NOT NULL,
  "amount_vnd" integer NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "transfer_code" text NOT NULL,
  "invoice_id" text,
  "org_code" text,
  "outcome" text NOT NULL,
  "resolved_at" timestamp with time zone,
  "resolved_by_email" text,
  "resolved_note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_billing_payments_outcome_check" CHECK ("outcome" IN ('MATCHED','UNDERPAID','INVOICE_NOT_OPEN','NO_INVOICE'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_billing_payments_bank_ref_key" ON "platform_billing_payments" ("bank_ref");
