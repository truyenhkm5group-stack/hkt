-- ĐÍCH CHỈ SỐ CÓ THÊM MỘT TẦNG: MÃ HÀNG (migration 0084).
--
-- Chủ shop chốt 14/09/2026: "mục tiêu có thể cấu hình theo toàn shop và override theo mã hàng nếu
-- cần". Trước bản này `metric_targets.scope` chỉ nhận bốn giá trị nói về CON NGƯỜI
-- (COMPANY · DEPARTMENT · POSITION · USER), nên một đích riêng cho mã Q004 không có chỗ để sống.
--
-- Chỉ NỚI ràng buộc, không đụng một dòng dữ liệu nào: mọi đích đang có giữ nguyên tầng của nó.
-- `PRODUCT` là một TRỤC RIÊNG — một dòng mã hàng không có phòng ban, và một dòng người không có mã
-- hàng — nên nới ở đây không mở đường cho đích của mã lọt vào phép chấm một cá nhân
-- (lib/constants/metric-targets.ts::resolveTarget chặn tường minh).
--
-- `scope_ref` của tầng này là `products.custom_id` (Q001…X001). CỐ Ý không đặt khoá ngoại: đích đã
-- đặt phải sống sót khi một mã bị ẩn hoặc đổi tên, y như lý do `POSITION` không có khoá ngoại.
ALTER TABLE "metric_targets" DROP CONSTRAINT IF EXISTS "metric_targets_scope_check";
--> statement-breakpoint
ALTER TABLE "metric_targets" ADD CONSTRAINT "metric_targets_scope_check"
  CHECK ("scope" IN ('COMPANY', 'DEPARTMENT', 'POSITION', 'USER', 'PRODUCT'));
