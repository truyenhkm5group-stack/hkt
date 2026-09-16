-- ═══════════ VIETTEL POST LÀ NGUỒN SỰ THẬT: LỜI KHAI THÔ, SỔ TRẠNG THÁI, SỔ NHẬP TỆP ═══════════
--
-- VÌ SAO. Audit 16/09/2026 (docs/audit-vtp-source-of-truth-2026-09-16.md) tìm được ba lỗ:
--
--  · RC-2 — Trạng thái ĐVVC mà ERP chưa dịch được vẫn vào `shipment_events`, nhưng
--    `deriveShipmentState()` lọc bỏ chúng nên ẢNH CHỤP (`shipments.vtp_status_name`) giữ nguyên câu
--    CŨ và màn hình không có một dấu hiệu nào. Đường nhập tệp còn ném thẳng dòng đó đi.
--    ⇒ bốn cột `vtp_raw_*` ghi lời khai THÔ ở mọi lượt nạp, và bảng `vtp_status_registry` giữ mỗi
--      câu ĐVVC từng nói đúng một dòng.
--  · RC-3 — không cột nào nói ảnh chụp hiện tại do NGUỒN nào quyết định. `deriveShipmentState()`
--    vẫn tính ra `decidedBy` rồi vứt đi. ⇒ `vtp_sync_source`.
--  · RC-1 — bộ đối chiếu xếp hàng theo "lâu chưa hỏi", nên kiện ĐANG ĐI GIAO đứng ngang hàng với
--    kiện CHỜ LẤY HÀNG. ⇒ `vtp_next_sync_at` / `vtp_sync_attempts` / `vtp_last_error`.
--  · RC-4 — nhập tệp không có cửa vào trên giao diện và không có chạy thử.
--    ⇒ `vtp_import_batches` ghi mọi lần chạy, kể cả CHẠY THỬ.
--
-- CHỈ CỘNG THÊM. Không cột nào bị xoá, không ràng buộc nào chặt lại, KHÔNG backfill: dòng cũ để
-- `vtp_raw_*` NULL nghĩa là CHƯA BIẾT ĐVVC đã nói gì lần cuối — khác hẳn với "đã dịch được".
-- Đoán ngược từ `vtp_status_name` sẽ sinh ra một lời khai thô chưa từng tồn tại.
-- `vtp_raw_mapped` mặc định TRUE có chủ đích: dòng cũ không được hiện thành "ĐVVC nói câu lạ".
-- Viết tay và idempotent như 0033–0098.

ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "vtp_raw_status_code" integer;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "vtp_raw_status_name" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "vtp_raw_status_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "vtp_raw_mapped" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "vtp_sync_source" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "vtp_next_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "vtp_sync_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "vtp_last_error" text;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "shipments_next_sync_idx" ON "shipments" ("vtp_next_sync_at") WHERE "is_final" = false;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipments_raw_unmapped_idx" ON "shipments" ("vtp_raw_status_at") WHERE "vtp_raw_mapped" = false;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "vtp_status_registry" (
	"id" text PRIMARY KEY NOT NULL,
	"status_key" text NOT NULL,
	"status_code" integer,
	"status_name" text DEFAULT '' NOT NULL,
	"normalized_stage" text,
	"resolve_basis" text DEFAULT 'unknown' NOT NULL,
	"mapped" boolean DEFAULT false NOT NULL,
	"occurrences" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_source" text DEFAULT '' NOT NULL,
	"last_shipment_id" text,
	"sample_raw" jsonb,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"acknowledge_note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vtp_status_registry_status_key_unique" UNIQUE("status_key")
);
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "vtp_status_registry" ADD CONSTRAINT "vtp_status_registry_last_shipment_id_shipments_id_fk"
		FOREIGN KEY ("last_shipment_id") REFERENCES "public"."shipments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "vtp_status_registry_unmapped_idx" ON "vtp_status_registry" ("last_seen_at") WHERE "mapped" = false;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vtp_status_registry_seen_idx" ON "vtp_status_registry" ("last_seen_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "vtp_import_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"filename" text NOT NULL,
	"checksum" text NOT NULL,
	"bytes" integer DEFAULT 0 NOT NULL,
	"kind" text NOT NULL,
	"mode" text NOT NULL,
	"uploaded_by" text DEFAULT '' NOT NULL,
	"uploaded_by_id" text,
	"rows" integer DEFAULT 0 NOT NULL,
	"matched" integer DEFAULT 0 NOT NULL,
	"applied" integer DEFAULT 0 NOT NULL,
	"stale" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"conflicts" integer DEFAULT 0 NOT NULL,
	"unmatched" integer DEFAULT 0 NOT NULL,
	"unknown_status" integer DEFAULT 0 NOT NULL,
	"invalid" integer DEFAULT 0 NOT NULL,
	"error" text,
	"summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "vtp_import_batches" ADD CONSTRAINT "vtp_import_batches_uploaded_by_id_users_id_fk"
		FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

ALTER TABLE "vtp_import_batches" DROP CONSTRAINT IF EXISTS "vtp_import_batches_mode_check";--> statement-breakpoint
ALTER TABLE "vtp_import_batches" ADD CONSTRAINT "vtp_import_batches_mode_check" CHECK ("vtp_import_batches"."mode" IN ('PREVIEW', 'APPLY'));--> statement-breakpoint
ALTER TABLE "vtp_import_batches" DROP CONSTRAINT IF EXISTS "vtp_import_batches_kind_check";--> statement-breakpoint
ALTER TABLE "vtp_import_batches" ADD CONSTRAINT "vtp_import_batches_kind_check" CHECK ("vtp_import_batches"."kind" IN ('ORDER_LIST', 'STATEMENT_DETAIL', 'ERROR'));--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "vtp_import_batches_checksum_idx" ON "vtp_import_batches" ("checksum","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vtp_import_batches_created_idx" ON "vtp_import_batches" ("created_at");
