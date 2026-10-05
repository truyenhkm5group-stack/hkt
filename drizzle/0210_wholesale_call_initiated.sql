-- SĂN KHÁCH SỈ — SỰ KIỆN «BẤM GỌI» TRÊN ĐIỆN THOẠI (/wholesale/mobile).
--
--  · Chủ shop 05/10/2026: nhân viên sale gọi khách bằng điện thoại; bấm «GỌI NGAY» chỉ MỞ ứng dụng gọi của máy, không chứng
--    minh đã nói chuyện. Nên lượt bấm là một sự kiện RIÊNG (`CALL_INITIATED`: lead · người bấm · số · mốc), tách khỏi dòng
--    `CALL` mang KẾT QUẢ cuộc gọi do người chọn sau khi quay lại ERP — gộp hai thứ là đếm lượt bấm thành cuộc gọi đã nói.
--  · Chỉ NỚI ràng buộc (thêm một giá trị) — dòng cũ không đổi, không backfill.
--  · CSDL mọi tổ chức. Viết tay, idempotent.

ALTER TABLE "wholesale_lead_activities" DROP CONSTRAINT IF EXISTS "wholesale_lead_activities_kind_check";
--> statement-breakpoint
ALTER TABLE "wholesale_lead_activities" ADD CONSTRAINT "wholesale_lead_activities_kind_check" CHECK ("wholesale_lead_activities"."kind" IN ('DISCOVERED','IMPORTED','ENRICHED','SCORED','NOTE','CALL','CALL_INITIATED','STATUS','ASSIGN','OUTREACH','OPPORTUNITY','CONVERT','EDIT','CAMPAIGN'));
