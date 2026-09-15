-- ═══════ NGÀY KHÁCH HẸN GIAO: TÁCH "ĐƠN CÓ HẸN" KHỎI "ĐƠN BỊ BỎ QUÊN" ═══════
--
-- VẤN ĐỀ. Khách chốt mua hôm nay nhưng xin giao ngày 20 ("giờ em đi công tác"). ERP không có chỗ
-- nào ghi lời hẹn đó, nên luật `ORDER_CONFIRMATION_STALE` (24 giờ) và hàng đợi nút thắt kho đều
-- đếm đơn ấy là TRỄ HẠN từ ngày thứ hai. Người trực phải nhớ trong đầu đơn nào là hẹn thật — và
-- một hàng đợi mà người dùng phải nhớ "cái này không tính" là hàng đợi sẽ bị bỏ qua cả cụm.
--
-- KHÔNG PHẢI `shipments.expected_delivery`. Cột kia là ETA do Viettel Post trả về — DỰ BÁO CỦA
-- ĐVVC về chuyến hàng, có SAU khi vận đơn tồn tại. Cột này là LỜI HỨA VỚI KHÁCH, có TRƯỚC đó.
--
-- LƯU MỘT MỐC THẬT, KHÔNG LƯU NGÀY TRẦN. Khách hẹn "ngày 20" nghĩa là "phải tới tay trong ngày 20
-- giờ Việt Nam", nên giá trị lưu là CUỐI ngày 20 theo giờ VN (`vnEndOfDay` ở lib/format.ts). Kiểu
-- `date` trần buộc mỗi nơi đọc phải tự chọn múi giờ, và nửa đêm là chỗ sai đầu tiên.
--
-- AN TOÀN KHI ÁP:
--   · Bốn cột đều NULLABLE (trừ ô ghi chú có mặc định chuỗi rỗng) ⇒ `ADD COLUMN` không viết lại
--     bảng và không khoá lâu trên Postgres 11+.
--   · KHÔNG backfill, KHÔNG đặt mặc định cho mốc hẹn (AGENTS.md mục 35): dòng cũ không có lời hẹn
--     nào, và `NULL` ở đây nghĩa là "khách KHÔNG hẹn ngày", không phải "hẹn hôm nay".
--   · Chỉ mục RIÊNG PHẦN: đơn có hẹn là thiểu số tuyệt đối, nên chỉ mục chỉ chứa dòng có lời hẹn.
--   · Đồng bộ Pancake KHÔNG đụng tới bốn cột này: `upsertOrder` ghi theo một danh sách trường
--     tường minh (`orderData` trong lib/integrations/pancake/sync.ts), nên cột mới không nằm trong
--     mệnh đề `set` của `ON CONFLICT` và sống sót qua mọi lượt đồng bộ.
--
-- TƯƠNG THÍCH NGƯỢC: bản ứng dụng CŨ không đọc bốn cột này và vẫn chạy bình thường sau khi áp, nên
-- migration đi TRƯỚC mã ứng dụng được (thứ tự deploy an toàn).

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "customer_promised_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "customer_promised_note" text DEFAULT '' NOT NULL;
--> statement-breakpoint
-- Quy kết đi bằng KHOÁ TÀI KHOẢN, không bằng ô chữ (AGENTS.md mục 34). `ON DELETE SET NULL`: xoá
-- một tài khoản KHÔNG được xoá lời hẹn với khách — chỉ mất dấu ai đã ghi nó.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "customer_promised_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "customer_promised_set_at" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_promised_by_user_id_users_id_fk"
    FOREIGN KEY ("customer_promised_by_user_id") REFERENCES "public"."users"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_promised_idx" ON "orders" ("customer_promised_at")
  WHERE "customer_promised_at" IS NOT NULL;
