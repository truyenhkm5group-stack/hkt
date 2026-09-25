-- 0142 · COMPANY OS · AGENT R — KẾT CỤC CHO HÀNG HOÀN KHÔNG NHÃN.
--
-- Sổ `return_dispositions` (0137, Agent E) chỉ neo được vào phiếu kiểm của kiện CÓ mã vận đơn. Món hàng
-- hoàn MẤT NHÃN (`return_unidentified`) kết luận hỏng / bẩn / sai hàng thì không có lối ra nào: không
-- sửa được trong sổ, không huỷ được, không trả xưởng được. Bản này cho sổ một NEO THỨ HAI:
--
--  · `unidentified_id` → `return_unidentified` (RESTRICT — xoá món là xoá chứng từ của quyết định).
--  · `inspection_id` bỏ NOT NULL; CHECK `return_dispositions_anchor_check` buộc ĐÚNG MỘT neo.
--  · `return_dispositions_subject_check` thay bằng bản ba nhánh (`item:` · `parcel:` · `unidentified:`).
--  · `restock_authority` — căn cứ của lượt nhập lại sau sửa cho món không nhãn (`IDENTIFIED` /
--    `MANAGER_OVERRIDE`, cùng từ vựng với `return_unidentified.restock_authority`); có ở ĐÚNG loại dòng ấy.
--
-- KHÔNG BACKFILL (mục 8.8, 35): không dòng nào được gieo hay sửa. Dòng cũ đều neo phiếu kiểm và đều thoả
-- ràng buộc mới. Viết tay và idempotent như 0033–0141: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS
-- rồi ADD — chạy lại ra đúng một ràng buộc mỗi tên.

ALTER TABLE "return_dispositions" ADD COLUMN IF NOT EXISTS "unidentified_id" text;
--> statement-breakpoint
ALTER TABLE "return_dispositions" ADD COLUMN IF NOT EXISTS "restock_authority" text;
--> statement-breakpoint
ALTER TABLE "return_dispositions" ALTER COLUMN "inspection_id" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "return_dispositions" ADD CONSTRAINT "return_dispositions_unidentified_id_return_unidentified_id_fk" FOREIGN KEY ("unidentified_id") REFERENCES "public"."return_unidentified"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "return_dispositions" DROP CONSTRAINT IF EXISTS "return_dispositions_anchor_check";
--> statement-breakpoint
ALTER TABLE "return_dispositions" ADD CONSTRAINT "return_dispositions_anchor_check" CHECK (num_nonnulls("inspection_id", "unidentified_id") = 1);
--> statement-breakpoint
ALTER TABLE "return_dispositions" DROP CONSTRAINT IF EXISTS "return_dispositions_subject_check";
--> statement-breakpoint
ALTER TABLE "return_dispositions" ADD CONSTRAINT "return_dispositions_subject_check" CHECK (("unidentified_id" IS NULL AND "inspection_id" IS NOT NULL AND (("inspection_item_id" IS NULL AND "subject_key" = 'parcel:' || "inspection_id") OR ("inspection_item_id" IS NOT NULL AND "subject_key" = 'item:' || "inspection_item_id"))) OR ("unidentified_id" IS NOT NULL AND "inspection_id" IS NULL AND "inspection_item_id" IS NULL AND "subject_key" = 'unidentified:' || "unidentified_id"));
--> statement-breakpoint
ALTER TABLE "return_dispositions" DROP CONSTRAINT IF EXISTS "return_dispositions_restock_authority_check";
--> statement-breakpoint
ALTER TABLE "return_dispositions" ADD CONSTRAINT "return_dispositions_restock_authority_check" CHECK ((("unidentified_id" IS NOT NULL AND "disposition" = 'RESTOCK_AFTER_REWORK') = ("restock_authority" IS NOT NULL)) AND ("restock_authority" IS NULL OR "restock_authority" IN ('IDENTIFIED', 'MANAGER_OVERRIDE')));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_dispositions_unidentified_idx" ON "return_dispositions" ("unidentified_id");
