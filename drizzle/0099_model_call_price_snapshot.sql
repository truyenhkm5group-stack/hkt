-- ẢNH CHỤP ĐƠN GIÁ TRÊN TỪNG LƯỢT GỌI MÔ HÌNH.
--
-- VẤN ĐỀ: `ai_model_calls.pricing_version` nói ta đã dùng BẢNG GIÁ NÀO, nhưng bảng giá nằm trong
-- `settings` và bị GHI ĐÈ khi chủ shop khai giá mới. Chỉ có phiên bản thì tháng sau không ai dựng
-- lại được con số cũ: cái nhãn còn đó, nội dung đã khác.
--
-- Ba cột dưới đây là CHÍNH đơn giá đã dùng lúc gọi. Nhà cung cấp đổi giá tháng sau, lịch sử vẫn
-- tính đúng theo giá lúc gọi — và không ai phải "sửa lại" chi phí lịch sử, một việc mà luật
-- không-sửa-kỳ-đã-chốt của kho mã vốn đã cấm.
--
-- NULL = lượt ấy chưa khai đơn giá ⇒ `cost_vnd` cũng phải NULL. KHÔNG BAO GIỜ là 0: "chưa biết
-- tốn bao nhiêu" và "tốn 0 đồng" là hai câu khác nhau (luật 42).
--
-- KHÔNG BACKFILL. 660 lượt gọi đã có trong bảng chạy trước khi có ba cột này, và không ai biết
-- đơn giá lúc ấy là bao nhiêu — vì chưa từng khai giá lần nào. Điền một con số vào đó là bịa ra
-- một lịch sử. Chúng giữ nguyên NULL, và bất kỳ phép tính lại nào trên chúng phải mang nhãn
-- ESTIMATED_WITH_CURRENT_PRICE chứ không được gọi là chi phí thật.
alter table "ai_model_calls" add column if not exists "input_price_vnd_per_million" integer;
--> statement-breakpoint
alter table "ai_model_calls" add column if not exists "cached_input_price_vnd_per_million" integer;
--> statement-breakpoint
alter table "ai_model_calls" add column if not exists "output_price_vnd_per_million" integer;
--> statement-breakpoint
alter table "ai_model_calls" add column if not exists "currency" text not null default 'VND';
