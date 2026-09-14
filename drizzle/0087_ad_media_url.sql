-- Ảnh của đính kèm quảng cáo — để NGƯỜI nhìn ra mẫu hàng trên màn hình ánh xạ.
-- Danh mục page này đặt tên sản phẩm bằng chính mã hàng ("Đầm Q004", "ĐẦM Q005"), còn quảng cáo
-- viết theo lối tiếp thị ("TINH KHÔI", "ĐẦM ĐỎ ĐÔ"). Hai vốn từ ấy không bao giờ khớp nhau bằng
-- chữ, nên người phải NHÌN mới trỏ đúng được — một dòng chữ không đủ.
-- THUẦN BỔ SUNG, một cột, chỉ chạm bảng do nền tảng AI sở hữu.
ALTER TABLE "sales_messages" ADD COLUMN "ad_media_url" text DEFAULT '' NOT NULL;
