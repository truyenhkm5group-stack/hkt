-- THƯƠNG HIỆU CỦA TỔ CHỨC (lib/platform/publish.ts::organizationBaseUrl).
--
--  · Cùng một app phục vụ hai thương hiệu: `vnx` (erp.vnxcommerce.com) và `chotdon` (app.chotdontudong.com). Liên kết gửi
--    cho người của tổ chức (mời, đặt lại mật khẩu, tin nhóm Lark/Telegram) phải về ĐÚNG phần mềm họ đã đăng ký — trước đây
--    khách Chốt Đơn nhận link erp.vnxcommerce.com vì sổ tổ chức không ghi họ đến từ đâu.
--  · Ghi MỘT lần, lúc khách TỰ đăng ký (host của trang /start). `NULL` = không theo dõi (tổ chức nhà, tổ chức có từ trước,
--    tổ chức người vận hành tạo hộ) ⇒ liên kết giữ như cũ (APP_URL). KHÔNG backfill: host lúc đăng ký của tổ chức cũ
--    không được lưu ở đâu, đoán là bịa (AGENTS.md mục 8.8).
--  · Sổ tổ chức nằm ở CSDL nhà; bảng ở CSDL tổ chức khác rỗng và không ai đọc. Viết tay, idempotent.

ALTER TABLE "platform_organizations" ADD COLUMN IF NOT EXISTS "brand" text;
--> statement-breakpoint
ALTER TABLE "platform_organizations" DROP CONSTRAINT IF EXISTS "platform_organizations_brand_check";
--> statement-breakpoint
ALTER TABLE "platform_organizations" ADD CONSTRAINT "platform_organizations_brand_check" CHECK ("brand" IS NULL OR "brand" IN ('vnx','chotdon'));
