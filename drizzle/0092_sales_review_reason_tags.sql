-- LÝ DO CHẤM: TỪ MỘT Ô CHỮ THÀNH MỘT DANH SÁCH ĐẾM ĐƯỢC.
--
-- Màn hình soát đã có ba nấc cho HÀNH ĐỘNG KẾ TIẾP và chín ô đúng/sai cho từng chiều. Thiếu đúng
-- một thứ: sau ba mươi lượt chấm, không ai trả lời được "máy hay hỏng ở đâu NHẤT". Ô ghi chú tự do
-- ghi được mọi thứ nhưng đếm được không thứ gì.
--
-- HAI CỘT, HAI VIỆC KHÁC NHAU
--
-- `verdict`      — kết luận CHUNG cho cả lượt: gửi được nguyên văn / sửa nhẹ là gửi được / không
--                  gửi được. Khác hẳn `next_action_quality`, vốn chỉ chấm VIỆC máy chọn làm: máy
--                  có thể chọn đúng việc (hỏi size) mà câu chữ vẫn không gửi được.
-- `reason_tags`  — vì sao, theo một DANH SÁCH ĐÓNG khai ở `lib/constants/sales-review-tags.ts`.
--                  Mỗi nhãn khai luôn ai phải đi sửa (MODEL · DATA · POLICY), vì đó mới là thứ
--                  biến một bảng đếm thành một việc. Nhãn để ĐẾM, ghi chú để HIỂU — không cái nào
--                  thay cái nào, nên cột `note` giữ nguyên.
--
-- NULL LÀ CHƯA CHẤM, KHÔNG PHẢI "TẠM ĐƯỢC"
--
-- `verdict` để NULL và `reason_tags` mặc định MẢNG RỖNG. Một lượt chưa ai mở ra xem phải đọc ra
-- "chưa chấm" ở mọi màn hình tổng hợp — y như mọi ô đúng/sai đã có.
--
-- Không backfill: không dòng nào đang có được đoán một kết luận.

alter table "sales_review_labels" add column if not exists "verdict" text;--> statement-breakpoint
alter table "sales_review_labels" add column if not exists "reason_tags" jsonb not null default '[]'::jsonb;--> statement-breakpoint

-- Danh sách ĐÓNG được chặn ở CSDL, không chỉ ở lược đồ đầu vào: một chuỗi lạ lọt vào đây thì mọi
-- bảng đếm sau này phải chọn giữa bỏ qua nó và hiện một nhãn không ai hiểu.
alter table "sales_review_labels" drop constraint if exists "sales_review_labels_verdict_check";--> statement-breakpoint
alter table "sales_review_labels" add constraint "sales_review_labels_verdict_check"
  check ("verdict" is null or "verdict" in ('GOOD', 'ACCEPTABLE', 'BAD'));--> statement-breakpoint

-- Mảng phải LÀ một mảng. Một chuỗi hay một object lọt vào thì mọi phép đếm bên dưới đều sai thầm.
alter table "sales_review_labels" drop constraint if exists "sales_review_labels_reason_tags_check";--> statement-breakpoint
alter table "sales_review_labels" add constraint "sales_review_labels_reason_tags_check"
  check (jsonb_typeof("reason_tags") = 'array');--> statement-breakpoint

create index if not exists "sales_review_labels_verdict_idx" on "sales_review_labels" ("verdict", "reviewed_at");
