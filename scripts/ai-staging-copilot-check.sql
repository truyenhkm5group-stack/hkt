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
-- PHẢI SOI CHIẾU ĐÚNG TRUY VẤN CỦA MÀN HÌNH, kể cả phép loại câu mẫu. Một câu kiểm dùng bộ lọc
-- KHÁC màn hình là một câu kiểm nói dối — đúng lỗi đã mắc với phép đọc nấc quyền hạn bằng psql.
with cau_mau as (
  select lower(btrim(m.text)) as van_ban
  from sales_messages m join sales_conversations sc on sc.id = m.conversation_id
  where m.from_page = true and m.sender_type = 'PAGE_HUMAN' and btrim(m.text) <> ''
    and sc.page_id in (select jsonb_array_elements_text(coalesce((select value from settings where key = 'ai.copilotPages'), '[]')::jsonb))
  group by 1 having count(distinct m.conversation_id) >= 3
), tin_khach as (
  select c.id, c.page_id,
         (select max(sent_at) from sales_messages m
            where m.conversation_id = c.id and m.from_page = false and m.sender_type = 'CUSTOMER' and btrim(m.text) <> '') as khach_luc,
         (select max(sent_at) from sales_messages m
            where m.conversation_id = c.id and m.from_page = true and m.sender_type = 'PAGE_HUMAN'
              and btrim(m.text) <> '' and lower(btrim(m.text)) not in (select van_ban from cau_mau))                       as shop_luc,
         c.human_takeover_at, c.takeover_by_user_id
  from sales_conversations c
  where c.page_id in (select jsonb_array_elements_text(coalesce((select value from settings where key = 'ai.copilotPages'), '[]')::jsonb))
)
-- LOẠI THEO `takeover_by_user_id`, KHÔNG theo `human_takeover_at` — giống hệt truy vấn màn hình.
-- Máy xin người vào thì CHƯA AI cầm, nên nó vẫn là việc; chỉ người thật nhận mới hết việc chung.
select
  count(*)::int                                                                            as hoi_thoai_cua_page,
  count(*) filter (where khach_luc is null)::int                                            as khong_co_tin_khach,
  count(*) filter (where takeover_by_user_id is not null)::int                              as NGUOI_THAT_dang_cam,
  count(*) filter (where human_takeover_at is not null and takeover_by_user_id is null)::int as MAY_xin_nguoi_vao,
  count(*) filter (where shop_luc is not null and shop_luc >= khach_luc)::int               as shop_da_dap_roi,
  count(*) filter (where khach_luc < now() - interval '24 hours')::int                      as qua_24_gio,
  count(*) filter (where khach_luc is not null and takeover_by_user_id is null
                     and (shop_luc is null or shop_luc < khach_luc)
                     and khach_luc >= now() - interval '24 hours')::int                     as CON_LAI_TRONG_HANG_DOI
from tin_khach;

\echo '── 9. Tin khách mới nhất của page (để biết dòng tin có đang chảy vào không) ──'
select max(m.sent_at) as tin_khach_moi_nhat, now() as bay_gio
from sales_messages m join sales_conversations c on c.id = m.conversation_id
where m.from_page = false and m.sender_type = 'CUSTOMER'
  and c.page_id in (select jsonb_array_elements_text(coalesce((select value from settings where key = 'ai.copilotPages'), '[]')::jsonb));

