# Kiểm kê số liệu quảng cáo — đo trên production 22/09/2026

> **Câu hỏi:** dựng được một bảng điều khiển CHUẨN tới từng chiến dịch / nhóm / mẩu quảng cáo không?
>
> **Trả lời ngắn:** tới **chiến dịch** thì được, và phải sửa mẫu số. Tới **nhóm** và **mẩu** thì
> **chưa** — không phải vì công thức sai mà vì **hai nguồn dữ liệu chưa được lấy về**. Cả hai đều
> lấy được, và mục 4 nói rõ cách.
>
> Mọi con số dưới đây đo bằng ops `db-query` trên CSDL thật, cửa sổ **30 ngày**. Không con số nào
> trong tài liệu này là ước tính.

---

## 1. Bốn con số nói lên tất cả

| | Đo được |
|---|---|
| Đơn đã chốt (30 ngày) | **1.395** |
| Chi quảng cáo (30 ngày) | **147.950.434 ₫** |
| Chiến dịch **có chi tiêu** | **1.096** |
| Chiến dịch **nối được về ít nhất một đơn** | **49** — *4,5%* |

**39,8% tiền quảng cáo — 58.868.900 ₫ — nằm ở những chiến dịch mà ERP không biết chúng đẻ ra đơn
nào.** Đó không phải "quảng cáo kém": phần lớn là ERP không nhìn thấy.

Tiền thì **tập trung**, không phân tán như con số 1.096 gợi ý: 20 chiến dịch lớn nhất chiếm
**81.717.710 ₫ = 55,2%**. Nghĩa là sửa quy kết cho phần đầu bảng là đủ để đổi hẳn chất lượng báo cáo.

---

## 2. Quy kết đơn về quảng cáo — theo từng cấp

| Cấp | Đơn nối được | Trên 1.395 đơn |
|---|---|---|
| **Chiến dịch** | 846 | 60,6% |
| **Nhóm quảng cáo** | 841 | 60,3% |
| **Mẩu quảng cáo** | 841 | 60,3% |

Ba con số gần bằng nhau, và đó chính là triệu chứng: **cả ba đều chỉ đang đi bằng `ad_id`** (841 đơn
có `ad_id`, và cả 841 đều tra được trong `fb_ads`).

Đường nối qua **bài viết** — thứ được dựng riêng để cứu những đơn Pancake không gửi `ad_id` — chỉ
thêm được **5 đơn** (846 so với 841). Nó gần như vô hiệu, và mục 3 nói vì sao.

---

## 3. Hai nguyên nhân gốc, không phải một

### 3.1 Sổ mẩu và sổ nhóm gần như trống

| | Dòng |
|---|---|
| `fb_ads` (sổ mẩu quảng cáo) | **185** |
| `fb_ads` có `adset_id` | 152 |
| `fb_ads` có `post_id` | **99** |
| `fb_adsets` (sổ nhóm) | **10** |
| Chiến dịch có chi 30 ngày mà `fb_ads` biết tới | **63 / 1.096** |

Nguyên nhân nằm trong chính thiết kế của `syncFacebookAdIndex`: nó **chỉ tra những `ad_id` ĐÃ xuất
hiện trong đơn**. Nó đi từ ĐƠN ra, nên nó không bao giờ biết một mẩu chưa đẻ ra đơn nào — và cũng
không bao giờ biết bài viết của mẩu ấy để mà nối ngược lại.

Đó là một vòng luẩn quẩn: *không có đơn ⇒ không index mẩu ⇒ không có bài viết ⇒ không nối được đơn.*

### 3.2 Chi tiêu chỉ tồn tại ở cấp chiến dịch

`FacebookAdsClient.campaignInsights()` gọi Graph API với `level: "campaign"`. Vì vậy
`ADS_DIMENSION_HAS_SPEND` khai thẳng `adset: false, ad: false`, và mọi dòng ở hai cấp ấy mang
`NO_SPEND_DATA`.

Không có tiền thì không có ROAS, không có %CPQC, không có lợi nhuận. **Hai tab "Nhóm quảng cáo" và
"Mẩu quảng cáo" trên `/ads` hôm nay là hai bảng tra cứu, không phải bảng điều khiển** — và mã nguồn
nói đúng như vậy chứ không giả vờ.

---

## 4. Một thay đổi sửa được cả hai nguyên nhân

Gọi insights ở `level: "ad"` thay vì `level: "campaign"`. Mỗi dòng trả về mang:

```
ad_id · ad_name · adset_id · adset_name · campaign_id · campaign_name · spend · impressions · clicks · actions
```

Ba hệ quả, cùng một lượt gọi:

1. **Chi tiêu có thật ở cả ba cấp.** Cấp nhóm và cấp chiến dịch trở thành **phép cộng** của cấp mẩu
   — không phải phân bổ. Đây là điểm mấu chốt: kho mã này cấm chia đều tiền chiến dịch xuống cấp
   dưới ("chia đều làm tổng khớp trong khi từng dòng đều sai"), và cấp mẩu không vi phạm điều đó vì
   nó là **số đo gốc của Facebook**, không phải phép chia của ERP.
