-- ─────────────────────────────────────────────────────────────────────────────
-- TIỀN MÔ HÌNH ĐANG THẬT SỰ TỐN BAO NHIÊU — CHỈ ĐỌC.
--
-- Trình mô phỏng in "HIỆN TẠI: —" (CHƯA BIẾT). Câu hỏi bắt buộc phải trả lời trước khi ai đọc con
-- số ấy: CHƯA BIẾT vì đã gọi mô hình mà chưa khai giá, hay vì chưa gọi mô hình lần nào? Hai câu
-- trả lời dẫn tới hai việc hoàn toàn khác nhau, và gộp chúng lại là cách nhanh nhất để đi khai một
-- bảng giá cho thứ không ai dùng — hoặc tệ hơn, để tưởng mình đang tốn 0đ.
--
-- KHÔNG GHI GÌ.
-- ─────────────────────────────────────────────────────────────────────────────

\echo '── 1. LƯỢT CHẠY THEO NẤC: có bao nhiêu lượt thật sự chạm tới mô hình ──'
select
  r.tier::text                                          as nac,
  count(*)                                              as so_luot,
  count(*) filter (where r.cost_vnd is null)            as tien_chua_biet,
  count(*) filter (where r.cost_vnd = 0)                as tien_bang_0,
  coalesce(sum(r.input_tokens), 0)                      as token_vao,
  coalesce(sum(r.output_tokens), 0)                     as token_ra
from ai_runs r
where r.created_at > now() - interval '30 days'
group by 1
order by 2 desc;

\echo ''
\echo '── 2. LƯỢT GỌI MÔ HÌNH THẬT: nhà cung cấp nào, mẫu nào, có khai giá chưa ──'
\echo '   (bảng rỗng = 30 ngày qua KHÔNG gọi mô hình lần nào ⇒ tiền thật là 0 THẬT, không phải chưa biết)'
select
  c.provider,
  c.model,
  c.tier::text                                          as nac,
  count(*)                                              as so_lan,
  count(*) filter (where not c.ok)                      as so_lan_hong,
  count(*) filter (where c.cost_vnd is null)            as chua_khai_gia,
  coalesce(sum(c.cost_vnd), 0)                          as tong_tien_vnd,
  coalesce(sum(c.input_tokens), 0)                      as token_vao,
  coalesce(sum(c.output_tokens), 0)                     as token_ra,
  round(percentile_cont(0.5) within group (order by case when c.ok then c.latency_ms end)::numeric, 0) as tre_p50_ms,
  round(percentile_cont(0.95) within group (order by case when c.ok then c.latency_ms end)::numeric, 0) as tre_p95_ms,
  max(c.created_at)                                     as lan_gan_nhat
from ai_model_calls c
where c.created_at > now() - interval '30 days'
group by 1, 2, 3
order by 4 desc;

\echo ''
\echo '── 3. ĐỘ TIN CỦA BẬC LUẬT: mô phỏng báo 0 lượt "luật không kết luận được" — kiểm lại ──'
\echo '   Nếu KHÔNG có dòng nào ở cột chua_biet thì nhánh "độ tin là NULL" của phép tính độ khó'
\echo '   KHÔNG BAO GIỜ chạy trên dữ liệu thật, và con số độ khó đang chỉ do ba yếu tố khác quyết.'
select
  count(*)                                                                as so_luot,
  count(*) filter (where r.understanding->>'confidence' is null)          as chua_biet,
  count(*) filter (where (r.understanding->>'confidence')::float >= 0.75) as tu_tin,
  count(*) filter (where (r.understanding->>'confidence')::float < 0.75)  as duoi_nguong,
  count(*) filter (where r.understanding is null)                         as khong_co_phan_hieu,
  round(min((r.understanding->>'confidence')::float)::numeric, 3)         as thap_nhat,
  round(max((r.understanding->>'confidence')::float)::numeric, 3)         as cao_nhat,
  count(distinct r.understanding->>'tier')                                as so_nac_hieu,
  string_agg(distinct r.understanding->>'tier', ' · ')                    as cac_nac_hieu
from ai_runs r
where r.created_at > now() - interval '30 days';

\echo ''
\echo '── 4. BẢNG GIÁ ĐÃ KHAI CHƯA (che nội dung, chỉ đếm khoá) ──'
select
  coalesce(s.value->>'pricingVersion', '(chưa khai)')                     as phien_ban_bang_gia,
  coalesce(jsonb_array_length(coalesce(jsonb_path_query_array(s.value, '$.pricing.keyvalue().key'), '[]'::jsonb)), 0) as so_mau_da_khai_gia
from settings s
where s.key = 'ai.config';
