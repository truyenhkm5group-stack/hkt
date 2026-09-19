-- ═══════════ MỘT LƯỢT SỬA CÓ KIỂM SOÁT, VÀ ĐẾM ĐƯỢC ═══════════
--
-- Model trả về đúng hợp đồng là chuyện THƯỜNG, không phải LUÔN LUÔN. Đã xảy ra thật trên
-- production 19/09/2026: AI CTO trả 13 việc cho một hợp đồng tối đa 12, và bản đề xuất bị zod
-- từ chối. Từ chối là ĐÚNG — cắt bớt mảng cho vừa thì `dependsOn` sẽ trỏ vào việc vừa bị xoá và
-- kế hoạch trông hợp lệ trong khi ý nghĩa đã hỏng.
--
-- Nhưng nếu chỉ lưu "hỏng" thì lần sau không ai biết nó hỏng ở BƯỚC NÀO, và cũng không ai đo được
-- bao nhiêu phần trăm bản đề xuất cần tới lượt sửa. Ba cột dưới đây trả lời ba câu khác nhau:
--
--   · model_calls    0 = bị chặn trước khi gọi · 1 = lượt đầu đã đạt · 2 = đã sửa một lần
--   · initial_error  lượt ĐẦU sai cái gì (rỗng = lượt đầu đạt)
--   · repair_outcome NONE chưa cần sửa · PASS sửa xong đạt · FAIL sửa rồi vẫn không đạt
--
-- KHÔNG lưu dòng suy nghĩ của model. Chỉ lưu lỗi kiểm tra và kết quả cuối.
--
-- CHỈ CỘNG THÊM. Không đổi cột nào đang có, không đụng một dòng dữ liệu nghiệp vụ nào.
-- Mặc định (1, '', 'NONE') mô tả đúng mọi dòng đã có: hồi đó chưa có đường sửa nào tồn tại.

ALTER TABLE "tech_proposals" ADD COLUMN IF NOT EXISTS "model_calls" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_proposals" ADD COLUMN IF NOT EXISTS "initial_error" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tech_proposals" ADD COLUMN IF NOT EXISTS "repair_outcome" text DEFAULT 'NONE' NOT NULL;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "tech_proposals" ADD CONSTRAINT "tech_proposals_model_calls_check" CHECK ("tech_proposals"."model_calls" BETWEEN 0 AND 2);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Hai cột phải kể CÙNG MỘT câu chuyện. `repair_outcome` khác 'NONE' mà `model_calls` không phải 2
-- nghĩa là một lượt sửa đã xảy ra nhưng không ai đếm nó.
DO $$ BEGIN
	ALTER TABLE "tech_proposals" ADD CONSTRAINT "tech_proposals_repair_check" CHECK (
		("tech_proposals"."repair_outcome" = 'NONE' AND "tech_proposals"."model_calls" <= 1)
		OR ("tech_proposals"."repair_outcome" IN ('PASS','FAIL') AND "tech_proposals"."model_calls" = 2)
	);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
