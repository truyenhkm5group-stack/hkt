-- ════════════════════════════════════════════════════════════════════════════════════════════
-- BẰNG CHỨNG AN TOÀN CỦA BẢN CHẠY THỬ — CHỈ ĐỌC, chạy lại được bất cứ lúc nào.
--
--   Actions → "Vận hành ERP trên VPS" → ai-staging-sql · arg = ai-staging-safety.sql
--
-- Vì sao nó tồn tại tách khỏi `ai-staging-report.sql` (báo cáo CHẤT LƯỢNG lượt nạp): tệp này trả
-- lời đúng một câu, và là câu phải trả lời được TRƯỚC MỌI CÂU KHÁC — **máy đã chạm tới khách hàng
-- lần nào chưa**. Trộn nó vào một báo cáo 12 khối là để nó trôi qua giữa những con số khác.
--
-- Mọi dòng dưới đây phải bằng 0. Một dòng khác 0 KHÔNG phải cảnh báo — nó là một sự cố.
-- ════════════════════════════════════════════════════════════════════════════════════════════

\echo '═══ 1. MÁY ĐÃ CHẠM TỚI KHÁCH LẦN NÀO CHƯA (tất cả PHẢI bằng 0) ═══'
select 'tin gợi ý đã gửi cho khách'            as phep_do, count(*)::text as so_do, (count(*) = 0) as dat from sales_suggestions where sent
union all
select 'tin do NHÂN SỰ AI soạn nằm trong bảng tin', count(*)::text, count(*) = 0 from sales_messages where from_agent
union all
select 'hội thoại đã gắn đơn POS',               count(*)::text, count(*) = 0 from sales_conversations where order_id is not null
union all
-- Sổ thao tác nấc TRỢ LÝ là nơi DUY NHẤT ghi "ai đã gửi gì cho khách". Rỗng = chưa ai bấm gửi.
select 'thao tác KẾT THÚC ở nấc trợ lý (gửi / sửa & gửi)', count(*)::text, count(*) = 0
  from sales_copilot_actions where action in ('SEND', 'EDIT_SEND')
union all
select 'lời gọi công cụ GHI bị CỔNG TỪ CHỐI (càng nhiều càng tốt — chứng tỏ cổng đang chặn)',
       count(*)::text, true from ai_tool_calls where outcome = 'DENIED';

\echo ''
\echo '═══ 2. NẤC QUYỀN HẠN THẬT, ĐỌC TỪ CSDL (không đọc từ biến môi trường) ═══'
select key as nhan_su, mode as nac_quyen_han, enabled as dang_bat, updated_at
  from ai_agents order by key;

\echo ''
\echo '═══ 3. BỘ CA HỒI QUY ═══'
-- Ca sinh ra từ trang soát. Ca dựng sẵn KHÔNG nằm trong CSDL (chúng đi theo kho mã), nên bảng này
-- rỗng là bình thường ở ngày đầu — nó KHÔNG có nghĩa là bộ hồi quy trống.
select count(*) filter (where active)      as ca_dang_bat,
       count(*) filter (where not active)  as ca_da_tat,
       count(distinct page_id)             as so_page,
       max(created_at)                     as ca_moi_nhat
  from sales_regression_cases;

\echo ''
\echo '═══ 4. NGƯỜI ĐÃ CHẤM ĐƯỢC BAO NHIÊU, VÀ AI CHẤM ═══'
select coalesce(u.name, u.email, '(không có khoá tài khoản)') as nguoi_cham,
       count(*)                                                as so_luot_da_cham,
       min(l.reviewed_at)                                      as lan_dau,
       max(l.reviewed_at)                                      as lan_cuoi
  from sales_review_labels l
  left join users u on u.id = l.reviewer_user_id
 where l.reviewed_at is not null
 group by 1 order by 2 desc;

\echo ''
\echo '═══ 5. ĐỘ PHỦ CHẤM TAY — mẫu số 0 phải ra NULL, không ra 0% ═══'
select count(*)                                               as tong_luot_goi_y,
       count(*) filter (where l.reviewed_at is not null)       as da_cham,
       case when count(*) = 0 then null
            else round(100.0 * count(*) filter (where l.reviewed_at is not null) / count(*), 1)
       end                                                     as do_phu_phan_tram
  from sales_suggestions s
  left join sales_review_labels l on l.suggestion_id = s.id;

\echo ''
\echo '═══ 6. MIGRATION ĐÃ ÁP ═══'
-- `created_at` của drizzle KHÔNG phải lúc migration CHẠY — nó là mốc `when` chép từ
-- `drizzle/meta/_journal.json`, tức một con số do người viết migration đặt. Gọi nó là "lần áp
-- cuối" là in ra một mốc thời gian sai lệch hàng ngày mà trông hoàn toàn hợp lý.
-- Muốn biết lúc CHẠY thật thì đọc log khởi động của container.
select count(*)                            as so_migration_da_ap,
       to_timestamp(max(created_at)/1000)  as moc_trong_so_cua_migration_moi_nhat
  from drizzle.__drizzle_migrations;

\echo ''
\echo '═══ 7. BẢNG CỦA BỘ CA HỒI QUY CÓ THẬT CHƯA (0096 đã chạy chưa) ═══'
select count(*) as bang_sales_regression_cases_ton_tai
  from information_schema.tables where table_name = 'sales_regression_cases';
