# HỢP ĐỒNG CHỈ SỐ — MÀN RA QUYẾT ĐỊNH QUẢNG CÁO

Cài đặt: `lib/queries/ads-decision.ts` · ngưỡng: `lib/constants/ads-decision.ts` ·
kiểm thử: `tests/ads-decision.test.ts` (chạy trong `npm test`) · đo hiệu năng: `scripts/bench/ads.ts`.

Tài liệu này bổ sung cho `docs/metrics-contract.md`, **không thay thế**. Mọi quy tắc ở đó vẫn áp
dụng, đặc biệt là mục 0 (hai population) và mục 6 (mẫu số 0 ⇒ `null`).

---

## 0. Màn này trả lời câu gì — và cố ý KHÔNG trả lời câu gì

| Trả lời | Không trả lời |
|---|---|
| Chiến dịch / mã hàng nào đang kiếm ra tiền sau khi trừ hết | Lợi nhuận ròng của shop (xem `/reports`) |
| Dòng nào đang đốt tiền, nên cắt | Lương và hoa hồng marketer (xem `/payroll`) |
| Mã nào chịu được scale | Giá trị vòng đời khách hàng |
| Mã nào quảng cáo tốt nhưng chết ở khâu giao | Dự báo doanh thu |
| ROAS hoà vốn của từng dòng | Phân bổ chi phí cố định |
| Tiền đang treo ở nhóm chưa đủ dữ liệu | |

**Lợi nhuận ở màn này là LỢI NHUẬN GÓP SAU QUẢNG CÁO, không phải lợi nhuận ròng.** Đây là lựa chọn
có chủ đích, không phải đường tắt: chi phí cố định, thuế và lương **không đổi** khi tăng hay giảm
ngân sách MỘT chiến dịch, nên đưa chúng vào phép so sánh giữa các chiến dịch chỉ làm nhiễu. Con số
dùng để quyết định tăng/giảm ngân sách là con số thay đổi theo ngân sách.

---

## 1. Grain và population

| | |
|---|---|
| **Grain** | một dòng = một CHIẾN DỊCH / MÃ HÀNG / NHÓM QC / MẨU QC trong kỳ |
| **Population** | `confirmed` — đơn đã xác nhận trên Pancake (`metricScope(period, "confirmed")`) |
| **Trường ngày (đơn)** | `orders.inserted_at` — ngày lên đơn |
| **Trường ngày (chi QC)** | `ad_spends.spend_date` |
| **Mỗi đơn một dòng** | `orders LEFT JOIN shipments ON PRIMARY_ATTEMPT` — đơn gửi lại không đếm hai lần |
| **Kết quả đơn** | `ORDER_OUTCOME` qua `ORDER_OUTCOME_FAST`. KHÔNG có công thức mới ở đây |

**Hai trường ngày khác nhau là CỐ Ý và là giới hạn đã biết**: tiền quảng cáo tính theo ngày tiêu,
đơn tính theo ngày lên đơn. Đơn của quảng cáo chạy ngày 30 có thể lên ngày 1 tháng sau. Ở kỳ tháng
trở lên, sai lệch này nhỏ; ở kỳ vài ngày thì KHÔNG được dùng màn này để kết luận.

---

## 2. Tám chiều đo, không cái nào suy ra từ cái kia

| Chỉ số | Công thức | Ghi chú |
|---|---|---|
| `spend` | `sum(ad_spends.spend)`, bỏ `excluded` | Chỉ tồn tại ở cấp **chiến dịch** và **mã hàng** |
| `bookedOrders` | `count(*) filter (outcome <> 'CANCELLED')` | |
| `deliveredOrders` | `count(*) filter (outcome = 'DELIVERED')` | |
| `returnedOrders` | `count(*) filter (outcome in ('RETURNED','RETURNED_BY_RULE'))` | Hai mã LUÔN gộp |
| `openOrders` | `count(*) filter (outcome in ('IN_TRANSIT','NOT_SHIPPED','UNKNOWN'))` | Chưa ngã ngũ |
| `bookedRevenue` | `sum(total_price_after_discount) filter (booked)` | |
| `deliveredRevenue` | `sum(total_price_after_discount) filter (delivered)` | **Doanh thu chuẩn của màn này** |
| `cashReceived` | `sum(cod_collected + prepaid + transfer_money) filter (delivered)` | Tiền CÓ CHỨNG TỪ |
| `cogs` | `sum(orderCogsFast()) filter (delivered)` | Cùng population với `deliveredRevenue` |
| `shippingCost` | `sum(coalesce(nullif(shipping_fee,0), partner_fee, 0))` trên **MỌI** đơn | Xem §3 |

