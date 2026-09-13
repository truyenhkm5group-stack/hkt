-- ═══════ LÝ DO HOÀN DO NGƯỜI XÁC ĐỊNH ═══════
--
-- Đặc tả: chú thích đầu `shipmentReturnReasons` trong `db/schema.ts`.
--
-- CHỈ CỘNG THÊM. Một bảng mới, không cột nào bị xoá hay đổi kiểu, không dòng dữ liệu nào đang có
-- bị viết lại. Không đụng `shipments`, `orders`, `shipment_events` — chứng từ vận chuyển vẫn là
-- chứng từ vận chuyển.
--
-- Viết tay và idempotent như 0033–0071: ảnh chụp `drizzle/meta/*_snapshot.json` đã cũ từ 0032.
--
-- ─── VÌ SAO KHÔNG THÊM MỘT CỘT VÀO `shipments` ───
--
-- Một cột `return_reason` sẽ không phân biệt được "máy suy ra" với "người xác nhận", và mỗi lần
-- sửa là mất giá trị cũ. Bảng riêng giữ cả hai vế cùng vết sửa. `UNIQUE(shipment_id)` vì một vận
-- đơn chỉ có MỘT lý do đang có hiệu lực; lịch sử thay đổi nằm ở `audit_logs`.

CREATE TABLE IF NOT EXISTS "shipment_return_reasons" (
  "id"               text PRIMARY KEY NOT NULL,
  "shipment_id"      text NOT NULL,
  "reason"           text NOT NULL,
  "note"             text DEFAULT '' NOT NULL,
  "inferred_reason"  text DEFAULT '' NOT NULL,
  "actor_id"         text,
  "actor_email"      text DEFAULT '' NOT NULL,
  "created_at"       timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"       timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "shipment_return_reasons_shipment_id_unique" ON "shipment_return_reasons" ("shipment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipment_return_reasons_reason_idx" ON "shipment_return_reasons" ("reason");--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "shipment_return_reasons" ADD CONSTRAINT "shipment_return_reasons_shipment_id_fk"
    FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "shipment_return_reasons" ADD CONSTRAINT "shipment_return_reasons_actor_id_fk"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
