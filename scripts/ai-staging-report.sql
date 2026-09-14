-- ───────── BÁO CÁO CHẤT LƯỢNG MỘT LƯỢT NẠP — CHỈ ĐỌC ─────────
--
-- Chạy trên CSDL RIÊNG của bản chạy thử:
--   docker exec -i vnx-ai-staging-db psql -U erp -d erp -P pager=off -f - < scripts/ai-staging-report.sql
--
-- Vì sao là SQL chứ không phải thêm code vào script nạp: báo cáo đọc được mà KHÔNG cần dựng lại
-- ảnh. Sửa một câu truy vấn ở đây là sửa xong; sửa một dòng TypeScript trong ảnh là tám phút dựng.
--
-- Mọi câu đều CHỈ ĐỌC. Không câu nào ghi, xoá hay sửa một dòng nào.

\pset border 2

\echo ''
\echo '════════ 1. NẠP ĐƯỢC GÌ ════════'
select
  (select count(*) from sales_conversations)                             as "hội thoại",
  (select count(*) from sales_messages)                                  as "tin nhắn",
  (select count(distinct conversation_id) from sales_messages)           as "hội thoại có tin",
  (select count(*) from sales_suggestions)                               as "gợi ý",
  (select count(*) from ai_runs where subject_type = 'CONVERSATION')     as "lượt chạy";

\echo ''
\echo '(14 bảng của nhân sự AI — liệt kê ĐÍCH DANH, không dò theo mẫu tên:'
\echo ' mẫu ai\_% còn khớp ai_interactions của AI Copilot bên main và làm số đếm ra 15/14)'
select count(*) || '/14' as "bảng nhân sự AI có mặt"
from information_schema.tables
where table_schema = 'public' and table_name in (
  'ai_agents','ai_agent_versions','ai_events','ai_tasks','ai_runs','ai_tool_calls',
  'ai_model_calls','ai_approvals','ai_errors','sales_conversations','sales_messages',
  'sales_suggestions','sales_followups','sales_review_labels');

\echo ''
\echo '════════ 2. PHÂN BIỆT KHÁCH / NHÂN VIÊN / BOT ════════'
\echo '(sender_type UNKNOWN nhiều = bộ phân loại chưa nhận ra nguồn tin, phải xem lại)'
select
  sender_type                      as "loại người gửi",
  count(*)                         as "số tin",
  count(*) filter (where from_page) as "từ phía shop",
  count(*) filter (where from_agent) as "do máy soạn (phải 0)"
from sales_messages
group by sender_type
order by count(*) desc;

\echo ''
\echo '════════ 3. CHỐNG TRÙNG ════════'
\echo '(khoá duy nhất (conversation_id, external_id) chặn ở tầng CSDL — số dưới đây phải là 0)'
select
  (select count(*) from (select conversation_id, external_id from sales_messages
                         where external_id <> '' group by 1,2 having count(*) > 1) d) as "trùng mã tin",
  (select count(*) from (select conversation_id, content_hash from sales_messages
                         where content_hash <> '' group by 1,2 having count(*) > 1) d) as "trùng vân tay nội dung",
  (select count(*) from (select page_id, external_id from sales_conversations
                         group by 1,2 having count(*) > 1) d)                         as "trùng hội thoại";

\echo ''
\echo '════════ 4. GOM ĐÚNG HỘI THOẠI ════════'
select
  page_id                                    as "page",
  count(*)                                   as "hội thoại",
  round(avg(n)::numeric, 1)                  as "tin/hội thoại",
  min(n)                                     as "ít nhất",
  max(n)                                     as "nhiều nhất",
  count(*) filter (where n = 0)              as "hội thoại RỖNG"
from (
  select c.id, c.page_id, (select count(*) from sales_messages m where m.conversation_id = c.id) as n
  from sales_conversations c
) t
group by page_id;

