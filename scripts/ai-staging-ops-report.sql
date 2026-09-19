-- BÁO CÁO VẬN HÀNH SAU TRIỂN KHAI — CHỈ ĐỌC.
--
-- Ba câu hỏi của phiên này, hỏi thẳng CSDL thay vì đọc log:
--   1. cầu dao đã bật chưa, và nó có đang cắt nhầm gì không;
--   2. sổ giá đã khai chưa, và lượt gọi nào tính được tiền;
--   3. "máy xin người vào mà chưa ai nhận" đang treo bao nhiêu, bao lâu.

\echo '── 1. CẤU HÌNH AI ĐANG BẬT GÌ (chỉ đếm/in cờ, KHÔNG in nội dung nhạy cảm) ──'
select
  coalesce(value::jsonb->>'circuitBreakerEnabled', '(chưa khai)')          as cau_dao,
  coalesce(value::jsonb->>'modelCallsEnabled', '(theo biến môi trường)')   as goi_mo_hinh,
  coalesce(value::jsonb->>'pricingVersion', '(chưa khai)')                 as phien_ban_bang_gia,
  coalesce((select count(*) from jsonb_object_keys(value::jsonb->'pricing')), 0) as so_mau_da_khai_gia
from settings where key = 'ai.config';

\echo ''
\echo '── 2. LƯỢT GỌI MÔ HÌNH 30 PHÚT QUA — có ảnh chụp giá chưa ──'
select
  c.provider, c.model, c.step as buoc,
  count(*)                                               as so_lan,
  count(*) filter (where c.ok)                           as dat,
  count(*) filter (where not c.ok)                       as hong,
  count(*) filter (where c.cost_vnd is not null)         as tinh_duoc_tien,
  count(*) filter (where c.input_price_vnd_per_million is not null) as co_anh_chup_gia,
  coalesce(sum(c.input_tokens), 0)                       as token_vao,
  coalesce(sum(c.output_tokens), 0)                      as token_ra,
  round(avg(c.latency_ms) filter (where c.ok))           as tre_tb_ms
from ai_model_calls c
where c.created_at > now() - interval '30 minutes'
group by 1, 2, 3
order by 4 desc;

\echo ''
\echo '── 3. LỖI NHÀ CUNG CẤP 30 PHÚT QUA (rỗng = không lượt nào hỏng) ──'
select
  left(regexp_replace(coalesce(c.error, ''), '\s+', ' ', 'g'), 90) as loi_lo,
  count(*) as so_lan
from ai_model_calls c
where c.created_at > now() - interval '30 minutes' and not c.ok
group by 1 order by 2 desc;

\echo ''
\echo '── 4. MÁY XIN NGƯỜI VÀO MÀ CHƯA AI NHẬN ──'
\echo '   `human_takeover_at` có HAI nơi ghi nói hai điều ngược nhau; phân biệt bằng khoá người.'
select
  count(*) filter (where c.human_takeover_at is not null and c.takeover_by_user_id is null)  as chua_ai_nhan,
  count(*) filter (where c.human_takeover_at is not null and c.takeover_by_user_id is not null) as da_co_nguoi_nhan,
  round(max(extract(epoch from (now() - c.human_takeover_at)) / 60)
        filter (where c.takeover_by_user_id is null))                                        as cu_nhat_phut,
  round(avg(extract(epoch from (now() - c.human_takeover_at)) / 60)
        filter (where c.takeover_by_user_id is null))                                        as tuoi_tb_phut
from sales_conversations c;

\echo ''
\echo '   Ngưỡng hạn xử lý đã khai chưa (chưa khai ⇒ mọi dòng là CHƯA BIẾT, không phải "trong hạn"):'
select coalesce((select value from settings where key = 'work.machineHandoffSlaMinutes'), '(CHƯA KHAI)') as nguong;

\echo ''
\echo '── 5. LÝ DO MÁY XIN NGƯỜI VÀO — luật 13 đòi mọi lần chuyển người phải có mã lý do ──'
select
  coalesce(nullif(c.takeover_reason, ''), '(KHÔNG CÓ LÝ DO)') as ly_do,
  count(*) as so_hoi_thoai
from sales_conversations c
where c.human_takeover_at is not null and c.takeover_by_user_id is null
group by 1 order by 2 desc limit 10;

\echo ''
\echo '── 6. HAI CON SỐ AN TOÀN PHẢI BẰNG 0 ──'
select
  (select count(*) from sales_suggestions s where s.sent)                                     as tin_da_gui_khach,
  (select count(*) from ai_tool_calls t
     where t.tool in ('order.create_draft','order.confirm') and t.outcome = 'OK')             as don_may_da_tao;
