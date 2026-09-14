-- ═══════════ ĐÍCH CÓ KỲ, CÓ DẢI, CÓ HẠN, VÀ NHẬN ĐƯỢC CẢ HAI SỔ CHỈ SỐ ═══════════
--
-- Bảng `metric_targets` đang RỖNG trên production (đo 13/09/2026: 0 dòng), nên các cột thêm vào
-- có mặc định mà KHÔNG phải đoán gì về dữ liệu cũ — không có dữ liệu cũ nào. Đây cũng là lý do
-- nới ràng buộc `scope` an toàn: không dòng nào cần kiểm tra lại.
--
-- `period_kind` mặc định 'ANY' giữ nguyên nghĩa của mọi dòng sẽ tạo theo cách cũ: đích áp cho mọi
-- kỳ. Một đích 500 đơn KHÔNG có nghĩa gì nếu không nói 500 đơn MỘT TUẦN hay MỘT THÁNG — nhưng
-- đoán hộ một kỳ cho người dùng còn tệ hơn, nên 'ANY' là "chưa khai", không phải "mỗi tháng".

ALTER TABLE "metric_targets" ADD COLUMN IF NOT EXISTS "target_max" double precision;
--> statement-breakpoint
ALTER TABLE "metric_targets" ADD COLUMN IF NOT EXISTS "warning_at" double precision;
--> statement-breakpoint
ALTER TABLE "metric_targets" ADD COLUMN IF NOT EXISTS "critical_at" double precision;
--> statement-breakpoint
ALTER TABLE "metric_targets" ADD COLUMN IF NOT EXISTS "period_kind" text DEFAULT 'ANY' NOT NULL;
--> statement-breakpoint
ALTER TABLE "metric_targets" ADD COLUMN IF NOT EXISTS "effective_to" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "metric_targets" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "metric_targets" ADD COLUMN IF NOT EXISTS "owner_department" text;
--> statement-breakpoint

-- Phạm vi CÁ NHÂN được thêm vào danh sách ĐÓNG. Vẫn là danh sách đóng có CHECK, không phải ô gõ
-- tự do (AGENTS.md mục 30): chuỗi lạ buộc mã nguồn phải chọn giữa khoá nhầm người và lộ dữ liệu.
-- `PRODUCT` cố ý KHÔNG có — chưa sổ nào khai một chỉ số đọc được ở mức mã hàng.
DO $$
BEGIN
  ALTER TABLE "metric_targets" DROP CONSTRAINT IF EXISTS "metric_targets_scope_check";
  ALTER TABLE "metric_targets" ADD CONSTRAINT "metric_targets_scope_check"
    CHECK ("scope" IN ('COMPANY', 'DEPARTMENT', 'POSITION', 'USER'));
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'metric_targets_period_check') THEN
    ALTER TABLE "metric_targets" ADD CONSTRAINT "metric_targets_period_check"
      CHECK ("period_kind" IN ('ANY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'));
  END IF;
END $$;
--> statement-breakpoint

-- Hạn kết thúc phải SAU mốc hiệu lực. Một khoảng rỗng thì đích không bao giờ áp cho kỳ nào, và
-- người đặt sẽ đi tìm xem "vì sao thẻ điểm không thấy đích tôi vừa đặt".
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'metric_targets_window_check') THEN
    ALTER TABLE "metric_targets" ADD CONSTRAINT "metric_targets_window_check"
      CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");
  END IF;
END $$;
--> statement-breakpoint

-- Dải (`RANGE`) phải là một dải thật: cận trên lớn hơn cận dưới.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'metric_targets_range_check') THEN
    ALTER TABLE "metric_targets" ADD CONSTRAINT "metric_targets_range_check"
      CHECK ("target_max" IS NULL OR "target_max" > "target");
  END IF;
END $$;
--> statement-breakpoint

-- Phiên bản đếm từ 1 và chỉ đi lên. Nó là số thứ tự lần đổi của CÙNG một đích (cùng chỉ số, cùng
-- tầng, cùng tham chiếu), để đọc lại được lịch sử quyết định thay vì chỉ thấy con số cuối cùng.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'metric_targets_version_check') THEN
    ALTER TABLE "metric_targets" ADD CONSTRAINT "metric_targets_version_check" CHECK ("version" >= 1);
  END IF;
END $$;

--> statement-breakpoint

-- KHOÁ DUY NHẤT PHẢI CHỨA HÌNH DẠNG KỲ.
--
-- Bản đầu của migration này giữ nguyên khoá cũ (chỉ số · tầng · tham chiếu · mốc hiệu lực). Nhưng
-- `resolveTarget` lọc theo `period_kind`, tức là nó GIẢ ĐỊNH một đích theo TUẦN và một đích theo
-- THÁNG của cùng chỉ số có thể cùng tồn tại. Với khoá cũ thì không: dòng thứ hai bị chặn, và lượt
-- ghi thứ hai tra dòng cũ không theo kỳ nên nó SỬA ĐÈ đích tuần thành đích tháng — chủ shop mất
-- một đích đã đặt, không một dòng cảnh báo nào.
--
-- Bảng rỗng trên production (0 dòng, đo 13/09/2026) nên dựng lại chỉ mục không đụng dữ liệu nào.
DROP INDEX IF EXISTS "metric_targets_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "metric_targets_uq" ON "metric_targets" ("metric_key", "scope", coalesce("scope_ref", ''), "period_kind", "effective_from");
