-- 0255 · ĐỊNH MỨC VẢI LÊN MÁY CHỦ (OD-P2-04, docs/tech/odoo-inspired-erp-upgrade.md §6.6).
--
--  · Trước bản này định mức vải chỉ nằm trong localStorage của trình duyệt người gõ (MM-REC-26): mất trình
--    duyệt là mất số, hai người hai số. Bảng này giữ ĐÚNG grain màn hình đang tính — theo sản phẩm.
--  · CHỈ TẠO một bảng mới. Không đổi, không backfill bảng nào. Dữ liệu cũ chỉ vào bảng khi NGƯỜI bấm nút
--    «Nhập vào ERP» trên /inventory/shortage — không tự đẩy.
--  · NULL = chưa khai, không phải 0. Không báo cáo / giá vốn nào đọc bảng này.
--  · Viết tay, idempotent (ảnh chụp drizzle cũ từ 0032 — không dùng `db:generate`).

CREATE TABLE IF NOT EXISTS "fabric_norms" (
	"product_id" text PRIMARY KEY NOT NULL,
	"common_qty" double precision,
	"by_size" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"waste_pct" double precision,
	"unit" text DEFAULT 'm' NOT NULL,
	"updated_by_user_id" text,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fabric_norms_common_check" CHECK ("fabric_norms"."common_qty" IS NULL OR "fabric_norms"."common_qty" > 0),
	CONSTRAINT "fabric_norms_waste_check" CHECK ("fabric_norms"."waste_pct" IS NULL OR ("fabric_norms"."waste_pct" >= 0 AND "fabric_norms"."waste_pct" <= 100)),
	CONSTRAINT "fabric_norms_unit_check" CHECK ("fabric_norms"."unit" IN ('m', 'kg', 'yard', 'cây'))
);--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "fabric_norms" ADD CONSTRAINT "fabric_norms_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "fabric_norms" ADD CONSTRAINT "fabric_norms_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
