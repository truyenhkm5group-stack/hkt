-- RÀ LỖI AI TRÊN HỘI THOẠI THẬT (docs/product-audit.md P7 · lib/sales-chatbot/quality.ts).
--
--  · Phát hiện (giá không căn cứ · công cụ lỗi · khách hỏi lại y nguyên) TÍNH LÚC ĐỌC bằng luật tất định — không lưu.
--  · Bảng này chỉ giữ QUYẾT ĐỊNH của người rà lên một phát hiện: đúng là lỗi / không phải lỗi, kèm ghi chú, `users.id` và
--    tên người rà do máy chủ đọc. Không có dòng = «chờ rà». Khoá (hội thoại, seq, loại): rà lại là sửa dòng cũ.
--  · Chỉ THÊM bảng; không backfill. CSDL mọi tổ chức. Viết tay, idempotent.

CREATE TABLE IF NOT EXISTS "sales_ai_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL REFERENCES "sales_chat_conversations"("id") ON DELETE cascade,
	"message_seq" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"reviewer_user_id" text,
	"reviewer_name" text,
	"reviewed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_ai_reviews_kind_check" CHECK ("sales_ai_reviews"."kind" IN ('PRICE_UNGROUNDED','TOOL_ERROR','REPEATED_QUESTION')),
	CONSTRAINT "sales_ai_reviews_status_check" CHECK ("sales_ai_reviews"."status" IN ('CONFIRMED','DISMISSED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_ai_reviews_key" ON "sales_ai_reviews" USING btree ("conversation_id","message_seq","kind");
