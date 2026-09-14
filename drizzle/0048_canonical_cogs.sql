-- GIÁ VỐN CẢ ĐƠN VÀO CÙNG BẢNG TĂNG TỐC.
--
-- Đo trên production sau khi vật chất hoá kết quả đơn: đọc kết quả đã tính sẵn cho toàn bộ 2.431
-- dòng chỉ mất 48ms, nhưng báo cáo vẫn mất 5–10 giây. Thủ phạm còn lại là ORDER_COGS — truy vấn con
-- LỒNG HAI TẦNG: mỗi đơn duyệt từng dòng hàng, mỗi dòng hàng tra ngược phiếu nhập gần nhất.
--
-- Cùng bệnh, cùng cách chữa, và để CÙNG một bảng: chỉ một nơi dựng lại, một phép đối chiếu.
ALTER TABLE "canonical_order_outcome" ADD COLUMN IF NOT EXISTS "cogs" integer DEFAULT 0 NOT NULL;
