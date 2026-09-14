-- Trang Vận đơn lọc theo kỳ và sắp mặc định theo ngày tạo vận đơn; năm bộ đếm facet dùng cùng vị ngữ.
-- Không có chỉ mục này là quét tuần tự shipments cho mọi lần mở trang / đổi kỳ.
CREATE INDEX IF NOT EXISTS "shipments_created_idx" ON "shipments" USING btree ("created_at");
