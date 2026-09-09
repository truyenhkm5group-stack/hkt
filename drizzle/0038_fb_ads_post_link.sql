-- IDEMPOTENT: chạy lại được sau khi một migration trước đó thất bại giữa chừng.
--
-- NỐI ĐƠN VỀ CHIẾN DỊCH QUA BÀI VIẾT.
--
-- Đo trên production: 46% đơn đã chốt có `ad_id`, nhưng 82% có `post_id`. Pancake không gửi ad_id
-- cho phần lớn đơn đến từ bình luận / nhắn tin dưới bài viết, và dữ liệu thô cũng không có (đã kiểm:
-- 0 đơn có ad_id trong raw mà thiếu ở cột).
--
-- Facebook cho biết mỗi mẩu quảng cáo quảng bá BÀI VIẾT nào. Lưu mối nối đó lại thì đơn chỉ có
-- post_id vẫn truy được về chiến dịch — bằng DỮ KIỆN CỦA FACEBOOK, không phải suy đoán.
--
-- Cố ý KHÔNG ghi ad_id suy ra ngược vào bảng đơn: đơn giữ nguyên sự thật thô của nó, phần nối được
-- tính lúc truy vấn. Ghi ngược là bịa quy kết và không thể lần lại được nữa.
ALTER TABLE "fb_ads" ADD COLUMN IF NOT EXISTS "post_id" text;--> statement-breakpoint
ALTER TABLE "fb_ads" ADD COLUMN IF NOT EXISTS "story_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fb_ads_post_idx" ON "fb_ads" USING btree ("post_id");
