-- ═══════ NGƯỜI GỠ MỘT DÒNG KHÔNG KHỚP — GHI LẠI AI GỠ, GỠ THẾ NÀO, VÌ SAO ═══════
--
-- CHỈ CỘNG THÊM CỘT NULLABLE vào `hmt_return_reconciliation`. Không đổi kiểu, không xoá cột, không
-- đổi tên, không đụng một dòng dữ liệu nào. Viết tay và idempotent như 0033–0082.
--
-- VÌ SAO. Lượt đối soát 14/09/2026 để lại 26 dòng không khớp. Chúng đếm được nhưng KHÔNG ai làm
-- được gì với chúng — một con số không có nút bấm là con số người ta học cách bỏ qua. Bốn cột dưới
-- đây là chỗ ghi lại kết luận của NGƯỜI, tách hẳn khỏi kết luận của MÁY (`match_status`).
--
-- HAI SỰ THẬT KHÔNG ĐƯỢC TRỘN. `match_status` là máy đọc sổ giấy ra được gì; `resolution` là người
-- nhìn hàng thật kết luận gì. Ghi đè cái sau lên cái trước là mất dấu vì sao máy không khớp được —
-- và lần sau không ai sửa được luật đọc.

ALTER TABLE "hmt_return_reconciliation" ADD COLUMN IF NOT EXISTS "resolution" text;--> statement-breakpoint
ALTER TABLE "hmt_return_reconciliation" ADD COLUMN IF NOT EXISTS "resolved_shipment_id" text;--> statement-breakpoint
ALTER TABLE "hmt_return_reconciliation" ADD COLUMN IF NOT EXISTS "resolved_variant_id" text;--> statement-breakpoint
ALTER TABLE "hmt_return_reconciliation" ADD COLUMN IF NOT EXISTS "resolved_by" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "hmt_return_reconciliation" ADD COLUMN IF NOT EXISTS "resolved_by_user_id" text;--> statement-breakpoint
ALTER TABLE "hmt_return_reconciliation" ADD COLUMN IF NOT EXISTS "resolution_note" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "hmt_return_reconciliation" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;--> statement-breakpoint

-- Kiện / mẫu mã bị xoá ⇒ khoá về NULL, DÒNG Ở LẠI. Xoá bằng chứng theo một bản ghi khác là mất dấu
-- một kết luận của người.
DO $$ BEGIN
  ALTER TABLE "hmt_return_reconciliation" ADD CONSTRAINT "hmt_return_rec_resolved_shipment_fk"
    FOREIGN KEY ("resolved_shipment_id") REFERENCES "shipments"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "hmt_return_reconciliation" ADD CONSTRAINT "hmt_return_rec_resolved_variant_fk"
    FOREIGN KEY ("resolved_variant_id") REFERENCES "product_variants"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "hmt_return_reconciliation" ADD CONSTRAINT "hmt_return_rec_resolver_fk"
    FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Danh sách ĐÓNG, khớp `HMT_RESOLUTIONS` ở lib/constants/hmt-returns.ts. Ô gõ tự do ở đây là chỗ
-- một chuỗi lạ buộc mã nguồn phải chọn giữa "bỏ qua dòng" và "coi như đã gỡ".
DO $$ BEGIN
  ALTER TABLE "hmt_return_reconciliation" ADD CONSTRAINT "hmt_return_rec_resolution_check"
    CHECK ("resolution" IS NULL OR "resolution" IN ('LINKED_SHIPMENT', 'RESOLVED_SKU', 'DISMISSED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- GỠ RỒI THÌ PHẢI BIẾT AI GỠ, LÚC NÀO, VÀ VÌ SAO. Ba vế, không thiếu vế nào: một kết luận không
-- quy kết được về người và thời điểm thì sáu tháng sau không ai kiểm chứng lại được.
DO $$ BEGIN
  ALTER TABLE "hmt_return_reconciliation" ADD CONSTRAINT "hmt_return_rec_resolution_actor_check"
    CHECK ("resolution" IS NULL OR ("resolved_at" IS NOT NULL AND "resolved_by" <> '' AND "resolution_note" <> ''));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Nối tay thì PHẢI chỉ đích danh một kiện; chọn mẫu mã thì PHẢI chỉ đích danh một mẫu mã. Một kết
-- luận "đã nối" mà không có đích là một kết luận rỗng trông như đã xong.
DO $$ BEGIN
  ALTER TABLE "hmt_return_reconciliation" ADD CONSTRAINT "hmt_return_rec_resolution_target_check"
    CHECK (
      "resolution" IS DISTINCT FROM 'LINKED_SHIPMENT' OR "resolved_shipment_id" IS NOT NULL
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "hmt_return_reconciliation" ADD CONSTRAINT "hmt_return_rec_resolution_sku_check"
    CHECK (
      "resolution" IS DISTINCT FROM 'RESOLVED_SKU' OR "resolved_variant_id" IS NOT NULL
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- ═══ DÒNG ĐÃ GHI LÀ BẤT KHẢ XÂM PHẠM ═══
--
-- 724 dòng `MATCHED` đã là chứng cứ nhận hàng của 672 kiện. Gắn một kết luận của người lên chúng là
-- viết đè lên bằng chứng. Muốn sửa một lượt nhận đã ghi thì đi đường huỷ nhận (`undoReturnArrived`)
-- — có dấu vết, có người chịu trách nhiệm.
DO $$ BEGIN
  ALTER TABLE "hmt_return_reconciliation" ADD CONSTRAINT "hmt_return_rec_resolution_written_check"
    CHECK ("resolution" IS NULL OR "written" = false);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "hmt_return_rec_resolution_idx" ON "hmt_return_reconciliation" ("resolution", "match_status");
