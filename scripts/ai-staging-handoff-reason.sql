-- ════════════════════════════════════════════════════════════════════════════════════════════
-- LÝ DO CHUYỂN NGƯỜI CÓ ĐƯỢC LƯU KHÔNG — ĐỌC LẠI TỪ CSDL, TRƯỚC ↔ SAU BẢN VÁ. CHỈ ĐỌC.
--
--   Actions → "Vận hành ERP trên VPS" → ai-staging-sql · arg = ai-staging-handoff-reason.sql
--
-- ═══ VÌ SAO PHẢI ĐỌC LẠI TỪ CSDL ═══
--
-- Mẻ chạy ngầm tự in ra "HANDOFF_HUMAN · chuyển người LOW_CONFIDENCE". Dòng ấy đọc từ BIẾN TRONG
-- BỘ NHỚ của chính lượt chạy vừa xong — nó chứng minh máy BIẾT lý do, không chứng minh lý do đã
-- được GHI XUỐNG. Mà bản vá hôm nay sửa đúng chỗ ghi xuống: trước đây chỉ bản quyết định ĐƯỢC
-- PHÉP được lưu, còn `sales_suggestions.action` lại lấy từ bản ĐỂ CHẤM — nên lượt có người đã vào
-- cầm hội thoại mang `HANDOFF_HUMAN` mà không có lý do nào tra được.
--
-- Một phép đo đọc lại chính biến vừa in ra thì luôn xanh, kể cả khi đường ghi hỏng hoàn toàn.
--
-- ═══ MỐC CẮT ═══
--
-- Container ứng dụng dựng lại lúc 19/09/2026 11:23:36 UTC (run 35439906471); bộ nạp lúc 11:33
-- (run 35440400008). Mẻ chạy ngầm chạy TRONG container ứng dụng, nên mốc của nó là mốc ứng dụng.
-- Lấy 11:35 UTC làm lằn ranh — muộn hơn cả hai, nên không lượt nào bị xếp nhầm sang phía SAU.
-- ════════════════════════════════════════════════════════════════════════════════════════════

\echo '═══ 1. MỐC CẮT VÀ KHỐI LƯỢNG HAI PHÍA ═══'
select case when s.created_at < timestamptz '2026-09-19 11:35:00+00' then 'TRƯỚC bản vá' else 'SAU bản vá' end as phia,
       count(*)                                                                as tong_goi_y,
       count(*) filter (where s.action = 'HANDOFF_HUMAN')                      as so_lan_chuyen_nguoi,
       min(s.created_at)                                                       as som_nhat,
       max(s.created_at)                                                       as muon_nhat
  from sales_suggestions s
 group by 1 order by 1 desc;

\echo ''
\echo '═══ 2. CÂU HỎI CHÍNH: CHUYỂN NGƯỜI MÀ KHÔNG TRA ĐƯỢC LÝ DO ═══'
-- Lý do đọc từ bản ĐỂ CHẤM trước (`decision->'evaluation'`), lùi về bản ĐƯỢC PHÉP cho những lượt
-- chạy trước bản vá. Mẫu số 0 ⇒ NULL, không ⇒ 0% (luật 42): một phía chưa có lượt chuyển người
-- nào mà in "0% thiếu lý do" là khoe một thành tích chưa ai lập được.
with lieu as (
  select case when s.created_at < timestamptz '2026-09-19 11:35:00+00' then 'TRƯỚC bản vá' else 'SAU bản vá' end as phia,
         coalesce(
           nullif(r.decision->'evaluation'->>'handoffReason', ''),
           nullif(r.decision->>'handoffReason', '')
         ) as ly_do
    from sales_suggestions s
    left join ai_runs r on r.id = s.run_id
   where s.action = 'HANDOFF_HUMAN'
)
select phia,
       count(*)                                    as chuyen_nguoi,
       count(*) filter (where ly_do is not null)   as co_ma_ly_do,
       count(*) filter (where ly_do is null)       as THIEU_ma_ly_do,
       case when count(*) = 0 then null
            else round(100.0 * count(*) filter (where ly_do is null) / count(*), 1)
       end                                          as ty_le_thieu_phan_tram
  from lieu group by 1 order by 1 desc;

\echo ''
\echo '═══ 3. BÓC TÁCH THEO MÃ LÝ DO, HAI PHÍA ═══'
with lieu as (
  select case when s.created_at < timestamptz '2026-09-19 11:35:00+00' then 'TRƯỚC' else 'SAU' end as phia,
         coalesce(
           nullif(r.decision->'evaluation'->>'handoffReason', ''),
           nullif(r.decision->>'handoffReason', ''),
           '⚠ KHÔNG TRA ĐƯỢC'
         ) as ly_do
    from sales_suggestions s
    left join ai_runs r on r.id = s.run_id
   where s.action = 'HANDOFF_HUMAN'
)
select ly_do,
       count(*) filter (where phia = 'TRƯỚC') as truoc_ban_va,
       count(*) filter (where phia = 'SAU')   as sau_ban_va,
       count(*)                                as tong
  from lieu group by 1 order by 4 desc;

\echo ''
\echo '═══ 4. BẢN ĐỂ CHẤM CÓ ĐƯỢC LƯU KHÔNG — VÀ CHỈ Ở ĐÚNG CHỖ CẦN LƯU ═══'
-- Vế thuận: lượt CHỈ ĐỂ CHẤM (người đã vào cầm việc) phải CÓ `decision.evaluation`.
-- Vế nghịch: lượt bình thường KHÔNG được có — lưu bừa cho mọi lượt là quay về chỗ vừa sửa.
select case when s.created_at < timestamptz '2026-09-19 11:35:00+00' then 'TRƯỚC' else 'SAU' end as phia,
       s.evaluation_only                                                      as chi_de_cham,
       count(*)                                                               as so_luot,
       count(*) filter (where r.decision ? 'evaluation'
                          and r.decision->'evaluation' <> 'null'::jsonb)      as co_ban_de_cham
  from sales_suggestions s
  left join ai_runs r on r.id = s.run_id
 group by 1, 2 order by 1 desc, 2;

\echo ''
\echo '═══ 5. BẰNG CHỨNG DÒNG THẬT — 10 lượt chuyển người MỚI NHẤT ═══'
-- In ra để người đọc tự kiểm, không phải tin một con số tổng hợp.
select to_char(s.created_at, 'DD/MM HH24:MI:SS')                                as luc,
       s.evaluation_only                                                        as chi_de_cham,
       coalesce(
         nullif(r.decision->'evaluation'->>'handoffReason', ''),
         nullif(r.decision->>'handoffReason', ''),
         '⚠ KHÔNG TRA ĐƯỢC'
       )                                                                        as ly_do,
       coalesce(r.decision->>'action', '(không có)')                            as hanh_dong_duoc_phep,
       coalesce(r.decision->'evaluation'->>'action', '(không lưu)')             as hanh_dong_de_cham
  from sales_suggestions s
  left join ai_runs r on r.id = s.run_id
 where s.action = 'HANDOFF_HUMAN'
 order by s.created_at desc limit 10;
