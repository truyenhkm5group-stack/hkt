# Kiểm kê số liệu quảng cáo — đo trên production 22/09/2026

> **Câu hỏi:** dựng được một bảng điều khiển CHUẨN tới từng chiến dịch / nhóm / mẩu quảng cáo không?
>
> **Trả lời ngắn (cập nhật 22/09 chiều):** ĐƯỢC, cả ba cấp. Hai nguồn dữ liệu còn thiếu đã lấy
> được, và phép đo trên production xác nhận hạ hạt chi tiêu xuống cấp mẩu **không làm đổi một đồng
> nào** (mục 4). Mẫu số cũng đã sửa (mục 5).
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
*thay* dòng cấp chiến dịch bằng dòng cấp mẩu theo từng (tài khoản × ngày) — không bao giờ *thêm*.

### Kết quả: đã chạy 22/09/2026, và nó KHỚP TUYỆT ĐỐI

```
Dò chi tiêu hai cấp · 2026-08-24 → 2026-09-22 (30 ngày) · 7 tài khoản · CHỈ ĐỌC

  Σ chi cấp CHIẾN DỊCH : 148.369.383 ₫ (1.793 dòng)
  Σ chi cấp MẨU        : 148.369.383 ₫ (2.240 dòng)
  Lệch tổng            : +0 ₫  (0%)
  Số (tài khoản × ngày) lệch: 0
```

**Lệch 0 đồng, và 0 cặp (tài khoản × ngày) lệch** — không phải "tổng khớp còn từng ngày thì chưa
kiểm", mà khớp ở đúng mức hạt sẽ được ghi. Hạ hạt không làm đổi một đồng nào của báo cáo lợi nhuận.

Phần thứ hai của kết quả còn đáng giá hơn phần tiền:

| | Sổ đang có | Thấy trong kỳ | **MỚI** |
|---|---|---|---|
| Mẩu quảng cáo | 186 | 1.254 | **1.146** |
| Nhóm quảng cáo | 10 | 1.254 | **1.244** |
| Chiến dịch | — | 1.096 | — |

Vòng luẩn quẩn ở mục 3.1 bị phá: sổ mẩu và sổ nhóm được điền từ TIỀN thay vì từ ĐƠN.

Thời gian: 99 giây cho 7 tài khoản × 30 ngày — đắt hơn cấp chiến dịch nhưng vẫn nằm trong ngưỡng
của một job chạy mỗi giờ trên cửa sổ 3 ngày.

> **Một điều ghi lại để người sau không tưởng là lỗi:** số mẩu và số nhóm bằng nhau đúng 1.254. Đó
> là dữ liệu thật, không phải trùng biến — shop dựng gần như một nhóm cho mỗi mẩu. Hai con số đếm
> trên hai tập khác nhau trong bộ dò.

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

### Đã sửa, và đã đối chiếu lại trên production (22/09 chiều, AGENTS.md mục 6.5)

```
đơn đã chốt 1.402 · xác định 852 · nhập nhằng 35 · mất dấu 287 · ngoài quảng cáo 228
mẫu số đúng 1.174

độ phủ CŨ  (chia cho TỔNG đơn)   : 60,8%
độ phủ MỚI (chia cho mẫu số đúng): 72,6%
```

Dự báo trước khi sửa là 60,6% → 72,5%; đo lại ra 60,8% → 72,6%. Lệch 0,1–0,2 điểm vì cửa sổ 30 ngày
đã trôi vài giờ (1.395 → 1.402 đơn). **Bản sửa làm đúng thứ nó nói** — và đó là điều kiện để tin nó,
chứ không phải việc bài kiểm xanh.

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

| # | Việc | Trạng thái |
|---|---|---|
| 1 | Chạy ops `ads-level-probe --days=30`, đọc kết luận | ✅ **đã chạy — KHỚP, lệch 0 ₫** |
| 2 | Sửa **mẫu số**: tách đơn không-từ-Facebook ra khỏi "chưa quy kết" (mục 5) | ✅ đã gộp |
| 3 | Hạ hạt `ad_spends` xuống cấp mẩu, đối chiếu tổng chi trước/sau trên production | ✅ dò xong (lệch 0đ) · đã dựng |
| 4 | Lấy `post_id` cho các mẩu mới index được → nối lại đơn thiếu `ad_id` | ⏳ sau bước 3 |
| 5 | Bảng điều khiển: chuỗi bán trước + chỉ số quảng cáo + %CPQC hai mẫu số | ✅ đã dựng · có đủ ở cả ba cấp sau bước 3 |

**Không làm bước 3 trước bước 1.**

Bước 5 làm được sớm vì phần chuỗi thực hiện và chỉ số quảng cáo **không phụ thuộc hạt chi tiêu** —
chúng đọc `orders` + `shipments` + ba cột đã nằm sẵn trong `ad_spends`. Hai tab *Nhóm* và *Mẩu* vẫn
rỗng cho tới khi bước 3 xong, và giao diện nói thẳng điều đó thay vì hiện những ô `—` không giải
thích.