2. **Sổ mẩu và sổ nhóm được điền đầy cho MỌI mẩu đã tiêu tiền** — lật ngược chiều của vòng luẩn
   quẩn ở 3.1: đi từ TIỀN ra thay vì đi từ ĐƠN ra.
3. **Nối qua bài viết mới có cơ hội thật**, vì lúc đó mới có mẩu để đi hỏi `effective_object_story_id`.

### Rủi ro phải đo TRƯỚC khi làm

`ad_spends` là **nguồn thẩm quyền của tiền quảng cáo** trong mọi báo cáo lợi nhuận, lương và
marketer (AGENTS.md mục 15). Thêm dòng cấp mẩu mà quên bỏ dòng cấp chiến dịch là **nhân đôi toàn bộ
chi phí quảng cáo** — làm sai mọi con số lợi nhuận và lương cùng một lúc.

Facebook *nói* rằng Σ(mẩu) = chiến dịch. Chưa ai đo điều đó trên tài khoản của shop này, và có loại
chiến dịch (Advantage+, chi tiêu đặt ở cấp chiến dịch) trả về lệch. **Một lời bảo đảm chưa đo không
phải một lời bảo đảm.**

Nên bản này chỉ dựng **bộ dò chỉ-đọc**: ops `ads-level-probe` (`scripts/ads-level-probe.ts`). Nó gọi
cả hai cấp, so theo **từng (tài khoản × ngày)** chứ không chỉ so tổng — tổng khớp mà từng ngày lệch
là dấu hiệu bù trừ, và nó nguy hiểm hơn lệch tổng. Nó trả về ba kết luận, không phải hai: **khớp** ·
**lệch** · **chưa đủ căn cứ**.

```
Actions → Vận hành ERP trên VPS → ads-level-probe → arg: --days=30
```

Chỉ khi nó nói **khớp từng ngày** thì mới được hạ hạt `ad_spends`, và khi ấy đường đi an toàn là
*thay* dòng cấp chiến dịch bằng dòng cấp mẩu theo từng (tài khoản × ngày) trong một giao dịch —
không bao giờ *thêm*.

---

## 5. Mẫu số đang SAI, và đây là chỗ sửa được ngay

514 đơn không có cả `ad_id` lẫn `post_id`. Nhưng chúng **không phải một nhóm** — đo ra hai nhóm có
hệ quả trái ngược:

| Nhóm | Đơn | Fanpage | Khách cũ | Nghĩa là gì |
|---|---|---|---|---|
| Nguồn **`Facebook`** | **286** | 8 | 19 | Đơn THẬT từ Facebook mà Pancake không gửi tín hiệu ⇒ **mất dấu** |
| Nguồn **`Khác`** | **228** | 0 | 42 | `page_id` rỗng ⇒ **không đến từ Facebook** (landing, điện thoại, khách cũ) |

Hôm nay cả hai bị gộp làm một và cùng bị đếm là "không quy kết được". Hệ quả: **mẫu số của mọi báo
cáo quảng cáo đang bị thổi phồng bởi 228 đơn vốn không thuộc về quảng cáo.**

Tính trên đúng mẫu số — đơn CÓ nguồn Facebook (1.395 − 228 = 1.167):

> Độ phủ quy kết cấp chiến dịch = **846 / 1.167 ≈ 72,5%**, không phải 60,6%.

Đây là một phép sửa **định nghĩa**, không cần thêm dữ liệu nào. Và nó đổi cách đọc bảng: 72,5% là
một nền đủ để kết luận về chiến dịch lớn; 60,6% thì không.

**Phần 286 đơn mất dấu là trần thật của quy kết**, và nó nằm ở phía Pancake chứ không phải ERP.
Không được lấp nó bằng suy đoán.

---

## 6. Bảng điều khiển sẽ có hình gì

Chuỗi đúng theo mô hình BÁN TRƯỚC của shop, mỗi cột là một mốc có chứng từ riêng:

```
chi QC → hiển thị/click/tin nhắn → ĐƠN CHỐT (doanh số POS)
       → chốt chưa xuất kho (sản xuất + đóng gói)
       → đã bàn giao ĐVVC → đang giao
       → GIAO THÀNH CÔNG (doanh thu thực) → hoàn
       → TIỀN VỀ (có chứng từ bảng kê)
```

Bốn điều phải giữ khi dựng:

1. **Mỗi mốc một chứng từ riêng, không suy ra lẫn nhau.** "Chốt chưa xuất kho" đi theo
   `SHIPMENT_LEFT_WAREHOUSE` (mốc lấy hàng của ĐVVC), "giao thành công" đi theo `ORDER_OUTCOME`,
   "tiền về" đi theo bảng kê. Đây là luật nền của kho mã (AGENTS.md mục 3.1) và nó không có ngoại lệ
   cho bảng này.
