-- ═══════ KIỂM HÀNG HOÀN THEO TỪNG MÓN ═══════
--
-- CHỈ CỘNG THÊM MỘT BẢNG. Không đổi kiểu, không xoá cột, không đổi tên, không đụng
-- `return_inspections` đang có — đường đếm nhanh cả kiện vẫn chạy y nguyên, và không dòng dữ liệu
-- nào đã ghi bị viết lại.
--
-- Viết tay và idempotent (`IF NOT EXISTS`) như các migration 0033–0065 của kho này: ảnh chụp
-- (`drizzle/meta/*_snapshot.json`) đã cũ từ 0032 — 63 migration nhưng chỉ 28 ảnh chụp — nên
-- `drizzle-kit generate` sinh ra một bản dựng lại TOÀN BỘ lược đồ (31KB, CREATE TABLE mọi thứ).
-- Chạy bản đó lên production sẽ hỏng ngay ở câu lệnh đầu tiên.
--
-- VÌ SAO CẦN BẢNG RIÊNG. `return_inspections` có grain MỘT DÒNG MỘT KIỆN: một `condition` và một
-- `restock_qty` cho cả kiện. Một kiện ba món có thể vừa đủ một món, vừa thiếu một món, vừa hỏng
-- một món — ép cả kiện về một kết luận là vứt đúng phần thông tin người kho vừa bỏ công đếm, và
-- sau đó không ai trả lời được "mã nào hay bị trả về hỏng". Nhét JSON vào cột `note` thì không
-- đếm được, không lọc được, không ràng buộc được, và biến một cột đang có một nghĩa thành hai.
--
-- BẢNG NÀY KHÔNG ĐỤNG TỒN KHO. Nó chỉ ghi lại người kho đã nhìn thấy gì. Tồn vẫn chỉ thay đổi qua
-- `stock_receipts` / `stock_receipt_items` như mọi đường khác, và chỉ cho món kết luận 'OK'.

CREATE TABLE IF NOT EXISTS "return_inspection_items" (
  "id" text PRIMARY KEY NOT NULL,
  "inspection_id" text NOT NULL,
  "shipment_id" text NOT NULL,

  -- Hàng KỲ VỌNG — ảnh chụp TẠI LÚC KIỂM, không đọc sống từ đơn. Đơn có thể bị sửa và mẫu mã có
  -- thể bị xoá sau đó; giữ ảnh chụp thì phần lệch không tự biến mất khi dữ liệu gốc đổi.
  "expected_variant_id" text,
  "expected_sku" text NOT NULL DEFAULT '',
  "expected_name" text NOT NULL DEFAULT '',
  "expected_color" text NOT NULL DEFAULT '',
  "expected_size" text NOT NULL DEFAULT '',
  "expected_qty" integer NOT NULL DEFAULT 0,

  -- Hàng THỰC NHẬN. `actual_variant_id` khác `expected_variant_id` khi khách trả nhầm mẫu mã.
  "actual_variant_id" text,
  "actual_sku" text NOT NULL DEFAULT '',
  "actual_qty" integer NOT NULL DEFAULT 0,

  "condition" text NOT NULL,
  "note" text NOT NULL DEFAULT '',
  "inspected_by" text NOT NULL DEFAULT '',
  "inspected_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),

  -- Danh sách PHẢI khớp `ITEM_CONDITIONS` ở lib/constants/return-lifecycle.ts. Đã có tiền lệ lệch
  -- giữa hằng số TypeScript và ràng buộc SQL (`WRONG_ITEM` của bảng kiểm cả kiện): người kho bấm
  -- một nút hợp lệ và nhận lỗi ràng buộc, đúng lúc đang đứng đếm hàng.
  CONSTRAINT "return_inspection_items_condition_check" CHECK ("condition" IN ('OK', 'SHORT', 'WRONG_ITEM', 'DAMAGED', 'DIRTY', 'UNSELLABLE', 'OTHER')),
  CONSTRAINT "return_inspection_items_qty_check" CHECK ("expected_qty" >= 0 AND "actual_qty" >= 0),
  -- Không "đủ" mà không nói vì sao thì phần hàng mất biến mất không dấu vết.
  CONSTRAINT "return_inspection_items_reason_check" CHECK ("condition" = 'OK' OR length(trim("note")) > 0)
);--> statement-breakpoint

-- Xoá phiếu kiểm thì kết quả từng món đi theo; xoá vận đơn cũng vậy. Mẫu mã bị xoá khỏi danh mục
-- thì CHỈ gỡ liên kết (SET NULL) — ảnh chụp mã/tên/màu/size ở trên vẫn đọc được, nên lịch sử kiểm
-- hàng không bao giờ mất theo một thao tác dọn danh mục.
DO $$ BEGIN
  ALTER TABLE "return_inspection_items"
    ADD CONSTRAINT "return_inspection_items_inspection_id_fk"
    FOREIGN KEY ("inspection_id") REFERENCES "return_inspections"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "return_inspection_items"
    ADD CONSTRAINT "return_inspection_items_shipment_id_fk"
    FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "return_inspection_items"
    ADD CONSTRAINT "return_inspection_items_expected_variant_id_fk"
    FOREIGN KEY ("expected_variant_id") REFERENCES "product_variants"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "return_inspection_items"
    ADD CONSTRAINT "return_inspection_items_actual_variant_id_fk"
    FOREIGN KEY ("actual_variant_id") REFERENCES "product_variants"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "return_inspection_items_inspection_idx" ON "return_inspection_items" USING btree ("inspection_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_inspection_items_shipment_idx" ON "return_inspection_items" USING btree ("shipment_id");--> statement-breakpoint
-- Hỏi "mã Q002 bị trả về bao nhiêu, hỏng mấy cái" phải quét được theo mẫu mã.
CREATE INDEX IF NOT EXISTS "return_inspection_items_variant_idx" ON "return_inspection_items" USING btree ("expected_variant_id");
