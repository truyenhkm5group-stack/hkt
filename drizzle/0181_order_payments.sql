-- 0181 · CHỨNG TỪ THANH TOÁN CỦA ĐƠN TẠO TAY — PHIẾU THU / PHIẾU HOÀN TIỀN (docs/business-rules/ORDER_OUTCOME.md mục 11).
--
--  · CHỈ THÊM một bảng nghiệp vụ `order_payments` (CSDL mọi tổ chức). Chủ nền tảng 30/09/2026: đơn không qua ĐVVC cần
--    đường chuẩn để ghi chứng từ thanh toán; doanh thu thực thu dựa trên chứng từ, KHÔNG tự coi "đã giao" là "đã thu".
--  · CHECK `order_id LIKE 'erp-%'`: chỉ đơn tạo tay nhận chứng từ — đơn Pancake (id là chuỗi số) không bao giờ ghi được
--    dòng nào, kể cả khi một action lỗi quên kiểm. Tổ chức nhà (VNX) vì thế không đổi một con số nào.
--  · Số tiền nguyên dương (CHECK); chiều tiền nằm ở `kind` (RECEIPT / REFUND); phương thức là tập ĐÓNG (CHECK).
--  · Huỷ = `status = 'VOIDED'` + mốc + người + lý do (CHECK bắt buộc lý do ≥ 3 ký tự), KHÔNG xoá cứng.
--  · Người ghi / người huỷ là khoá `users.id` (AGENTS 34), tên chỉ là ảnh chụp.
--  · KHÔNG backfill (mục 8.8, 35): bảng mới RỖNG — không đoán đơn tay nào "đã thu" từ trạng thái hay phiếu giao.
-- Viết tay và idempotent như các migration trước.

CREATE TABLE IF NOT EXISTS "order_payments" (
  "id" text PRIMARY KEY NOT NULL,
  "order_id" text NOT NULL,
  "kind" text NOT NULL,
  "method" text NOT NULL,
  "amount" integer NOT NULL,
  "paid_at" timestamp with time zone NOT NULL,
  "status" text DEFAULT 'CONFIRMED' NOT NULL,
  "reference" text DEFAULT '' NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "created_by_user_id" text,
  "created_by_name" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "voided_at" timestamp with time zone,
  "voided_by_user_id" text,
  "voided_by_name" text DEFAULT '' NOT NULL,
  "void_reason" text
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "order_payments" DROP CONSTRAINT IF EXISTS "order_payments_manual_check";
--> statement-breakpoint
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_manual_check" CHECK ("order_id" LIKE 'erp-%');
--> statement-breakpoint
ALTER TABLE "order_payments" DROP CONSTRAINT IF EXISTS "order_payments_amount_check";
--> statement-breakpoint
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_amount_check" CHECK ("amount" > 0);
--> statement-breakpoint
ALTER TABLE "order_payments" DROP CONSTRAINT IF EXISTS "order_payments_kind_check";
--> statement-breakpoint
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_kind_check" CHECK ("kind" IN ('RECEIPT', 'REFUND'));
--> statement-breakpoint
ALTER TABLE "order_payments" DROP CONSTRAINT IF EXISTS "order_payments_method_check";
--> statement-breakpoint
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_method_check" CHECK ("method" IN ('CASH', 'BANK_TRANSFER', 'COD', 'OTHER'));
--> statement-breakpoint
ALTER TABLE "order_payments" DROP CONSTRAINT IF EXISTS "order_payments_void_check";
--> statement-breakpoint
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_void_check" CHECK (("status" = 'CONFIRMED' AND "voided_at" IS NULL AND "void_reason" IS NULL) OR ("status" = 'VOIDED' AND "voided_at" IS NOT NULL AND length(btrim(coalesce("void_reason", ''))) >= 3));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_payments_order_idx" ON "order_payments" USING btree ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_payments_paid_at_idx" ON "order_payments" USING btree ("paid_at");
