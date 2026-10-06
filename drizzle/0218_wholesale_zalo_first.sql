-- SĂN KHÁCH SỈ — NHẮN ZALO TRƯỚC, GỌI SAU (chủ shop 06/10/2026).
--
--  · `wholesale_leads.zalo_status`: lời khai của NHÂN VIÊN sau khi mở Zalo theo SĐT — `FOUND` (Zalo hiện hồ sơ, đã nhắn /
--    kết bạn) hoặc `NOT_FOUND` (Zalo báo không tìm thấy). `NULL` = CHƯA BIẾT: ERP không tự tra được số có Zalo hay không
--    (Zalo không mở API đó), nên không đoán, không backfill.
--  · Hoạt động mới: `ZALO_OPENED` (bấm «Nhắn Zalo» — chỉ mở app, chưa chứng minh đã gửi) và `ZALO` (kết quả do người chọn).
--    Tách đúng như cặp `CALL_INITIATED` / `CALL`.
--  · Chỉ NỚI ràng buộc + thêm cột cho phép NULL. CSDL mọi tổ chức. Viết tay, idempotent.

ALTER TABLE "wholesale_leads" ADD COLUMN IF NOT EXISTS "zalo_status" text;
--> statement-breakpoint
ALTER TABLE "wholesale_leads" ADD COLUMN IF NOT EXISTS "zalo_checked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "wholesale_leads" DROP CONSTRAINT IF EXISTS "wholesale_leads_zalo_status_check";
--> statement-breakpoint
ALTER TABLE "wholesale_leads" ADD CONSTRAINT "wholesale_leads_zalo_status_check" CHECK ("wholesale_leads"."zalo_status" IS NULL OR "wholesale_leads"."zalo_status" IN ('FOUND','NOT_FOUND'));
--> statement-breakpoint
ALTER TABLE "wholesale_lead_activities" DROP CONSTRAINT IF EXISTS "wholesale_lead_activities_kind_check";
--> statement-breakpoint
ALTER TABLE "wholesale_lead_activities" ADD CONSTRAINT "wholesale_lead_activities_kind_check" CHECK ("wholesale_lead_activities"."kind" IN ('DISCOVERED','IMPORTED','ENRICHED','SCORED','NOTE','CALL','CALL_INITIATED','ZALO','ZALO_OPENED','STATUS','ASSIGN','OUTREACH','OPPORTUNITY','CONVERT','EDIT','CAMPAIGN'));
