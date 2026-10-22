-- 0254 · SỔ LỖ CÁ NHÂN: CĂN CỨ THỨ BA CHO SỐ DƯ ĐẦU KỲ — `FIRST_WORK_MONTH` (Tech Lead 22/10/2026).
--
--  · Tháng làm việc ĐẦU TIÊN (ngày vào làm trong hồ sơ từ tháng này trở đi, chưa có dòng sổ nào trước đó) có số dư
--    lỗ đầu kỳ = 0 là SỰ THẬT. Ghi nó là `OPENING_DECLARATION` là ghi sai vào cột của một dòng sắp bị KHOÁ (bất
--    biến, AGENTS.md mục 21) — người đọc cột (báo cáo, ops) sẽ tưởng chủ shop khai đích danh.
--  · Chỉ MỞ RỘNG tập giá trị của CHECK. Không đổi, không backfill dòng nào (mục 35): dòng cũ giữ nguyên nguồn.
--  · Viết tay, idempotent (ảnh chụp drizzle cũ từ 0032 — không dùng `db:generate`).

ALTER TABLE "marketer_profit_carryover" DROP CONSTRAINT IF EXISTS "marketer_carryover_source_check";--> statement-breakpoint
ALTER TABLE "marketer_profit_carryover" ADD CONSTRAINT "marketer_carryover_source_check" CHECK ("marketer_profit_carryover"."opening_source" IN ('PREV_MONTH', 'OPENING_DECLARATION', 'FIRST_WORK_MONTH'));