\echo ''
\echo '════════ 5. BÓC ĐƯỢC GÌ TỪ HỘI THOẠI ════════'
\echo '(NULL = CHƯA BÓC ĐƯỢC, không phải "không có" — hai thứ khác nhau)'
select
  count(*)                                                                    as "hội thoại",
  count(*) filter (where state->>'productId' is not null)                     as "nhận ra sản phẩm",
  count(*) filter (where state->>'variantId' is not null)                     as "nhận ra mẫu mã",
  count(*) filter (where nullif(state->>'size', '')     is not null)          as "size",
  count(*) filter (where nullif(state->>'color', '')    is not null)          as "màu",
  count(*) filter (where coalesce(nullif(phone, ''), nullif(state->>'phone', '')) is not null) as "SĐT",
  count(*) filter (where nullif(state->>'address', '')  is not null)          as "địa chỉ",
  count(*) filter (where nullif(state->>'province', '') is not null)          as "tỉnh/thành",
  count(*) filter (where coalesce((state->>'purchaseIntent')::boolean, false)) as "có ý định mua",
  count(*) filter (where jsonb_typeof(state->'pending') = 'object')           as "đã đọc bản chốt",
  count(*) filter (where stage in ('CONFIRMED', 'ORDER_CREATED'))             as "khách đã chốt"
from sales_conversations;

\echo ''
\echo '════════ 6. GIAI ĐOẠN HỘI THOẠI ════════'
select stage as "giai đoạn", count(*) as "số hội thoại"
from sales_conversations group by stage order by count(*) desc;

\echo ''
\echo '════════ 7. KẾT CỤC LƯỢT CHẠY — CHUYỂN NGƯỜI VÀ LỖI ════════'
select status as "kết cục", count(*) as "số lượt"
from ai_runs where subject_type = 'CONVERSATION' group by status order by count(*) desc;

\echo ''
\echo 'Lý do chuyển người / leo nấc:'
select coalesce(nullif(escalation_reason, ''), '(không)') as "lý do", count(*) as "số lượt"
from ai_runs where subject_type = 'CONVERSATION' group by 1 order by count(*) desc;

\echo ''
\echo '════════ 8. CÔNG CỤ ERP ĐÃ GỌI — KHỚP SẢN PHẨM HỎNG Ở ĐÂU ════════'
select tool as "công cụ", outcome as "kết cục", count(*) as "lần",
       round(avg(latency_ms)::numeric, 0) as "ms trung bình"
from ai_tool_calls group by tool, outcome order by count(*) desc;

\echo ''
\echo '════════ 9. LỖI GHI NHẬN ĐƯỢC ════════'
select scope as "phạm vi", left(message, 90) as "thông báo", count(*) as "lần"
from ai_errors group by scope, left(message, 90) order by count(*) desc limit 15;

\echo ''
\echo '════════ 10. TOKEN & CHI PHÍ ════════'
\echo '(chi phí NULL = CHƯA BIẾT vì chưa khai bảng giá — KHÔNG phải 0đ)'
select
  count(*)                                        as "lượt chạy",
  sum(input_tokens)                               as "token vào",
  sum(output_tokens)                              as "token ra",
  sum(cached_input_tokens)                        as "token đệm",
  count(*) filter (where cost_vnd is null)        as "chi phí CHƯA BIẾT",
  coalesce(sum(cost_vnd), 0)                      as "chi phí đã tính (VND)",
  round(avg(latency_ms)::numeric, 0)              as "ms trung bình"
from ai_runs where subject_type = 'CONVERSATION';

\echo ''
\echo '════════ 11. GỢI Ý CỦA MÁY vs CÂU NHÂN VIÊN THẬT ════════'
select
  count(*)                                                   as "gợi ý",
  count(*) filter (where coalesce(suggested_reply,'') <> '') as "máy có soạn câu",
  count(*) filter (where coalesce(human_reply,'')    <> '') as "đã nối được câu nhân viên",
  count(*) filter (where human_response_seconds is null)     as "thời gian phản hồi CHƯA BIẾT",
  count(*) filter (where sent)                               as "ĐÃ GỬI CHO KHÁCH (phải 0)"
from sales_suggestions;

\echo ''
\echo '════════ 12. BẰNG CHỨNG KHÔNG GỬI, KHÔNG LÊN ĐƠN ════════'
select
  (select count(*) from sales_suggestions where sent)                          as "tin đã gửi (phải 0)",
  (select count(*) from sales_messages where from_agent)                        as "tin do máy (phải 0)",
  (select count(*) from sales_conversations where order_id is not null)         as "đơn do máy tạo (phải 0)",
  (select count(*) from ai_tool_calls where tool in ('order.create_draft','order.confirm') and outcome = 'OK') as "công cụ lên đơn CHẠY ĐƯỢC (phải 0)";

