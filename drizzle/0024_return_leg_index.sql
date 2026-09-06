-- IDEMPOTENT: chạy lại được sau khi một migration trước đó thất bại giữa chừng.
-- Index cho truy vấn con dò vận đơn chiều về. Chỉ thêm index, không đổi dữ liệu.
CREATE INDEX IF NOT EXISTS "shipments_return_leg_idx" ON "shipments" USING btree ("order_reference","vtp_order_number") WHERE "shipments"."stage" = 'DELIVERED' and "shipments"."cod_amount" = 0;