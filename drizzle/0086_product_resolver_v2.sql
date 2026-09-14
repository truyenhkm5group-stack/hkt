-- NHẬN DIỆN SẢN PHẨM v2 — 2 bảng mới + 7 cột thêm.
-- THUẦN BỔ SUNG, chỉ chạm bảng sales_* do chính nền tảng AI sở hữu.
-- Không câu lệnh nào đụng tới đơn hàng, vận đơn, tiền hay tồn kho.
--
-- VÌ SAO: mẻ chạy thử 20 hội thoại thật (14/09/2026) khớp được 0/20 sản phẩm — `product.search`
-- gọi 36 lần, rỗng 36 lần. Kiểm kê API Pancake cho thấy tín hiệu sản phẩm DUY NHẤT có thật là
-- `attachments[].ad_id` cùng câu quảng cáo đi kèm; `post_id` ở mức hội thoại NULL 20/20 và
-- `parent_id` NULL 80/80. Toàn bộ phần ấy trước đây bị vứt ngay tại tầng ánh xạ.
--
-- VIẾT TAY, không sinh bằng `db:generate`: kho mã này đã bỏ chuỗi ảnh chụp của drizzle từ lâu
-- (29 ảnh chụp cho 86 migration, cái mới nhất là 0032), nên lệnh sinh sẽ đổ ra TOÀN BỘ lược đồ
-- chứ không phải phần chênh lệch — chạy nó lên máy chủ là dựng lại từ đầu những bảng đang có dữ liệu.

ALTER TABLE "sales_messages" ADD COLUMN "ad_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_messages" ADD COLUMN "post_url" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_messages" ADD COLUMN "ad_description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_messages" ADD COLUMN "attachment_types" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "sales_messages_ad_idx" ON "sales_messages" USING btree ("ad_id");--> statement-breakpoint

-- HAI NGHĨA, HAI CỘT. `action` = máy LẼ RA nên làm gì (chấm chất lượng);
-- `production_action` = máy ĐƯỢC PHÉP làm gì (an toàn — ở nấc SHADOW luôn là NO_SEND).
-- Gộp chúng lại thì hội thoại đã có nhân viên vào sẽ ra NO_ACTION và mất sạch phần đáng so sánh nhất.
ALTER TABLE "sales_suggestions" ADD COLUMN "production_action" text DEFAULT 'NO_SEND' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_suggestions" ADD COLUMN "evaluation_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint

CREATE TABLE "sales_ad_product_map" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"ad_key" text NOT NULL,
	"key_kind" text DEFAULT 'AD' NOT NULL,
	"product_id" text,
	"variant_id" text,
	"source" text DEFAULT 'AD_DESCRIPTION' NOT NULL,
	"confidence" double precision DEFAULT 0 NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"ad_description" text DEFAULT '' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_product_resolutions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"conversation_id" text NOT NULL,
	"message_id" text,
	"product_id" text,
	"variant_id" text,
	"product_code" text DEFAULT '' NOT NULL,
	"source" text NOT NULL,
	"confidence" double precision DEFAULT 0 NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "sales_ad_product_map" ADD CONSTRAINT "sales_ad_product_map_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_ad_product_map" ADD CONSTRAINT "sales_ad_product_map_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_ad_product_map" ADD CONSTRAINT "sales_ad_product_map_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_product_resolutions" ADD CONSTRAINT "sales_product_resolutions_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_product_resolutions" ADD CONSTRAINT "sales_product_resolutions_conversation_id_sales_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."sales_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_product_resolutions" ADD CONSTRAINT "sales_product_resolutions_message_id_sales_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."sales_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_product_resolutions" ADD CONSTRAINT "sales_product_resolutions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_product_resolutions" ADD CONSTRAINT "sales_product_resolutions_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "sales_ad_product_map_uq" ON "sales_ad_product_map" USING btree ("page_id","ad_key");--> statement-breakpoint
CREATE INDEX "sales_ad_product_map_product_idx" ON "sales_ad_product_map" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "sales_product_resolutions_conv_idx" ON "sales_product_resolutions" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "sales_product_resolutions_source_idx" ON "sales_product_resolutions" USING btree ("source");
