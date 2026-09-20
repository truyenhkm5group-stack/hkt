-- LÚC MỘT CON NGƯỜI THẬT SỰ NHẬN VIỆC — tách khỏi lúc MÁY xin người vào.
--
-- `human_takeover_at` có HAI nơi ghi và trả lời hai câu khác nhau:
--   · máy gọi `conversation.handoff` ⇒ "việc này bắt đầu chờ người từ lúc nào";
--   · nhân viên tự nhận việc         ⇒ "người cầm từ lúc nào".
--
-- Gộp hai nghĩa vào một ô thì không đo được thứ đáng đo nhất: KHÁCH ĐÃ CHỜ BAO LÂU trước khi có
-- người. Đo 19/09/2026: 202 việc máy xin người vào, tuổi trung bình 18 giờ, cũ nhất 4,2 ngày — và
-- không có cách nào biết trong số đó bao nhiêu đã từng được ai cầm rồi trả lại.
--
-- CỘNG THÊM MỘT CỘT NULLABLE. Không backfill: không ai biết những việc cũ được nhận lúc nào, và
-- điền một mốc vào đó là bịa ra lịch sử. NULL = chưa ai nhận, và đó là câu trả lời đúng.
alter table "sales_conversations" add column if not exists "takeover_claimed_at" timestamp with time zone;
--> statement-breakpoint
-- Tra "việc đang chờ người, xếp theo tuổi" — đúng câu hỏi của hàng đợi vận hành.
create index if not exists "sales_conversations_unclaimed_idx"
  on "sales_conversations" ("human_takeover_at")
  where "takeover_by_user_id" is null;
