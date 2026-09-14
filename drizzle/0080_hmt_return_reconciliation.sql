-- ═══════ CHỨNG CỨ ĐỐI SOÁT SỔ HÀNG HOÀN VIẾT TAY ↔ ERP ═══════
--
-- CHỈ CỘNG THÊM MỘT BẢNG. Không đổi kiểu, không xoá cột, không đổi tên, không đụng
-- `return_inspections` / `return_inspection_items` / `shipments`. Luồng nhận và đếm hàng hoàn chạy
-- y nguyên; lượt đối soát chỉ GỌI dịch vụ nghiệp vụ sẵn có rồi ghi lại nó đã kết luận gì.
--
-- Viết tay và idempotent (`IF NOT EXISTS`) như các migration 0033–0079 của kho này: ảnh chụp
-- (`drizzle/meta/*_snapshot.json`) đã cũ từ 0032, nên `drizzle-kit generate` sinh ra một bản dựng
-- lại TOÀN BỘ lược đồ — chạy bản đó lên production sẽ hỏng ngay ở câu lệnh đầu tiên.
--
-- VÌ SAO CẦN BẢNG RIÊNG. Không bảng nào đang có mang được grain "một dòng của một bảng tính":
-- `return_inspections` là một dòng một KIỆN, `return_inspection_items` là một dòng một MÓN ĐÃ ĐẾM.
-- Dòng bảng tính KHÔNG khớp thì không sinh ra kiện lẫn món nào — mà đó lại chính là phần đáng đọc
-- nhất của một lượt đối soát. Nhét vào `note` thì không đếm được, không lọc được, không ràng buộc
-- được.
--
-- BẢNG NÀY KHÔNG ĐỤNG TỒN KHO. Tồn vẫn chỉ đổi qua `stock_receipts` / `stock_receipt_items`, và
-- chỉ khi người kho đếm thật (AGENTS.md mục 10).

CREATE TABLE IF NOT EXISTS "hmt_return_reconciliation" (
  "id" text PRIMARY KEY NOT NULL,

  -- Nguồn: nhiều lượt đối soát từ nhiều tệp phải phân biệt được, kể cả khi cùng một sheet.
  "workbook" text NOT NULL,
  "sheet" text NOT NULL,
  "sheet_role" text NOT NULL,
  "source_row" integer NOT NULL DEFAULT 0,

  "tracking_raw" text NOT NULL DEFAULT '',
  "tracking_key" text NOT NULL DEFAULT '',
  -- Vì sao dòng này mang mã vận đơn đó. `MERGED_CELL` = bảng tính GỘP Ô để nói các dòng là một
  -- kiện; `NONE` = ô trống không chứng cứ, và dòng đó không bao giờ được ghi.
  "inheritance" text NOT NULL DEFAULT 'OWN_CELL',

  "product_text" text NOT NULL DEFAULT '',
  "product_code" text NOT NULL DEFAULT '',
  "color" text NOT NULL DEFAULT '',
  "size" text NOT NULL DEFAULT '',
  "variant_id" text,
  "sku" text NOT NULL DEFAULT '',
  "quantity" integer NOT NULL DEFAULT 0,

  "shipment_id" text,
  "match_status" text NOT NULL,
  "detail" text NOT NULL DEFAULT '',
  "written" boolean NOT NULL DEFAULT false,

  -- Khoá chống ghi trùng bám vào NỘI DUNG dòng, không bám vào số dòng: chèn một dòng ở đầu tệp
  -- không được biến cả lượt chạy lại thành một lượt ghi mới.
  "idempotency_key" text NOT NULL,

  "actor_id" text,
  "actor_label" text NOT NULL DEFAULT '',
  "processed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),

  -- Danh sách PHẢI khớp `HMT_MATCH_STATUSES` ở lib/constants/hmt-returns.ts.
  CONSTRAINT "hmt_return_rec_status_check" CHECK ("match_status" IN (
    'MATCHED', 'ALREADY_RECEIVED', 'AMBIGUOUS_TRACKING', 'AMBIGUOUS_SKU', 'SKU_MISMATCH',
    'QUANTITY_CONFLICT', 'UNMATCHED_TRACKING', 'DUPLICATE_SOURCE_ROW', 'CONFLICT'
  )),
  CONSTRAINT "hmt_return_rec_inheritance_check" CHECK ("inheritance" IN ('OWN_CELL', 'MERGED_CELL', 'NONE')),
  -- Ranh giới giữa "đã đối chiếu" và "đã đổi dữ liệu": một dòng đánh dấu đã ghi mà mang trạng thái
  -- khác `MATCHED` là một lượt ghi không ai giải thích được.
  CONSTRAINT "hmt_return_rec_written_check" CHECK ("written" = false OR "match_status" = 'MATCHED')
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "hmt_return_reconciliation_idempotency_key_unique" ON "hmt_return_reconciliation" USING btree ("idempotency_key");--> statement-breakpoint

-- Mẫu mã bị xoá khỏi danh mục thì CHỈ gỡ liên kết: ảnh chụp mã/màu/size ở trên vẫn đọc được, nên
-- lịch sử đối soát không mất theo một thao tác dọn danh mục.
DO $$ BEGIN
  ALTER TABLE "hmt_return_reconciliation"
    ADD CONSTRAINT "hmt_return_reconciliation_variant_id_fk"
    FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "hmt_return_reconciliation"
    ADD CONSTRAINT "hmt_return_reconciliation_shipment_id_fk"
    FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "hmt_return_reconciliation"
    ADD CONSTRAINT "hmt_return_reconciliation_actor_id_fk"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "hmt_return_rec_shipment_idx" ON "hmt_return_reconciliation" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hmt_return_rec_status_idx" ON "hmt_return_reconciliation" USING btree ("match_status");--> statement-breakpoint
-- "Kiện này có trong sổ giấy không" phải tra được bằng mã, không phải quét cả bảng.
CREATE INDEX IF NOT EXISTS "hmt_return_rec_tracking_idx" ON "hmt_return_reconciliation" USING btree ("tracking_key");
