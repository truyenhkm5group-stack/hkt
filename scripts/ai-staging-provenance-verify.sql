-- SÁU CA CỦA SỔ NGUỒN Ô ĐƠN HÀNG, KIỂM TRÊN DỮ LIỆU THẬT VỪA CHẠY. CHỈ ĐỌC.
--
-- Bài kiểm đơn vị đã canh hàm thuần. Bài này hỏi một câu khác và khó hơn: trên dữ liệu bản chạy
-- thử, đường GHI có thật sự tạo ra những dòng mà hàm thuần hứa không.
--
-- KHÔNG GHI GÌ.

\echo '── 0. ĐÃ CÓ DÒNG NÀO CHƯA (rỗng = chưa lượt chạy mới nào sau khi triển khai) ──'
select
  count(*)                                           as tong_dong,
  count(*) filter (where status = 'ACTIVE')          as dang_hieu_luc,
  count(*) filter (where status = 'SUPERSEDED')      as da_thay_the,
  count(distinct conversation_id)                    as so_hoi_thoai,
  min(created_at)                                    as som_nhat,
  max(created_at)                                    as gan_nhat
from order_field_provenance;

\echo ''
\echo '── 1. PHÂN BỔ THEO Ô và MỨC KHẲNG ĐỊNH ──'
\echo '   Cột `claim` phải phân biệt được KHÁCH NÓI với MÁY SUY RA — đó là cả lý do bảng này tồn tại.'
select
  field                                              as o_du_lieu,
  claim                                              as muc_khang_dinh,
  source_type                                        as nguon,
  count(*)                                           as so_dong,
  count(*) filter (where status = 'ACTIVE')          as con_hieu_luc
from order_field_provenance
group by 1, 2, 3
order by 4 desc;

\echo ''
\echo '── 2. CA E — SIZE DO MÁY SUY RA KHÔNG ĐƯỢC MANG NHÃN LỜI KHÁCH ──'
\echo '   Dòng nào vi phạm sẽ hiện ra ở đây. Bảng RỖNG là ĐẠT.'
select id, conversation_id, field, value, source_type, claim
from order_field_provenance
where source_type in ('ERP_SIZE_ENGINE', 'ERP_CATALOG', 'PRODUCT_RESOLVER', 'MODEL_INFERENCE')
  and claim = 'STATED';

\echo ''
\echo '── 3. CA B/F — MỖI Ô CHỈ ĐƯỢC CÓ MỘT DÒNG CÒN HIỆU LỰC ──'
\echo '   Hai dòng ACTIVE cho cùng một ô nghĩa là sổ đang trả lời hai kiểu cho cùng một câu hỏi.'
\echo '   Bảng RỖNG là ĐẠT.'
select conversation_id, field, count(*) as so_dong_active
from order_field_provenance
where status = 'ACTIVE'
group by 1, 2
having count(*) > 1;

\echo ''
\echo '── 4. RÀNG BUỘC MỐC HẾT HIỆU LỰC — ACTIVE không được mang mốc, SUPERSEDED phải có ──'
\echo '   Bảng RỖNG là ĐẠT (CSDL đã có CHECK, đây là phép kiểm lại).'
select id, status, superseded_at
from order_field_provenance
where (status = 'ACTIVE' and superseded_at is not null)
   or (status = 'SUPERSEDED' and superseded_at is null);

\echo ''
\echo '── 5. CA D — DÒNG SĐT PHẢI TRỎ VỀ ĐÚNG TIN NHẮN, VÀ TIN ẤY PHẢI LÀ TIN CỦA KHÁCH ──'
select
  count(*)                                                        as tong_dong_sdt,
  count(*) filter (where p.source_message_id is not null)         as co_tro_ve_tin_nhan,
  count(*) filter (where m.direction = 'IN')                      as tin_ay_la_cua_khach,
  count(*) filter (where p.claim = 'STATED')                      as ghi_la_khach_noi
from order_field_provenance p
left join sales_messages m on m.id = p.source_message_id
where p.field = 'phone';

\echo ''
\echo '── 6. CA F — MỘT HỘI THOẠI ĐỔI SẢN PHẨM THÌ MẪU MÃ CŨ PHẢI HẾT HIỆU LỰC ──'
\echo '   Liệt kê hội thoại có >1 mã hàng từng được ghi, kèm số dòng mẫu mã còn hiệu lực (phải ≤ 1).'
select
  conversation_id,
  count(*) filter (where field = 'product_id')                               as lan_doi_ma_hang,
  count(*) filter (where field = 'variant_id' and status = 'ACTIVE')         as mau_ma_con_hieu_luc
from order_field_provenance
group by 1
having count(*) filter (where field = 'product_id') > 1
order by 2 desc
limit 10;
