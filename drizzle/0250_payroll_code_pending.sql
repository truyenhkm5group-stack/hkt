-- 0250 · PHÂN CÔNG MKTer ↔ MÃ VÀ ĐIỀU KHOẢN THƯỞNG: thêm trạng thái CHỜ DUYỆT (chủ shop 20/10/2026, Payroll V2).
--
-- VÌ SAO: "Chưa có phê duyệt thì giữ trạng thái chờ, không tự mặc định tỷ lệ." Trước bản này lưu một phân công là có hiệu
-- lực ngay. Từ nay lưu chỉ tạo dòng `PENDING`; một thao tác DUYỆT riêng (`approveCodeRow`) mới đưa sang `APPROVED`, và bảng
-- lương chỉ đọc `APPROVED`. Chỉ NỚI ràng buộc trạng thái + đổi mặc định của cột — không đổi, không gieo, không xoá dòng nào
-- (production đo 20/10/2026: 0 dòng ở cả hai bảng). Dòng `APPROVED` phải mang mốc duyệt. Idempotent.
ALTER TABLE "product_marketer_assignments" DROP CONSTRAINT IF EXISTS "product_marketer_assignments_status_check";
--> statement-breakpoint
ALTER TABLE "product_marketer_assignments" ADD CONSTRAINT "product_marketer_assignments_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REVOKED'));
--> statement-breakpoint
ALTER TABLE "product_marketer_assignments" ALTER COLUMN "status" SET DEFAULT 'PENDING';
--> statement-breakpoint
ALTER TABLE "product_marketer_assignments" DROP CONSTRAINT IF EXISTS "product_marketer_assignments_approved_check";
--> statement-breakpoint
ALTER TABLE "product_marketer_assignments" ADD CONSTRAINT "product_marketer_assignments_approved_check" CHECK ("status" <> 'APPROVED' OR "approved_at" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "product_bonus_terms" DROP CONSTRAINT IF EXISTS "product_bonus_terms_status_check";
--> statement-breakpoint
ALTER TABLE "product_bonus_terms" ADD CONSTRAINT "product_bonus_terms_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REVOKED'));
--> statement-breakpoint
ALTER TABLE "product_bonus_terms" ALTER COLUMN "status" SET DEFAULT 'PENDING';
--> statement-breakpoint
ALTER TABLE "product_bonus_terms" DROP CONSTRAINT IF EXISTS "product_bonus_terms_approved_check";
--> statement-breakpoint
ALTER TABLE "product_bonus_terms" ADD CONSTRAINT "product_bonus_terms_approved_check" CHECK ("status" <> 'APPROVED' OR "approved_at" IS NOT NULL);
