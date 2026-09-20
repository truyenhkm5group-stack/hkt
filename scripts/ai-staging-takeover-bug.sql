-- NGƯỜI CÓ BẤM "NHẬN VIỆC" KHÔNG, VÀ LƯỢT BẤM ẤY CÓ ĂN KHÔNG. CHỈ ĐỌC.
--
-- 202 việc chưa ai nhận / 0 việc đã nhận có hai cách giải thích rất khác nhau:
--   A. KHÔNG AI BẤM — vấn đề là con người / quy trình / khả năng nhìn thấy.
--   B. CÓ NGƯỜI BẤM MÀ KHÔNG ĂN — vấn đề là một con bug, và mọi lời nhắc nhở đều vô ích.
--
-- Phân biệt được vì mỗi lượt bấm ghi một dòng `sales_copilot_actions` với `action = 'TAKEOVER'`,
-- ĐỘC LẬP với việc `sales_conversations.takeover_by_user_id` có được ghi hay không.

\echo '── 1. CÓ AI BẤM "NHẬN VIỆC" BAO GIỜ CHƯA ──'
select
  action                                          as thao_tac,
  count(*)                                        as so_lan,
  count(distinct conversation_id)                 as so_hoi_thoai,
  count(distinct actor_user_id)                   as so_nguoi,
  max(created_at)                                 as gan_nhat
from sales_copilot_actions
group by 1 order by 2 desc;

\echo ''
\echo '── 2. PHÁN XÉT: bấm rồi mà hội thoại vẫn "chưa ai nhận"? ──'
with da_bam as (
  select distinct conversation_id from sales_copilot_actions where action = 'TAKEOVER'
)
select
  (select count(*) from da_bam)                                                        as hoi_thoai_da_co_nguoi_bam,
  (select count(*) from da_bam d join sales_conversations c on c.id = d.conversation_id
     where c.takeover_by_user_id is not null)                                          as trong_do_da_ghi_duoc_chu,
  (select count(*) from da_bam d join sales_conversations c on c.id = d.conversation_id
     where c.takeover_by_user_id is null)                                              as trong_do_VAN_khong_co_chu,
  case
    when (select count(*) from da_bam) = 0
      then 'A — KHÔNG AI BẤM. Vấn đề là quy trình/khả năng nhìn thấy, không phải bug.'
    when (select count(*) from da_bam d join sales_conversations c on c.id = d.conversation_id
            where c.takeover_by_user_id is null) > 0
      then '⛔ B — CÓ NGƯỜI BẤM MÀ KHÔNG ĂN. Đây là một con bug; mọi lời nhắc nhở đều vô ích.'
    else 'Bấm được và ghi được — 0 việc đã nhận đến từ nguyên nhân khác.'
  end                                                                                  as phan_xet;

\echo ''
\echo '── 3. CHI TIẾT VÀI HỘI THOẠI ĐÃ BẤM MÀ VẪN KHÔNG CÓ CHỦ ──'
select
  left(c.id, 12)                                                                       as hoi_thoai,
  left(coalesce(c.takeover_reason, ''), 42)                                            as ly_do_may_xin,
  c.takeover_by_user_id                                                                as chu_viec,
  count(a.id)                                                                          as so_lan_bam,
  max(a.created_at)                                                                    as lan_bam_gan_nhat
from sales_conversations c
join sales_copilot_actions a on a.conversation_id = c.id and a.action = 'TAKEOVER'
where c.takeover_by_user_id is null
group by 1, 2, 3
order by 4 desc
limit 10;