2. **"Sản xuất" KHÔNG phải một cột thật ở cấp chiến dịch.** `production_orders` là phiếu gửi xưởng
   theo *mã hàng × màu × size*, không gắn với từng đơn khách — nên không có đường nào quy nó về một
   chiến dịch. Cái quan sát được là khoảng **chốt → rời kho**, và cột phải mang đúng tên ấy kèm ghi
   chú rằng nó bao gồm sản xuất và đóng gói. Đặt tên nó là "đang sản xuất" là khẳng định một thứ ERP
   không đo.
3. **%CPQC có BA mẫu số, và phải in rõ đang dùng cái nào** — `adsRatios()` trong
   `lib/constants/profit.ts` đã khai sẵn: trên doanh số POS · trên doanh thu đã giao THẬT · trên
   doanh thu giao ƯỚC TÍNH. Dùng lại, không viết bản thứ hai.
4. **Độ phủ đứng cạnh mọi con số**, và tiền chưa quy kết được hiện thành một dòng riêng — không rải
   đều vào các chiến dịch.

---

## 7. Thứ tự việc

| # | Việc | Chặn bởi |
|---|---|---|
| 1 | Chạy ops `ads-level-probe --days=30`, đọc kết luận | — (đã sẵn sàng sau khi deploy bản này) |
| 2 | Sửa **mẫu số**: tách đơn không-từ-Facebook ra khỏi "chưa quy kết" (mục 5) | — làm được ngay, không cần dữ liệu mới |
| 3 | Hạ hạt `ad_spends` xuống cấp mẩu, đối chiếu tổng chi trước/sau trên production | kết luận của bước 1 |
| 4 | Lấy `post_id` cho các mẩu mới index được → nối lại đơn thiếu `ad_id` | bước 3 |
| 5 | Dựng bảng điều khiển ba cấp theo mục 6 | bước 3 |

**Không làm bước 3 trước bước 1.** Và không dựng bảng điều khiển ba cấp trước bước 3 — nó sẽ là một
bảng đẹp với hai tab rỗng, đúng thứ chủ shop vừa bảo đừng làm.

---

## 8. Câu SQL đã dùng

Ba câu dưới đây chạy được nguyên văn qua ops `db-query` (một câu mỗi lần, enum cast `::text`) để đo
lại bất cứ lúc nào — con số trong tài liệu này sẽ cũ đi, cách đo thì không.

```sql
-- Độ phủ quy kết theo từng cấp
with don as (select o.id, nullif(o.ad_id,'') as ad_id, regexp_replace(coalesce(o.post_id,''), '^.*_', '') as pk
             from orders o where o.stage::text not in ('NEW','CANCELLED','DELETED') and o.inserted_at > now() - interval '30 days'),
     p as (select post_id, count(distinct campaign_id) n_camp, count(distinct adset_id) n_adset, count(distinct id) n_ad
           from fb_ads where post_id ~ '^[0-9]{5,}$' group by post_id)
select count(*) as don,
       count(*) filter (where d.ad_id is not null) as co_ad_id,
       count(*) filter (where exists (select 1 from fb_ads fa where fa.id = d.ad_id) or p.n_camp = 1) as ve_chien_dich,
       count(*) filter (where exists (select 1 from fb_ads fa where fa.id = d.ad_id) or p.n_adset = 1) as ve_nhom,
       count(*) filter (where exists (select 1 from fb_ads fa where fa.id = d.ad_id) or p.n_ad = 1) as ve_mau
from don d left join p on p.post_id = d.pk;
```

```sql
-- Tiền nằm ở chiến dịch không nối được về đơn nào
with sp as (select campaign_id, sum(spend)::bigint chi from ad_spends
            where spend_date > now() - interval '30 days' and excluded = false and campaign_id is not null group by campaign_id),
     cid as (select distinct (select fa.campaign_id from fb_ads fa where fa.id = nullif(o.ad_id,'')) c
             from orders o where o.stage::text not in ('NEW','CANCELLED','DELETED') and o.inserted_at > now() - interval '30 days')
select count(*) as so_chien_dich, sum(chi) as tong_chi,
       sum(chi) filter (where campaign_id not in (select c from cid where c is not null)) as chi_khong_noi_duoc
from sp;
```

```sql
-- 514 đơn mất tín hiệu là hai nhóm, không phải một
select coalesce(nullif(o.source,''),'(trong)') as nguon, count(*) as so_don, count(distinct o.page_id) as so_page
from orders o
where o.stage::text not in ('NEW','CANCELLED','DELETED') and o.inserted_at > now() - interval '30 days'
  and nullif(o.ad_id,'') is null and not (regexp_replace(coalesce(o.post_id,''),'^.*_','') ~ '^[0-9]{5,}$')
group by 1 order by 2 desc;
```
