-- 0177 · VÒNG ĐỜI KHÁCH PILOT (docs/platform/pilot-operations.md).
--
--  · CHỈ THÊM một cột vào sổ tổ chức ở mặt phẳng điều khiển (CSDL NHÀ; bản sao trong CSDL tổ chức khác bị
--    `migrateOrganizationDb` xoá rỗng mỗi lần mở, như mọi bảng platform_*):
--      `platform_organizations.pilot_stage` ∈ CREATED · CONFIGURING · READY_FOR_UAT · ACTIVE.
--  · TÁCH HẲN khỏi `status`: `status` trả lời "tổ chức có được chạy không" (SUSPENDED là công tắc khẩn), còn
--    `pilot_stage` trả lời "khách đang ở bước nào của lượt nhận vào". Gộp hai thứ thì tắt khẩn một tổ chức làm mất
--    luôn việc nó đang ở bước nào, và bật lại không biết trả về đâu.
--  · `NULL` = KHÔNG theo dõi vòng đời pilot (tổ chức nhà, tổ chức có từ trước bản này). KHÔNG backfill, KHÔNG đặt
--    mặc định: đoán giai đoạn cho tổ chức cũ là bịa ra một lịch sử chưa từng có (AGENTS.md mục 8.8). Tổ chức mới đi
--    luồng /start nhận CREATED do mã ứng dụng ghi, có dòng nhật ký nền tảng.
--  · CHECK giữ giá trị trong tập đóng. Viết tay và idempotent như các migration trước.

ALTER TABLE "platform_organizations" ADD COLUMN IF NOT EXISTS "pilot_stage" text;
--> statement-breakpoint
ALTER TABLE "platform_organizations" DROP CONSTRAINT IF EXISTS "platform_organizations_pilot_stage_check";
--> statement-breakpoint
ALTER TABLE "platform_organizations" ADD CONSTRAINT "platform_organizations_pilot_stage_check" CHECK ("pilot_stage" IS NULL OR "pilot_stage" IN ('CREATED','CONFIGURING','READY_FOR_UAT','ACTIVE'));
