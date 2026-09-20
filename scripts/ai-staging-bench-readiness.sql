-- SẴN SÀNG ĐỐI CHỨNG TỚI ĐÂU — CHỈ ĐỌC, KHÔNG GỌI MÔ HÌNH NÀO.
--
-- Bốn câu hỏi của phiên 20/09/2026 gộp vào một lượt, vì cả bốn đều bị chặn bởi CÙNG một thứ:
-- chưa có nhãn người chấm.
--
--   · Bộ đối chứng có bao nhiêu dòng, và bao nhiêu dòng CÓ CĂN CỨ (nói được lỗi ở đâu)?
--   · Nhánh chỉ-luật đúng bao nhiêu phần so với người? (chỉ trả lời được khi có nhãn)
--   · Sổ giá đã khai chưa, và bao nhiêu lượt gọi tính được thành tiền?
--   · Cầu dao đã cắt nhầm gì chưa?
--
-- MỌI CON SỐ Ở ĐÂY ĐỀU LÀ SỐ QUAN SÁT ĐƯỢC. Không ô nào là ước tính, và chỗ nào chưa biết thì
-- in ra CHƯA BIẾT chứ không in 0.

\echo '── 1. NHÃN NGƯỜI CHẤM: bộ đối chứng đang có bao nhiêu dòng ──'
\echo '   `co_can_cu` = có kết luận CHUNG **và** (lý do đóng hoặc câu "đáng lẽ phải làm gì").'
\echo '   Chỉ những dòng ấy mới so được hai mô hình trên cùng một lượt; dòng chỉ có một cái tích'
\echo '   nói được "có lỗi" mà không nói được lỗi ở đâu.'
select
  count(*)                                                                             as tong_dong_cham,
  count(*) filter (where coalesce(verdict, '') <> '')                                  as co_ket_luan,
  count(*) filter (where verdict = 'GOOD')                                             as dat,
  count(*) filter (where verdict = 'ACCEPTABLE')                                       as tam_duoc,
  count(*) filter (where verdict = 'BAD')                                              as khong_dat,
  count(*) filter (where coalesce(verdict, '') <> ''
                     and (jsonb_array_length(coalesce(reason_tags, '[]'::jsonb)) > 0
                          or length(trim(coalesce(expected_behavior, ''))) > 0))        as co_can_cu,
  count(distinct conversation_id)                                                      as so_hoi_thoai,
  max(created_at)                                                                      as cham_gan_nhat
from sales_review_labels;

\echo ''
\echo '── 2. PHÁN XÉT CỠ MẪU — bốn mức, ranh giới ở lib/constants/review-benchmark.ts ──'
with n as (
  select count(*) filter (where coalesce(verdict, '') <> ''
                            and (jsonb_array_length(coalesce(reason_tags, '[]'::jsonb)) > 0
                                 or length(trim(coalesce(expected_behavior, ''))) > 0)) as co_can_cu
  from sales_review_labels
)
select
  co_can_cu                                                                            as dong_co_can_cu,
  case when co_can_cu >= 100 then 'STRONGER — đủ để so hai mô hình, chênh lệch nhỏ vẫn có nghĩa'
       when co_can_cu >= 38  then 'MEANINGFUL — con số đầu tiên dùng để quyết định được'
       when co_can_cu >= 20  then 'PRELIMINARY — đọc được xu hướng, CHƯA kết luận được'
       else 'INSUFFICIENT — dưới 20 dòng thì mọi tỷ lệ đều là tiếng ồn'
  end                                                                                  as muc,
  greatest(0, 38 - co_can_cu)                                                          as con_thieu_de_dung_duoc,
  case when co_can_cu >= 38 then 'XẾP HẠNG MÔ HÌNH ĐƯỢC'
       else 'KHÔNG ĐƯỢC xếp hạng mô hình. Đây là CHƯA BIẾT, KHÔNG phải "hai mô hình ngang nhau".'
  end                                                                                  as ket_luan
from n;

