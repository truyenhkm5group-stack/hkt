-- VÌ SAO SỔ NGUỒN RỖNG — phân biệt "không có gì để ghi" với "đường ghi hỏng". CHỈ ĐỌC.
--
-- Bảng `order_field_provenance` rỗng sau một mẻ chạy ngầm. Có ĐÚNG HAI cách giải thích, và chúng
-- đòi hai việc khác hẳn nhau:
--
--   A. KHÔNG CÓ GÌ ĐỂ GHI — các lượt ấy không đổi ô nào (hội thoại đã có sẵn trạng thái từ lượt
--      trước, hoặc máy chuyển người ngay). Đây là hành vi ĐÚNG, đúng ca C của đặc tả.
--   B. ĐƯỜNG GHI HỎNG — có ô đổi thật mà không dòng nào được ghi. `recordProvenance` nuốt lỗi
--      CÓ CHỦ Ý (không được làm hỏng lượt phục vụ khách), nên một lỗi ở đó là hoàn toàn im lặng.
--
-- Cách phân biệt: so `ai_runs.state_before` với `state_after` trên chính các lượt ấy. Có ô đổi mà
-- sổ rỗng ⇒ B. Không ô nào đổi ⇒ A.

\echo '── 1. CÁC LƯỢT CHẠY 45 PHÚT QUA: có ô nào trong sáu ô then chốt ĐỔI không ──'
select
  count(*)                                                                as tong_luot,
  count(*) filter (where r.state_before is null or r.state_after is null) as thieu_anh_chup,
  count(*) filter (where coalesce(r.state_before->>'productId','') <> coalesce(r.state_after->>'productId','')) as doi_ma_hang,
  count(*) filter (where coalesce(r.state_before->>'variantId','') <> coalesce(r.state_after->>'variantId','')) as doi_mau_ma,
  count(*) filter (where coalesce(r.state_before->>'color','')     <> coalesce(r.state_after->>'color',''))     as doi_mau,
  count(*) filter (where coalesce(r.state_before->>'size','')      <> coalesce(r.state_after->>'size',''))      as doi_size,
  count(*) filter (where coalesce(r.state_before->>'phone','')     <> coalesce(r.state_after->>'phone',''))     as doi_sdt,
  count(*) filter (where coalesce(r.state_before->>'quantity','')  <> coalesce(r.state_after->>'quantity',''))  as doi_so_luong
from ai_runs r
where r.created_at > now() - interval '45 minutes';

\echo ''
\echo '── 2. PHÁN XÉT ──'
select case
  when (select count(*) from ai_runs r where r.created_at > now() - interval '45 minutes') = 0
    then 'CHƯA CÓ LƯỢT CHẠY NÀO trong cửa sổ — chạy một mẻ ngầm rồi hỏi lại'
  when (select count(*) from ai_runs r where r.created_at > now() - interval '45 minutes'
        and (coalesce(r.state_before->>'productId','') <> coalesce(r.state_after->>'productId','')
          or coalesce(r.state_before->>'variantId','') <> coalesce(r.state_after->>'variantId','')
          or coalesce(r.state_before->>'color','')     <> coalesce(r.state_after->>'color','')
          or coalesce(r.state_before->>'size','')      <> coalesce(r.state_after->>'size','')
          or coalesce(r.state_before->>'phone','')     <> coalesce(r.state_after->>'phone','')
          or coalesce(r.state_before->>'quantity','')  <> coalesce(r.state_after->>'quantity',''))) = 0
    then 'A — KHÔNG CÓ GÌ ĐỂ GHI: không lượt nào đổi một trong sáu ô. Sổ rỗng là ĐÚNG (ca C).'
  when (select count(*) from order_field_provenance) = 0
    then 'B — ĐƯỜNG GHI HỎNG: CÓ ô đổi mà sổ vẫn rỗng. Đi đọc nhật ký container tìm dòng [provenance].'
  else 'ĐÃ CÓ DÒNG — chạy lại ai-staging-provenance-verify.sql để soi sáu ca.'
end as phan_xet;

\echo ''
\echo '── 3. MẤY LƯỢT GẦN NHẤT ĐÃ LÀM GÌ (để thấy vì sao trạng thái không đổi) ──'
select
  r.tier::text                                    as nac,
  r.status,
  coalesce(r.decision->>'action', '?')            as hanh_dong,
  count(*)                                        as so_luot
from ai_runs r
where r.created_at > now() - interval '45 minutes'
group by 1, 2, 3
order by 4 desc limit 10;
