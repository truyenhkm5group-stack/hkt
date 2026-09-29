-- 0178 · PHIẾU GIAO CÓ KÝ NHẬN CHO ĐƠN TẠO TAY (G-ORDER — docs/business-rules/ORDER_OUTCOME.md mục 11).
--
--  · CHỈ THÊM một bảng nghiệp vụ `order_delivery_notes` (CSDL mọi tổ chức). Chủ nền tảng quyết 29/09/2026: phiếu giao có
--    chữ ký người nhận là chứng cứ GIAO THÀNH CÔNG của đơn không qua ĐVVC — chiều logistics + tồn kho, KHÔNG phải tiền.
--  · CHECK `order_id LIKE 'erp-%'`: chỉ đơn tạo tay nhận phiếu — đơn Pancake (id là chuỗi số) không bao giờ ghi được dòng
--    nào, kể cả khi một action lỗi quên kiểm. Tổ chức nhà (VNX) vì thế không đổi một con số nào.
--  · Chỉ mục duy nhất một phần `WHERE voided_at IS NULL`: một đơn tối đa MỘT phiếu còn hiệu lực.
--  · Huỷ phiếu = đặt `voided_at` + người + lý do (CHECK bắt buộc lý do ≥ 3 ký tự), KHÔNG xoá cứng.
--  · Người ghi / người huỷ là khoá `users.id` (AGENTS 34), tên chỉ là ảnh chụp.
--  · KHÔNG backfill (mục 8.8, 35): bảng mới RỖNG — không đoán đơn tay nào "đã giao" từ trạng thái hay phiếu xuất cũ.
-- Viết tay và idempotent như các migration trước.

CREATE TABLE IF NOT EXISTS "order_delivery_notes" (
  "id" text PRIMARY KEY NOT NULL,
  "order_id" text NOT NULL,
  "signed_at" timestamp with time zone NOT NULL,
  "receiver_name" text NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "recorded_by_user_id" text,
  "recorded_by_name" text DEFAULT '' NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  "voided_at" timestamp with time zone,
  "voided_by_user_id" text,
  "voided_by_name" text DEFAULT '' NOT NULL,
  "void_reason" text
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_delivery_notes" ADD CONSTRAINT "order_delivery_notes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_delivery_notes" ADD CONSTRAINT "order_delivery_notes_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_delivery_notes" ADD CONSTRAINT "order_delivery_notes_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "order_delivery_notes" DROP CONSTRAINT IF EXISTS "order_delivery_notes_manual_check";
--> statement-breakpoint
ALTER TABLE "order_delivery_notes" ADD CONSTRAINT "order_delivery_notes_manual_check" CHECK ("order_id" LIKE 'erp-%');
--> statement-breakpoint
ALTER TABLE "order_delivery_notes" DROP CONSTRAINT IF EXISTS "order_delivery_notes_receiver_check";
--> statement-breakpoint
ALTER TABLE "order_delivery_notes" ADD CONSTRAINT "order_delivery_notes_receiver_check" CHECK (length(btrim("receiver_name")) > 0);
--> statement-breakpoint
ALTER TABLE "order_delivery_notes" DROP CONSTRAINT IF EXISTS "order_delivery_notes_void_check";
--> statement-breakpoint
ALTER TABLE "order_delivery_notes" ADD CONSTRAINT "order_delivery_notes_void_check" CHECK (("voided_at" IS NULL AND "void_reason" IS NULL) OR ("voided_at" IS NOT NULL AND length(btrim(coalesce("void_reason", ''))) >= 3));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_delivery_notes_order_idx" ON "order_delivery_notes" USING btree ("order_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_delivery_notes_active_uq" ON "order_delivery_notes" USING btree ("order_id") WHERE "voided_at" IS NULL;