\echo ''
\echo '── 3. CHỈ-LUẬT so với NGƯỜI: tính được chưa ──'
\echo '   Nhánh chỉ-luật là phép tính TẤT ĐỊNH, chạy lại lúc nào cũng ra cùng kết quả. Nhưng'
\echo '   "đúng bao nhiêu phần" thì phải có SỰ THẬT để so, và sự thật ấy chỉ đến từ người chấm.'
select
  (select count(*) from ai_runs where created_at > now() - interval '30 days')          as luot_chay_30_ngay,
  (select count(*) from sales_suggestions s
     join sales_review_labels l on l.suggestion_id = s.id
   where coalesce(l.verdict, '') <> '')                                                 as luot_co_su_that,
  case when (select count(*) from sales_review_labels where coalesce(verdict, '') <> '') = 0
       then 'CHƯA TÍNH ĐƯỢC — 0 nhãn người chấm. Không phải "chỉ-luật kém", là CHƯA CÓ THƯỚC ĐO.'
       else 'Tính được — xem tỷ lệ ở trình mô phỏng định tuyến.'
  end                                                                                  as phan_xet;

\echo ''
\echo '── 4. SỔ GIÁ: lượt nào tính được thành tiền, lượt nào CHƯA BIẾT ──'
\echo '   Một lượt chưa khai giá là CHƯA BIẾT chi phí. Cộng phần đã khai rồi in ra như tổng của cả'
\echo '   nhóm là khẳng định những lượt kia tốn 0đ.'
select
  provider || ' / ' || model                                                            as mo_hinh,
  count(*)                                                                              as luot_goi,
  count(*) filter (where cost_vnd is not null)                                          as tinh_duoc_tien,
  count(*) filter (where cost_vnd is null)                                              as chua_khai_gia,
  count(*) filter (where coalesce(pricing_version, '') <> '')                           as co_anh_chup_gia,
  case when count(*) filter (where cost_vnd is not null) = 0 then null
       else sum(cost_vnd) filter (where cost_vnd is not null) end                       as tong_tien_vnd_phan_da_khai,
  sum(input_tokens)                                                                     as token_vao,
  sum(output_tokens)                                                                    as token_ra
from ai_model_calls
where created_at > now() - interval '30 days'
group by 1
order by 2 desc
limit 20;

\echo ''
\echo '── 5. SỔ GIÁ ĐÃ KHAI CHƯA ──'
-- Sổ giá nằm TRONG `settings['ai.config']` ở khoá `pricing` — không phải một dòng settings riêng.
with g as (
  select coalesce((select count(*) from jsonb_object_keys(value::jsonb->'pricing')), 0) as so_dong,
         coalesce(value::jsonb->>'pricingVersion', '')                                  as nhan
  from settings where key = 'ai.config'
)
select
  coalesce((select so_dong from g), 0)                                                 as so_dong_gia,
  coalesce(nullif((select nhan from g), ''), '(chưa khai)')                            as nhan_phien_ban,
  case when coalesce((select so_dong from g), 0) = 0
       then 'PRICING_UNKNOWN — chưa khai tỷ giá USD→VND, và hai mẫu erp/gpt-5.6-* chưa có giá công bố. KHÔNG được thay bằng 0.'
       else 'ĐÃ KHAI — đối chiếu tiền tính được ở khối 4.'
  end                                                                                  as phan_xet;

\echo ''
\echo '── 6. CẦU DAO: đã cắt nhầm gì chưa ──'
\echo '   Cột đáng lo là `bi_cat`: một lượt bị cầu dao chặn trong khi nhà cung cấp vẫn khoẻ.'
select
  coalesce((select value::jsonb->>'circuitBreakerEnabled' from settings where key = 'ai.config'), '(chưa khai)') as cau_dao_bat,
  count(*) filter (where not ok)                                                        as luot_hong,
  count(*) filter (where ok)                                                            as luot_tot,
  count(*) filter (where coalesce(error, '') ilike '%circuit%' or coalesce(error, '') ilike '%cầu dao%') as bi_cat,
  max(created_at) filter (where not ok)                                                 as lan_hong_gan_nhat,
  max(created_at) filter (where ok)                                                     as lan_tot_gan_nhat
from ai_model_calls
where created_at > now() - interval '7 days';

\echo ''
\echo '── 7. LƯỢT HỎNG GẦN NHẤT THEO NGÀY — phân biệt "đang hỏng" với "đã hỏng rồi khỏi" ──'
\echo '   Một tỷ lệ hỏng gộp cả 7 ngày đọc ra như thể hôm nay vẫn đang hỏng.'
select
  date_trunc('day', created_at)::date                                                   as ngay,
  provider || ' / ' || model                                                            as mo_hinh,
  count(*)                                                                              as luot,
  count(*) filter (where not ok)                                                        as hong
from ai_model_calls
where created_at > now() - interval '7 days'
group by 1, 2
having count(*) filter (where not ok) > 0
order by 1 desc, 4 desc
limit 20;
