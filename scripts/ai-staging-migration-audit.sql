-- KIỂM KÊ LỊCH SỬ MIGRATION ĐÃ ÁP DỤNG THẬT — CHỈ ĐỌC, KHÔNG GHI MỘT DÒNG NÀO.
--
-- Drizzle KHÔNG so tên tệp và KHÔNG so hash để quyết định "đã chạy chưa". Nó chỉ so MỐC THỜI GIAN
-- (`created_at`, lấy từ `when` trong sổ): một migration có mốc <= mốc lớn nhất đã áp dụng sẽ bị
-- BỎ QUA VĨNH VIỄN, im lặng, dù nội dung hoàn toàn mới.
--
-- Đó là lý do phải đọc bảng này trước khi đụng tới bất cứ thứ gì: nó cho biết CHÍNH XÁC mốc trần
-- của CSDL này, và từ đó biết migration nào sẽ chạy, migration nào sẽ bị nuốt.
--
-- KHÔNG sửa bảng này. KHÔNG xoá dòng. KHÔNG đổi mốc.

\echo '── 1. TRẦN MỐC: migration nào sẽ bị BỎ QUA nếu mốc của nó thấp hơn con số này ──'
select
  count(*)                                        as so_migration_da_ap,
  max(created_at)                                 as moc_tran,
  to_timestamp(max(created_at)/1000) at time zone 'UTC' as moc_tran_doc_duoc,
  min(created_at)                                 as moc_dau
from drizzle.__drizzle_migrations;

\echo ''
\echo '── 2. MƯỜI LƯỢT ÁP DỤNG GẦN NHẤT (hash = SHA256 nội dung tệp .sql lúc chạy) ──'
select
  id,
  left(hash, 16)                                  as hash_16,
  created_at                                      as moc,
  to_timestamp(created_at/1000) at time zone 'UTC' as moc_doc_duoc
from drizzle.__drizzle_migrations
order by created_at desc
limit 10;

\echo ''
\echo '── 3. CÓ BAO NHIÊU BẢNG CỦA MỖI PHÍA — để biết CSDL này mang lược đồ của nhánh nào ──'
\echo '   Bảng của NHÁNH (nhân sự AI bán hàng):'
select
  count(*) filter (where table_name = 'ai_runs')                  as ai_runs,
  count(*) filter (where table_name = 'ai_model_calls')           as ai_model_calls,
  count(*) filter (where table_name = 'sales_conversations')      as sales_conversations,
  count(*) filter (where table_name = 'sales_regression_cases')   as sales_regression_cases,
  count(*) filter (where table_name = 'order_field_provenance')   as order_field_provenance,
  count(*) filter (where table_name = 'sales_product_resolutions') as sales_product_resolutions
from information_schema.tables where table_schema = 'public';

\echo '   Bảng của MAIN (lương · hoàn hàng · landing · vtp · tech · phiên):'
select
  count(*) filter (where table_name = 'payroll_periods')          as payroll_periods,
  count(*) filter (where table_name = 'fb_adsets')                as fb_adsets,
  count(*) filter (where table_name = 'return_reason_observations') as return_reason_obs,
  count(*) filter (where table_name = 'care_decisions')           as care_decisions,
  count(*) filter (where table_name = 'cto_proposals')            as cto_proposals
from information_schema.tables where table_schema = 'public';

\echo ''
\echo '── 4. CỘT MỚI NHẤT CỦA NHÁNH đã có chưa (ảnh chụp giá trên từng lượt gọi) ──'
select
  count(*) filter (where column_name = 'input_price_vnd_per_million')  as co_cot_gia_vao,
  count(*) filter (where column_name = 'cached_input_price_vnd_per_million') as co_cot_gia_dem,
  count(*) filter (where column_name = 'output_price_vnd_per_million') as co_cot_gia_ra,
  count(*) filter (where column_name = 'currency')                     as co_cot_tien_te
from information_schema.columns
where table_schema = 'public' and table_name = 'ai_model_calls';

\echo ''
\echo '── 5. TỔNG SỐ BẢNG — một con số để so nhanh hai CSDL ──'
select count(*) as tong_so_bang from information_schema.tables where table_schema = 'public';
