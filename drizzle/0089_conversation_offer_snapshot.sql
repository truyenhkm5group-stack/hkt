-- ẢNH CHỤP ĐIỀU KIỆN BÁN trên hội thoại — 2 cột.
-- Chụp cả GIÁ và BẢNG SIZE chứ không chỉ mã hàng: khách được báo 499k thì cuộc ấy thuộc mức 499k,
-- dù hôm sau page đổi giá. Đọc lại bảng giá hiện hành để giải thích một câu đã nói ra là viết lại
-- quá khứ — y hệt vấn đề với mã hàng mà 0088 đã giải.
-- THUẦN BỔ SUNG, chỉ chạm bảng do nền tảng AI sở hữu.
ALTER TABLE "sales_conversations" ADD COLUMN "offer_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD COLUMN "size_profile_id" text;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD CONSTRAINT "sales_conversations_size_profile_id_sales_size_profiles_id_fk" FOREIGN KEY ("size_profile_id") REFERENCES "public"."sales_size_profiles"("id") ON DELETE set null ON UPDATE no action;
