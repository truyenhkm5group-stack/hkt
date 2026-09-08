-- IDEMPOTENT: chạy lại được sau khi một migration trước đó thất bại giữa chừng.
--
-- ĐO TRƯỚC, SỬA SAU (TASK 16). Hai truy vấn dưới đây chạy cho TỪNG vận đơn nên chi phí tăng theo
-- bình phương khi shop lớn dần; index riêng phần khiến chúng chỉ đọc đúng phần dữ liệu cần.
--
-- 1. "Vận đơn này có sự kiện phát thành công nào của ĐVVC không?" — câu hỏi của hai luật đối soát
--    mức NGHIÊM TRỌNG (DELIVERED_WITHOUT_LOGISTICS_EVIDENCE, PAYMENT_DELIVERED_CONFLICT).
CREATE INDEX IF NOT EXISTS "shipment_events_delivered_idx" ON "shipment_events" USING btree ("shipment_id")
  WHERE "normalized_stage" = 'DELIVERED';--> statement-breakpoint
-- 2. "Đã giao, có thu hộ, chưa thấy đồng nào" — quét mỗi lần mở trang Cần xử lý và mỗi lần chạy
--    cảnh báo đòi tiền Viettel Post.
CREATE INDEX IF NOT EXISTS "shipments_cod_overdue_idx" ON "shipments" USING btree ("delivered_at")
  WHERE "stage" = 'DELIVERED' AND "cod_collected" = 0;