\echo ''
\echo '════════ 5B. SỐ ĐO CƠ THỂ & Ý ĐỊNH — ĐỌC TỪ ai_runs.understanding ════════'
\echo '(SalesState KHÔNG giữ số đo; chúng chỉ sống trong bản hiểu của từng lượt chạy)'
select
  count(*)                                                                as "lượt chạy",
  count(*) filter (where nullif(understanding->'entities'->>'heightCm','') is not null) as "chiều cao",
  count(*) filter (where nullif(understanding->'entities'->>'weightKg','') is not null) as "cân nặng",
  count(*) filter (where nullif(understanding->'entities'->>'bustCm','')   is not null) as "vòng 1",
  count(*) filter (where nullif(understanding->'entities'->>'waistCm','')  is not null) as "vòng 2",
  count(*) filter (where nullif(understanding->'entities'->>'hipCm','')    is not null) as "vòng 3",
  count(*) filter (where understanding->'intents' ? 'PURCHASE_INTENT')    as "ý định mua",
  count(*) filter (where understanding->'intents' ? 'SIZE_QUESTION')      as "hỏi size",
  count(*) filter (where understanding->'intents' ? 'PRICE_QUESTION')     as "hỏi giá",
  count(*) filter (where understanding->'intents' ? 'SHIPPING_QUESTION')  as "hỏi ship"
from ai_runs where subject_type = 'CONVERSATION' and understanding is not null;

\echo ''
\echo 'Ý định nhận ra được, đếm theo từng loại:'
select y as "ý định", count(*) as "lượt"
from ai_runs, lateral jsonb_array_elements_text(coalesce(understanding->'intents', '[]'::jsonb)) y
where subject_type = 'CONVERSATION' group by y order by count(*) desc;

\echo ''
\echo '════════ 13. TỪNG HỘI THOẠI — CHỌN VÍ DỤ TIÊU BIỂU ════════'
\echo '(KHÔNG in nội dung tin khách: log của Actions là CÔNG KHAI. Chỉ in dấu hiệu có/không.)'
select
  left(c.external_id, 10)                                    as "hội thoại",
  c.stage                                                    as "giai đoạn",
  (select count(*) from sales_messages m where m.conversation_id = c.id)                        as "tin",
  (select count(*) from sales_messages m where m.conversation_id = c.id and m.sender_type = 'CUSTOMER') as "khách",
  (select count(*) from sales_messages m where m.conversation_id = c.id and m.from_page)        as "shop",
  case when c.state->>'productId' is not null then '✓' else '·' end                             as "SP",
  case when c.state->>'variantId' is not null then '✓' else '·' end                             as "mẫu",
  case when nullif(c.state->>'color','') is not null then '✓' else '·' end                      as "màu",
  case when nullif(c.state->>'size','')  is not null then '✓' else '·' end                      as "size",
  case when coalesce(nullif(c.phone,''), nullif(c.state->>'phone','')) is not null then '✓' else '·' end as "SĐT",
  case when nullif(c.state->>'address','') is not null then '✓' else '·' end                    as "ĐC",
  case when coalesce((c.state->>'purchaseIntent')::boolean, false) then '✓' else '·' end        as "muốn mua",
  r.status                                                   as "kết cục",
  r.tier                                                     as "nấc",
  coalesce(r.escalation_reason, '·')                         as "lý do chuyển người",
  s.action                                                   as "hành động",
  round(s.confidence::numeric, 2)                            as "tin cậy",
  length(s.suggested_reply)                                  as "dài câu máy",
  case when coalesce(s.human_reply,'') <> '' then '✓' else '·' end                              as "có câu người"
from sales_conversations c
left join lateral (
  select * from ai_runs r2 where r2.subject_type = 'CONVERSATION' and r2.subject_id = c.id
  order by r2.created_at desc limit 1) r on true
left join lateral (
  select * from sales_suggestions s2 where s2.conversation_id = c.id
  order by s2.created_at desc limit 1) s on true
order by c.stage, c.external_id;

\echo ''
\echo '════════ 14. CÂU MÁY SOẠN (chỉ đầu ra của máy, đã che mọi chữ số) ════════'
\echo '(Không in tin nhắn của khách. Chữ số bị thay bằng ● để không lộ SĐT/địa chỉ/giá.)'
select
  left(c.external_id, 10)                                          as "hội thoại",
  s.action                                                         as "hành động",
  s.stage_before || ' → ' || s.stage_after                         as "giai đoạn",
  left(regexp_replace(s.suggested_reply, '[0-9]', '●', 'g'), 180)  as "câu máy soạn (đã che số)"
from sales_suggestions s
join sales_conversations c on c.id = s.conversation_id
order by c.external_id, s.created_at;
