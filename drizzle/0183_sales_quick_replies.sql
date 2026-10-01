-- 0183 · CÂU TRẢ LỜI MẪU (Q&A) CỦA CHATBOT BÁN HÀNG — trả lời câu hỏi phổ biến KHÔNG tốn token AI.
--
--  · `sales_chat_quick_replies`: mỗi dòng một câu hỏi phổ biến của shop — câu khách hay gõ (`triggers`), câu trả lời soạn
--    sẵn (`answer`, giá / tồn / phí ship chỉ là CHỖ TRỐNG `{{giá:SKU}}` · `{{tồn:SKU}}` · `{{ship}}`, máy đọc ERP lúc gửi),
--    bật / tắt, số lần đã dùng. `source = 'LEARNED'` = AI gợi ý từ hội thoại cũ (luôn tạo ở trạng thái TẮT — người duyệt).
--  · `sales_chat_quick_reply_images`: ảnh gửi kèm câu trả lời (bytea, đã kiểm JPEG / PNG / WEBP). Ba cột `pancake_*` nhớ
--    mã nội dung Pancake đã tải lên cho một page (dùng lại trong 12 giờ, khỏi tải lại mỗi lượt).
--  · `sales_chat_conversations.quick_replies`: số lượt của hội thoại được trả lời bằng câu mẫu (không tốn lượt AI chính).
--  · CSDL mọi tổ chức. Viết tay và idempotent như các migration trước.

CREATE TABLE IF NOT EXISTS "sales_chat_quick_replies" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "triggers" text[] DEFAULT '{}' NOT NULL,
  "answer" text NOT NULL,
  "active" boolean DEFAULT false NOT NULL,
  "source" text DEFAULT 'MANUAL' NOT NULL,
  "uses" integer DEFAULT 0 NOT NULL,
  "last_used_at" timestamp with time zone,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sales_chat_quick_replies_source_check" CHECK ("source" IN ('MANUAL','LEARNED'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_chat_quick_replies_active_idx" ON "sales_chat_quick_replies" ("active");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sales_chat_quick_reply_images" (
  "id" text PRIMARY KEY NOT NULL,
  "quick_reply_id" text NOT NULL REFERENCES "sales_chat_quick_replies"("id") ON DELETE CASCADE,
  "position" integer DEFAULT 0 NOT NULL,
  "content_type" text NOT NULL,
  "bytes" integer NOT NULL,
  "sha256" text NOT NULL,
  "data" bytea NOT NULL,
  "pancake_page_id" text,
  "pancake_content_id" text,
  "pancake_uploaded_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sales_chat_quick_reply_images_type_check" CHECK ("content_type" IN ('image/jpeg','image/png','image/webp')),
  CONSTRAINT "sales_chat_quick_reply_images_size_check" CHECK ("bytes" > 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_chat_quick_reply_images_reply_idx" ON "sales_chat_quick_reply_images" ("quick_reply_id", "position");--> statement-breakpoint

ALTER TABLE "sales_chat_conversations" ADD COLUMN IF NOT EXISTS "quick_replies" integer DEFAULT 0 NOT NULL;