\echo '── 10. PHÂN LOẠI NGƯỜI GỬI — 50 HỘI THOẠI GẦN NHẤT CỦA PAGE THÍ ĐIỂM ──'
-- Chỉ PAGE_HUMAN mới là "nhân viên đã trả lời". PAGE_BOT và PAGE_SYSTEM KHÔNG được làm một lượt
-- khách biến mất khỏi hàng đợi: một câu tự động là đúng thứ khiến khách ngồi đợi.
with gan_nhat as (
  select c.id
  from sales_conversations c
  where c.page_id in (select jsonb_array_elements_text(coalesce((select value from settings where key = 'ai.copilotPages'), '[]')::jsonb))
  order by c.updated_at desc nulls last
  limit 50
), mau as (
  select lower(btrim(m.text)) as van_ban
  from sales_messages m join sales_conversations sc on sc.id = m.conversation_id
  where m.from_page = true and m.sender_type = 'PAGE_HUMAN' and btrim(m.text) <> ''
    and sc.page_id in (select jsonb_array_elements_text(coalesce((select value from settings where key = 'ai.copilotPages'), '[]')::jsonb))
  group by 1 having count(distinct m.conversation_id) >= 3
), moc as (
  select g.id,
         (select max(sent_at) from sales_messages m where m.conversation_id = g.id
            and m.from_page = false and m.sender_type = 'CUSTOMER' and btrim(m.text) <> '')      as khach_luc,
         -- NGƯỜI THẬT = PAGE_HUMAN và KHÔNG phải câu mẫu chạy sẵn.
         (select max(sent_at) from sales_messages m where m.conversation_id = g.id
            and m.from_page = true and m.sender_type = 'PAGE_HUMAN'
            and btrim(m.text) <> '' and lower(btrim(m.text)) not in (select van_ban from mau))   as nguoi_luc,
         (select max(sent_at) from sales_messages m where m.conversation_id = g.id
            and m.from_page = true and (m.sender_type in ('PAGE_BOT','PAGE_SYSTEM')
              or (m.sender_type = 'PAGE_HUMAN' and lower(btrim(m.text)) in (select van_ban from mau)))) as may_luc
  from gan_nhat g
)
select
  count(*) filter (where khach_luc is not null)::int                                       as co_tin_khach,
  count(*) filter (where nguoi_luc is not null and nguoi_luc >= khach_luc)::int            as nhan_vien_that_da_dap,
  count(*) filter (where may_luc is not null)::int                                         as co_tin_may_bot_he_thong,
  count(*) filter (where khach_luc is not null
                     and (nguoi_luc is null or nguoi_luc < khach_luc))::int                as khach_van_dang_cho_nguoi,
  count(*) filter (where khach_luc is not null
                     and (nguoi_luc is null or nguoi_luc < khach_luc)
                     and may_luc is not null and may_luc >= khach_luc)::int                as truoc_day_bi_dem_nham_la_da_dap
from moc;

\echo '── 11. Từng loại người gửi có bao nhiêu tin (để thấy phân loại có chạy không) ──'
select m.sender_type, m.from_page, count(*)::int as so_tin
from sales_messages m join sales_conversations c on c.id = m.conversation_id
where c.page_id in (select jsonb_array_elements_text(coalesce((select value from settings where key = 'ai.copilotPages'), '[]')::jsonb))
group by 1, 2 order by 3 desc;

\echo '── 12. PAGE_HUMAN CÓ THẬT SỰ LÀ NGƯỜI KHÔNG — ba dấu hiệu, không in tên ai ──'
-- Kho mã này PUBLIC và log Actions đọc được, nên KHÔNG in tên người gửi hay tên khách.
-- Ba con số dưới đây đủ để phân biệt người thật với máy mà không lộ một danh tính nào:
--   · bao nhiêu TÀI KHOẢN khác nhau đang gửi — một tài khoản duy nhất cho 339 tin là dấu hiệu máy;
--   · bao nhiêu tin nằm TRƯỚC tin đầu tiên của khách — nhân viên không chào trước khi khách nhắn;
--   · bao nhiêu tin là bản sao y hệt của một tin khác — người không gõ lại đúng từng chữ.
with h as (
  select m.id, m.conversation_id, m.from_name, m.sent_at,
         lower(btrim(m.text)) as van_ban,
         (select min(sent_at) from sales_messages k
            where k.conversation_id = m.conversation_id and k.from_page = false and k.sender_type = 'CUSTOMER') as khach_dau
  from sales_messages m join sales_conversations c on c.id = m.conversation_id
  where m.sender_type = 'PAGE_HUMAN'
    and c.page_id in (select jsonb_array_elements_text(coalesce((select value from settings where key = 'ai.copilotPages'), '[]')::jsonb))
), lap as (
  select van_ban, count(*)::int as n, count(distinct conversation_id)::int as so_hoi_thoai
  from h where van_ban <> '' group by 1 having count(distinct conversation_id) >= 3
)
select
  (select count(*)::int from h)                                                         as tong_tin_page_human,
  (select count(distinct from_name)::int from h)                                        as so_tai_khoan_gui,
  (select count(*)::int from h where khach_dau is not null and sent_at < khach_dau)     as gui_TRUOC_khi_khach_nhan,
  (select coalesce(sum(n), 0)::int from lap)                                            as tin_lap_lai_tren_3_hoi_thoai,
  (select count(*)::int from lap)                                                       as so_mau_cau_bi_lap;

