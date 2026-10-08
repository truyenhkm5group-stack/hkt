# Chi phí AI theo loại việc × nguồn tiền — nền 30 ngày (CHỈ ĐỌC)

> CHỈ TÀI LIỆU, 08/10/2026, đọc mã ở `origin/main` `051f49a5`. Sứ mệnh `ai-cost-opt-v2` (kiểm kê 08/10, việc E2). Mục đích: cho
> Integration Lead MỘT bộ câu SQL chỉ đọc để lấy nền chi phí AI 30 ngày theo loại việc và nguồn trả tiền. Nền ấy dùng để: (1) đo
> biên gộp thật so với đích 75–85% của bảng giá V1, (2) định cỡ và hậu kiểm việc chuyển AI Bán hàng của HSLC sang nguồn `PLATFORM`
> (ops `org-ai-cutover`, #659), (3) chọn chỗ tối ưu model theo việc. Tài liệu này KHÔNG chứa số đo production nào. Số đo nằm ở phần
> mã hoá của lượt `db-query`.

## 1. Nguồn dữ liệu

| Thứ | Ở đâu | Ghi chú |
|---|---|---|
| Sổ AI | `platform_ai_usage` (`db/schema.ts:5070-5122`), CSDL NHÀ — đúng CSDL mà ops `db-query` đọc | một dòng = một lượt AI; đường ghi DUY NHẤT `recordAiUsage` (`lib/ai-usage/ledger.ts:82`) |
| Nguồn trả tiền | `billing_source` ∈ `BYOK` · `PLATFORM` · `HOME` (`db/schema.ts:5117`, `lib/ai-usage/types.ts:18`) | `BYOK` = khách tự trả nhà cung cấp — KHÔNG phải chi phí nền tảng (`COST_BILLING.md` §1) · `PLATFORM` = khoá nền tảng · `HOME` = khoá `.env` của nhà |
| Tính năng | `feature` ∈ 7 khoá (`lib/ai-usage/types.ts:27`) | thuộc sản phẩm qua `aiFeatures`: ERP = `ai_builder · copilot · creative_image · creative_copy · lead_hunter` (`lib/saas/catalog.ts:116`), Chốt Đơn = `sales_chatbot · sales_playbook` (`:138`) |
| Loại việc | `workload` ∈ `sales_chatbot · order_sync · quick_extract · vision` (CHECK `db/schema.ts:5111`, `lib/ai-usage/types.ts:35`) | có từ 0232 (07/10/2026); dòng cũ `NULL`; giá trị lạ bị bỏ im lặng lúc ghi (`lib/ai-usage/ledger.ts:112`) |
| Tiền | `cost_usd` = token × bảng giá ƯỚC TÍNH (`lib/ai/provider.ts:82`) | model không có trong bảng giá ⇒ `NULL` (`lib/ai/provider.ts:137-140`) = CHƯA BIẾT, không phải 0 (luật 42) |
| Token | `input_tokens` (gồm phần đọc bộ đệm) · `output_tokens` (gồm phần suy nghĩ) · `cached_tokens` ⊂ vào · `thinking_tokens` ⊂ ra (`db/schema.ts:5099-5106`) | đừng cộng `cached` / `thinking` thêm lần nữa |
| Trạng thái | `OK` · `ERROR` · `BLOCKED_QUOTA` | `BLOCKED_QUOTA` = bị chặn TRƯỚC khi gọi model, không phải một lượt dùng (`lib/ai-usage/ledger.ts:125-126`) |
| Khách AI (đơn vị thu) | `platform_usage_events` (`product_key = 'chotdon'`, `metric = 'ai_customers'`) | ghi từ khi V1 bật (0228, 07/10); dòng bí danh mang `quantity = 0` ⇒ luôn `sum(quantity)`, đừng `count(*)` (`PRICING_V1.md` §II.7) |
| Doanh thu | `platform_saas_daily.mrr_vnd` (`db/schema.ts:5414-5439`) · Số dư AI `platform_ai_ledger_entries` (`:5336`) | `mrr_vnd NULL` = chưa biết |

## 2. Từ điển «loại việc» (dẫn xuất — một biểu thức dùng chung cho mọi câu)

| Loại việc | Điều kiện trên sổ | Nơi ghi | Sản phẩm |
|---|---|---|---|
| `sales_chatbot` — trả lời khách | `workload = 'sales_chatbot'` | `lib/sales-chatbot/engine.ts:901` | Chốt Đơn |
| `quick_extract` — AI chọn câu mẫu | `workload = 'quick_extract'` | `lib/sales-chatbot/engine.ts:855-859` | Chốt Đơn |
| `vision` — đọc ảnh khách gửi | `workload = 'vision'` | `lib/sales-chatbot/engine.ts:443-455` | Chốt Đơn |
| `order_sync` — ghi đơn từ hội thoại nhân viên | `workload = 'order_sync'` HOẶC `ref LIKE 'order-sync:%'` (đọc được cả dòng trước 0232) | `lib/sales-chatbot/order-sync.ts:660-671` | Chốt Đơn |
| `sales_chatbot_chua_gan` | `feature = 'sales_chatbot'` mà `workload IS NULL` và không phải `order-sync:` | trước 07/10: mọi lượt trả lời · sau 07/10: chủ yếu NHẮN LẠI (`lib/sales-chatbot/followup.ts:176` không truyền loại việc) + lượt lỗi dự phòng không mang loại việc (`engine.ts:534`, `:576`) | Chốt Đơn |
| `sales_playbook_gop_y` · `_tu_hoc` · `_so_tay` | `feature = 'sales_playbook'` với `ref LIKE 'feedback:%'` · `ref = 'lessons'` · `ref = 'playbook'` | `lib/sales-chatbot/inbox-feedback.ts:114` · `lessons.ts:204` · `playbook.ts:278` | Chốt Đơn |
| `creative_image` · `creative_copy` | theo `feature` | `lib/creative/org-ai.ts:199`, `:257-259` (luôn `BYOK`) | ERP |
| `lead_hunter` — lời chào khách sỉ | theo `feature` | `lib/wholesale/outreach.ts:121` | ERP |
| `copilot` · `ai_builder` | theo `feature` | `lib/ai/copilot.ts:256` · `lib/ai-builder/service.ts:171-212` | ERP |

Phép tách `order-sync:` khớp với hàm ứng dụng `conversationOfRef` (`lib/ai-usage/conversation-cost.ts:29-32`, #658). Hàm cộng
tiền của ứng dụng cũng không cộng khoản chưa định giá thành 0 (`addUsdAsVnd`, `:35-37`). Biểu thức SQL dưới đây chỉ là bản chẩn
đoán CHỈ ĐỌC cho `db-query`. Mã ứng dụng không chép nó (AGENTS mục 8.12). Bảng trên `/platform` (AC-2, §7) phải dùng một hàm thuần
dùng chung.

Biểu thức (chép nguyên vào câu nào cần):

```sql
case when workload is not null then workload when feature = 'sales_chatbot' and coalesce(ref, '') like 'order-sync:%' then 'order_sync' when feature = 'sales_chatbot' then 'sales_chatbot_chua_gan' when feature = 'sales_playbook' and coalesce(ref, '') like 'feedback:%' then 'sales_playbook_gop_y' when feature = 'sales_playbook' and ref = 'lessons' then 'sales_playbook_tu_hoc' when feature = 'sales_playbook' and ref = 'playbook' then 'sales_playbook_so_tay' else feature end
```

## 3. Các câu SQL (CHỈ ĐỌC)

Cách chạy: ops `db-query`, MỘT câu mỗi lượt, dán nguyên dòng vào ô `arg`.

- Câu chạy bằng role `erp_ro` (chỉ có quyền SELECT) và kết quả đi dạng MÃ HOÁ (`.github/workflows/ops-vps.yml:1104-1143`).
- Không có dấu `\` (psql coi là lệnh meta và từ chối chạy).
- CTE chỉ sống trong câu của nó.
- Mọi mốc ngày theo giờ VN: `(at at time zone 'UTC') + interval '7 hours'` (cùng cách `lib/ai-usage/ledger.ts:209`).

Câu có `org_code` thì kết quả chứa mã tổ chức. Để nguyên trong phần mã hoá; tóm tắt công khai chỉ in tổng.

**Q0 — Độ phủ của sổ 30 ngày** (chạy TRƯỚC — các câu sau chỉ đáng tin bằng câu này)

```sql
select count(*) as dong, count(*) filter (where status = 'OK') as ok, count(*) filter (where status = 'ERROR') as loi, count(*) filter (where status = 'BLOCKED_QUOTA') as bi_chan, count(*) filter (where status <> 'BLOCKED_QUOTA' and cost_usd is null) as chua_dinh_gia, count(*) filter (where status = 'OK' and cost_usd is null) as ok_chua_dinh_gia, count(*) filter (where workload is not null) as co_loai_viec, count(*) filter (where conversation_id is not null) as co_ma_hoi_thoai, count(*) filter (where status <> 'BLOCKED_QUOTA' and model is null) as khong_ghi_model, min(at) as dong_dau, max(at) as dong_cuoi from platform_ai_usage where at > now() - interval '30 days'
```

**Q1 — Loại việc × nguồn tiền, 30 ngày** (bảng nền chính)

```sql
with u as (select *, case when workload is not null then workload when feature = 'sales_chatbot' and coalesce(ref, '') like 'order-sync:%' then 'order_sync' when feature = 'sales_chatbot' then 'sales_chatbot_chua_gan' when feature = 'sales_playbook' and coalesce(ref, '') like 'feedback:%' then 'sales_playbook_gop_y' when feature = 'sales_playbook' and ref = 'lessons' then 'sales_playbook_tu_hoc' when feature = 'sales_playbook' and ref = 'playbook' then 'sales_playbook_so_tay' else feature end as loai_viec from platform_ai_usage where at > now() - interval '30 days') select loai_viec, billing_source as nguon, count(*) filter (where status <> 'BLOCKED_QUOTA') as luot, count(*) filter (where status = 'ERROR') as loi, count(*) filter (where status = 'BLOCKED_QUOTA') as bi_chan, sum(requests) as loi_goi, sum(input_tokens) as token_vao, sum(output_tokens) as token_ra, sum(cached_tokens) as token_cache, sum(thinking_tokens) as token_suy_nghi, round(sum(cost_usd)::numeric, 4) as usd_da_dinh_gia, count(*) filter (where status <> 'BLOCKED_QUOTA' and cost_usd is null) as luot_chua_dinh_gia, count(*) filter (where status = 'OK' and cost_usd is null) as ok_chua_dinh_gia from u group by 1, 2 order by usd_da_dinh_gia desc nulls last, luot desc
```

**Q2 — Tổ chức × loại việc × nguồn, 30 ngày** (kết quả chứa mã tổ chức ⇒ chỉ phần mã hoá)

```sql
with u as (select *, case when workload is not null then workload when feature = 'sales_chatbot' and coalesce(ref, '') like 'order-sync:%' then 'order_sync' when feature = 'sales_chatbot' then 'sales_chatbot_chua_gan' when feature = 'sales_playbook' and coalesce(ref, '') like 'feedback:%' then 'sales_playbook_gop_y' when feature = 'sales_playbook' and ref = 'lessons' then 'sales_playbook_tu_hoc' when feature = 'sales_playbook' and ref = 'playbook' then 'sales_playbook_so_tay' else feature end as loai_viec from platform_ai_usage where at > now() - interval '30 days') select org_code, loai_viec, billing_source as nguon, count(*) filter (where status <> 'BLOCKED_QUOTA') as luot, count(*) filter (where status = 'ERROR') as loi, round(sum(cost_usd)::numeric, 4) as usd_da_dinh_gia, count(*) filter (where status = 'OK' and cost_usd is null) as ok_chua_dinh_gia from u group by 1, 2, 3 order by 1, usd_da_dinh_gia desc nulls last
```

**Q3 — Ngày (giờ VN) × nguồn tiền, 30 ngày** (thấy ngay ngày cutover: `BYOK` giảm, `PLATFORM` tăng)

```sql
select to_char((at at time zone 'UTC') + interval '7 hours', 'YYYY-MM-DD') as ngay_vn, billing_source as nguon, count(*) filter (where status <> 'BLOCKED_QUOTA') as luot, count(*) filter (where status = 'ERROR') as loi, round(sum(cost_usd)::numeric, 4) as usd_da_dinh_gia, count(*) filter (where status = 'OK' and cost_usd is null) as ok_chua_dinh_gia from platform_ai_usage where at > now() - interval '30 days' group by 1, 2 order by 1, 2
```

**Q4 — Model × loại việc × nguồn, kèm độ trễ** (model nào chưa có giá, việc nào đắt)

```sql
with u as (select *, case when workload is not null then workload when feature = 'sales_chatbot' and coalesce(ref, '') like 'order-sync:%' then 'order_sync' when feature = 'sales_chatbot' then 'sales_chatbot_chua_gan' when feature = 'sales_playbook' and coalesce(ref, '') like 'feedback:%' then 'sales_playbook_gop_y' when feature = 'sales_playbook' and ref = 'lessons' then 'sales_playbook_tu_hoc' when feature = 'sales_playbook' and ref = 'playbook' then 'sales_playbook_so_tay' else feature end as loai_viec from platform_ai_usage where at > now() - interval '30 days' and status <> 'BLOCKED_QUOTA') select coalesce(provider, '-') as nha_cung_cap, coalesce(model, '-') as model, loai_viec, billing_source as nguon, count(*) as luot, count(*) filter (where status = 'ERROR') as loi, round(sum(cost_usd)::numeric, 4) as usd_da_dinh_gia, count(*) filter (where status = 'OK' and cost_usd is null) as ok_chua_dinh_gia, count(latency_ms) as mau_do_tre, percentile_cont(0.5) within group (order by latency_ms) as tre_p50_ms, percentile_cont(0.95) within group (order by latency_ms) as tre_p95_ms from u group by 1, 2, 3, 4 order by luot desc
```

**Q5 — AI Bán hàng: chi phí mỗi hội thoại khách, theo tổ chức × nguồn, 30 ngày** (thay thế tạm cho «chi phí / khách AI»: backtest
đo 1,02 phiên / khách — `AI_SESSION_BACKTEST_2026-10-08.md` §2)

```sql
select org_code, billing_source as nguon, count(distinct coalesce(conversation_id, ref)) filter (where coalesce(ref, '') not like 'order-sync:%' and coalesce(conversation_id, ref) is not null) as hoi_thoai_khach, case when count(*) filter (where coalesce(ref, '') not like 'order-sync:%' and status <> 'BLOCKED_QUOTA') = 0 then 0 else round(sum(cost_usd) filter (where coalesce(ref, '') not like 'order-sync:%')::numeric, 4) end as usd_tra_loi_khach, round((sum(cost_usd) filter (where coalesce(ref, '') not like 'order-sync:%') / nullif(count(distinct coalesce(conversation_id, ref)) filter (where coalesce(ref, '') not like 'order-sync:%' and coalesce(conversation_id, ref) is not null), 0))::numeric, 6) as usd_moi_hoi_thoai, case when count(*) filter (where coalesce(ref, '') like 'order-sync:%' and status <> 'BLOCKED_QUOTA') = 0 then 0 else round(sum(cost_usd) filter (where coalesce(ref, '') like 'order-sync:%')::numeric, 4) end as usd_ghi_don_ho, count(*) filter (where status = 'OK' and cost_usd is null) as ok_chua_dinh_gia from platform_ai_usage where feature = 'sales_chatbot' and at > now() - interval '30 days' group by 1, 2 order by usd_tra_loi_khach desc nulls last
```

**Q6 — Đồng hồ khách AI theo tổ chức × tháng** (đơn vị thu thật; chỉ có từ khi V1 bật)

```sql
select org_code, to_char((occurred_at at time zone 'UTC') + interval '7 hours', 'YYYY-MM') as ky, sum(quantity) as khach_ai, count(*) as dong, min(occurred_at) as dau, max(occurred_at) as cuoi from platform_usage_events where product_key = 'chotdon' and metric = 'ai_customers' group by 1, 2 order by 2, 1
```

**Q7 — Biên sau AI theo tổ chức: MRR ở ảnh chụp mới nhất so với AI nền tảng trả 30 ngày** (`25500` = tỷ giá mặc định
`FACEBOOK_USD_VND`, `lib/env.ts:137` — thay bằng tỷ giá đang chạy nếu khác). Ba trường hợp:

- không có lượt nào do nền tảng trả ⇒ chi phí là 0 THẬT;
- có lượt nhưng chưa định giá hết (`ok_chua_dinh_gia > 0`) ⇒ chi phí là CẬN DƯỚI, nên `bien_sau_ai_pct` là CẬN TRÊN;
- mọi lượt đều chưa định giá ⇒ in `NULL`.

Tổ chức nhà: bot cũ `chatbot/` ghi sổ riêng (`docs/saas/OWNERSHIP.md` §2), nên chi phí của nhà luôn là cận dưới.

```sql
with mrr as (select org_code, is_home, plan_key, paying, mrr_vnd from platform_saas_daily where day = (select max(day) from platform_saas_daily)), chi as (select org_code, case when count(*) filter (where billing_source in ('PLATFORM', 'HOME') and status <> 'BLOCKED_QUOTA') = 0 then 0 else round(sum(cost_usd) filter (where billing_source in ('PLATFORM', 'HOME'))::numeric, 4) end as usd_nen_tang_tra, case when count(*) filter (where billing_source = 'BYOK' and status <> 'BLOCKED_QUOTA') = 0 then 0 else round(sum(cost_usd) filter (where billing_source = 'BYOK')::numeric, 4) end as usd_khach_tu_tra, count(*) filter (where status = 'OK' and cost_usd is null) as ok_chua_dinh_gia from platform_ai_usage where at > now() - interval '30 days' group by 1), j as (select coalesce(m.org_code, c.org_code) as org_code, m.is_home, m.plan_key, m.paying, m.mrr_vnd, case when c.org_code is null then 0 else c.usd_nen_tang_tra end as usd_nen_tang_tra, case when c.org_code is null then 0 else c.usd_khach_tu_tra end as usd_khach_tu_tra, coalesce(c.ok_chua_dinh_gia, 0) as ok_chua_dinh_gia from mrr m full join chi c on c.org_code = m.org_code) select *, case when mrr_vnd > 0 and usd_nen_tang_tra is not null then round(100 * (1 - usd_nen_tang_tra * 25500 / mrr_vnd), 1) end as bien_sau_ai_pct from j order by usd_nen_tang_tra desc nulls last
```

**Q8 — Hậu kiểm cutover một tổ chức từ mốc** (điền `<MÃ_TỔ_CHỨC>` và `<MỐC_ISO>` — mốc do `org-ai-cutover --apply` in ra; bổ sung
cho `--apply-probe --since=`)

```sql
with u as (select *, case when workload is not null then workload when feature = 'sales_chatbot' and coalesce(ref, '') like 'order-sync:%' then 'order_sync' when feature = 'sales_chatbot' then 'sales_chatbot_chua_gan' when feature = 'sales_playbook' and coalesce(ref, '') like 'feedback:%' then 'sales_playbook_gop_y' when feature = 'sales_playbook' and ref = 'lessons' then 'sales_playbook_tu_hoc' when feature = 'sales_playbook' and ref = 'playbook' then 'sales_playbook_so_tay' else feature end as loai_viec from platform_ai_usage where org_code = '<MÃ_TỔ_CHỨC>' and at >= timestamptz '<MỐC_ISO>') select billing_source as nguon, loai_viec, count(*) filter (where status <> 'BLOCKED_QUOTA') as luot, count(*) filter (where status = 'ERROR') as loi, round(sum(cost_usd)::numeric, 4) as usd_da_dinh_gia, count(*) filter (where status = 'OK' and cost_usd is null) as ok_chua_dinh_gia, min(at) as dau, max(at) as cuoi from u group by 1, 2 order by 1, 2
```

**Q9 — Doanh thu dùng AI qua Số dư (chỉ có nghĩa khi đã có tổ chức bật cờ — 08/10 chưa có)**

```sql
select org_code, -coalesce(sum(amount_vnd) filter (where funds_class = 'CASH' and (entry_type = 'AI_USAGE' or (entry_type = 'ADJUSTMENT' and source_type = 'AI_CUSTOMER'))), 0) as doanh_thu_tien_that_vnd, -coalesce(sum(amount_vnd) filter (where funds_class = 'PROMO' and entry_type = 'AI_USAGE'), 0) as tien_tang_da_dung_vnd, coalesce(sum(units) filter (where entry_type = 'AI_USAGE'), 0) as khach_ai_da_tru from platform_ai_ledger_entries where occurred_at > now() - interval '30 days' group by 1 order by 2 desc
```

## 4. Cách đọc — năm điều đừng làm

1. **Chưa định giá ≠ 0.** `usd_da_dinh_gia` chỉ cộng lượt có giá, nên nó là CẬN DƯỚI. Luôn đọc `ok_chua_dinh_gia` cạnh nó: lượt
   thành công mà model không có trong bảng giá. Số đó > 0 thì không kết luận biên. Thay vào đó, thêm giá model vào
   `PRICE_PER_MTOK` (`lib/ai/provider.ts:82`). Lượt `ERROR` mang tiền `NULL` theo thiết kế
   (`docs/platform/ai-model-control.md` §3). Nhà cung cấp thường không tính tiền lượt lỗi, nhưng ERP không chứng minh được điều
   đó. Vì vậy nó nằm ở `luot_chua_dinh_gia` (cùng định nghĩa với màn hình — `lib/ai-usage/ledger.ts:179`), không bị ép thành 0.
   Backtest ngày 08/10 có coi lượt lỗi = 0 đ, và đó là một giả định (`AI_SESSION_BACKTEST_2026-10-08.md` §1).
2. **Tiền là ƯỚC TÍNH** (token × bảng giá). Hoá đơn thật của nhà cung cấp cho nguồn `PLATFORM` mới là sự thật. Đối chiếu mỗi tháng
   và in độ lệch, không chỉnh sổ cho khớp.
3. **`BYOK` không phải chi phí nền tảng.** Nó chỉ là cỡ chi phí nếu chuyển sang `PLATFORM`. Biên của nền tảng chỉ trừ `PLATFORM` +
   `HOME` (`COST_BILLING.md` §1).
4. **Đừng so loại việc trước và sau 07/10 một cách ngây thơ.** Trước 0232, mọi lượt Chốt Đơn trừ ghi đơn hộ đều nằm ở
   `sales_chatbot_chua_gan`. Sau 07/10, nhóm đó chủ yếu là nhắn lại. Q0 cho biết bao nhiêu phần trăm dòng đã mang loại việc.
5. **Tổ chức thử lẫn vào nền.** Lưu lượng của tổ chức thử (kênh thử, ghi đơn của shop thử) vẫn vào sổ; chỉ benchmark phát lại là
   không ghi (`lib/ai-usage/ledger.ts:71-80`). Tách bằng danh sách tổ chức thử trong phần mã hoá. Trong mã chưa có cờ «tổ chức thử»
   nào để lọc tự động.

## 5. Liên hệ với biên gộp mục tiêu 75–85%

Đích 75–85%, cảnh báo < 70%, nguy cấp < 60% (chủ shop chốt 07/10 — `PRICING_V1.md` §I.6, `lib/pricing/versions.ts:475`). Từ giá
V1 suy ra hai mốc. Đây là phép tính trên giá niêm yết, không phải số đo:

| Gói | Giá tháng | Ngân sách AI mềm (= 40% giá ÷ 25.500 — `lib/pricing/versions.ts:596-606`) | Trần AI để giữ biên 75% (25% giá) | Trần / khách AI gồm |
|---|---|---|---|---|
| Starter | 790.000 ₫ | 12,39 USD | 197.500 ₫ ≈ 7,75 USD | 131,7 ₫ |
| Growth | 1.490.000 ₫ | 23,37 USD | 372.500 ₫ ≈ 14,61 USD | 124,2 ₫ |
| Scale | 2.990.000 ₫ | 46,90 USD | 747.500 ₫ ≈ 29,31 USD | 99,7 ₫ |

Đặt cạnh chi phí ~133 ₫ / khách AI mà backtest 8 ngày đo được (`AI_SESSION_BACKTEST_2026-10-08.md` §3, nhãn ƯỚC TÍNH):

- khi khách dùng HẾT phần gồm, biên chỉ trừ AI là Starter ≈ 74,7% · Growth ≈ 73,2% · Scale ≈ 66,6%;
- phần vượt theo đơn giá từng khách là Starter 77% · Growth 73% · Scale 66%.

Scale nằm dưới ngưỡng cảnh báo 70% ở cả hai cách nhìn. Q5 (chi phí / hội thoại) và Q7 (biên theo tổ chức) trên 30 ngày là để xác
nhận hay bác bỏ con số ấy. Đổi giá là quyết định của chủ shop (R4) — tài liệu này chỉ nêu bằng chứng cần có.

Biên ở Q7 là biên CHỈ TRỪ AI, cùng ý với `aiOnlyMargin` (`lib/platform/saas-metrics.ts:412`). Nó chưa trừ hạ tầng đã khai và chưa
cộng doanh thu Số dư AI. Màn `/platform/saas` có hai định nghĩa biên khác (`platformMargin` `lib/platform/saas-metrics.ts:399`,
`platformGrossMargin` `lib/pricing/economics.ts:204`). Kiểm kê 08/10 đã ghi chuyện hai định nghĩa lệch nhau. Đừng đặt số của Q7
cạnh hai số đó mà không ghi rõ định nghĩa.

## 6. Liên hệ với việc chuyển AI Bán hàng của HSLC sang `PLATFORM` (#659)

| Điều | Ở đâu |
|---|---|
| Công cụ | `scripts/org-ai-cutover.ts`: KIỂM chỉ đọc (`:10-16`) · `--apply` chuyển (`:17-20`) · `--apply-probe --since=` hậu kiểm (`:21-22`), chạy qua ops `org-ai-cutover` (`.github/workflows/ops-vps.yml:43`) |
| Đổi gì | động cơ bot sang `platform`, model của nền tảng, KHÔNG dự phòng (`PLATFORM_ENGINE_PATCH`, `scripts/org-ai-cutover.ts:55`). Phạm vi = `sales_chatbot` + `sales_playbook` (`:57`) |
| KHÔNG đổi | Media (`creative_*`) và Săn khách sỉ (`lead_hunter`) vẫn đọc thẳng kết nối `BYOK` (`scripts/org-ai-cutover.ts:4-7`) ⇒ hai loại việc này còn ở `BYOK` sau cutover |
| Chặn chuyển mù | credit dùng chung là trần cứng nhỏ hơn mức dùng 30 ngày × 1,25 ⇒ TỪ CHỐI (`creditVerdict`, `scripts/org-ai-cutover.ts:60`, `:130-140`). HSLC đang ở giá legacy nên trần AI đọc từ dòng gói cũ, không phải ngân sách mềm của V1. Nâng hạn mức AI cho tổ chức là quyết định chi phí của chủ shop |
| Trước cutover (kiểm kê 08/10) | AI Bán hàng của HSLC ở `BYOK`, ≈ 10,6 USD / 30 ngày. Lưu lượng `PLATFORM` hôm 07/10 gần như chỉ là ghi đơn của shop thử (`docs/platform/ai-model-control.md` §7.1) |
| Sau cutover, kỳ vọng | Q3: theo ngày, cột `BYOK` của HSLC về ≈ 0 ở `sales_*`, cột `PLATFORM` tăng tương ứng. Q2: `creative_*` · `lead_hunter` vẫn `BYOK`. Q7: biên sau AI của HSLC giảm đúng bằng phần chi phí chuyển sang — đọc so với 70% / 60%. Model nền tảng có thể khác model HSLC đang dùng, nên chi phí / hội thoại (Q5) và lỗi đều phải đo lại; đổi model thì đi đúng luật A/B (`docs/platform/ai-model-control.md` §7) |
| Ai quyết | `--apply` là bước không đảo được nửa chừng trên khách thật ⇒ chủ shop (kiểm kê 08/10, mục E.5) |

## 7. Việc kế tiếp (đề xuất PR)

| PR | Nội dung | Mức R / sàn gộp |
|---|---|---|
| AC-1 | Thêm loại việc `follow_up` (và tách học / sổ tay nếu muốn chính sách model riêng): mở rộng CHECK `db/schema.ts:5111` + `PLATFORM_WORKLOADS` (`lib/ai-usage/types.ts:35`), truyền loại việc ở `followup.ts:176`, `lessons.ts:204`, `playbook.ts:278`, `inbox-feedback.ts:114` | R3 · HIGH SERIAL (migration) |
| AC-2 | Bảng «chi phí theo loại việc × nguồn, 30 ngày, kèm độ phủ» trên `/platform/saas`, dùng chung biểu thức §2 (một hàm thuần, không chép sang trang) | R1 · MEDIUM (đề xuất HIGH cho `lib/ai-usage/` — `RISK_SCALE.md` §3) |
| AC-3 | Phép kiểm A14 (AI chưa định giá) của Auditor + quy trình thêm giá model | R1 |
| AC-4 | Đối chiếu tháng: tổng `PLATFORM` ước tính so với hoá đơn nhà cung cấp — in độ lệch, không chỉnh sổ | R1 (đọc) · R4 nếu cần khai hoá đơn nhà cung cấp |
