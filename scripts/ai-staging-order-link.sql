-- NỐI HỘI THOẠI VỚI ĐƠN HÀNG — ĐO ĐỘ PHỦ TRƯỚC KHI DỰNG. CHỈ ĐỌC.
--
-- `chi phí mỗi đơn` hiện không bao giờ ra số vì mẫu số là `sales_conversations.order_id`, cột chỉ
-- được điền khi CHÍNH nhân sự AI tạo đơn — mà quyền đó đang cấm. Cần một mẫu số có thật.
--
-- Pancake mang sẵn `orders.conversation_id`. Nếu nó đủ phủ thì đây là KHOÁ THẬT, không phải phép
-- quy kết theo số điện thoại (vốn luôn mơ hồ: một khách nhắn ba lần, đặt một đơn).

\echo ''
\echo '════════ 1. ĐƠN CÓ MANG MÃ HỘI THOẠI KHÔNG ════════'
select
  count(*)                                                        as "tổng đơn",
  count(*) filter (where coalesce(conversation_id,'') <> '')      as "có mã hội thoại",
  count(*) filter (where coalesce(page_id,'') <> '')              as "có mã page",
  count(*) filter (where coalesce(bill_phone,'') <> '' or coalesce(ship_phone,'') <> '') as "có SĐT",
  min(inserted_at)                                                as "đơn cũ nhất",
  max(inserted_at)                                                as "đơn mới nhất"
from orders;

\echo ''
\echo '════════ 2. NỐI ĐƯỢC BAO NHIÊU — THEO MÃ HỘI THOẠI ════════'
\echo '(khoá thật: cùng page + cùng mã hội thoại Pancake)'
select
  count(distinct c.id)                             as "hội thoại đã nạp",
  count(distinct o.id)                             as "đơn nối được",
  count(distinct c.id) filter (where o.id is not null) as "hội thoại có đơn"
from sales_conversations c
left join orders o
  on o.conversation_id = c.external_id
 and coalesce(o.page_id,'') = c.page_id;

\echo ''
\echo '════════ 3. NẾU KHÔNG CÓ MÃ — SĐT PHỦ ĐƯỢC THÊM BAO NHIÊU ════════'
\echo '(phép quy kết YẾU HƠN: một khách nhắn nhiều lần vẫn chỉ đặt một đơn)'
select
  count(*) filter (where coalesce(c.phone,'') <> '')  as "hội thoại có SĐT",
  count(*)                                            as "tổng hội thoại"
from sales_conversations c;

\echo ''
\echo '════════ 4. ĐƠN CỦA PAGE THÍ ĐIỂM, THEO NGUỒN ════════'
select
  coalesce(nullif(source,''),'(trống)') as "nguồn",
  count(*)                              as "số đơn",
  count(*) filter (where coalesce(conversation_id,'') <> '') as "có mã hội thoại"
from orders
group by 1 order by 2 desc limit 10;
