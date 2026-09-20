-- ẢNH CHỤP AN TOÀN BẢN CHẠY THỬ — CHỈ ĐỌC, KHÔNG GHI MỘT DÒNG NÀO.
--
-- Bảy câu hỏi của P0, hỏi thẳng CSDL. Mỗi khối in ra một PHÁN XÉT chứ không chỉ một con số:
-- một bảng số trần dễ bị đọc thành điều người đọc đang mong.

\echo '── 1. CẦU DAO + CỜ AI ──'
select
  coalesce(value::jsonb->>'circuitBreakerEnabled', '(chưa khai)')                  as cau_dao,
  coalesce(value::jsonb->>'modelCallsEnabled', '(theo biến môi trường)')           as goi_mo_hinh,
  coalesce(value::jsonb->>'autoReplyEnabled', '(theo mặc định)')                   as tu_tra_loi,
  coalesce(value::jsonb->>'pricingVersion', '(chưa khai)')                         as bang_gia,
  coalesce((select count(*) from jsonb_object_keys(value::jsonb->'pricing')), 0)   as so_mau_co_gia
from settings where key = 'ai.config';

\echo ''
\echo '── 2. HAI CON SỐ AN TOÀN PHẢI BẰNG 0 ──'
select
  (select count(*) from sales_suggestions where sent)                                      as tin_da_gui_khach,
  (select count(*) from ai_tool_calls
     where tool in ('order.create_draft','order.confirm') and outcome = 'OK')               as don_may_tu_tao,
  case when (select count(*) from sales_suggestions where sent) = 0
        and (select count(*) from ai_tool_calls
               where tool in ('order.create_draft','order.confirm') and outcome = 'OK') = 0
       then 'ĐẠT — máy chưa chạm tới khách hay tới đơn lần nào'
       else '⛔ CÓ DẤU VẾT — đọc kỹ trước khi làm gì tiếp' end                              as phan_xet;

\echo ''
\echo '── 3. SỨC KHOẺ NHÀ CUNG CẤP (24 giờ) ──'
select
  provider, model,
  count(*)                                        as so_lan,
  count(*) filter (where ok)                      as dat,
  count(*) filter (where not ok)                  as hong,
  round(100.0 * count(*) filter (where not ok) / nullif(count(*), 0), 1) as pct_hong,
  round(avg(latency_ms) filter (where ok))        as tre_tb_ms,
  max(created_at)                                 as lan_gan_nhat
from ai_model_calls
where created_at > now() - interval '24 hours'
group by 1, 2 order by 3 desc;

\echo ''
\echo '   Lỗi 24 giờ qua (rỗng = không lượt nào hỏng):'
select left(regexp_replace(coalesce(error,''), '\s+', ' ', 'g'), 80) as loi, count(*) as so_lan
from ai_model_calls where created_at > now() - interval '24 hours' and not ok
group by 1 order by 2 desc limit 5;

\echo ''
\echo '── 4. BỘ NẠP TIN — lượt nạp gần nhất và kết cục ──'
select
  source                                          as nguon,
  status                                          as ket_cuc,
  count(*)                                        as so_luot,
  max(finished_at)                                as gan_nhat
from sync_runs
where started_at > now() - interval '24 hours'
group by 1, 2 order by 4 desc nulls last limit 8;

\echo ''
\echo '   Tin nhắn mới nạp được trong 24 giờ (0 = bộ nạp đang đứng):'
select
  count(*)                                        as tin_moi,
  max(sent_at)                                    as tin_gan_nhat,
  round(extract(epoch from (now() - max(sent_at))) / 60)  as phut_ke_tu_tin_cuoi
from sales_messages where created_at > now() - interval '24 hours';

\echo ''
\echo '── 5. LƯỢT CHẠY NHÂN SỰ AI (24 giờ) — nấc và kết cục ──'
select
  tier::text as nac, status, count(*) as so_luot
from ai_runs where created_at > now() - interval '24 hours'
group by 1, 2 order by 3 desc;
