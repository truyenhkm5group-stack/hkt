-- ═══════ FANPAGE LỊCH SỬ PHẢI QUẢN LÝ ĐƯỢC KHI KHÔNG CÒN QUYỀN ĐỌC TÊN ═══════
--
-- CHỈ CỘNG THÊM HAI CỘT NULLABLE/CÓ MẶC ĐỊNH vào `fanpages`. Không đổi kiểu, không xoá cột, không
-- đổi tên, không đụng một dòng dữ liệu nào. Viết tay và idempotent như 0033–0088.
--
-- VÌ SAO. Đo trên production 15/09/2026: 7/15 fanpage chưa gán marketer, và CẢ BẢY đều có `name`
-- rỗng — chúng không nằm trong danh sách 20 page mà token Pancake hiện đọc được. Màn hình khai báo
-- vì thế chỉ hiện một dãy 15 chữ số, không ai nhận ra page nào để gán. 129 đơn treo ở đó.
--
-- Việc gán marketer KHÔNG được phụ thuộc vào việc API còn đọc được tên: quy kết đi bằng `page_id`,
-- và `page_id` thì nằm sẵn trên từng đơn. Thứ thiếu chỉ là một cái tên cho NGƯỜI đọc.
--
-- HAI TRƯỜNG, HAI NGUỒN, KHÔNG TRƯỜNG NÀO ĐÈ TRƯỜNG NÀO:
--   · `name`  — tên do API Pancake trả về (đã có từ 0086), đồng bộ ghi;
--   · `alias` — tên do NGƯỜI đặt, đồng bộ KHÔNG bao giờ chạm tới.
-- Ngày nào lấy lại được quyền đọc page, `name` cập nhật trở lại mà tên người đã đặt vẫn còn.

ALTER TABLE "fanpages" ADD COLUMN IF NOT EXISTS "alias" text NOT NULL DEFAULT '';--> statement-breakpoint

-- Mốc lần gần nhất Pancake CÒN liệt kê page này. `NULL` = chưa bao giờ thấy trong danh sách API.
-- So với mốc LỚN NHẤT của cả bảng là suy ra được trạng thái truy cập, không cần bảng trạng thái
-- riêng — và một lần API lỗi không làm page nào bị kết luận nhầm là "mất quyền", vì lúc đó không
-- dòng nào được cập nhật nên mốc lớn nhất cũng đứng yên.
ALTER TABLE "fanpages" ADD COLUMN IF NOT EXISTS "last_seen_in_api_at" timestamp with time zone;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "fanpages_last_seen_idx" ON "fanpages" ("last_seen_in_api_at");
