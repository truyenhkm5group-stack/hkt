-- 0144 · COMPANY OS · AGENT U — AI XÁC NHẬN MẪU MÃ CỦA MÓN HÀNG HOÀN KHÔNG NHÃN, LÚC NÀO.
--
-- Món hàng hoàn mất nhãn (`return_unidentified`) chỉ đếm được về một mẫu và chỉ nhập lại tồn được khi kho
-- XÁC NHẬN mẫu mã (`variant_id`). Trước bản này cột ấy chỉ ghi được lúc nhận kiện và không ai biết ai đã
-- chọn. Nay kho gắn / đổi mẫu mã SAU khi nhận, và mỗi lượt để lại:
--
--  · `variant_identified_at` · `variant_identified_by` (ảnh chụp TÊN do máy chủ đọc) ·
--    `variant_identified_by_user_id` (khoá tài khoản — luật 34) · `variant_identify_note` (lý do khi ĐỔI).
--  · CHECK `return_unidentified_variant_identified_check`: mốc và tên đi cùng nhau.
--
-- Tách khỏi `identified_*` — đó là LỚP 2 (nối ĐƠN), một câu hỏi khác.
--
-- KHÔNG BACKFILL (mục 8.8, 35): dòng cũ giữ NULL = CHƯA BIẾT ai chọn mẫu. Không DEFAULT. Viết tay và
-- idempotent như 0033–0142: ADD COLUMN IF NOT EXISTS, khoá ngoại bọc duplicate_object, DROP CONSTRAINT IF
-- EXISTS rồi ADD — chạy lại ra đúng một ràng buộc mỗi tên.

ALTER TABLE "return_unidentified" ADD COLUMN IF NOT EXISTS "variant_identified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "return_unidentified" ADD COLUMN IF NOT EXISTS "variant_identified_by" text;
--> statement-breakpoint
ALTER TABLE "return_unidentified" ADD COLUMN IF NOT EXISTS "variant_identified_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "return_unidentified" ADD COLUMN IF NOT EXISTS "variant_identify_note" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "return_unidentified" ADD CONSTRAINT "return_unidentified_variant_identified_by_user_id_users_id_fk" FOREIGN KEY ("variant_identified_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "return_unidentified" DROP CONSTRAINT IF EXISTS "return_unidentified_variant_identified_check";
--> statement-breakpoint
ALTER TABLE "return_unidentified" ADD CONSTRAINT "return_unidentified_variant_identified_check" CHECK (("variant_identified_at" IS NULL) = ("variant_identified_by" IS NULL));
