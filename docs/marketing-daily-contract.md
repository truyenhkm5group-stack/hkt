# Hợp đồng — Báo cáo hiệu quả marketing theo ngày

Mã nguồn: `lib/constants/marketing-daily.ts` (hợp đồng) · `lib/queries/marketing-daily.ts` (bộ máy) ·
`lib/marketing/*` (phân tích · cảnh báo · bản tin · AI) · `app/(dashboard)/ads/daily/` (màn hình).
Kiểm thử: `tests/marketing-daily.test.ts`, chạy trong `npm test`.

---

## 0. Câu hỏi duy nhất báo cáo này trả lời

> "Tiền quảng cáo tiêu **ngày hôm đó** cuối cùng đẻ ra bao nhiêu đơn, bao nhiêu tiền về, và lãi hay
> lỗ bao nhiêu?"

Câu hỏi ấy quyết định mọi thứ còn lại. Nó **không phải** câu hỏi dòng tiền ("hôm nay thu được bao
nhiêu"), và không được trả lời bằng bảng của câu hỏi kia.

## 1. Mốc thời gian — hai chế độ, không trộn

| Mốc | Ngày của một dòng là | Dùng để |
|---|---|---|
| `created` (**mặc định**) | `orders.inserted_at` — ngày phát sinh đơn | Đánh giá quảng cáo |
| `delivered` | `shipments.delivered_at` — ngày ghi nhận | Tài chính / dòng tiền |

Đơn lên 01/09, giao 05/09 ⇒ ở mốc mặc định, **toàn bộ** doanh thu và lợi nhuận của đơn ấy thuộc
dòng **01/09**. Đẩy sang 05/09 là làm hỏng việc đánh giá 10 triệu đã tiêu ngày 01/09.

**Chi quảng cáo KHÔNG dịch theo mốc**: tiền tiêu ngày nào đứng ở ngày đó ở cả hai chế độ. Vì vậy ở
mốc `delivered`, ROAS là con số **không so được** (hai vế không cùng một tập đơn) — màn hình nói rõ
điều đó trên tooltip của nút chọn mốc.

Hai mốc dùng lại `ReportBasis` của bộ máy lợi nhuận, không dựng từ vựng thứ hai.

## 2. Nguồn sự thật — không có cái nào mới

| Số liệu | Nguồn | Ghi chú |
|---|---|---|
| Kết quả đơn | `ORDER_OUTCOME` / `canonical_order_outcome` | Không viết lại điều kiện `stage` |
| Population | `lib/queries/metrics.ts::CONFIRMED_ORDER` | Cùng tập đơn với Báo cáo lợi nhuận |
| Doanh thu / giá vốn / cước / chi phí vận hành | `lib/queries/reports.ts::pnlFacts` | **Cùng bảng dẫn xuất** với `getDailyBreakdown` |
| Chi QC · tin nhắn | `ad_spends` (`excluded = false`) | Grain ngày × chiến dịch × mã × marketer |
| Quy kết marketer | `order_attributions` (ảnh chụp) | Đổi người phụ trách **không** viết lại lịch sử |
| Trùng đơn | `order_attributions.status = 'DUPLICATE'` | Không tự xét lại |
| Đơn → chiến dịch | `ORDER_CAMPAIGN_ID` (`ad_id` → `post_id`) | Nhập nhằng thì **không** nối |
| Đích / ngưỡng | `metric_targets` + `evaluateMetric` | Không có ngưỡng mặc định trong mã |

`pnlFacts()` là **cửa duy nhất**. Chép phép nối `orders ⋈ shipments` sang tệp thứ hai là dựng một
khoá chân lý thứ hai — hai bên sẽ đồng ý hôm nay và lệch nhau vào ngày ai đó sửa một vế.

## 3. Hai cột lợi nhuận, và vì sao

- **Lợi nhuận góp sau QC** = DT thực − giá vốn − cước/phí hoàn/phí sàn − chi QC.
  Lọc được theo **mọi** chiều, vì mọi vế đếm trên đúng tập đơn ấy.
- **Lợi nhuận (canonical)** = lợi nhuận góp − chi phí vận hành phân bổ.
  Chi phí vận hành là của **cả shop**. Không có căn cứ nào chia tiền thuê nhà cho một chiến dịch,
  nên **bật bất kỳ bộ lọc chiều nào ⇒ ô này là `—` (CHƯA BIẾT)**. Tuyệt đối không rơi về lợi nhuận
  góp và càng không phải 0.

### Cột thứ ba: lợi nhuận góp **ƯỚC TÍNH** (22/09/2026)

Hai cột trên đều đọc **đơn đã có kết cục**. Đơn của hôm nay chưa ai biết có giao được không, nên
`deliveredRevenue` của một ngày mới gần bằng 0 trong khi tiền quảng cáo đã tiêu đủ — bảng vì thế
**ngày nào cũng âm**, và một bảng ngày nào cũng âm thì không ai đọc nó để quyết định nữa.

- **DT thực ước tính** = DT thực (đo được) + Σ(DT đơn đang đi × tỷ lệ giao TC của mã trong đơn).
- **TL GTC ước tính** = (giao TC + Σ đơn đang đi × tỷ lệ) ÷ (đã kết thúc + đang đi).
  Mẫu số **khác** `Tỷ lệ giao TC`: ô kia bỏ đơn đang đi ra khỏi cả tử lẫn mẫu, ô này giữ chúng lại.
- **LN góp ước tính** = DT ước tính − giá vốn ước tính − **cước đã phát sinh** − chi QC.
- **ROAS ước tính** = DT ước tính ÷ chi QC.

Tỷ lệ lấy từ **thang bậc chung** `lib/constants/delivery-rate.ts` — cùng hàm mà Báo cáo lợi nhuận
danh nghĩa dùng, không có bản thứ hai:

| bậc | điều kiện | vì sao xếp ở đó |
| --- | --- | --- |
| `override` | chủ shop gõ tỷ lệ cho mã ở Giả định | một QUYẾT ĐỊNH, không phải ước lượng |
| `projected` | hợp đồng `PROJECTED_GTC_V3` **và** mã đã có ≥ 1 đơn đi tới kết cục | chưa đơn nào kết thúc thì con số là xác suất **mượn** của mã khác (Đầm Q005, 21/09/2026: giao 0 · hoàn 0 · đang giao 62 mà ô in 37,5%) |
| `history` | tỷ lệ hoàn 90 ngày của mã, ≥ `minFinishedOrders` đơn đã kết thúc | số đo thật, cửa sổ rộng hơn |
| `default` | `profit.assumptions.defaultReturnRate` (hiện 40 ⇒ **GTC 60%**) | bậc cuối, không một quan sát nào của chính mã đứng sau |

Ba điều khoá lại:

- **Ước tính KHÔNG BAO GIỜ nhỏ hơn số đo** — nó là số đo CỘNG phần dự phóng. Nhỏ hơn nghĩa là phép
  nhân tỷ lệ đã chạm vào cả đơn đã có kết cục.
- **Hết đơn đang đi ⇒ ước tính bằng đúng số đo.** Không còn gì để dự báo.
- **Không tô màu, không xếp hạng, luôn mang nhãn `ƯT`** (AGENTS.md mục 8.6). Độ phủ thang bậc
  (bao nhiêu mã theo số đo · bao nhiêu mã theo tỷ lệ khai) in ngay dưới dải KPI.

**Hướng sai đã biết:** cước là số **đã phát sinh**; phí hoàn của đơn đang đi chưa có trong đó, nên
ô này **lạc quan** đúng bằng phần phí hoàn chưa tới. Dự phóng nó cần thêm hai giả định nữa (cước
gửi, cước hoàn) vào một báo cáo vốn khai là "không có định nghĩa tiền nào của riêng nó" — nên nó
được **nói ra** thay vì được vá.

## 4. Độ chín — đọc trước khi đọc lợi nhuận

`maturity = (giao TC + hoàn) ÷ (giao TC + hoàn + đang đi)`. Đơn **huỷ không nằm** trong phân số.

| Mức | Ngưỡng | Hệ quả trên màn hình |
|---|---|---|
| `FINAL` | ≥ 95% | Đọc như kết quả thật |
| `PARTIAL` | ≥ 60% | Còn có thể đổi |
| `TOO_EARLY` | < 60% | **Không tô màu, không xếp hạng, không kết luận lãi/lỗ** |

Ba ngưỡng này không quyết định một con số tiền nào — chỉ quyết định khi nào màn hình thôi kết luận.
Đó là lý do chúng được phép nằm trong mã, khác hẳn đích đạt/không đạt.

### Đo trên production 19/09/2026 — con số quyết định thiết kế

Độ chín của 14 ngày gần nhất (đơn đã có kết quả cuối ÷ đơn không huỷ):

| Ngày | Độ chín | Ngày | Độ chín | Ngày | Độ chín |
|---|---|---|---|---|---|
| 18/09 | 0,0% | 13/09 | 46,7% | 08/09 | 71,4% |
| 17/09 | 0,0% | 12/09 | 13,3% | 07/09 | 83,3% |
| 16/09 | 1,8% | 11/09 | 20,8% | 06/09 | 48,0% |
| 15/09 | 2,6% | 10/09 | 20,5% | 05/09 | 70,6% |
| 14/09 | 22,5% | 09/09 | 85,0% | | |

**12/14 ngày dưới ngưỡng 60%.** Với vòng giao của shop này, một ngày mất khoảng **9–12 ngày** mới
ngã ngũ. Hai hệ quả, cả hai đều đã được xử lý:

1. Không có độ chín thì bảng sẽ in "lỗ" cho gần như **mọi** ngày gần đây — tiền quảng cáo đã tiêu
   hết từ sáng, hàng chưa tới tay ai.
2. Bản tin nói về **hôm qua** không bao giờ kết luận được lãi/lỗ. Nên bản tin có **hai khối**:
   *hôm qua* (phễu, hành động được ngay) và *ngày vừa ngã ngũ* (kết quả tiền cuối cùng, đến sau
   ~10 ngày). Xem `lib/marketing/digest.ts`.

### Các số nền khác (production, 30 ngày, đo 19/09/2026)

| Chỉ số | Giá trị | Ý nghĩa cho báo cáo |
|---|---|---|
| Biên quan sát chi tiêu | `2026-09-19` (hôm nay) | Không ngày nào bị in `—` vì thiếu quan sát |
| Ngày có dòng chi tiêu | 30/30 | Nguồn Facebook phủ kín kỳ |
| Đơn đã xác nhận | 1.098 | |
| Quy kết được marketer | **1.020 (92,9%)** | Trên ngưỡng cảnh báo 70% ⇒ bóc tách theo MKTer có nghĩa |
| Đơn không có dòng quy kết | 0 | Ảnh chụp phủ 100% |
| **Đơn TRÙNG** | **14** | Khác 0 ⇒ khối `duplicates` là cần thiết thật, không phải phòng xa |
| Chi QC | 136.184.686đ | ⇒ CPA ≈ **124.031đ/đơn** |
| Tin nhắn | 13.880 | ⇒ giá tin nhắn ≈ **9.811đ** · tỷ lệ chốt ≈ **7,9%** |

## 5. CHƯA BIẾT ≠ 0 — bốn chỗ, một luật

1. **Chi quảng cáo**: phân biệt bằng **biên quan sát** (`spendObservedThrough` = ngày gần nhất
   `ad_spends` đã nói tới). Trong biên mà không có dòng ⇒ hôm đó thật sự không chạy QC ⇒ `0 ₫`.
   Ngoài biên ⇒ `—`, và lợi nhuận của ngày ấy cũng `—`.
2. **Mẫu số 0** ⇒ `null`, không bao giờ `Infinity`/`NaN`.
3. **Chi phí vận hành khi có bộ lọc** ⇒ `—` (mục 3).
4. **Chiều không có số chi** (fanpage · nguồn đơn) ⇒ `—`; tiền quảng cáo ghi theo chiến dịch và mẩu,
   **không** chia xuống hai chiều ấy.
   **Nhóm QC · mẩu QC** (từ 25/09/2026, Company OS · B): CÓ số chi, nhưng CHỈ ở ngày đã ghi hạt MẨU
   (`ad_spends.grain = 'AD'`, xem `lib/constants/ads-grain.ts`) — chi = phép CỘNG các dòng hạt mẩu. Ngày
   mà chiến dịch của nhóm/mẩu còn ở hạt CHIẾN DỊCH ⇒ chi của ngày ấy `—` (tiền có thật nhưng chưa tách),
   và tổng kỳ có ngày như vậy cũng `—`. ĐỘ PHỦ (`spendCoverage`: ngày + tiền đã biết ở hạt mẩu, ngày +
   tiền cấp chiến dịch chưa tách) in NGAY trong thẻ Chi quảng cáo. Chiều chiến dịch / mã hàng / marketer
   không đổi — mọi hạt vẫn cộng như trước. Mẩu mà sổ không biết thuộc chiến dịch nào ⇒ cả chiều `—`.
5. **Chiều CÓ số chi nhưng nguồn chưa biết tới nhóm này** ⇒ `—`. Biên quan sát ở mục 1 trả lời
   "đồng bộ đã chạy tới ngày nào"; nó **không** trả lời được "nhóm này có được khai trong bảng chi
   tiêu không". Để nó trả lời thay là lỗi đã xảy ra trên Bóc tách theo MKTer: đơn được quy kết bằng
   **ảnh chụp phân công fanpage** (`order_attributions`), còn tiền quảng cáo đi bằng **ánh xạ chiến
   dịch → marketer** (`ad_spends.marketer_id`). Marketer chưa có chiến dịch nào được khai in `0 ₫`
   chi QC — ROAS đẹp, lợi nhuận góp dương — còn toàn bộ tiền thật dồn vào dòng "Chưa quy kết", và
   dòng đó lỗ nặng. **Cả hai con số đều sai**, và không ô nào nói rằng có gì chưa biết.
   Hai ô trống trông giống hệt nhau nhưng đưa người đọc đi hai nơi: "đồng bộ chưa tới" ⇒ đợi;
   "chưa khai ánh xạ" ⇒ đi khai, đợi bao lâu cũng không có số. Nên chúng là **hai câu cảnh báo**.

Luật này đi tới tận CSV: ô chưa biết xuất ra chuỗi rỗng. Tệp CSV rời khỏi ERP mà không mang theo
tooltip nào, nên một số 0 ở đó sẽ sống mãi như một phép đo thật.

## 6. Hàng tổng — tính lại, không trung bình

Mọi tỷ lệ đi qua `ratioOf(key, base)` trên tử/mẫu **đã cộng**. Bài kiểm dựng đúng cái bẫy:

```
ngày 1: 5 đơn / 10 tin nhắn  = 50%
ngày 2: 9 đơn / 100 tin nhắn =  9%
trung bình phần trăm        → 29,5%   ❌
tính lại từ tử/mẫu          → 12,7%   ✅
```

Khoảng cách giữa hai con số ấy là khoảng cách giữa "đội chốt đơn đang tốt" và "đội chốt đơn đang rơi".

## 7. Đối soát với Báo cáo lợi nhuận

`tests/marketing-daily.test.ts::testMarketingDailyReconciliation` so **từng ngày**: đơn · doanh thu
giao TC · giá vốn · cước+phí · chi QC · chi phí vận hành · **lợi nhuận**.

Chỉ **hai** chênh lệch được phép, và cả hai đều in ra thành số:

1. **Đơn TRÙNG** — báo cáo này loại (câu hỏi là "quảng cáo mang về bao nhiêu LẦN MUA"), Báo cáo lợi
   nhuận giữ (tiền của một đơn nhập hai lần vẫn là tiền đã thu). Mỗi ngày mang khối `duplicates`;
   cộng lại phải bằng đúng.
2. **Ngày ngoài biên quan sát chi tiêu** — ở đây lợi nhuận là `null`; Báo cáo lợi nhuận coi chi
   tiêu chưa có là 0 rồi vẫn chốt một con số. Bài kiểm chặn: ngoại lệ chỉ được phép khi
   `spendKnown = false`, và khi đó lợi nhuận **phải** là `null`.

## 8. Máy phân tích

Hàm thuần `lib/marketing/diagnose.ts`. Mỗi phát hiện là một **tổ hợp**, không phải một chỉ số riêng
lẻ — "CPA tăng" một mình không nói được phải sửa ở khâu quảng cáo hay khâu chốt đơn.

Hai cửa trước mọi kết luận: **đủ mẫu** (tin nhắn / đơn / tiền) và **đủ độ chín**.

| Tổ hợp | Kết luận | Người xử lý |
|---|---|---|
| Chi tăng, tin nhắn/DT đứng | Quảng cáo / traffic | MKTer |
| Giá tin nhắn đắt lên | Creative mỏi | MKTer |
| Tin nhắn ổn, đơn tụt | Khâu chốt | Sales |
| CPA tăng mà giá tin nhắn không tăng | Chuyển đổi, không phải traffic | Sales |
| AOV tụt | Mix sản phẩm / bán kèm | MKTer + Sales |
| GTC tụt (mức shop) | Chất lượng đơn / logistics | Vận hành |
| Hoàn tăng (mức **mã hàng**) | Sản phẩm / mô tả QC | MKTer + Sản phẩm |
| DT tăng mà LN tụt | Chi phí chạy nhanh hơn doanh thu | Quản lý |
| Chi ≥ 1tr mà 0 đơn | **NÓNG** — phễu đứt | MKTer ngay |
| Lỗ ≥ 3 ngày liên tiếp (chỉ đếm ngày đã ngã ngũ) | Leo thang | Quản lý |

"GTC tụt" và "hoàn tăng" là **cùng một phép trừ**; chúng chia nhau theo phạm vi để không gửi một
vấn đề hai lần.

## 9. Cảnh báo và bản tin

- **Cảnh báo** đi vào hàng đợi việc sẵn có (`notifications`), nên được thừa hưởng chống trùng theo
  `dedupeKey` (mang **ngày**, nên vấn đề kéo dài ba ngày là ba việc thật) và tự đóng `AUTO` khi
  điều kiện hết. Bật/tắt ở `alerts.config.enabled.marketingDaily`.
- **Bản tin Lark** (`marketing-digest`, 30 phút/lần) nói về **hôm qua** — ngày duy nhất vừa đã đóng
  vừa còn đáng hành động. Sổ chống gửi lại ở `settings["marketing.digest.sent"]` khoá đúng một bản
  tin mỗi phạm vi mỗi ngày Việt Nam. Người nhận khai ở `settings["marketing.alerts"]`; MKTer nhận
  bản của mình, quản lý nhận bản tổng.
- Bản riêng của MKTer chỉ gửi khi có phát hiện đủ mức. Một tin "hôm qua bình thường" gửi mỗi sáng
  cho năm người là cách nhanh nhất để kênh này bị tắt thông báo.

## 10. Đích / ngưỡng — không có mặc định

Bốn chỉ số (`marketing_cpa` · `marketing_roas_delivered` · `marketing_close_rate` ·
`marketing_margin`) khai ở `METRIC_BINDINGS`, đích đặt ở `metric_targets` theo ba tầng
(công ty → phòng ban → chức danh), mỗi đích có người đặt và lý do.

Chưa ai đặt đích ⇒ màn hình hiện **thực tế** và im lặng về chuyện đạt hay không. Im lặng ở đây là
câu trả lời đúng, không phải một chỗ còn thiếu. Việc chấm đi qua `evaluateMetric` — một đường tính
cho mọi ô thẻ điểm trong ERP.

## 11. AI

Thứ tự không được đảo:

```
bộ máy chỉ số (xác định) → máy phân tích quy tắc (thuần) → bối cảnh có cấu trúc → AI
```

AI đứng cuối và **chỉ viết chữ**. Không gửi đơn hàng, tên khách, số điện thoại. Không có khoá API
thì bảng, chẩn đoán và cảnh báo vẫn chạy nguyên vẹn — phần diễn giải đơn giản là không xuất hiện,
và lý do được in ra.

## 12. Những gì CỐ Ý không làm

- **Không** suy rộng doanh thu theo tỷ lệ độ phủ quy kết. Độ phủ 46% thì câu trả lời trung thực là
  "chưa kết luận được", không phải một con số nội suy.
- **Không** chia đều tiền chiến dịch xuống adset/mẩu quảng cáo — ngày còn ở hạt chiến dịch là `—`, không phải một phần chia.
- **Không** chia chi phí cố định cho một chiến dịch.
- **Không** đặt ngưỡng đạt/không đạt trong mã nguồn, kể cả trong màu của một ô.
- **Không** để AI sinh ra một con số tài chính.
- **Không** thay cột đo được bằng cột ước tính. Ước tính đứng **cạnh**, không tô màu, có nhãn — và
  cột đo được vẫn là cột đối soát được với Báo cáo lợi nhuận.
- **Không** dựng một tỷ lệ giao thành công riêng cho báo cáo này. Thang bậc ở
  `lib/constants/delivery-rate.ts` là bản duy nhất, dùng chung với Báo cáo lợi nhuận danh nghĩa.

## 13. Hiệu năng — bốn lần đo, và hai lần chẩn đoán sai

Đo bằng `ops smoke` (phiên đăng nhập thật). Luôn đọc kèm `/ads` của CÙNG lượt chạy để loại nhiễu
do phiên khác đang dùng máy chủ.

| Bản | `/ads` | `/ads/daily` | Nhận định |
|---|---|---|---|
| Ban đầu (chưa có phát hiện nào ⇒ không gọi AI) | 18,4s | 4,7s | — |
| Bóc tách chạy song song | 19,2s | 15,9s | ❌ tệ hơn |
| Bóc tách gộp một câu `GROUP BY` | 19,8s | 21,1s | ❌ tệ hơn nữa |
| Quay về bản tuần tự | 18,7s | 20,3s | vẫn chậm ⇒ **không phải lỗi truy vấn** |
| **AI ra sau `Suspense` riêng** | 21,4s | **9,5s** | ✅ |

**Nguyên nhân thật**: `explainMarketing` gọi mô hình NGAY TRONG lượt dựng trang. Lượt đo đầu nhanh
vì máy phân tích không tìm thấy bất thường nào nên hàm trả về ngay; các lượt sau có phát hiện, và
một lời gọi bậc `analysis` mất ~15 giây.

**Hai lần chẩn đoán sai** đều là giả thuyết về *hình dạng truy vấn* trong khi thủ phạm không phải
truy vấn. Bài học đã ghi vào chú thích mã nguồn: "48 câu truy vấn" nghe như vấn đề nhưng đó chỉ là
một con số **đếm**; cái tốn tiền là **khối lượng quét**, và 48 câu hẹp (mỗi câu đi qua
`order_attribution_marketer_idx`) rẻ hơn một câu rộng kèm truy vấn con tương quan. Và trước khi đổ
cho SQL, hãy hỏi: *giữa hai lượt đo, cái gì đã thực sự đổi?*

Phần còn lại (~9,5s) là giá thật của hai lượt quét 30 ngày `orders ⋈ shipments` kèm `ORDER_OUTCOME`
— cùng họ với `/ads` (21,4s) và `/reports/*`. Đó là một lượt tối ưu truy vấn riêng, chưa làm.

**Cập nhật 23–24/09/2026.** Bóc tách MKTer chuyển sang số của Báo cáo lợi nhuận (#165), tắt JIT hai
câu lớn (#176), bỏ đọc tồn kho (#185) ⇒ mọi hàm dữ liệu của trang ~3s nguội. Đoạn AI được nhả khỏi
luồng trả về (#198) ⇒ smoke `/ads/daily` 14–16s → 2,0–2,8s. Rồi chủ shop chốt GỠ hẳn đoạn "Diễn
giải" cùng `lib/marketing/ai-explain.ts`: nó chỉ viết lại thành văn các phát hiện đã in phía trên.
