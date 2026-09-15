-- MỘT NGUỒN CHO SIZE, MỘT NGUỒN CHO CHÍNH SÁCH.
--
-- ① GỠ BẢNG SỐ ĐO THỨ HAI.
--
-- ERP đã có máy gợi ý size từ trước: `lib/constants/size-engine.ts` + `settings["ai.sizeRules"]`,
-- có phiên bản, có phạm vi (mẫu mã → sản phẩm → nhóm hàng → toàn shop, hẹp thắng rộng), có mã
-- AMBIGUOUS / OUT_OF_RANGE, và có script nhập liệu kiểm tra trước khi ghi. Bảng
-- `sales_size_profiles` dựng ở 0088 là BẢN THỨ HAI của cùng một thứ — tôi dựng nó vì chưa tra kỹ.
--
-- Hai bảng số đo là hai câu trả lời khác nhau cho cùng một câu hỏi "khách này mặc size gì", và cái
-- sai không lộ ra ở màn hình: nó lộ ra ở một kiện hàng không vừa. Gỡ bản thừa, giữ bản có sẵn.
-- Bảng này chưa có dòng nào (chưa màn hình nào ghi vào nó) nên gỡ không mất dữ liệu.
--
-- ② CHÍNH SÁCH ĐỔI TRẢ CÓ CẤU TRÚC, THAY CHO MỘT Ô CHỮ.
--
-- Ô chữ tự do thì máy chỉ đọc lại nguyên văn được. Khách hỏi "đổi màu được không" mà ô chữ viết về
-- đổi size thì máy hoặc trả lời lạc, hoặc im. Tách từng nhánh thì mỗi câu hỏi có đúng một ô trả
-- lời nó, và ô nào chưa khai thì CHỈ nhánh ấy phải chuyển người.
--
-- `policy_version` tách khỏi `knowledge_version`: đổi CAM KẾT khác đổi CÁCH NÓI.
--
-- ③ CÂU DỮ KIỆN ĐÃ DUYỆT CÓ PHÂN LOẠI VÀ CÓ NGƯỜI DUYỆT.
--
-- Mảng chữ không nói được ai duyệt, duyệt lúc nào, câu ấy thuộc nhóm nào. Mà "ai duyệt" chính là
-- thứ phân biệt một dữ kiện với một câu ai đó gõ vội.
--
-- Các cột bị gỡ đều đang RỖNG ở mọi dòng — chúng mới sinh ra ở 0088-0090 và chưa màn hình nào ghi.
ALTER TABLE "sales_conversations" DROP CONSTRAINT IF EXISTS "sales_conversations_size_profile_id_sales_size_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "fanpage_sales_profiles" DROP CONSTRAINT IF EXISTS "fanpage_sales_profiles_size_profile_id_sales_size_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "test_product_profiles" DROP CONSTRAINT IF EXISTS "test_product_profiles_size_profile_id_sales_size_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "sales_source_rules" DROP CONSTRAINT IF EXISTS "sales_source_rules_size_profile_id_sales_size_profiles_id_fk";--> statement-breakpoint

ALTER TABLE "sales_conversations" DROP COLUMN IF EXISTS "size_profile_id";--> statement-breakpoint
ALTER TABLE "sales_conversations" DROP COLUMN IF EXISTS "size_profile_version";--> statement-breakpoint
ALTER TABLE "fanpage_sales_profiles" DROP COLUMN IF EXISTS "size_profile_id";--> statement-breakpoint
ALTER TABLE "test_product_profiles" DROP COLUMN IF EXISTS "size_profile_id";--> statement-breakpoint
DROP TABLE IF EXISTS "sales_size_profiles";--> statement-breakpoint

-- Bản bảng số đo là CHUỖI (`SizeRule.version`, ví dụ "dam-q004-2026-09"), không phải số đếm.
ALTER TABLE "sales_conversations" ADD COLUMN "size_rule_version" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_conversations" ADD COLUMN "policy_version" integer;--> statement-breakpoint

ALTER TABLE "fanpage_sales_profiles" DROP COLUMN IF EXISTS "exchange_policy";--> statement-breakpoint
ALTER TABLE "fanpage_sales_profiles" DROP COLUMN IF EXISTS "approved_facts";--> statement-breakpoint
ALTER TABLE "fanpage_sales_profiles" ADD COLUMN "exchange_policy_json" jsonb;--> statement-breakpoint
ALTER TABLE "fanpage_sales_profiles" ADD COLUMN "approved_facts_json" jsonb;--> statement-breakpoint
ALTER TABLE "fanpage_sales_profiles" ADD COLUMN "policy_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint

ALTER TABLE "test_product_profiles" DROP COLUMN IF EXISTS "exchange_policy";--> statement-breakpoint
ALTER TABLE "test_product_profiles" DROP COLUMN IF EXISTS "approved_facts";--> statement-breakpoint
ALTER TABLE "test_product_profiles" ADD COLUMN "exchange_policy_json" jsonb;--> statement-breakpoint
ALTER TABLE "test_product_profiles" ADD COLUMN "approved_facts_json" jsonb;--> statement-breakpoint
ALTER TABLE "test_product_profiles" ADD COLUMN "policy_version" integer DEFAULT 1 NOT NULL;