### Bước 3 sẽ đi thế nào, và nó được chặn ở đâu

Cột `grain` (`CAMPAIGN` · `AD` · `MANUAL`) làm cho lời hứa "không cộng đúp" **kiểm chứng được** thay
vì phải tin:

- Hai hạt cùng tồn tại trong **BẢNG** là bình thường và bắt buộc — Facebook chỉ giữ insights khoảng
  37 tháng và lượt đồng bộ chỉ chạm N ngày gần nhất, nên ngày cũ mãi mãi ở hạt `CAMPAIGN`.
- Hai hạt cùng tồn tại trong **MỘT (tài khoản × ngày)** thì **không** — đó đúng là hình dạng của
  phép cộng đúp. Đường ghi bảo đảm bằng XOÁ-RỒI-GHI trong một giao dịch.
- Mỗi ngày còn có một **cổng đối chiếu tại chỗ**: Σ(mẩu) phải khớp tổng cấp chiến dịch của chính
  ngày ấy; lệch quá dung sai thì **lùi về hạt `CAMPAIGN`** cho ngày đó và nêu cảnh báo. Không bao
  giờ ghi một bức tranh nửa vời.
- Dòng gõ tay (`grain = 'MANUAL'`) **không bao giờ** bị đường ghi xoá.

---

---

## 7b. Hạ hạt đã chạy thật — đối chiếu trước/sau trên production

Deploy 22/09 chiều, rồi chạy `sync-facebook-ads --days=3` và đo lại **đúng câu SQL** của ảnh chụp
trước đó (AGENTS.md mục 6.5).

| Ngày | Trước (dòng / chi) | Sau (dòng / chi) | Δ tiền |
|---|---|---|---|
| **20/09** | 37 / 3.806.757 ₫ | **51** / 3.806.757 ₫ | **0 ₫** |
| 21/09 | 40 / 5.901.807 ₫ | 57 / 5.901.935 ₫ | +128 ₫ — làm tròn từng dòng |
| 22/09 *(hôm nay, còn đang tiêu)* | 35 / 3.096.617 ₫ | 37 / 3.276.410 ₫ | +179.793 ₫ |
| 19/09 *(ngoài cửa sổ đồng bộ)* | 61 / 4.367.171 ₫ | 61 / 4.367.171 ₫ | 0 ₫ |

**Ngày 20/09 là bằng chứng sạch nhất: số dòng tăng 38%, tiền không đổi một đồng.**

Và bất biến giữ được:

```
cặp (tài khoản × ngày) mang HAI hạt : 0
cặp (chiến dịch × ngày) mang HAI hạt: 0
tổng cặp đã xét                     : 19
```

### Một ngày CÓ THỂ mang hai hạt, và đó không phải lỗi

Ngày 22/09 có **16 chiến dịch ở hạt MẨU và 19 ở hạt CHIẾN DỊCH**. Hàng rào quyết định hạt theo
**(tài khoản × ngày)**, nên với 7 tài khoản thì một NGÀY có thể có tài khoản ở hạt này và tài khoản
ở hạt kia. 16 + 19 = 35 = đúng số chiến dịch của ngày ấy ⇒ **hai tập rời nhau, không đồng nào bị
đếm hai lần**.

Bất biến đúng là *"một **(tài khoản × ngày)** một hạt"* — không phải *"một ngày một hạt"*. Viết tắt
thành vế sau là mô tả sai hàng rào, và người đọc sẽ tưởng bảng đang hỏng khi nó đang chạy đúng.

### Và cổng an toàn đã im lặng — lỗi tìm ra bằng cách CHẠY THẬT

Không có đường nào biết 19 trường hợp kia là `MISMATCH` hay `NO_AD_DATA`, mà **hai thứ đó sửa ở hai
chỗ khác nhau** — đúng lý do ba phán quyết được tách riêng ngay từ đầu.

Nguyên nhân: cổng ghi lý do vào `ctx.log`, còn `runSyncJob` chỉ giữ **5 dòng cuối** và chỉ đổ chúng
vào `sync_runs.error` **khi** lượt chạy có `warning`. Lượt ấy không đặt warning nên ghi `SUCCESS`,
và với 7 tài khoản × 3 ngày thì lý do bị đẩy ra ngoài cửa sổ trước khi ai kịp đọc.

> **Một cổng an toàn im lặng lùi về phía an toàn là một cổng không sửa được.**

Đã vá: số (tài khoản × ngày) ở mỗi hạt vào `summary.detail`; có ngày lùi hạt ⇒ `summary.warning` ⇒
lượt chạy ghi **PARTIAL** kèm tối đa 8 lý do nguyên vẹn. Bốn cổng đều xanh trong suốt thời gian lỗi
này tồn tại — nó chỉ lộ ra khi có người chạy thật rồi đi đọc kết quả.

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
