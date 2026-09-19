-- ─────────────────────────────────────────────────────────────────────────────
-- P0 BƯỚC B — MẺ NGẦM VỪA CHẠY NÓI GÌ. CHỈ ĐỌC.
--
-- Đọc từ CSDL chứ không từ log: log in ra các CA ĐẠI DIỆN (chọn để người đọc), còn cái cần ở đây
-- là TỔNG — đã gọi bao nhiêu, đạt bao nhiêu, hỏng vì nhóm nào. Hai thứ khác nhau, và đếm bằng mắt
-- trên một danh sách đã được chọn lọc là cách chắc chắn ra số sai.
--
-- Cửa sổ 45 phút: đủ trùm lượt dò (bước A) và mẻ ngầm (bước B) của phiên này, không trùm lịch sử cũ.
-- ─────────────────────────────────────────────────────────────────────────────

\echo '── B1. LƯỢT GỌI MÔ HÌNH TRONG 45 PHÚT QUA ──'
select
  c.provider,
  c.model,
  c.tier::text                                    as nac,
  c.step                                          as buoc,
  count(*)                                        as so_lan,
  count(*) filter (where c.ok)                    as dat,
  count(*) filter (where not c.ok)                as hong,
  coalesce(sum(c.input_tokens), 0)                as token_vao,
  coalesce(sum(c.cached_input_tokens), 0)         as token_dem,
  coalesce(sum(c.output_tokens), 0)               as token_ra,
  round(avg(c.latency_ms) filter (where c.ok))    as tre_tb_ms,
  round(percentile_cont(0.95) within group (order by case when c.ok then c.latency_ms end)::numeric, 0) as tre_p95_ms,
  count(*) filter (where c.cost_vnd is null)      as chua_khai_gia
from ai_model_calls c
where c.created_at > now() - interval '45 minutes'
group by 1, 2, 3, 4
order by 5 desc;

\echo ''
\echo '── B2. LỖI THEO LỜI LỖI — để phân loại được, không gộp thành một chữ "hỏng" ──'
\echo '   Bảng RỖNG = không lượt nào hỏng trong cửa sổ.'
select
  left(regexp_replace(regexp_replace(coalesce(c.error, ''), '\s+', ' ', 'g'), '[0-9a-f]{8,}', '<mã>', 'g'), 100) as loi_lo,
  count(*) as so_lan
from ai_model_calls c
where c.created_at > now() - interval '45 minutes' and not c.ok
group by 1
order by 2 desc;

\echo ''
\echo '── B3. LƯỢT CHẠY: nấc kết thúc và lý do leo nấc (đường lui có bị dùng tới không) ──'
select
  r.tier::text                                    as nac_ket_thuc,
  coalesce(r.escalation_reason, '(không leo nấc)') as ly_do_leo,
  count(*)                                        as so_luot,
  count(*) filter (where r.status = 'SUCCEEDED')  as thanh_cong,
  count(*) filter (where r.status = 'HANDED_OFF') as chuyen_nguoi,
  count(*) filter (where r.status = 'FAILED')     as that_bai
from ai_runs r
where r.created_at > now() - interval '45 minutes'
group by 1, 2
order by 3 desc;

\echo ''
\echo '── B4. HAI CON SỐ PHẢI BẰNG 0 — đọc lại từ bảng, không phải lời hứa ──'
select
  (select count(*) from sales_suggestions s where s.created_at > now() - interval '45 minutes' and s.sent)                  as tin_da_gui_khach,
  -- KHÔNG phải một con số an toàn, và tên cũ ("hành động khác không gửi") đọc như thể nó là.
  -- `production_action` là hành động máy ĐƯỢC PHÉP làm: ở nấc SHADOW luôn `NO_SEND`, ở nấc COPILOT
  -- là hành động thật để NGƯỜI bấm. Bản chạy thử đang ở COPILOT nên con số này khác 0 là ĐÚNG.
  -- Hai ô nói về an toàn là `sent` và số đơn đã tạo — cả hai đều ở dưới.
  (select count(*) from sales_suggestions s where s.created_at > now() - interval '45 minutes' and s.production_action <> 'NO_SEND') as duoc_phep_nguoi_bam,
  -- `ai_tool_calls` dùng cột `outcome` chứ không có cột `ok`: một lượt gọi công cụ có thể bị
  -- CHẶN (DENIED) chứ không chỉ chạy-được / hỏng, nên một ô boolean không đủ chỗ nói.
  (select count(*) from ai_tool_calls t where t.created_at > now() - interval '45 minutes' and t.tool in ('order.create_draft','order.confirm') and t.outcome = 'OK') as don_da_tao,
  (select coalesce(string_agg(distinct t.outcome, ' · '), '(không gọi lần nào)') from ai_tool_calls t where t.created_at > now() - interval '45 minutes' and t.tool in ('order.create_draft','order.confirm')) as ket_cuc_cong_cu_don;
