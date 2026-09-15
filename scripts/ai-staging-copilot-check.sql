-- KIỂM CHỨNG NẤC TRỢ LÝ TRÊN BẢN ĐANG CHẠY — CHỈ ĐỌC.
--
-- Bốn câu hỏi, và cả bốn đều phải trả lời được bằng dữ liệu chứ không bằng lời:
--   1. Migration của sổ thao tác đã áp chưa?
--   2. Ràng buộc chống gửi hai lần có thật sự tồn tại không?
--   3. Danh sách page thí điểm đang là gì?
--   4. Đã có tin nào rời khỏi ERP chưa?

\echo '── 1. Sổ thao tác nấc trợ lý ──'
select
  to_regclass('public.sales_copilot_actions') is not null as bang_da_co,
  (select count(*)::int from information_schema.columns where table_name = 'sales_copilot_actions') as so_cot;

\echo '── 2. Ràng buộc & chỉ mục (chống gửi hai lần nằm ở đây) ──'
select indexname, indexdef is not null as co_dinh_nghia
from pg_indexes where tablename = 'sales_copilot_actions' order by indexname;

select conname from pg_constraint
where conrelid = 'public.sales_copilot_actions'::regclass and contype = 'c' order by conname;

\echo '── 3. Nấc quyền hạn & danh sách page thí điểm ──'
select key, mode from ai_agents where key = 'sales';
select coalesce((select value from settings where key = 'ai.copilotPages'), '(chưa khai)') as page_thi_diem;

\echo '── 4. ĐÃ CÓ TIN NÀO RỜI KHỎI ERP CHƯA — phải bằng 0 khi chưa thí điểm ──'
select
  (select count(*)::int from sales_copilot_actions where action in ('SEND','EDIT_SEND') and send_status = 'SENT') as tin_da_gui,
  (select count(*)::int from sales_suggestions where sent = true)                                                  as goi_y_danh_dau_da_gui,
  (select count(*)::int from sales_conversations where order_id is not null)                                       as hoi_thoai_co_don;
