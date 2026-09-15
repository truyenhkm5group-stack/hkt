-- KIỂM CHỨNG NẤC TRỢ LÝ TRÊN BẢN ĐANG CHẠY — CHỈ ĐỌC.
--
-- Không câu nào dưới đây tin vào mã nguồn hay biến môi trường đã gõ. Tất cả đọc từ CSDL của bản
-- đang chạy, vì đó mới là thứ ứng dụng thật sự dùng lúc quyết định có gửi một tin hay không.

\echo '── 1. Sổ thao tác nấc trợ lý ──'
select
  to_regclass('public.sales_copilot_actions') is not null as bang_da_co,
  (select count(*)::int from information_schema.columns where table_name = 'sales_copilot_actions') as so_cot;

\echo '── 2. Ràng buộc & chỉ mục (chống gửi hai lần nằm ở đây) ──'
select indexname from pg_indexes where tablename = 'sales_copilot_actions' order by indexname;
select conname from pg_constraint
where conrelid = 'public.sales_copilot_actions'::regclass and contype = 'c' order by conname;

\echo '── 3. Nấc quyền hạn & danh sách page thí điểm ──'
select key, mode from ai_agents where key = 'sales';
select coalesce((select value from settings where key = 'ai.copilotPages'), '(chưa khai)') as page_thi_diem;

\echo '── 4. MỌI PAGE CÓ HỘI THOẠI: page nào ĐƯỢC, page nào KHÔNG ──'
select
  c.page_id,
  count(*)::int as so_hoi_thoai,
  (c.page_id in (
     select jsonb_array_elements_text(coalesce((select value from settings where key = 'ai.copilotPages'), '[]')::jsonb)
   )) as duoc_thi_diem
from sales_conversations c
group by c.page_id order by 2 desc;

\echo '── 5. ĐÃ CÓ TIN NÀO RỜI KHỎI ERP CHƯA — phải bằng 0 khi chưa thí điểm ──'
select
  (select count(*)::int from sales_copilot_actions where action in ('SEND','EDIT_SEND') and send_status = 'SENT') as tin_da_gui,
  (select count(*)::int from sales_suggestions where sent = true)                                                  as goi_y_danh_dau_da_gui,
  (select count(*)::int from sales_conversations where order_id is not null)                                       as hoi_thoai_co_don,
  (select count(*)::int from ai_tool_calls where tool in ('order.create_draft','order.confirm') and outcome = 'OK') as goi_cong_cu_don;

\echo '── 6. BỘ LẬP LỊCH CÓ ĐANG CHẠY VIỆC NÀO KHÔNG (phải là 0 việc đang chạy) ──'
select coalesce(nullif(status,''),'?') as trang_thai, count(*)::int as n
from ai_tasks group by 1 order by 2 desc;

\echo '── 7. Lượt chạy gần nhất đi qua nấc nào (production_action phải là NO_SEND khi chưa ai bấm) ──'
select coalesce(nullif(production_action,''),'?') as hanh_dong_san_xuat, count(*)::int as n
from sales_suggestions group by 1 order by 2 desc;
