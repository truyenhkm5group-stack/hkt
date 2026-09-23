-- ═══════════ PHÒNG SẢN XUẤT — TÁCH KHỎI PHÒNG KHO (chủ shop chốt 23/09/2026) ═══════════
--
-- Migration 0069 gieo bảy phòng, trong đó phòng Kho gánh cả "đặt sản xuất". Chủ shop chốt tách
-- thành phòng thứ tám để ba màn hình quyết định đặt hàng (Kế hoạch đặt hàng SX · Quyết định vốn
-- tồn kho · Hiệu quả mẫu mã) có một chủ thật.
--
-- CHỈ CỘNG THÊM VÀ CHỈ ĐỔI THỨ TỰ HIỂN THỊ. Không dòng dữ liệu nghiệp vụ nào bị chạm:
--
--  · Hàng đợi việc tồn kho / sản xuất VẪN về phòng Kho. Đó là quyết định có chủ đích, khai ở
--    `lib/constants/departments.ts::TEAM_DEPARTMENT_DIVERGENCE`: một phòng chưa có thành viên mà đã
--    nhận việc thì việc rơi vào hàng đợi không ai mở. Chuyển sang phòng Sản xuất làm được bằng ghi
--    đè `settings` khoá `work.ownership` — KHÔNG cần migration, không cần deploy.
--  · Không ai mất quyền: phòng ban KHÔNG sinh quyền (AGENTS.md mục 29). Dòng này chỉ tạo một chỗ
--    để xếp người vào.
--
-- Thứ tự hiển thị đổi để hai phòng đầu phễu đứng cạnh nhau (Kinh doanh → Marketing), khớp với
-- `DEPARTMENT_ORDER` trong mã nguồn. Mỗi lệnh UPDATE chỉ chạm dòng CÒN NGUYÊN giá trị gieo ban đầu:
-- nếu ai đã đổi thứ tự bằng tay thì lựa chọn của họ được giữ, và chạy lại migration là no-op.

INSERT INTO "departments" ("id", "code", "name", "description", "sort_order", "active") VALUES
  (gen_random_uuid()::text, 'PRODUCTION', 'Sản xuất', 'Kế hoạch đặt hàng, làm việc với xưởng, quyết định bỏ vốn vào mẫu nào', 50, true)
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint

UPDATE "departments" SET "sort_order" = 20 WHERE "code" = 'MARKETING'  AND "sort_order" = 40;--> statement-breakpoint
UPDATE "departments" SET "sort_order" = 30 WHERE "code" = 'LOGISTICS'  AND "sort_order" = 20;--> statement-breakpoint
UPDATE "departments" SET "sort_order" = 40 WHERE "code" = 'WAREHOUSE'  AND "sort_order" = 30;--> statement-breakpoint
UPDATE "departments" SET "sort_order" = 60 WHERE "code" = 'FINANCE'    AND "sort_order" = 50;--> statement-breakpoint
UPDATE "departments" SET "sort_order" = 70 WHERE "code" = 'MANAGEMENT' AND "sort_order" = 60;--> statement-breakpoint
UPDATE "departments" SET "sort_order" = 80 WHERE "code" = 'HR'         AND "sort_order" = 70;
