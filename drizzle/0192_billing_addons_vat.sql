-- 0192 · MUA THÊM HẠN MỨC GIỮA KỲ + THÔNG TIN XUẤT HOÁ ĐƠN VAT (docs/platform/billing.md §7–8).
--
--  · `platform_plans.addon_prices`: đơn giá MỘT BƯỚC / tháng cho từng hạng mục bán thêm (bước nằm trong mã,
--    lib/billing/addons.ts). KHÔNG gieo giá nào — `{}` = gói chưa bán thêm gì; chủ nền tảng khai ở /platform.
--  · `platform_subscriptions.addons`: số đơn vị đã mua thêm, cộng vào hạn mức gói; giữ qua các lần gia hạn.
--    `invoice_info`: thông tin xuất hoá đơn VAT khách khai (NULL = chưa khai).
--  · `platform_invoices.kind`: `RENEWAL` (như 0187) · `ADDON` (mua thêm giữa kỳ, `months = 0`). Mọi hoá đơn có từ trước là
--    `RENEWAL` nhờ mặc định — không backfill, không đổi một số tiền nào. `invoice_info` = ảnh chụp lúc tạo; `vat_*` = người
--    vận hành ghi số hoá đơn VAT đã xuất bên ngoài ERP.
--  · Chỉ thật ở CSDL nhà; CSDL tổ chức xoá sạch mỗi lần mở (db/migrate.ts). Viết tay, idempotent.

ALTER TABLE "platform_plans" ADD COLUMN IF NOT EXISTS "addon_prices" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_subscriptions" ADD COLUMN IF NOT EXISTS "addons" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_subscriptions" ADD COLUMN IF NOT EXISTS "invoice_info" jsonb;--> statement-breakpoint
ALTER TABLE "platform_invoices" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'RENEWAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_invoices" ADD COLUMN IF NOT EXISTS "addon_kind" text;--> statement-breakpoint
ALTER TABLE "platform_invoices" ADD COLUMN IF NOT EXISTS "addon_units" integer;--> statement-breakpoint
ALTER TABLE "platform_invoices" ADD COLUMN IF NOT EXISTS "addons" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_invoices" ADD COLUMN IF NOT EXISTS "invoice_info" jsonb;--> statement-breakpoint
ALTER TABLE "platform_invoices" ADD COLUMN IF NOT EXISTS "vat_issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_invoices" ADD COLUMN IF NOT EXISTS "vat_ref" text;--> statement-breakpoint
ALTER TABLE "platform_invoices" ADD COLUMN IF NOT EXISTS "vat_issued_by_email" text;--> statement-breakpoint
ALTER TABLE "platform_invoices" DROP CONSTRAINT IF EXISTS "platform_invoices_kind_check";--> statement-breakpoint
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_kind_check" CHECK ("kind" IN ('RENEWAL','ADDON'));--> statement-breakpoint
ALTER TABLE "platform_invoices" DROP CONSTRAINT IF EXISTS "platform_invoices_months_check";--> statement-breakpoint
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_months_check" CHECK (("kind" = 'RENEWAL' AND "months" BETWEEN 1 AND 12 AND "addon_kind" IS NULL) OR ("kind" = 'ADDON' AND "months" = 0 AND "addon_kind" IS NOT NULL AND "addon_units" > 0));--> statement-breakpoint
ALTER TABLE "platform_invoices" DROP CONSTRAINT IF EXISTS "platform_invoices_vat_check";--> statement-breakpoint
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_vat_check" CHECK ("vat_issued_at" IS NULL OR ("invoice_info" IS NOT NULL AND "status" = 'PAID' AND "vat_ref" IS NOT NULL));
