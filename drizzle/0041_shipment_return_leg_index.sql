-- IDEMPOTENT: chạy lại được sau khi một migration trước đó thất bại giữa chừng.
--
-- ĐO TRƯỚC, SỬA SAU. Bằng chứng (EXPLAIN ANALYZE trên bộ dữ liệu 4.802 vận đơn, xem
-- docs/erp-performance-p0-report.md):
--
--   SubPlan 9 → Seq Scan on shipments leg (actual time=0.316 rows=0 loops=3245)
--               Filter: (id <> shipments.id) AND (order_reference = shipments.vtp_order_number)
--               Rows Removed by Filter: 4802 · Buffers: shared hit=460790
--
-- `HAS_RETURN_LEG` trong ORDER_OUTCOME hỏi "có vận đơn nào trỏ ngược về mã này không?" cho TỪNG
-- dòng. Câu hỏi đó KHÔNG kèm điều kiện stage/COD nên index riêng phần `shipments_return_leg_idx`
-- (chỉ phủ stage='DELIVERED' AND cod_amount=0) không dùng được, và Postgres phải quét toàn bảng
-- vận đơn cho mỗi dòng: chi phí tăng theo BÌNH PHƯƠNG số vận đơn. Một lần dựng trang Chất lượng
-- dữ liệu chạy bảy lần quét như vậy.
--
-- Index này chỉ phủ các dòng CÓ order_reference (vận đơn chiều về + vận đơn ngoài Pancake), nên
-- rất nhỏ so với bảng và không làm chậm ghi đáng kể.
CREATE INDEX IF NOT EXISTS "shipments_order_reference_lookup_idx" ON "shipments" USING btree ("order_reference")
  WHERE "order_reference" IS NOT NULL;
