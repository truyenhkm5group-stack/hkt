-- KHẢO SÁT TRƯỚC KHI BẬT THÍ ĐIỂM — CHỈ ĐỌC, KHÔNG GHI MỘT DÒNG NÀO.
--
-- Bốn câu hỏi phải trả lời bằng dữ liệu của bản ĐANG CHẠY:
--   1. Page thí điểm có bao nhiêu hội thoại, và bao nhiêu hội thoại có tin khách THẬT?
--   2. Có hội thoại NỘI BỘ / KIỂM THỬ nào không (danh sách trắng `AI_TEST_CONVERSATION_IDS`)?
--   3. Hàng đợi sẽ gồm những gì nếu bật ngay bây giờ?
--   4. Nguồn WIN / TEST phân bố ra sao?

\echo '── 1. Hội thoại trên page thí điểm ──'
select
  count(*)::int                                                                as tong_hoi_thoai,
  count(*) filter (where human_takeover_at is not null)::int                    as dang_co_nguoi_cam,
  count(*) filter (where order_id is not null)::int                             as da_co_don,
  count(distinct source_type)                                                   as so_loai_nguon
from sales_conversations where page_id = '1117899664739453';

\echo '── 2. Phân bố nguồn & giai đoạn ──'
select coalesce(nullif(source_type,''),'(trống)') as nguon, stage, count(*)::int as n
from sales_conversations where page_id = '1117899664739453'
group by 1,2 order by 3 desc limit 12;

\echo '── 3. Hội thoại CÓ TIN KHÁCH THẬT, mới nhất trước ──'
select c.id, coalesce(nullif(c.source_type,''),'?') as nguon, c.stage,
       left(coalesce(t.text,''), 60) as tin_khach_cuoi,
       t.sent_at,
       (select count(*)::int from sales_messages m where m.conversation_id = c.id and m.from_page = false) as so_tin_khach
from sales_conversations c
join lateral (
  select text, sent_at from sales_messages
  where conversation_id = c.id and from_page = false and btrim(text) <> ''
  order by sent_at desc nulls last limit 1
) t on true
where c.page_id = '1117899664739453'
order by t.sent_at desc nulls last
limit 15;

\echo '── 4. Loại người gửi đã ghi nhận (để biết tin hệ thống có bị lẫn vào không) ──'
select coalesce(nullif(m.sender_type,''),'(trống)') as loai_nguoi_gui, m.from_page, count(*)::int as n
from sales_messages m
join sales_conversations c on c.id = m.conversation_id
where c.page_id = '1117899664739453'
group by 1,2 order by 3 desc;

\echo '── 5. Gợi ý đang chờ xử lý (chưa ai bấm gì) ──'
select count(*)::int as goi_y_chua_xu_ly
from sales_suggestions s
join sales_conversations c on c.id = s.conversation_id
where c.page_id = '1117899664739453'
  and btrim(s.suggested_reply) <> '' and s.evaluation_only = false
  and not exists (
    select 1 from sales_copilot_actions a
    where a.suggestion_id = s.id and a.action in ('SEND','EDIT_SEND','REJECT') and a.send_status <> 'FAILED'
  );