> **`bookedRevenue` KHÔNG BAO GIỜ được dùng thay `deliveredRevenue`.** Với shop bán COD, khoảng
> cách giữa hai con số này là 30–40% và đó chính là chỗ lỗ. `tests/ads-decision.test.ts` khoá bất
> biến `bookedRevenue >= deliveredRevenue` trên mọi dòng, mọi cấp.

> **Không suy `delivered` từ tiền.** `ORDER_OUTCOME` xét chứng từ ĐVVC trước, rồi mới tới tiền —
> và đó là quy tắc của `docs/business-rules/ORDER_OUTCOME.md`, không được viết lại ở đây.

---

## 3. Cước theo bậc thang Sự thật tài chính: đơn đã giao + đơn hoàn, cộng phí hoàn

`shippingCost` = cước (`coalesce(shipping_fee vận đơn, partner_fee đơn)`) của đơn **đã giao thành
công** và đơn **hoàn**, cộng `orders.return_fee` của đơn hoàn — đúng bậc thang `financial-truth.ts`
và `docs/metrics-contract.md`. Đơn hoàn vẫn tốn cước — đó chính là phần làm biên lợi nhuận tụt; lọc
nó ra sẽ cho một điểm hoà vốn đẹp hơn sự thật. Nhưng đơn huỷ / chưa gửi / đang đi thì CHƯA có cước
thật: `partner_fee` ở đó chỉ là cước Pancake ước tính lúc lên đơn, cộng vào là gánh tiền chưa hề chi
(bản đầu của trang này từng cộng cả nó — sửa ở vòng tích hợp 12/09/2026).

Hệ quả phải chấp nhận: `marginRate` là biên **đã gánh sẵn phần hoàn**, nên nó thấp hơn biên của
riêng một đơn giao thành công. Đó là con số đúng để quyết định ngân sách.

**Cấp MÃ HÀNG — căn cứ phân bổ cước** (AGENTS.md mục 14): cước là chi phí của CẢ ĐƠN, không của
dòng hàng. Phân bổ theo **tỷ trọng doanh thu dòng trong đơn**
(`line_total / sum(line_total) over (partition by order_id)`). Không phân bổ theo số lượng hay khối
lượng vì dữ liệu cước chỉ tồn tại ở cấp vận đơn.

---

## 4. Dẫn xuất

```
contributionBeforeAds = deliveredRevenue − cogs − shippingCost
profitAfterAds        = contributionBeforeAds − spend
marginRate            = contributionBeforeAds ÷ deliveredRevenue          (null nếu deliveredRevenue = 0)
deliveredShare        = deliveredRevenue ÷ bookedRevenue                  (ĐO, không suy từ tỷ lệ đơn)
successRate           = delivered ÷ (delivered + returned)                (null nếu chưa có đơn kết thúc)
maturity              = (delivered + returned) ÷ bookedOrders
headroom              = contributionBeforeAds ÷ spend
```

### ROAS hoà vốn — hai con số, hai cơ sở

```
breakEvenDeliveredRoas = 1 ÷ marginRate
breakEvenBookedRoas    = 1 ÷ (marginRate × deliveredShare)
```

`breakEvenBookedRoas` luôn **cao hơn** `breakEvenDeliveredRoas`, vì ROAS trên đơn ĐÃ LÊN còn phải
gánh phần đơn sẽ hoàn. Đây là con số so trực tiếp được với ROAS hiện trên Facebook Ads Manager, nên
nó là con số người chạy quảng cáo cần.

`deliveredShare` được **đo thẳng từ dữ liệu**, không suy từ tỷ lệ ĐƠN: đơn to và đơn nhỏ hoàn với
tỷ lệ khác nhau, nên quy đổi qua số đơn sẽ sai ở đúng những mã đáng quan tâm nhất.

