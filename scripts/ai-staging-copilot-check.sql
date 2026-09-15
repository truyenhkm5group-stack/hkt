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

\echo '── 8. HÀNG ĐỢI NGAY LÚC NÀY (cùng bộ lọc mà màn hình dùng) ──'
with tin_khach as (
  select c.id, c.page_id,
         (select max(sent_at) from sales_messages m
            where m.conversation_id = c.id and m.from_page = false and m.sender_type = 'CUSTOMER' and btrim(m.text) <> '') as khach_luc,
         (select max(sent_at) from sales_messages m
            where m.conversation_id = c.id and m.from_page = true and m.sender_type in ('PAGE_HUMAN','PAGE_BOT'))            as shop_luc,
         c.human_takeover_at
  from sales_conversations c
  where c.page_id in (select jsonb_array_elements_text(coalesce((select value from settings where key = 'ai.copilotPages'), '[]')::jsonb))
)
select
  count(*)::int                                                                            as hoi_thoai_cua_page,
  count(*) filter (where khach_luc is null)::int                                            as khong_co_tin_khach,
  count(*) filter (where human_takeover_at is not null)::int                                as nguoi_dang_cam,
  count(*) filter (where shop_luc is not null and shop_luc >= khach_luc)::int               as shop_da_dap_roi,
  count(*) filter (where khach_luc < now() - interval '24 hours')::int                      as qua_24_gio,
  count(*) filter (where khach_luc is not null and human_takeover_at is null
                     and (shop_luc is null or shop_luc < khach_luc)
                     and khach_luc >= now() - interval '24 hours')::int                     as CON_LAI_TRONG_HANG_DOI
from tin_khach;

\echo '── 9. Tin khách mới nhất của page (để biết dòng tin có đang chảy vào không) ──'
select max(m.sent_at) as tin_khach_moi_nhat, now() as bay_gio
from sales_messages m join sales_conversations c on c.id = m.conversation_id
where m.from_page = false and m.sender_type = 'CUSTOMER'
  and c.page_id in (select jsonb_array_elements_text(coalesce((select value from settings where key = 'ai.copilotPages'), '[]')::jsonb));
