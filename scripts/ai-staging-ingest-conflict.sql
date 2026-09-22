-- VÌ SAO HAI ĐƯỜNG NẠP ĐÁNH MÃ KHÁC NHAU CHO CÙNG MỘT TIN — CHỈ ĐỌC.
--
-- Đo 22/09/2026: bốn tin nhắn sinh ra 17.962 dòng `ai_errors`, 4.571 dòng cho MỘT tin. Phần
-- ĐẾM đã được vá (khoá tự nhiên + `detail.seen`), nhưng đó mới là vá chỗ RỈ, chưa trả lời
-- được câu hỏi thật: vì sao hai lượt đọc lại gán hai mã khác nhau cho cùng một câu của khách.
--
-- Tệp này KHÔNG in nội dung tin khách — log của GitHub Actions là CÔNG KHAI. Chỉ in độ dài,
-- mốc thời gian, cờ đính kèm và mã tin: đủ để phân biệt ba giả thuyết dưới đây, không đủ để
-- đọc trộm một câu nào.
--
--   ① VÂN TAY DỰNG TỪ HƯ KHÔNG — tin rỗng chữ VÀ thiếu mốc ⇒ vân tay là "IN|0|", nên MỌI tin
--     rỗng trong cùng hội thoại đều đụng nhau. Nhận ra bằng: dài chữ = 0 và mốc NULL.
--   ② HAI TIN THẬT TRÙNG GIÂY — shop gửi hai câu y hệt trong cùng một giây (mẫu câu tự động).
--     Đây KHÔNG phải trùng chéo kênh, và tin thứ hai đang bị bỏ rơi một cách im lặng.
--   ③ TRÙNG CHÉO KÊNH THẬT — webhook và poll gán hai mã cho cùng một câu. Nhận ra bằng:
--     `ingest_source` của hai bên KHÁC nhau.
--
-- Giả thuyết nào đúng quyết định bản vá nào đúng, và ba bản vá ấy đi ba hướng khác hẳn nhau.

\echo ''
\echo '════════ 1. CÁC MÂU THUẪN ĐANG ĐƯỢC GHI NHẬN ════════'
select
  e.subject_id                                   as "hội thoại",
  left(e.message, 150)                           as "thông báo",
  coalesce((e.detail ->> 'seen')::bigint, 1)     as "số lần gặp",
  count(*)                                       as "số dòng",
  min(e.created_at)                              as "lần đầu",
  max(e.created_at)                              as "lần cuối"
from ai_errors e
where e.scope = 'INGEST' and e.message like 'Hai đường nạp đánh mã khác nhau%'
group by 1, 2, 3
order by 4 desc, 3 desc
limit 20;

\echo ''
\echo '════════ 2. BA GIẢ THUYẾT — ĐẾM TRÊN TOÀN BỘ TIN ĐÃ NẠP ════════'
\echo '(nhóm = cùng hội thoại + cùng vân tay nội dung, có từ 2 mã tin trở lên)'
with nhom as (
  select
    m.conversation_id,
    m.content_hash,
    count(*)                                  as so_dong,
    count(distinct m.external_id)             as so_ma,
    count(distinct m.ingest_source)           as so_duong_nap,
    max(length(coalesce(m.text, '')))         as dai_chu,
    count(*) filter (where m.sent_at is null) as thieu_moc,
    bool_or(m.has_attachment)                 as co_dinh_kem
  from sales_messages m
  group by 1, 2
  having count(distinct m.external_id) > 1
)
select
  count(*)                                                                  as "nhóm đụng nhau",
  count(*) filter (where dai_chu = 0 and thieu_moc > 0)                     as "① vân tay rỗng",
  count(*) filter (where so_duong_nap = 1 and not (dai_chu = 0 and thieu_moc > 0)) as "② cùng một đường nạp",
  count(*) filter (where so_duong_nap > 1)                                  as "③ chéo kênh thật",
  count(*) filter (where co_dinh_kem)                                       as "có đính kèm",
  sum(so_dong)                                                              as "tổng dòng dính"
from nhom;

\echo ''
\echo '════════ 3. TỪNG NHÓM — DẤU HIỆU, KHÔNG IN NỘI DUNG ════════'
select
  left(m.conversation_id, 12)              as "hội thoại",
  left(m.content_hash, 28)                 as "vân tay",
  m.external_id                            as "mã tin",
  m.ingest_source                          as "đường nạp",
  m.sender_type                            as "người gửi",
  length(coalesce(m.text, ''))             as "dài chữ",
  m.has_attachment                         as "đính kèm",
  m.sent_at                                as "mốc ĐVVC/Pancake",
  m.created_at                             as "lúc ERP ghi"
from sales_messages m
join (
  select conversation_id, content_hash
  from sales_messages
  group by 1, 2
  having count(distinct external_id) > 1
) d on d.conversation_id = m.conversation_id and d.content_hash = m.content_hash
order by m.conversation_id, m.content_hash, m.created_at
limit 60;

\echo ''
\echo '════════ 4. VÂN TAY RỖNG CÓ PHẢI CHUYỆN PHỔ BIẾN KHÔNG ════════'
\echo '(tin rỗng chữ mà vẫn nạp được: nếu nhiều, luật vân tay phải đổi chứ không vá từng ca)'
select
  count(*)                                                                as "tổng tin",
  count(*) filter (where coalesce(text, '') = '')                         as "rỗng chữ",
  count(*) filter (where sent_at is null)                                 as "thiếu mốc",
  count(*) filter (where coalesce(text, '') = '' and sent_at is null)     as "rỗng chữ VÀ thiếu mốc",
  count(*) filter (where has_attachment and coalesce(text, '') = '')      as "chỉ có đính kèm"
from sales_messages;
