-- 0239 · CON TRỎ ĐỌC THEO NGƯỜI CỦA HỘP THƯ (chủ shop 10/10/2026, P0 «Chưa đọc»). «Chưa đọc» trước bản này là MỘT mốc chung của
-- cả hội thoại (`staff_seen_at`, ghi bằng GIỜ MỞ chứ không phải tin đã thấy) ⇒ người này mở thì người kia mất dấu chưa đọc, và tin
-- khách tới giữa lúc nạp khung chat với lúc ghi bị coi là đã đọc. Bảng mới: một dòng mỗi (hội thoại, người), mốc = tin KHÁCH cuối
-- cùng đã trả về cho người đó. Chỉ CỘNG THÊM: bảng rỗng (không backfill — chưa có dòng ⇒ đọc lùi về mốc chung cũ như hôm nay),
-- `staff_seen_at` vẫn được ghi cho các chỗ đang đọc nó. Thêm một chỉ mục (luồng, mốc) cho tin khách sau con trỏ. Idempotent.

CREATE TABLE IF NOT EXISTS "sales_chat_reads" (
	"conversation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"read_through_at" timestamp with time zone NOT NULL,
	"read_through_message_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_chat_reads_pk" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_chat_reads" ADD CONSTRAINT "sales_chat_reads_conversation_id_sales_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."sales_chat_conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_chat_reads_user_idx" ON "sales_chat_reads" USING btree ("user_id","updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_chat_inbound_thread_created_idx" ON "sales_chat_inbound" USING btree ("page_id","thread_id","created_at");