\echo '── 13. Mẫu câu bị lặp nhiều nhất (cắt 60 ký tự; câu lặp qua nhiều hội thoại thì không phải câu riêng của ai) ──'
select left(lower(btrim(m.text)), 60) as mau_cau,
       count(*)::int as so_tin,
       count(distinct m.conversation_id)::int as so_hoi_thoai
from sales_messages m join sales_conversations c on c.id = m.conversation_id
where m.sender_type = 'PAGE_HUMAN' and btrim(m.text) <> ''
  and c.page_id in (select jsonb_array_elements_text(coalesce((select value from settings where key = 'ai.copilotPages'), '[]')::jsonb))
group by 1 having count(distinct m.conversation_id) >= 3
order by 3 desc, 2 desc limit 12;

\echo '── 14. AI GIAO CHO NGƯỜI hay NGƯỜI TỰ NHẬN — hai chuyện khác nhau, cùng một cột ──'
-- `human_takeover_at` có HAI nơi ghi: nút "Tự nhận việc" của nhân viên (có `takeover_by_user_id`),
-- và công cụ `conversation.handoff` do CHÍNH MÁY gọi khi nó quyết định không trả lời được (không có
-- khoá người). Hàng đợi loại cả hai. Nhưng "người đang cầm" và "máy xin người vào" là ngược nhau:
-- cái sau nghĩa là CHƯA AI cầm, và nó phải nằm ĐẦU hàng đợi chứ không phải bị xoá khỏi hàng đợi.
select
  count(*) filter (where c.human_takeover_at is not null)::int                                       as tong_da_danh_dau,
  count(*) filter (where c.human_takeover_at is not null and c.takeover_by_user_id is not null)::int as NGUOI_tu_nhan,
  count(*) filter (where c.human_takeover_at is not null and c.takeover_by_user_id is null)::int     as MAY_xin_nguoi_vao
from sales_conversations c
where c.page_id in (select jsonb_array_elements_text(coalesce((select value from settings where key = 'ai.copilotPages'), '[]')::jsonb));

\echo '── 15. HỘI THOẠI CÒN TƯƠI (khách nhắn trong 24h) — vì sao từng cái KHÔNG ở hàng đợi ──'
with cau_mau as (
  select lower(btrim(m.text)) as van_ban
  from sales_messages m join sales_conversations sc on sc.id = m.conversation_id
  where m.from_page = true and m.sender_type = 'PAGE_HUMAN' and btrim(m.text) <> ''
    and sc.page_id in (select jsonb_array_elements_text(coalesce((select value from settings where key = 'ai.copilotPages'), '[]')::jsonb))
  group by 1 having count(distinct m.conversation_id) >= 3
)
select
  left(c.id, 8) as hoi_thoai,
  (select max(sent_at) from sales_messages m where m.conversation_id = c.id
     and m.from_page = false and m.sender_type = 'CUSTOMER' and btrim(m.text) <> '') as khach_luc,
  (c.human_takeover_at is not null and c.takeover_by_user_id is not null)            as nguoi_dang_cam,
  (c.human_takeover_at is not null and c.takeover_by_user_id is null)                as may_xin_nguoi,
  ((select max(sent_at) from sales_messages m where m.conversation_id = c.id
      and m.from_page = true and m.sender_type = 'PAGE_HUMAN' and btrim(m.text) <> ''
      and lower(btrim(m.text)) not in (select van_ban from cau_mau))
    >= (select max(sent_at) from sales_messages m where m.conversation_id = c.id
          and m.from_page = false and m.sender_type = 'CUSTOMER' and btrim(m.text) <> ''))  as nguoi_da_dap,
  exists (select 1 from sales_suggestions s where s.conversation_id = c.id
            and btrim(s.suggested_reply) <> '' and s.evaluation_only = false)          as co_cau_goi_y
