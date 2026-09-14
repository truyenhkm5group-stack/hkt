-- IDEMPOTENT: chạy lại được sau khi một migration trước đó thất bại giữa chừng.
--
-- CHỨNG TỪ ĐVVC CHÉP TAY được phép mang dấu VERIFIED.
--
-- `shipment_events_verified_check` buộc mọi dòng đánh dấu VERIFIED phải nêu rõ ai xác minh, lúc
-- nào, và đến từ nguồn nào. Ràng buộc đó đã làm đúng việc của nó: lần ghi lô chép tay đầu tiên bị
-- chặn vì thiếu `verified_at` / `verified_by`. Nay bổ sung `VTP_UI_MANUAL_VERIFICATION` vào danh
-- sách nguồn hợp lệ — chủ shop mở trang Viettel Post đọc trạng thái rồi chép lại VẪN là chứng từ
-- của ĐVVC, chỉ đi qua mắt người, và vẫn phải khai đủ ai/lúc nào như mọi nguồn khác.
--
-- Cố ý KHÔNG nới các điều kiện còn lại: vẫn phải có `normalized_stage` khác UNKNOWN, `leg_type`
-- rõ chiều đi/hoàn, `source_reference` (mã lô) và `verified_by` không rỗng.
--
-- NOT VALID: chỉ áp cho dòng mới, không quét lại toàn bảng lịch sử.
DO $$
BEGIN
  ALTER TABLE "shipment_events" DROP CONSTRAINT IF EXISTS "shipment_events_verified_check";
  ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_verified_check" CHECK (
    "shipment_events"."verification_status" IS DISTINCT FROM 'VERIFIED' OR (
      "shipment_events"."normalized_stage" IS NOT NULL AND "shipment_events"."normalized_stage" <> 'UNKNOWN'
      AND "shipment_events"."leg_type" IS NOT NULL AND "shipment_events"."leg_type" IN ('OUTBOUND', 'RETURN')
      AND "shipment_events"."source" IN ('VTP_WEBHOOK', 'VTP_POLL', 'VTP_IMPORT', 'MANUAL', 'VTP_UI_MANUAL_VERIFICATION')
      AND "shipment_events"."source_reference" IS NOT NULL AND length(trim("shipment_events"."source_reference")) > 0
      AND "shipment_events"."verified_at" IS NOT NULL
      AND "shipment_events"."verified_by" IS NOT NULL AND length(trim("shipment_events"."verified_by")) > 0)
  ) NOT VALID;
END $$;
