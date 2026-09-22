-- AI CỦA SHOP ĐANG TRẢ LỜI DƯỚI TÊN NÀO — CHỈ ĐỌC.
--
-- Chủ shop cho biết (22/09/2026) cột "Nhân viên trả lời" thực chất là một bot Gemini, không phải
-- người. Mọi con số đối chiếu "máy so với nhân viên" vì thế đang so AI với AI.
--
-- Không in nội dung tin khách (log Actions là CÔNG KHAI). Tin phía SHOP thì in được: đó là chữ
-- của chính shop, và phải nhìn thấy mới phân biệt được bot với người.

\echo ''
\echo '════════ 1. AI NÀO ĐANG GỬI, DƯỚI TÊN NÀO ════════'
select
  coalesce(nullif(m.from_name, ''), '(không tên)') as "tên người gửi",
  m.sender_type                                    as "ERP đang xếp loại",
  count(*)                                         as "số tin",
  count(distinct m.conversation_id)                as "số hội thoại",
  min(m.sent_at)                                   as "lần đầu",
  max(m.sent_at)                                   as "lần cuối"
from sales_messages m
where m.from_page
group by 1, 2
order by 3 desc
limit 30;

\echo ''
\echo '════════ 2. BAO NHIÊU TIN ĐANG BỊ TÍNH LÀ NGƯỜI ════════'
\echo '(nếu bot chiếm gần hết PAGE_HUMAN thì mọi phép đo "nhân viên" đều đang nói về máy)'
select
  count(*) filter (where sender_type = 'PAGE_HUMAN')  as "đang tính là NGƯỜI",
  count(*) filter (where sender_type = 'PAGE_BOT')    as "đã nhận ra là MÁY",
  count(*) filter (where sender_type = 'PAGE_SYSTEM') as "thông báo nền tảng",
  count(*) filter (where sender_type = 'UNKNOWN')     as "chưa rõ",
  count(*) filter (where not from_page)               as "của khách"
from sales_messages;

\echo ''
\echo '════════ 3. MẪU CÂU PHÍA SHOP — ĐỌC ĐỂ NHẬN RA GIỌNG MÁY ════════'
\echo '(câu lặp lại ở nhiều hội thoại gần như chắc chắn do máy sinh)'
select
  left(m.text, 110)                 as "câu shop gửi",
  count(*)                          as "số lần",
  count(distinct m.conversation_id) as "số hội thoại"
from sales_messages m
where m.from_page and coalesce(m.text, '') <> ''
group by 1
having count(distinct m.conversation_id) >= 3
order by 3 desc
limit 15;

\echo ''
\echo '════════ 4. CÓ ĐƠN NÀO ĐƯỢC CHỐT KHÔNG — NỀN SO SÁNH THẬT ════════'
\echo '(bot Gemini đã chạy thật với khách, nên kết cục của nó là thước đo có sẵn)'
select
  count(*)                                              as "hội thoại",
  count(*) filter (where c.order_id is not null)        as "đã lên đơn",
  count(*) filter (where c.stage = 'LOST')              as "mất",
  count(*) filter (where c.human_takeover_at is not null) as "đánh dấu người cầm"
from sales_conversations c;
