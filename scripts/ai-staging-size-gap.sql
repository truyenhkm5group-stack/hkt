-- TRUY NGUYÊN KHOẢNG TRỐNG BẢNG SỐ ĐO — CHỈ ĐỌC.
--
-- Đo 19/09/2026: khoảng một nửa số việc "máy xin người vào" là chuyện bảng số đo. Máy TỪ CHỐI đoán
-- size khi không có căn cứ — đúng luật, và KHÔNG được sửa — rồi xin người vào, và không ai vào.
--
-- Nên câu hỏi không phải "làm sao để máy đoán giỏi hơn". Nó là: **bổ sung bảng số đo cho mẫu nào
-- TRƯỚC thì xoá được nhiều việc treo nhất.**
--
-- KHÔNG GHI GÌ. KHÔNG sửa hành vi AI.

\echo '── 1. BẢNG SỐ ĐO ĐÃ KHAI ĐƯỢC BAO NHIÊU ──'
select
  coalesce(value::jsonb->>'version', '(chưa khai)')                                   as phien_ban,
  coalesce(jsonb_array_length(value::jsonb->'rules'), 0)                              as so_bang,
  coalesce((select count(*) from jsonb_array_elements(value::jsonb->'rules') r
            where r->>'scope' = 'GLOBAL'), 0)                                         as pham_vi_toan_shop,
  coalesce((select count(*) from jsonb_array_elements(value::jsonb->'rules') r
            where r->>'scope' = 'PRODUCT'), 0)                                        as pham_vi_san_pham,
  coalesce((select count(*) from jsonb_array_elements(value::jsonb->'rules') r
            where r->>'scope' = 'VARIANT'), 0)                                        as pham_vi_mau_ma
from settings where key = 'ai.sizeRules';

\echo '   (không có dòng nào ở trên = CHƯA TỪNG KHAI bảng số đo nào)'

\echo ''
\echo '── 2. VIỆC TREO VÌ THIẾU BẢNG SỐ ĐO, XẾP THEO MẪU HÀNG ──'
\echo '   Đây là bảng đáng đọc nhất: mẫu ở đầu danh sách là mẫu bổ sung trước thì lợi nhất.'
select
  coalesce(nullif(c.state->>'productName', ''), '(máy CHƯA nhận ra mẫu nào)')          as mau_hang,
  coalesce(nullif(c.state->>'productId', ''), '—')                                     as ma_hang,
  count(*)                                                                             as viec_treo,
  round(avg(extract(epoch from (now() - c.human_takeover_at)) / 3600))                 as tuoi_tb_gio,
  round(max(extract(epoch from (now() - c.human_takeover_at)) / 3600))                 as cu_nhat_gio
from sales_conversations c
where c.human_takeover_at is not null
  and c.takeover_by_user_id is null
  and c.takeover_reason like 'SIZE_DATA_MISSING%'
group by 1, 2
order by 3 desc
limit 15;

\echo ''
\echo '── 3. TỔNG: bao nhiêu phần việc treo là chuyện bảng số đo ──'
select
  count(*)                                                                             as tong_viec_treo,
  count(*) filter (where c.takeover_reason like 'SIZE_DATA_MISSING%')                  as do_thieu_bang_so_do,
  count(*) filter (where c.takeover_reason like '%size%' and c.takeover_reason not like 'SIZE_DATA_MISSING%') as lien_quan_size_khac,
  round(100.0 * count(*) filter (where c.takeover_reason like 'SIZE_DATA_MISSING%')
        / nullif(count(*), 0), 1)                                                      as pct_do_bang_so_do,
  count(distinct nullif(c.state->>'productId', ''))                                    as so_ma_hang_lien_quan
from sales_conversations c
where c.human_takeover_at is not null and c.takeover_by_user_id is null;

\echo ''
\echo '── 4. MẪU HÀNG CÓ SIZE TRONG DANH MỤC — tức là CÓ THỂ khai bảng số đo cho nó ──'
\echo '   ERP biết mẫu có size NÀO; nó không biết AI MẶC VỪA. Cột phải là danh sách size có thật.'
select
  p.code                                                                               as ma_hang,
  left(p.name, 44)                                                                     as ten,
  count(distinct nullif(v.size, ''))                                                   as so_size,
  string_agg(distinct nullif(v.size, ''), ' · ' order by nullif(v.size, ''))            as cac_size
from products p
join product_variants v on v.product_id = p.id
where coalesce(v.size, '') <> ''
group by 1, 2
having count(distinct nullif(v.size, '')) > 1
order by 3 desc
limit 15;

\echo ''
\echo '── 5. PHÂN NHÓM TÌNH TRẠNG — bốn nhóm đặc tả đòi ──'
\echo '   CHƯA KHAI BẢNG NÀO ⇒ mọi mẫu đều thuộc nhóm "thiếu". Không có nhóm "không đầy đủ" hay'
\echo '   "cũ" hay "mâu thuẫn" nào tồn tại được khi con số tổng là 0 — nói đúng như vậy thay vì'
\echo '   dựng ra bốn ô rỗng cho đẹp bảng.'
select
  (select coalesce(jsonb_array_length(value::jsonb->'rules'), 0)
     from settings where key = 'ai.sizeRules')                                         as bang_da_khai,
  (select count(distinct p.id) from products p
     join product_variants v on v.product_id = p.id
     where coalesce(v.size, '') <> '')                                                 as mau_co_size_trong_danh_muc,
  case when coalesce((select jsonb_array_length(value::jsonb->'rules')
                        from settings where key = 'ai.sizeRules'), 0) = 0
       then 'CHƯA KHAI BẢNG NÀO — mọi mẫu có size đều thuộc nhóm THIẾU. Ba nhóm còn lại (không đầy đủ · cũ · mâu thuẫn) chưa thể tồn tại.'
       else 'ĐÃ CÓ BẢNG — cần soi tiếp từng bảng để phân đủ bốn nhóm.'
  end                                                                                  as phan_xet;
