-- ════════════════════════════════════════════════════════════════════════════════════════════
-- MÃ PAGE FACEBOOK ↔ MÃ PAGE PANCAKE — ĐI TÌM NGUỒN CÓ THẨM QUYỀN. CHỈ ĐỌC.
--
--   Actions → "Vận hành ERP trên VPS" → ai-staging-sql · arg = ai-staging-page-identity.sql
--
-- ═══ VÌ SAO TỆP NÀY TỒN TẠI ═══
--
-- Bài kiểm đọc Pancake ngày 19/09/2026 in ra MỌI khoá trông như một mã định danh trong đối tượng
-- page mà Pancake trả về. Đúng ba khoá: `id` (chính mã Pancake), `role_in_page`, `shop_id`. Mã
-- Facebook `61589434244037` KHÔNG khớp khoá nào.
--
-- Điều đó KHÔNG chứng minh hai mã không thuộc về nhau — nó chỉ chứng minh **Pages API của Pancake
-- không phải nguồn trả lời được câu hỏi này**. Nên phải đi hỏi những nguồn khác, và mỗi nguồn
-- phải tự khai nó thuộc hạng nào:
--
--   CHỨNG CỨ   — dữ liệu do BÊN NGOÀI sinh ra, ERP chỉ chép lại (đường dẫn bài viết Facebook,
--                gói tin webhook, mã quảng cáo). Đây là thứ duy nhất KẾT LUẬN được.
--   KHAI BÁO   — một người gõ vào ô cấu hình. Đọc được, nhưng nó là NIỀM TIN của người gõ chứ
--                không phải quan sát; lấy nó làm bằng chứng là tự xác nhận chính mình.
--   VẮNG MẶT   — nguồn có tồn tại nhưng không chứa gì.
--
-- Gộp ba hạng ấy lại là cách dễ nhất để một con số gõ tay biến thành một sự thật đã kiểm chứng.
-- ════════════════════════════════════════════════════════════════════════════════════════════

\echo '═══ 0. HAI MÃ ĐANG ĐƯỢC HỎI ═══'
\echo '  Pancake  : 1117899664739453   (khoá tự nhiên của page trong mọi bảng dưới đây)'
\echo '  Facebook : 61589434244037     (mã cần xác minh — KHÔNG được giả định là đúng)'

\echo ''
\echo '═══ 1. KHAI BÁO — ô cấu hình trong ERP (KHÔNG phải chứng cứ) ═══'
-- Ô này do người gõ. Nó trả lời "ai đó tin điều gì", không trả lời "sự thật là gì".
select pancake_page_id,
       coalesce(nullif(facebook_page_id, ''), '(để trống)') as facebook_page_id_da_khai,
       name, ai_mode, active, updated_at
  from fanpage_sales_profiles order by pancake_page_id;

\echo ''
\echo '═══ 2. CHỨNG CỨ — ĐƯỜNG DẪN BÀI VIẾT FACEBOOK trong tin nhắn đã nạp ═══'
-- `post_url` chép từ `attachments[].post_attachments[].url` của Pancake, tức một URL do FACEBOOK
-- sinh ra. Dạng thường gặp: facebook.com/<mã page>/posts/<mã bài>. Nếu có, đây là CHỨNG CỨ.
select count(*) filter (where post_url <> '')                                     as tin_co_duong_dan_bai,
       count(*) filter (where post_url ~ 'facebook\.com/[0-9]{6,}')               as duong_dan_mang_mot_day_so,
       count(*)                                                                   as tong_tin
  from sales_messages;

\echo ''
\echo '── Những dãy số ĐỨNG NGAY SAU facebook.com/ (mỗi dãy một dòng, kèm số lần gặp) ──'
select (regexp_match(post_url, 'facebook\.com/([0-9]{6,})'))[1] as day_so_trong_duong_dan,
       count(*)                                                 as so_lan,
       min(sent_at)                                             as lan_dau,
       max(sent_at)                                             as lan_cuoi
  from sales_messages
 where post_url ~ 'facebook\.com/[0-9]{6,}'
 group by 1 order by 2 desc limit 20;

