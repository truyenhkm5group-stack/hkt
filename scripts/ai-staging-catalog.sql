-- KIỂM KÊ DANH MỤC TRÊN BẢN CHẠY THỬ — CHỈ ĐỌC.
-- Tên sản phẩm là dữ liệu của SHOP, in được; không câu nào chạm vào dữ liệu khách.

\echo ''
\echo '════════ 1. DANH MỤC ĐANG CÓ ════════'
select
  count(distinct p.id)                                   as "sản phẩm",
  count(pv.id)                                           as "mẫu mã",
  count(distinct p.id) filter (where p.is_hidden)        as "đang ẩn",
  count(distinct p.id) filter (where p.is_removed)       as "đã xoá",
  count(pv.id) filter (where coalesce(pv.retail_price,0) > 0) as "mẫu mã có giá"
from products p left join product_variants pv on pv.product_id = p.id;

\echo ''
\echo '════════ 2. TỪNG SẢN PHẨM ════════'
select
  coalesce(nullif(p.custom_id, ''), '(chưa có mã)')      as "mã hàng",
  left(p.name, 52)                                       as "tên sản phẩm",
  count(pv.id)                                           as "mẫu mã",
  min(nullif(pv.retail_price, 0))                        as "giá thấp nhất",
  max(pv.retail_price)                                   as "giá cao nhất",
  case when p.is_hidden then 'ẩn' when p.is_removed then 'xoá' else 'bán' end as "trạng thái"
from products p left join product_variants pv on pv.product_id = p.id
group by p.id, p.custom_id, p.name, p.is_hidden, p.is_removed
order by p.name;

\echo ''
\echo '════════ 3. TỪ KHOÁ CỦA TÊN SẢN PHẨM (phép khớp chữ dựa vào đây) ════════'
\echo '(scoreProductMatch cần từ dài >= 3 ký tự; tên chỉ có từ ngắn thì gần như không khớp được)'
select
  coalesce(nullif(p.custom_id, ''), '(chưa mã)')         as "mã",
  left(p.name, 40)                                       as "tên",
  array_length(string_to_array(trim(p.name), ' '), 1)    as "số từ",
  cardinality(array(select w from unnest(string_to_array(lower(trim(p.name)), ' ')) w where length(w) >= 3)) as "từ >= 3 ký tự"
from products p where not p.is_removed order by p.name;
