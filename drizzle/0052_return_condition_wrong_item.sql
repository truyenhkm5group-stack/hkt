-- ═══════ KẾT LUẬN "KHÔNG ĐÚNG HÀNG" CHO KIỆN HOÀN ═══════
--
-- `WRONG_ITEM` (khách trả về MỘT MÓN KHÁC với món đã gửi) đã được thêm vào hằng số dùng chung và
-- vào nút bấm một chạm của trạm kiểm đếm, nhưng ràng buộc CHECK trên production thì chưa — nên
-- người kho bấm "Không đúng hàng" là gặp lỗi ràng buộc, đúng lúc đang đứng đếm hàng.
--
-- Chỉ NỚI danh sách giá trị hợp lệ. Không đụng dữ liệu, không đụng bảng nào khác.
--
-- `NOT VALID` để khỏi quét lại toàn bảng khi áp: mọi dòng đang có đều mang giá trị cũ, vốn đã nằm
-- trong danh sách mới, nên không có gì để kiểm lại.
DO $$
BEGIN
  ALTER TABLE "return_inspections" DROP CONSTRAINT IF EXISTS "return_inspections_condition_check";
  ALTER TABLE "return_inspections" ADD CONSTRAINT "return_inspections_condition_check"
    CHECK ("condition" IS NULL OR "condition" IN ('RESTOCKABLE', 'UNSELLABLE', 'DAMAGED', 'MISSING', 'WRONG_ITEM')) NOT VALID;
END $$;