Cả hai là `null` khi `marginRate ≤ 0` — bán dưới giá vốn thì **không có** mức ROAS nào hoà vốn, và
`null` nói đúng điều đó. Trả về một con số ở đây là nói dối.

### `headroom` — khoảng cách tới điểm hoà vốn

`headroom ≥ 1 ⟺ profitAfterAds ≥ 0`. Dùng một số vô hướng thay vì so hai ROAS với nhau vì nó so
được giữa các mã có biên khác nhau: `headroom = 1,3` nghĩa là "dư 30%" ở mọi mã, trong khi
"ROAS 2,0" có thể là lãi to ở mã này và lỗ ở mã kia.

---

## 5. `null` là CHƯA BIẾT, không phải 0

| Tình huống | Kết quả |
|---|---|
| Cấp không có số chi (nhóm QC, mẩu QC) | `spendKnown = false`; mọi tỷ số tiền = `null`; hành động `NO_SPEND_DATA` |
| `spend = 0` | mọi ROAS = `null` (chia cho 0 là vô nghĩa) |
| `deliveredOrders = 0` | `cacDelivered = null` |
| Chưa có đơn nào kết thúc | `successRate = null` — và KHÔNG được coi là "giao kém" |
| `marginRate ≤ 0` | hai ROAS hoà vốn = `null` |

**Vì sao `ad_spends` không có chi tiêu cấp nhóm/mẩu:** bảng không có cột `adset_id` lẫn `ad_id` —
Facebook Insights đồng bộ ở cấp chiến dịch/ngày. Chia đều tiền chiến dịch xuống nhóm/mẩu làm **tổng
khớp trong khi từng dòng đều sai**, nên cố ý không chia. Hai cấp đó vẫn hữu ích: chúng cho biết
nhóm/mẩu nào thật sự đưa được hàng tới tay khách.

---

## 6. Quy kết: chỉ nhận dữ kiện thật

| Cấp | Nguồn quy kết |
|---|---|
| Chiến dịch | `ad_id` Pancake gửi, **hoặc** `post_id` khi bài đó chỉ thuộc MỘT chiến dịch (`ORDER_CAMPAIGN_ID`) |
| Nhóm QC / Mẩu QC | **Chỉ** `ad_id`. Một bài có thể do nhiều mẩu chạy ⇒ chọn bừa một mẩu là bịa |
| Mã hàng | `ad_spends.product_id` (ghép từ tên chiến dịch); doanh thu theo dòng đơn, KHÔNG lọc `ad_id` |

Cấp mã hàng cố ý không lọc `ad_id`: mã hàng có doanh thu từ cả đơn không chạy quảng cáo, và lọc
theo `ad_id` sẽ bỏ mất phần doanh thu mà chính quảng cáo đó tạo ra nhưng Pancake không gắn mã —
cho ra ROAS thấp giả tạo.

**Độ phủ quy kết đi kèm mọi bảng** (`confidence`). Dưới `LOW_COVERAGE_PCT` (60%), giao diện phải
nói rõ bảng mô tả PHẦN ĐƠN CÓ MÃ QUẢNG CÁO, không phải toàn shop. Phần không quy kết được **không
bao giờ** chia đều cho các chiến dịch.

---

## 7. Quy tắc khuyến nghị — từ chối kết luận TRƯỚC, kết luận SAU

Các cổng chạy theo đúng thứ tự này. Bảng chân lý đầy đủ ở `tests/ads-decision.test.ts`.

| # | Điều kiện | Kết quả |
|---|---|---|
| 0 | Không có số chi | `NO_SPEND_DATA` |
| 1 | `spend < minSpend` (300.000đ) | `INSUFFICIENT_DATA` |
| 1 | `finished < minFinishedOrders` (10) | `INSUFFICIENT_DATA` |
| 2 | `maturity < minMaturity` (60%) | `INSUFFICIENT_DATA` — tiền đã tiêu, kết quả chưa ngã ngũ |
| 3 | GTC < 65% **và** `headroom < 1,3` **và** ROAS lên đơn ≥ ROAS lên đơn hoà vốn | `FIX_DELIVERY` |
| 4 | `headroom ≥ 1,3` | `SCALE` |
| 5 | `headroom ≥ 1,0` | `HOLD` |
| 6 | `headroom ≥ 0,8` | `WATCH` |
| 7 | còn lại | `CUT` |

