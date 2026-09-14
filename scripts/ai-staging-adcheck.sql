-- KIỂM CHÉO: bốn mã quảng cáo "CONFIRMED" có thật sự đến từ BỐN hội thoại khác nhau không?
-- Nếu chúng cùng trỏ về MỘT hội thoại thì ba tin nhân viên ấy đang được đếm bốn lần, và bốn
-- "chứng cứ xác định" thật ra chỉ là một.
\echo ''
\echo '════════ MỖI MÃ QUẢNG CÁO THUỘC NHỮNG HỘI THOẠI NÀO ════════'
select
  m.ad_id                                    as "mã quảng cáo",
  count(distinct m.conversation_id)          as "số hội thoại",
  left(string_agg(distinct left(m.conversation_id, 8), ', '), 70) as "hội thoại (rút gọn)"
from sales_messages m where m.ad_id <> '' group by m.ad_id order by 2 desc;

\echo ''
\echo '════════ HỘI THOẠI NÀO CHỨA NHIỀU MÃ QUẢNG CÁO ════════'
\echo '(> 1 nghĩa là khách bấm nhiều quảng cáo trong CÙNG một cuộc — mọi suy luận "ad này bán mã kia"'
\echo ' dựa trên tin nhân viên của cuộc ấy đều bị lẫn giữa các quảng cáo)'
select
  left(m.conversation_id, 8)                 as "hội thoại",
  count(distinct m.ad_id)                    as "số mã quảng cáo",
  string_agg(distinct m.ad_id, ', ')         as "các mã"
from sales_messages m where m.ad_id <> ''
group by m.conversation_id having count(distinct m.ad_id) > 1
order by 2 desc;

\echo ''
\echo '════════ MÃ HÀNG NHÂN VIÊN GÕ, THEO TỪNG HỘI THOẠI CÓ QUẢNG CÁO ════════'
select
  left(m.conversation_id, 8)                 as "hội thoại",
  p.custom_id                                as "mã hàng",
  count(*)                                   as "số tin nhắc"
from sales_messages m
join products p on p.custom_id <> '' and (' ' || lower(m.text) || ' ') like ('% ' || lower(p.custom_id) || ' %')
where m.sender_type = 'PAGE_HUMAN'
  and exists (select 1 from sales_messages a where a.conversation_id = m.conversation_id and a.ad_id <> '')
group by m.conversation_id, p.custom_id order by 1, 3 desc;
