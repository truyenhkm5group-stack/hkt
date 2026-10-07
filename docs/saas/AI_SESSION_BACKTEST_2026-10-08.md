# Backtest «phiên khách AI 24 giờ» — 08/10/2026

> Theo Master Mission mục XI + XXVIII: KHÔNG công bố giá phiên khi chưa có bằng chứng từ log thật. Đây là bằng chứng đầu tiên —
> chỉ đọc (ops `db-query`, run 37665841694), không đổi giá nào. Giá đang áp dụng vẫn là V1 (khách AI / tháng, `PRICING_V1.md`).

## 1. Dữ liệu

- Nguồn: `platform_ai_usage` (CSDL nhà), `feature = 'sales_chatbot'`, 30 ngày gần nhất — sổ thực có dữ liệu từ **30/09/2026**
  (≈ 8 ngày). Khoá khách = `ref` (mã tham chiếu hội thoại; `conversation_id` hiện RỖNG ở mọi dòng — xem §5).
- Phiên = khối 24 giờ tính từ lượt AI đầu tiên của khách (xấp xỉ «cửa sổ trượt 24 giờ»: khi khách quay lại sau một khoảng
  trống > 24 giờ, phiên thật bắt đầu lại ở lượt mới còn cách xấp xỉ bắt đầu ở mốc khối — sai lệch nhỏ với tỷ lệ phiên/khách đo được).
- Chi phí = `cost_usd` nhà cung cấp (lượt lỗi không tính tiền ⇒ 0). Quy đổi **25.500 đ/USD** (`FACEBOOK_USD_VND` mặc định).

```sql
with calls as (select org_code, ref, at, coalesce(cost_usd,0)::float8 cost, coalesce(input_tokens,0)+coalesce(output_tokens,0) tok, status
               from platform_ai_usage where feature in ('sales_chatbot') and ref is not null and at > now() - interval '30 days'),
firsts as (select org_code, ref, min(at) first_at from calls group by 1,2),
sess as (select c.org_code, c.ref, floor(extract(epoch from (c.at - f.first_at))/86400)::int k, sum(c.cost) cost, sum(c.tok) tok, count(*) calls
         from calls c join firsts f on f.org_code = c.org_code and f.ref = c.ref group by 1,2,3)
select org_code, count(*), percentile_cont(0.5|0.75|0.9|0.95) within group (order by cost), avg(cost), … from sess group by rollup(org_code);
```

## 2. Chi phí nhà cung cấp mỗi phiên

| Tổ chức | Phiên | Khách | P50 | P75 | P90 | P95 | Max | TB | Lượt/phiên P50 · P90 |
|---------|------:|------:|----:|----:|----:|----:|----:|---:|------|
| Tất cả | 2.355 | 2.300 | 90đ | 143đ | 230đ | 405đ | 4.106đ | 120đ | 3 · 6 |
| HSLC (hải sản, khách thật) | 1.941 | 1.896 | 109đ | 152đ | 250đ | 429đ | 2.132đ | 130đ | 3 · 6 |
| qa (thử) | 389 | 379 | 32đ | 46đ | 83đ | 112đ | 303đ | 42đ | 2 · 5 |
| hslc-vgcnj | 23 | 23 | 0đ | 316đ | 2.154đ | 3.892đ | 4.106đ | 552đ | 1 · 5 |

Phiên / khách trong 8 ngày: **1,02** — gần như mọi khách chỉ có MỘT phiên. Hệ quả: tính theo «khách AI / tháng» (V1) và theo
«phiên 24 giờ» hôm nay cho doanh thu gần như bằng nhau ở cùng mức giá; khác biệt chỉ lộ ra với khách quay lại nhiều ngày.

## 3. Mô phỏng các mức giá (theo chi phí TB — HSLC 130đ · toàn nền tảng 120đ)

| Giá / phiên | Biên góp HSLC | Biên góp toàn nền tảng | Phiên lỗ ở P95 HSLC (429đ)? |
|------------:|--------------:|-----------------------:|----------------------------|
| 399đ | 67,5% | 70,0% | lỗ (P95 > giá) |
| 499đ | 74,0% | 76,0% | lời |
| 599đ | 78,3% | 80,0% | lời |
| 699đ | 81,4% | 82,9% | lời |
| 799đ | 83,8% | 85,0% | lời |

Biên góp ở đây = 1 − chi phí nhà cung cấp / giá. Hạ tầng biến đổi (VPS cố định) và phí thu tiền (chuyển khoản qua SePay — phí
theo gói cố định, không theo giao dịch) ≈ 0 mỗi phiên ở quy mô hôm nay; đưa vào khi có số thật.

So với V1 đang áp dụng (khách AI vượt phần gồm, mỗi khách ≈ 1,02 phiên ⇒ chi phí ≈ 133đ / khách): Starter 590đ → 77% ·
Growth 490đ → 73% · Scale 390đ → **66%** (dưới đích 70%, trên ngưỡng nguy cấp 60% của PRICING_V1 §6).

## 4. Đề xuất (KHÔNG công bố — chờ chủ shop + thêm dữ liệu)

1. **Giữ V1 ngay bây giờ** (đúng quyết định 08/10/2026). Theo dõi biên của Scale: 390đ / khách đang ở 66%.
2. Nếu chuyển sang giá phiên 24 giờ: **Starter 599đ · Growth 499đ · Scale 449đ** — cả ba trên đích 70% theo chi phí TB, P95 của
   HSLC vẫn lời ở mọi mức. Không dùng 399đ: P95 lỗ và biên toàn nền tảng chạm đúng 70%.
3. Trước khi công bố: (a) đủ ≥ 30 ngày dữ liệu và ≥ 2 ngành (hôm nay HSLC hải sản chiếm 82% phiên); (b) có tỷ lệ chốt /
   giao thành công / lợi nhuận gộp mỗi phiên (cần quy kết hội thoại → đơn → giao ở CSDL tổ chức — `db-query` không đọc được
   CSDL tổ chức); (c) chi phí theo model × việc sau khi định tuyến (giá nhà cung cấp giảm là lợi ích của nền tảng — Master
   Mission mục XXX — không tự giảm giá khách).

## 5. Lỗ hổng đo lường phát hiện được

- `platform_ai_usage.conversation_id` RỖNG ở 100% dòng 30 ngày qua (7.089 lượt OK + 886 lỗi) dù cột đã có từ 0224 —
  khoá theo hội thoại hiện chỉ đọc được qua `ref`. Đường ghi của bot bán hàng cần điền `conversation_id` để kinh tế đơn vị
  (chi phí / khách AI · chi phí / đơn AI) đọc một khoá chuẩn thay vì chuỗi `ref`.
- `workload` mới có từ 07/10 (0232) — chưa tách được chi phí theo việc (trả lời · đồng bộ đơn · đọc ảnh) cho giai đoạn trước.