from sales_conversations c
where c.page_id in (select jsonb_array_elements_text(coalesce((select value from settings where key = 'ai.copilotPages'), '[]')::jsonb))
  and (select max(sent_at) from sales_messages m where m.conversation_id = c.id
         and m.from_page = false and m.sender_type = 'CUSTOMER' and btrim(m.text) <> '') >= now() - interval '24 hours'
order by 2 desc limit 15;

\echo '── 16. PILOT: TỪNG THAO TÁC CỦA NHÂN VIÊN (đếm từ SỔ, không suy từ cờ) ──'
select
  coalesce(nullif(a.action, ''), '?')        as thao_tac,
  coalesce(nullif(a.send_status, ''), '—')   as trang_thai_gui,
  count(*)::int                              as so_luot,
  count(distinct a.conversation_id)::int     as so_hoi_thoai,
  count(*) filter (where a.edited)::int      as co_sua,
  round(avg(a.edit_distance) filter (where a.edit_distance is not null))::int as kc_sua_tb,
  percentile_cont(0.5) within group (order by a.review_seconds)::int          as giay_soat_trung_vi
from sales_copilot_actions a
group by 1, 2 order by 3 desc;

\echo '── 17. PILOT: TỶ LỆ — mẫu số rỗng thì để NULL, không in 0% ──'
with q as (
  select
    count(*) filter (where action = 'SEND'      and send_status = 'SENT')::int as gui_nguyen_van,
    count(*) filter (where action = 'EDIT_SEND' and send_status = 'SENT')::int as sua_roi_gui,
    count(*) filter (where action = 'REJECT')::int                             as tu_choi,
    count(*) filter (where action = 'TAKEOVER')::int                           as tu_nhan_viec,
    count(*) filter (where action = 'REGENERATE')::int                         as soan_lai,
    count(*) filter (where send_status = 'FAILED')::int                        as gui_hong
  from sales_copilot_actions
)
select *,
  (gui_nguyen_van + sua_roi_gui)                                as tong_da_gui,
  (gui_nguyen_van + sua_roi_gui + tu_choi)                      as tong_da_quyet_dinh,
  case when (gui_nguyen_van + sua_roi_gui + tu_choi) = 0 then null
       else round(100.0 * (gui_nguyen_van + sua_roi_gui) / (gui_nguyen_van + sua_roi_gui + tu_choi), 1) end as ty_le_dung_duoc_pct,
  case when (gui_nguyen_van + sua_roi_gui) = 0 then null
       else round(100.0 * sua_roi_gui / (gui_nguyen_van + sua_roi_gui), 1) end                              as ty_le_phai_sua_pct
from q;

\echo '── 18. PILOT: ĐƯỜNG MÔ HÌNH & CHI PHÍ (CHƯA KHAI GIÁ thì để NULL, không thành 0đ) ──'
select
  coalesce(nullif(mc.tier, ''), '?')                as nac_mo_hinh,
  coalesce(nullif(mc.model, ''), '?')               as mo_hinh,
  count(*)::int                                     as so_luot_goi,
  sum(mc.input_tokens)::int                         as token_vao,
  sum(mc.output_tokens)::int                        as token_ra,
  percentile_cont(0.5) within group (order by nullif(mc.latency_ms, 0))::int as tre_trung_vi_ms,
  count(*) filter (where mc.cost_vnd is null)::int  as chua_khai_gia
from ai_model_calls mc
join ai_runs r on r.id = mc.run_id
where r.subject_type = 'CONVERSATION' and mc.created_at >= now() - interval '7 days'
group by 1, 2 order by 3 desc;
