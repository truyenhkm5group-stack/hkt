-- ════════════════════════════════════════════════════════════════════════════════════════════
-- TRẠNG THÁI CHẠY THẬT CỦA BẢN CHẠY THỬ — phần nằm trong CSDL. CHỈ ĐỌC.
--
--   Actions → "Vận hành ERP trên VPS" → ai-staging-runtime
--
-- Tệp này là NỬA CSDL của phép đo; nửa kia (nấc quyền hạn có hiệu lực, ba công tắc, container)
-- do chính thao tác ops in ra từ môi trường container đang chạy. Hai nửa phải đọc CÙNG MỘT LÚC:
-- công tắc nằm ở môi trường còn danh sách page nằm ở CSDL, nên đọc lệch nhau vài phút là có thể
-- kết luận sai về một hệ thống đang đổi trạng thái.
--
-- KHÔNG GHI GÌ. Không `insert`, không `update`, không `delete`. Đó là toàn bộ lý do nó tồn tại
-- tách khỏi `ai-staging-copilot` và `ai-staging-live-ingest` — hai thao tác ấy GHI rồi mới đọc lại,
-- nên muốn biết trạng thái thì phải đổi nó.
-- ════════════════════════════════════════════════════════════════════════════════════════════

\echo '── PAGE THÍ ĐIỂM (settings.ai.copilotPages) ──'
select coalesce((select value::text from settings where key = 'ai.copilotPages'), '(chưa khai)') as danh_sach_page;

\echo ''
\echo '── MỐC ĐỌC CỦA BỘ NẠP ──'
select page_id,
       to_char(last_ok_at,      'DD/MM HH24:MI:SS') as vong_chay_duoc_gan_nhat,
       to_char(last_run_at,     'DD/MM HH24:MI:SS') as vong_gan_nhat_ke_ca_hong,
       to_char(last_message_at, 'DD/MM HH24:MI:SS') as tin_khach_moi_nhat,
       messages_ingested                            as tin_da_nap,
       consecutive_errors                           as hong_lien_tiep,
       coalesce(nullif(last_error, ''), '—')        as loi_cuoi
  from sales_ingest_cursors order by page_id;

\echo ''
\echo '── DỮ LIỆU ĐANG CÓ, THEO PAGE ──'
select c.page_id,
       count(distinct c.id)                                          as hoi_thoai,
       count(m.id)                                                   as tin_nhan,
       count(m.id) filter (where not m.from_page)                    as tin_khach,
       count(m.id) filter (where m.from_page)                        as tin_shop,
       to_char(max(m.sent_at), 'DD/MM HH24:MI')                      as tin_moi_nhat
  from sales_conversations c
  left join sales_messages m on m.conversation_id = c.id
 group by c.page_id order by 2 desc;

\echo ''
\echo '── BẰNG CHỨNG AN TOÀN (bốn dòng đầu PHẢI bằng 0) ──'
select 'tin gợi ý đã gửi cho khách' as phep_do, count(*)::text as so_do, (count(*) = 0) as dat from sales_suggestions where sent
union all
select 'tin do NHÂN SỰ AI soạn nằm trong bảng tin', count(*)::text, count(*) = 0 from sales_messages where from_agent
union all
select 'hội thoại đã gắn đơn POS', count(*)::text, count(*) = 0 from sales_conversations where order_id is not null
union all
select 'thao tác KẾT THÚC ở nấc trợ lý (gửi / sửa & gửi)', count(*)::text, count(*) = 0
  from sales_copilot_actions where action in ('SEND', 'EDIT_SEND')
union all
-- ĐẢO CHIỀU có chủ ý: lời gọi công cụ GHI bị cổng từ chối càng nhiều càng tốt — nó là bằng chứng
-- cổng đang làm việc, không phải một con số xấu.
select 'lời gọi công cụ GHI bị CỔNG TỪ CHỐI', count(*)::text, true from ai_tool_calls where outcome = 'DENIED';

\echo ''
\echo '── KHỐI LƯỢNG ĐÃ CHẠY VÀ ĐÃ CHẤM ──'
select (select count(*) from ai_runs)                                          as luot_chay,
       (select count(*) from sales_suggestions)                                as goi_y,
       (select count(*) from sales_suggestions where suggested_reply <> '')    as goi_y_co_chu,
       (select count(*) from sales_review_labels where reviewed_at is not null) as da_cham_tay,
       (select count(*) from sales_regression_cases where active)              as ca_hoi_quy_dang_bat;

\echo ''
\echo '── CHẤM TAY: CHƯA CÓ DỮ LIỆU khác hẳn 0% LỖI ──'
-- Mẫu số 0 ⇒ NULL. Một bảng in "0% sai" khi chưa ai chấm dòng nào là lời nói dối nguy hiểm nhất
-- mà báo cáo chất lượng có thể nói (AGENTS.md mục 42).
select count(*)                                                     as da_cham,
       case when count(*) = 0 then null
            else round(100.0 * count(*) filter (where verdict = 'GOOD') / count(*), 1)
       end                                                          as ty_le_dat_phan_tram,
       case when count(*) = 0 then 'CHƯA CÓ DỮ LIỆU CHẤM' else 'đã có dữ liệu' end as trang_thai
  from sales_review_labels where reviewed_at is not null;
