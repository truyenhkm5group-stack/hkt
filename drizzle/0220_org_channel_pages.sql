-- NHIỀU PAGE DƯỚI MỘT KẾT NỐI (docs/messaging-providers.md §7 · lib/connectors/service.ts).
--
--  · `org_connections` giữ MỘT hàng mỗi loại kết nối ⇒ Messenger trực tiếp chỉ giữ được một page (nối page B ghi đè page A).
--  · Bảng con: mỗi tài khoản kênh (Facebook page · Instagram gắn với page) một hàng, token mã hoá riêng, trạng thái người chọn,
--    bật / tắt AI theo page, sức khoẻ máy ghi (mốc tin, lỗi gần nhất). Lỗi của page A không đụng page B.
--  · Chỉ THÊM bảng; không backfill — tổ chức nối từ trước vẫn đọc từ hàng kết nối đơn. CSDL mọi tổ chức. Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "org_channel_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"org_code" text NOT NULL,
	"connector_key" text NOT NULL,
	"page_id" text NOT NULL,
	"kind" text DEFAULT 'PAGE' NOT NULL,
	"parent_page_id" text,
	"name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"ai_enabled" boolean DEFAULT true NOT NULL,
	"secrets_enc" bytea,
	"secrets_key_id" text,
	"last_event_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"connected_by_user_id" text,
	"connected_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_channel_pages_status_check" CHECK ("org_channel_pages"."status" in ('ACTIVE','DISABLED')),
	CONSTRAINT "org_channel_pages_kind_check" CHECK ("org_channel_pages"."kind" in ('PAGE','INSTAGRAM'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_channel_pages_key" ON "org_channel_pages" USING btree ("connector_key","page_id");
