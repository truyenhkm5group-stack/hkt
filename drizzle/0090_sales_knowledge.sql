-- SỔ DỮ KIỆN BÁN HÀNG — đủ để máy trả lời mà không phải bịa, và đủ để biết khi nào nó PHẢI im.
--
-- Ba nhóm cột, một lý do chung: mỗi câu máy nói ra phải truy được về một ô dữ liệu có người khai.
--
-- 1) `material` + `knowledge_version` trên hồ sơ fanpage. Chất liệu là một TUYÊN BỐ về sản phẩm
--    ("Rayon co giãn 4 chiều"), không được suy từ ảnh. `knowledge_version` tách khỏi `version`
--    vì hai thứ khác nhau: đổi GIÁ là đổi điều kiện bán, đổi CÂU DỮ KIỆN ĐÃ DUYỆT là đổi thứ máy
--    được phép nói — một hội thoại cần biết CẢ HAI lúc nó diễn ra.
--
-- 2) Bốn chính sách + phí ship + giá combo cho HÀNG TEST. Hàng test trước nay chỉ có
--    `shipping_policy` dạng chữ, nên cổng năng lực không thể hỏi nó cùng những câu hỏi hỏi hàng
--    thắng. Không thêm thì chỉ còn hai lối: hàng test mượn chính sách của hàng thắng (điều cấm),
--    hoặc hàng test được miễn kiểm tra (tệ hơn). Thêm cột là lối thứ ba và là lối đúng.
--
-- 3) Ba cột ảnh chụp còn thiếu trên hội thoại: luật nguồn nào đã áp, bảng số đo ở phiên bản nào,
--    sổ dữ kiện ở phiên bản nào. Thiếu chúng thì sáu tháng sau không ai dựng lại được vì sao máy
--    đã nói câu đó.
--
-- THUẦN BỔ SUNG, chỉ chạm bảng do nền tảng AI sở hữu. Không cột nào NOT NULL không mặc định.
ALTER TABLE "fanpage_sales_profiles" ADD COLUMN "material" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fanpage_sales_profiles" ADD COLUMN "knowledge_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint

ALTER TABLE "test_product_profiles" ADD COLUMN "knowledge_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "test_product_profiles" ADD COLUMN "shipping_fee" integer;--> statement-breakpoint
ALTER TABLE "test_product_profiles" ADD COLUMN "combo_pricing" jsonb;--> statement-breakpoint
ALTER TABLE "test_product_profiles" ADD COLUMN "free_ship_from" integer;--> statement-breakpoint
ALTER TABLE "test_product_profiles" ADD COLUMN "cod_policy" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "test_product_profiles" ADD COLUMN "inspection_policy" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "test_product_profiles" ADD COLUMN "delivery_estimate" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "test_product_profiles" ADD COLUMN "exchange_policy" text DEFAULT '' NOT NULL;--> statement-breakpoint

ALTER TABLE "sales_conversations" ADD COLUMN "source_rule_id" text;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD COLUMN "size_profile_version" integer;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD COLUMN "knowledge_version" integer;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD CONSTRAINT "sales_conversations_source_rule_id_sales_source_rules_id_fk" FOREIGN KEY ("source_rule_id") REFERENCES "public"."sales_source_rules"("id") ON DELETE set null ON UPDATE no action;