\echo ''
\echo '═══ 3. CHỨNG CỨ — MÃ QUẢNG CÁO khách đã bấm ═══'
-- `ad_id` là mã của Facebook. Nó KHÔNG chứa mã page, nhưng nó là chiếc cầu: tra mã quảng cáo trên
-- Facebook Ads sẽ ra page chạy nó. In ra để người đi tra, KHÔNG tự suy.
select count(*) filter (where ad_id <> '')  as tin_co_ma_quang_cao,
       count(distinct nullif(ad_id, ''))    as so_ma_quang_cao_khac_nhau
  from sales_messages;
select distinct ad_id from sales_messages where ad_id <> '' order by 1 limit 10;

\echo ''
\echo '═══ 4. CHỨNG CỨ — MỌI DÃY SỐ DÀI trong payload thô của tin nhắn ═══'
-- Quét `raw` (payload Pancake nguyên văn) tìm mọi dãy ≥ 12 chữ số, bỏ đi mã Pancake của chính
-- page và mã hội thoại. Còn lại là ứng viên cho mã Facebook — nếu 61589434244037 có mặt ở đâu
-- trong dữ liệu thật, nó phải lộ ra ở đây.
select day_so, count(*) as so_lan
  from (
    select (regexp_matches(raw::text, '[0-9]{12,}', 'g'))[1] as day_so
      from sales_messages
     where raw is not null
     limit 200000
  ) t
 where day_so <> '1117899664739453'
 group by 1 order by 2 desc limit 25;

\echo ''
\echo '── CÂU HỎI DỨT KHOÁT: mã Facebook cần xác minh có xuất hiện trong dữ liệu thật không? ──'
select count(*) as so_tin_co_chua_ma_61589434244037
  from sales_messages where raw::text like '%61589434244037%';
-- `sales_conversations` KHÔNG giữ payload thô; nó giữ `state` (trạng thái bán) và `offer_snapshot`
-- (ảnh chụp điều kiện bán). Quét cả hai để không bỏ sót, và nói rõ là đã quét cái gì.
select count(*) filter (where coalesce(state::text, '') like '%61589434244037%')           as trong_trang_thai,
       count(*) filter (where coalesce(offer_snapshot::text, '') like '%61589434244037%')  as trong_anh_chup_dieu_kien_ban,
       count(*)                                                                             as tong_hoi_thoai
  from sales_conversations;

\echo ''
\echo '═══ 5. CHỨNG CỨ — GÓI TIN WEBHOOK ═══'
-- Gói tin do Pancake gửi tới có thể mang trường mà API đọc không trả. Bảng rỗng cũng là một câu
-- trả lời: nghĩa là page này đang chạy bằng ĐỌC BÙ, không có webhook nào để mà đọc.
select source, count(*) as so_goi, min(received_at) as dau, max(received_at) as cuoi
  from webhook_events group by 1 order by 2 desc;
select count(*) as goi_tin_co_chua_ma_facebook
  from webhook_events where payload::text like '%61589434244037%';

\echo ''
\echo '═══ 6. CHỨNG CỨ — BÀI VIẾT CỦA QUẢNG CÁO (fb_ads.story_id = "<mã page>_<mã bài>") ═══'
-- Bảng này do đồng bộ Facebook Ads ghi. Trên bản chạy thử nó nhiều khả năng RỖNG — và nếu rỗng
-- thì phải nói là rỗng, chứ không đi mượn số của production rồi gọi là đã xác minh.
select count(*) as so_dong_fb_ads,
       count(*) filter (where coalesce(story_id, '') <> '') as so_dong_co_story_id
  from fb_ads;
select distinct (regexp_match(story_id, '^([0-9]+)_'))[1] as ma_page_trong_story_id, count(*) as so_lan
  from fb_ads where story_id ~ '^[0-9]+_' group by 1 order by 2 desc limit 10;

\echo ''
\echo '═══ 7. MÃ HỘI THOẠI CÓ MANG MÃ PAGE NÀO ═══'
-- Mã hội thoại Pancake có dạng "<mã page>_<mã khách>". Tiền tố ấy là mã PANCAKE hay mã FACEBOOK?
-- Đếm thẳng thì biết, không phải đoán.
select (regexp_match(external_id, '^([0-9]+)_'))[1] as tien_to_ma_hoi_thoai,
       count(*) as so_hoi_thoai
  from sales_conversations where external_id ~ '^[0-9]+_' group by 1 order by 2 desc limit 10;
