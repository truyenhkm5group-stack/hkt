-- Dòng thời gian của đơn tra nhật ký theo entity_id (mã đơn + mã các vận đơn). Không có chỉ mục này
-- là quét tuần tự bảng audit_logs — bảng tăng nhanh nhất CSDL — mỗi lần mở chi tiết đơn.
CREATE INDEX IF NOT EXISTS "audit_entity_id_idx" ON "audit_logs" USING btree ("entity_id","created_at");
