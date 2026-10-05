-- HỘP THƯ KHÁCH: GỬI ẢNH · NHÃN · GHI CHÚ NỘI BỘ (M8 · lib/sales-chatbot/inbox.ts · lib/sales-chatbot/inbox-labels.ts).
--
--  · Chủ shop 05/10/2026: hộp thư gửi được ẢNH và có NHÃN / GHI CHÚ NỘI BỘ cho hội thoại.
--  · `sales_chat_staff_messages`: thêm `text_sent_at` (chữ đã tới khách — gửi lại chỉ gửi phần thiếu) + `image_count`.
--  · `sales_chat_staff_images`: ảnh nhân viên gửi (bản gốc, loại nhận diện từ byte).
--  · `sales_chat_labels` + `sales_chat_conversation_labels`: bộ nhãn của tổ chức (bảng màu đóng) và nhãn gắn trên hội thoại.
--  · `sales_chat_notes`: ghi chú nội bộ — không gửi khách, không vào lịch sử bot, không phép tính nào đọc.
--  · Chỉ THÊM cột / bảng; dòng cũ không đổi, không backfill. CSDL mọi tổ chức. Viết tay, idempotent.

ALTER TABLE "sales_chat_staff_messages" ADD COLUMN IF NOT EXISTS "text_sent_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sales_chat_staff_messages" ADD COLUMN IF NOT EXISTS "image_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_chat_staff_images" (
	"id" text PRIMARY KEY NOT NULL,
	"staff_message_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"data" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_chat_staff_images_type_check" CHECK ("sales_chat_staff_images"."content_type" IN ('image/jpeg','image/png','image/webp')),
	CONSTRAINT "sales_chat_staff_images_size_check" CHECK ("sales_chat_staff_images"."bytes" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_chat_staff_images_msg_idx" ON "sales_chat_staff_images" USING btree ("staff_message_id","position");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_chat_labels" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT 'gray' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "sales_chat_labels_color_check" CHECK ("sales_chat_labels"."color" IN ('gray','red','orange','amber','green','teal','blue','violet','pink'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_chat_labels_name_key" ON "sales_chat_labels" USING btree (lower("name")) WHERE "sales_chat_labels"."archived_at" is null;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_chat_conversation_labels" (
	"conversation_id" text NOT NULL,
	"label_id" text NOT NULL,
	"added_by" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_chat_conversation_labels_conversation_id_label_id_pk" PRIMARY KEY("conversation_id","label_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_chat_conversation_labels_label_idx" ON "sales_chat_conversation_labels" USING btree ("label_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_chat_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"user_name" text DEFAULT '' NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_chat_notes_conv_idx" ON "sales_chat_notes" USING btree ("conversation_id","created_at");