**Cổng 3 là điểm quan trọng nhất của màn này.** Nó tách hai nguyên nhân mà mọi báo cáo ROAS thông
thường gộp làm một: quảng cáo dở, và quảng cáo tốt nhưng hàng không tới tay khách. Hai nguyên nhân
đó cần hai hành động ngược nhau — cắt ngân sách, hay sửa khâu chốt đơn / đóng gói / ĐVVC. Điều kiện
"ROAS lên đơn đã vượt hoà vốn" chính là bằng chứng quảng cáo không có lỗi.

Cờ `lowDelivery` bật **độc lập** với hành động: một dòng vẫn đáng tăng ngân sách mà vẫn đang mất
hàng ở khâu giao, và bỏ sót nó là bỏ sót tiền.

**Mọi khuyến nghị phải dẫn số thật của chính dòng đó.** Kiểm thử ép điều này: mỗi `reason` phải
chứa chữ số.

---

## 8. Tiền treo — phải nhìn thấy

| | |
|---|---|
| `pending.spendInsufficientData` | chi ở các dòng `INSUFFICIENT_DATA` |
| `pending.spendWithoutOrders` | chi ở chiến dịch KHÔNG có đơn nào gắn vào — tiền đã mất dấu |
| `pending.openOrders` | đơn chưa ngã ngũ |

Ba con số đầu bảng đang **đẹp hơn sự thật đúng bằng phần này**, nên chúng đứng ngang hàng với ba
con số kia trên giao diện thay vì nằm trong một chú thích nhỏ ở cuối trang.

---

## 9. Hiệu năng — đo, không đoán

`npx tsx scripts/bench/ads.ts --scale=3` (quy mô 3× ≈ 3.959 đơn, có dựng
`canonical_order_outcome` như production).

| | Trước | Sau |
|---|---|---|
| Phần người dùng CHỜ | 523,3ms · 39 câu | **30,1ms · 3 câu** |
| Tổng công sức cả trang | 523,3ms · 39 câu | 535,4ms · 42 câu |

Nút thắt thật: `getAdsPerformance → getMarketerReport → getNominalProfitReport` = **447ms / 33 câu**
— màn quảng cáo dựng lại toàn bộ báo cáo lợi nhuận công ty. Khối đó nay nằm sau `Suspense` nên
không chặn bảng quyết định; nó vẫn là việc cần làm tiếp, nhưng thuộc bộ máy lương/lợi nhuận dùng
chung với `/payroll` và `/expenses`, không phải của màn này.

Số câu truy vấn **không đổi theo quy mô** (3 câu ở cả 1× lẫn 3×) ⇒ không có N+1. Truy vấn đọc theo
`orders_inserted_idx` trong đúng kỳ đang xem, không quét toàn bộ lịch sử.

> **Cảnh báo về bộ đo:** từ `--scale=4` trở lên, PGlite trả **mảng rỗng cho mọi câu lệnh** (kể cả
> `select count(*) from orders`). Mọi con số đo ở quy mô đó là thời gian của câu lệnh KHÔNG trả về
> gì. `scripts/bench/ads.ts` nay chặn cứng trường hợp này; các tệp `docs/perf/*-scale4.json` và
> `*-scale10.json` có sẵn trong kho được đo trước khi biết điều đó nên **không dùng để kết luận**.

---

## 10. Quy tắc cho người sửa code sau

1. Thêm chỉ số ⇒ thêm một mục vào tài liệu này TRƯỚC.
2. Không viết lại điều kiện `stage`; dùng `ORDER_OUTCOME_FAST` và các vị ngữ ở `lib/queries/metrics.ts`.
3. Không hard-code ngưỡng — tất cả nằm ở `lib/constants/ads-decision.ts`, và **chỉ sửa khi chủ shop yêu cầu**.
4. Mẫu số 0 ⇒ `null`, không bao giờ 0.
5. Thêm cấp phân tích mới ⇒ khai `ADS_DIMENSION_HAS_SPEND` cho đúng. Khai sai sẽ sinh ra ROAS bịa.
6. Sửa công thức ⇒ chạy lại `scripts/bench/ads.ts` và cập nhật §9.
