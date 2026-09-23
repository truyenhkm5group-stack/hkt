-- ═══════════ MỐC NHẬN HÀNG TỪ XƯỞNG — CÁI THIẾU LÀM KHÔNG ĐO ĐƯỢC ĐỘ TIN CỦA XƯỞNG ═══════════
--
-- `production_orders` có mốc HẸN (`due_date`) và mốc GỬI (`sent_at`), nhưng lúc hàng về thì `status`
-- chỉ đổi sang `RECEIVED` mà KHÔNG ghi thời điểm. Hệ quả đo được (bảng năng lực AI, nấc CHẨN ĐOÁN
-- của phòng Sản xuất): máy không phân biệt được **"hết hàng vì bán nhanh"** với **"hết hàng vì xưởng
-- giao trễ"** — hai nguyên nhân cần hai cách xử lý khác nhau, mà cùng hiện ra là một dòng cảnh báo.
--
-- Chủ shop chốt quy trình 23/09/2026: **KHO là người bấm, và bấm LÚC ĐẾM XONG** — không phải lúc xe
-- tới cổng. Nên mốc này là LỜI KHAI CỦA NGƯỜI ĐẾM, không phải một sự kiện suy ra từ trạng thái.
--
-- ─── KHÔNG BACKFILL, VÀ ĐÓ LÀ CHỦ Ý (AGENTS.md mục 35) ───
--
-- Các lệnh đã ở `RECEIVED` từ trước giữ `received_at = NULL`. Lấy `updated_at` làm mốc nhận là BỊA:
-- dòng đó đã bị sửa vì nhiều lý do khác nhau, và một con số trông hợp lý sẽ đi thẳng vào phép đo
-- "xưởng trễ mấy ngày" mà không ai kiểm lại được. `NULL` ở đây đọc là CHƯA BIẾT, và nó đúng.
--
-- Vì thế phép đo độ tin của xưởng chỉ bắt đầu có nghĩa sau vài tuần dữ liệu mới — bảng năng lực AI
-- khai đúng như vậy thay vì tô xanh nấc CHẨN ĐOÁN ngay hôm nay.
--
-- `received_by_user_id` là KHOÁ TÀI KHOẢN (mục 34); `received_by` chỉ là ảnh chụp tên để người đọc,
-- do MÁY CHỦ đọc từ `users` chứ không nhận từ client.

ALTER TABLE "production_orders" ADD COLUMN IF NOT EXISTS "received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "production_orders" ADD COLUMN IF NOT EXISTS "received_by_user_id" text;--> statement-breakpoint
ALTER TABLE "production_orders" ADD COLUMN IF NOT EXISTS "received_by" text DEFAULT '' NOT NULL;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_received_by_user_id_users_id_fk"
    FOREIGN KEY ("received_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- Truy vấn "xưởng trễ mấy ngày" lọc theo lệnh ĐÃ NHẬN và có mốc hẹn; chỉ mục đi theo đúng hình dạng đó.
CREATE INDEX IF NOT EXISTS "production_orders_received_idx" ON "production_orders" USING btree ("received_at","due_date");
