-- 0172 · CÀI ĐẶT NỀN TẢNG — bật `/start` KHÔNG CẦN DEPLOY (docs/platform/launch-gates.md mục B).
--
--  · CHỈ THÊM một bảng của mặt phẳng điều khiển (chỉ có nghĩa ở CSDL NHÀ; bản sao trong CSDL tổ chức khác bị
--    `migrateOrganizationDb` xoá rỗng mỗi lần mở, như các bảng platform_* của 0152 / 0169).
--  · Mục đầu tiên: `platform.signup.mode` ∈ off · invite · open. Hiệu lực = min(trần môi trường
--    `PLATFORM_SIGNUP_MODE`, cài đặt này). KHÔNG gieo dòng nào: thiếu dòng ⇒ `off`, nên production sau migration
--    này vẫn TẮT đúng như trước — mở là việc của người vận hành ở `/platform`, có hộp xác nhận và nhật ký.
--  · CHECK giữ giá trị trong tập đóng: một lượt ghi tay sai chính tả bị CSDL từ chối, không mở cửa.
--  · Không backfill, không đổi dữ liệu nào đang có. Viết tay và idempotent như các migration trước.

CREATE TABLE IF NOT EXISTS "platform_settings" (
  "key" text PRIMARY KEY NOT NULL,
  "value" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" text,
  "updated_by_email" text
);
--> statement-breakpoint
ALTER TABLE "platform_settings" DROP CONSTRAINT IF EXISTS "platform_settings_signup_mode_check";
--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_signup_mode_check" CHECK ("key" <> 'platform.signup.mode' OR ("value" #>> '{}') IN ('off','invite','open'));
