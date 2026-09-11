-- ═══════ KHẢ NĂNG TRA CỨU CỦA TỪNG VẬN ĐƠN ═══════
--
-- Đo được 11/09/2026: nguồn VTP_POLL sinh ra 0 sự kiện từ trước tới nay, trong khi sync_runs ghi
-- "tài khoản API Viettel Post không thấy bất kỳ vận đơn nào — lượt thứ 548 liên tiếp". Vận đơn do
-- Pancake tạo thuộc một tài khoản VTP khác.
--
-- ERP vẫn đều đặn gọi một API không bao giờ trả về gì. Không sai số liệu, nhưng tốn request, tốn
-- thời gian job và làm log đầy tiếng ồn che mất lỗi thật.
--
-- Kết luận theo TỪNG VẬN ĐƠN, không theo tài khoản: ngày shop trỏ ERP về đúng tài khoản thì vận
-- đơn mới tự được xếp lại đúng.
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "tracking_capability" text DEFAULT 'UNKNOWN_CAPABILITY' NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN IF NOT EXISTS "capability_probes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipments_capability_idx" ON "shipments" USING btree ("tracking_capability","is_final");--> statement-breakpoint
-- Vận đơn ĐÃ CÓ sự kiện webhook nhưng CHƯA BAO GIỜ có sự kiện từ tra cứu API: bằng chứng đã đủ để
-- kết luận ngay, khỏi bắt bộ tra cứu đi thử lại từ đầu 486 lần.
UPDATE "shipments" s
   SET "tracking_capability" = 'WEBHOOK_ONLY', "capability_probes" = 3
 WHERE s."is_final" = false
   AND EXISTS (SELECT 1 FROM "shipment_events" e WHERE e."shipment_id" = s."id" AND e."source" = 'VTP_WEBHOOK')
   AND NOT EXISTS (SELECT 1 FROM "shipment_events" e WHERE e."shipment_id" = s."id" AND e."source" = 'VTP_POLL');
