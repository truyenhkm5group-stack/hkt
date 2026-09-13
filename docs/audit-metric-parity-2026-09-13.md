# Cùng một chỉ số, bao nhiêu cách tính — soát từ mã nguồn (13/09/2026)

## Bảng soát

| Chỉ số | Trang | Nơi tính | Grain | Mốc thời gian | Mẫu số | Công thức |
|---|---|---|---|---|---|---|
| TL GTC **thực tế** | `/reports/returns` | `return-rate.ts:607` | mẫu mã | ngày ĐVVC tiếp nhận | `delivered + returned` | `delivered / (delivered + returned)` |
| TL GTC **ước tính** | `/reports/returns` | `return-rate.ts:607` | mẫu mã | ngày ĐVVC tiếp nhận | `delivered + returned + failed` | `100 − (returned + failed×p) / (d+r+f)` |
| TL GTC **ước tính** | `/reports?tab=nominal` | `profit-nominal.ts:459` | **sản phẩm** | **ngày tạo đơn** | **`base.orders` (MỌI đơn)** | `100 − (returned + failed×pFail + unknown×giả_định) / orders` |
| DT GTC ước tính | `/reports?tab=nominal` | `profit-nominal.ts:289` | sản phẩm | ngày tạo đơn | — | **`grossSales × (1 − r)`** |
| Rủi ro TK (bảng chính) | `/reports?tab=nominal` | `profit-nominal.ts:493` | sản phẩm | ngày tạo đơn | — | `inventoryRiskOnSold(expectedCogs, %)` ✅ đúng luật 14 |
| Rủi ro TK (bảng hàng nhập) | `/reports?tab=nominal` | `profit-nominal.ts:494` | sản phẩm | **ngày NHẬP KHO** | — | `inventoryRiskOnSold(purchaseCost, %)` ⚠️ |
| CPQC / DS POS | *chưa có* | — | — | — | — | — |
| CPQC / DT GTC ƯT | *chưa có* | — | — | — | — | — |

## Kết luận 1 — TL GTC ước tính lệch vì BỐN khác biệt độc lập

Chênh lệch **cộng dồn** chứ không triệt tiêu:

1. **Mẫu số** — returns dùng cohort vận đơn đã kết thúc + chờ phát lại; nominal dùng MỌI đơn.
2. **Nhóm chưa rõ** — returns loại hẳn; nominal nhân với một tỷ lệ hoàn giả định.
3. **Mốc cohort** — returns theo ngày ĐVVC tiếp nhận; nominal theo ngày tạo đơn.
   (Đo 13/09/2026: 73,6% vận đơn có hai mốc này rơi vào HAI NGÀY KHÁC NHAU, lệch trung bình 4,5 ngày.)
4. **Grain** — mẫu mã ở một bên, sản phẩm ở bên kia.

Không trang nào ghi cứng 22%. Nhưng `defaultReturnRate` là **giả định do người đặt** và chỉ được áp
ở một bên — tác dụng giống hệt một con số ghi cứng, chỉ khó thấy hơn.

## Kết luận 2 — "Rủi ro TK cả lô nhập = 0" KHÔNG phải lỗi công thức

`lib/constants/profit.ts:49` khai mặc định `inventoryRiskPercent: 10`, và `resolveAssumptions()`
áp mặc định đó. Nên `riskPct` là **10**, không phải 0.

Số 0 đến từ `purchaseByProduct(period)`: hàm này chỉ lấy **phiếu nhập có `received_at` TRONG KỲ**.
Kỳ 7 ngày không có phiếu nhập nào ⇒ `purchaseCost = 0` ⇒ rủi ro = 0.

Đúng theo nghĩa đen của tên cột ("rủi ro của lô NHẬP"), nhưng **sai theo luật nghiệp vụ số 14 của
chính kho mã này**:

> *dự phòng rủi ro tồn kho đi theo GIÁ VỐN HÀNG BÁN RA, không theo giá trị hàng nhập trong kỳ —
> nhập hàng là sự kiện một lần, ném trọn vào kỳ chứa nó thì tuần bán 1/10 lô vẫn gánh đủ dự phòng
> cả lô.*

Bảng chính đã làm đúng (`inventoryRiskOnSold(expectedCogs, %)`). Bảng "theo tổng giá trị hàng nhập"
là chỗ duy nhất còn tính rủi ro theo hàng NHẬP — và vì thế vừa bằng 0 khi không nhập, vừa nhảy vọt
đúng vào tuần có phiếu nhập.

**Không cần phát minh mô hình rủi ro mới.** Mô hình đúng đã có sẵn và đã phân bổ theo kỳ bằng chính
cấu tạo của nó (đi theo hàng BÁN RA trong kỳ). Việc phải làm là để bảng hàng nhập dùng lại nó, và
đổi tên cột cho khớp với thứ nó thật sự đo.

---

# ĐO PRODUCTION — xác nhận bằng số thật (ops run #700, db-query CHỈ ĐỌC)

| Mục | Giá trị |
|---|---|
| Phiếu nhập 7 ngày | **1** |
| Phiếu nhập 30 ngày | 3 |
| **Giá trị hàng nhập 7 ngày** | **0 ₫** |
| `inventoryRiskPercent` đã khai | **10** |
| `defaultReturnRate` đã khai | **40** |
| Vận đơn chưa kết thúc | **448** |
| Mẫu học xác suất (vận đơn đã kết thúc có sự kiện ĐVVC) | **1.363** |

## Chốt nguyên nhân "Rủi ro TK cả lô nhập = 0"

**KHÔNG phải vì % chưa khai.** Dữ liệu nói rõ: `inventoryRiskPercent = 10`.

Nguyên nhân là **giá trị hàng nhập trong kỳ 7 ngày bằng 0 ₫** — có đúng một phiếu nhập nhưng
`Σ(số lượng × giá nhập)` của nó bằng 0. Nhân 10% với 0 thì ra 0.

Nên cột đó không nói "hàng không có rủi ro". Nó nói "tuần này không nhập hàng" — hai câu hoàn toàn
khác nhau, và bảng lợi nhuận đang in câu thứ nhất.

Với cách tính mới (rủi ro theo GIÁ VỐN HÀNG BÁN RA, `AGENTS.md` mục 14), kỳ 7 ngày vẫn có hàng bán
ra nên vẫn có dự phòng — và kỳ có phiếu nhập lớn cũng thôi bị nhảy vọt.

## Chốt nguyên nhân "TL GTC ước tính lệch nhau"

`defaultReturnRate = 40`. Đây chính là con số giả định được áp cho nhóm **chưa rõ** ở bảng nominal
và **không** áp ở bảng returns. Không ai gõ 22% vào mã nguồn — nhưng một giả định 40% nhân với
nhóm chưa rõ tạo ra đúng loại chênh lệch mà chủ shop nhìn thấy.

**448 vận đơn chưa kết thúc** là tập bị hai báo cáo đối xử khác nhau: một bên loại hẳn khỏi phép
tính, một bên nhân với 40%.

## Mô hình xác suất có đủ dữ liệu để học

**1.363 vận đơn đã kết thúc** có sự kiện ĐVVC — vượt xa ngưỡng tin cậy cao (100 mẫu) cho tổng thể.
Cỡ mẫu của từng trạng thái con sẽ được in ra cạnh mỗi xác suất, và trạng thái nào dưới 10 mẫu thì
trả `null` chứ không trả một con số đoán.

---

# Đo lại sau khi nối hợp đồng (ops #701, #702 — chỉ đọc, 13/09/2026)

## Cohort 30 ngày theo NGÀY CHỐT ĐƠN, tách theo mã hàng

Đếm theo mã VTP thuần tuý (bậc chứng từ cao nhất), để thấy phần nào đã ngã ngũ và phần nào còn treo:

| Mã | Đơn | Đã giao (501) | Hỏng (504/101/107/201/503) | Đang chạy | Chưa có mã VTP số |
|---|---:|---:|---:|---:|---:|
| Q002 | 458 | 16 | 15 | 46 | 381 |
| Q003 | 359 | 15 | 19 | 98 | 227 |
| Q004 | 96 | 4 | 0 | 75 | 17 |
| Q005 | 21 | 0 | 1 | 20 | 0 |
| (chưa có mã) | 3 | 0 | 0 | 3 | 0 |
| Q001 | 2 | 0 | 0 | 0 | 2 |

## 627 vận đơn "chưa có mã VTP số" rơi về đâu

Câu hỏi quan trọng nhất của bản này: nếu phần lớn cohort không có `vtp_status` thì mô hình đang dự
báo trên cái gì? Đo thẳng:

| `stage` | `vtp_status_name` | Số kiện | Luật chữ / chặng bắt được | Trạng thái con |
|---|---|---:|---|---|
| DELIVERED | Giao thành công | 240 | `%giao thanh cong%` | `DELIVERED` |
| RETURNED | Đã trả | 193 | (không khớp luật chữ) → chặng `RETURNED` | `RETURNED` |
| RETURNING | Đang chuyển hoàn | 59 | `%chuyen hoan%` | `RETURNING` |
| PENDING | Chờ xử lý | 49 | `%cho xu ly%` | `WAITING_PROCESSING` |
| DELIVERY_FAILED | Chờ phát lại | 30 | `%cho phat lai%` | `WAITING_REDELIVERY` |
| IN_TRANSIT | Đang vận chuyển | 27 | `%dang van chuyen%` | `IN_TRANSIT` |
| OUT_FOR_DELIVERY | Đang giao hàng | 26 | `%dang giao hang%` | `OUT_FOR_DELIVERY` |
| OUT_FOR_DELIVERY | Phát tiếp | 1 | `%phat tiep%` | `OUT_FOR_DELIVERY` |
| DELIVERED | (rỗng) | 1 | (rỗng) → chặng `DELIVERED` | `DELIVERED` |
| RETURNING | Đã duyệt hoàn | 1 | `%duyet hoan%` | `RETURNING` |

**Không dòng nào rơi vào `UNKNOWN`.** Và **433/627 (69%) đã có kết cục cuối** (240 giao + 193 hoàn)
— tức phần mà mô hình phải *dự báo* nhỏ hơn nhiều so với cột "chưa có mã VTP số" gợi ý. Cột đó đo
việc **thiếu mã số**, không đo việc **thiếu thông tin**.

Đây cũng là lý do `SUBSTATE_IMPLIES_PICKED_UP.WAITING_PROCESSING` phải là `AMBIGUOUS`: 49 kiện
"Chờ xử lý" ở đây không có mã số nào để nói chúng đã rời kho hay chưa.

## Việc còn lại sau bản này

Mô hình hiện học xác suất theo **trạng thái con của toàn shop**. Bước tiếp theo hợp lý — khi đủ mẫu
cho từng mã — là xác suất theo (mã hàng × trạng thái), với cùng luật lùi bậc: chưa đủ mẫu cho mã thì
lùi về xác suất toàn shop, chưa đủ cả hai thì `null`. Hợp đồng đã có `ProbabilityBasis` để khai bậc
nào đang được dùng, nên việc mở rộng không phải viết lại công thức.

---

# PROJECTED_GTC_V3 — hợp đồng, thử ngược, và những gì đã sửa (13/09/2026, phiên chiều)

## Vì sao phải có V3 ngay sau V2

V2 nối hai trang vào một hàm, nhưng hàm ấy vẫn **gán nhãn bằng `shipments.stage` / mã ĐVVC thô** thay
vì `ORDER_OUTCOME`. Đo production 13/09 (chỉ đọc), cohort 30 ngày theo mốc ĐVVC nhận:

| Mã | Đơn có `stage = DELIVERED` nhưng `ORDER_OUTCOME ≠ DELIVERED` |
|---|---:|
| Q002 | **134 / 799** |
| Q003 | **40 / 525** |
| Q004 | 9 / 96 |
| Q005 | 0 / 21 |

Theo mã ĐVVC: 119 kiện từng mang **501** có `stage` "đã giao" đủ 119, nhưng `ORDER_OUTCOME` chỉ công
nhận **87** — 27% là 501 của **chiều hoàn**. Sự kiện **không mã số** (1.370 kiện): stage nói 752 giao,
`ORDER_OUTCOME` nói 488. Mô hình V2 học từ những nhãn ấy nên vừa **lạc quan** (kiện thu 30.000đ,
kiện 50K–100K được dạy là "giao được") vừa **mù** với 503 tiêu huỷ (stage `CANCELLED` ⇒ rơi khỏi mẫu
số). Thử ngược của V2 lại chấm bằng chính trạng thái `DELIVERED` (P = 1) trên chính dữ liệu đã học.

## Hợp đồng V3 (`lib/constants/projected-delivery.ts`)

```
TL GTC thực tế     = Delivered ÷ (Delivered + Failed)                  — theo ORDER_OUTCOME, pending ngoài mẫu số
Ước tính giao được  = Delivered + Σ ActiveCount(s) × P(final DELIVERED │ s)
TL GTC ước tính     = Ước tính giao được ÷ (EligibleSent − UnmodelledActive)
DT GTC ước tính     = Σ DT(đơn DELIVERED) + Σ DT(đơn đang giao) × P(s) + Σ DT(đơn chưa gửi) × P(NOT_SHIPPED)
```

* **Nhãn và cohort đọc `ORDER_OUTCOME_FAST`** (bảng `canonical_order_outcome`, logic_version 2, 2.967
  dòng, làm mới liên tục — an toàn để nối). `DELIVERED` ⇒ giao; `RETURNED | RETURNED_BY_RULE` ⇒ hỏng;
  `CANCELLED` / `UNKNOWN` / `NOT_SHIPPED` ⇒ ngoài cohort tỷ lệ, đếm riêng. Trạng thái con ĐVVC **chỉ**
  dùng để chọn P(s) cho đơn `IN_TRANSIT`.
* **Trạng thái được dự báo** (`MODELLED_SUBSTATES`): 9 trạng thái chưa kết thúc; `WAITING_PROCESSING`
  và `WAITING_REDELIVERY` riêng. `DELIVERED / RETURNED / CANCELLED / RETURNING` không bao giờ là
  trạng thái dự báo (P = 1/0 là lộ đáp án).
* **Cửa sổ huấn luyện** (`TRAINING_WINDOW`): kiện ĐVVC nhận trong 180 ngày, **và** trước hôm nay ít
  nhất H ngày; H = p95 "ĐVVC nhận → kết cục" của đơn HOÀN, đo từ dữ liệu (≥ 30 đơn hoàn), trần 21,
  mặc định 14. Đo production: giao được p50 2,8 / p95 5,7 ngày; hoàn p50 7,0 / **p95 13,1** ngày.
* **Đơn ngoài ước tính** (trạng thái < 10 mẫu) rời khỏi mẫu số và được nêu riêng; quá **50%** phần
  đang giao ⇒ tỷ lệ là `null` (chưa đo được), không phải một con số tính trên nửa tập.
* **P(NOT_SHIPPED)** chỉ phục vụ doanh thu của cohort theo ngày chốt (bảng lợi nhuận); học từ đơn
  chốt trong cửa sổ đã kết thúc **kể cả huỷ**. Không vào tỷ lệ GTC.

## Thử ngược (`getProjectionBacktest`)

Tách theo thời gian: với mỗi tháng M trong 3 tháng gần nhất, huấn luyện lại bằng dữ liệu có kết cục
**trước** M (`cutoff`), rồi chấm các kiện đã kết thúc và **đủ chín** có mốc ĐVVC nhận trong M. Mỗi kiện
chụp ở k ∈ {1, 3, 5, 7, 10} ngày sau mốc nhận; trạng thái tại t = sự kiện ĐVVC mới nhất có
`occurred_at ≤ t`; ảnh chụp sau mốc kết cục hoặc ở trạng thái cuối bị loại. Báo: n (theo vận đơn, không
theo ảnh chụp), lệch, Brier, MAE, bảng hiệu chuẩn theo thập phân vị, độ dốc hiệu chuẩn, độ phủ.
Nhãn: `HIGH` n≥100 ∧ |lệch|≤0,03 ∧ dốc 0,8–1,2 · `MEDIUM` n≥30 ∧ |lệch|≤0,07 · `LOW` n≥10 · còn lại
`INSUFFICIENT_DATA` (= chưa kiểm chứng, **không** = sai). Huy hiệu + ⓘ đứng cạnh con số ước tính ở cả
`/reports/returns` lẫn `/reports?tab=nominal` (`app/(dashboard)/reports/projection-confidence.tsx`).

## Những chỗ đã sửa cùng bản này

| # | Chỗ | Trước | Sau |
|---|---|---|---|
| 1–2 | `projected-delivery.ts` | nhãn/chấm theo `stage` / 501 | theo `ORDER_OUTCOME`; 503 vào mẫu số |
| 3 | thử ngược | trong mẫu, lộ `DELIVERED` | tách thời gian, ảnh chụp đúng lúc, hiện trên màn hình |
| 4 | tỷ lệ | ngoài ước tính ở mẫu số (P = 0 ngầm) | rời mẫu số; > 50% ⇒ `null` |
| 5 | `profit-nominal.ts` | DT GTC ƯT = doanh số × (1 − r) | tiền cân theo từng đơn (`revenueBasis = ORDER_LEVEL`); ×(1 − r) chỉ cho ghi đè / lịch sử / mặc định, nhãn "ước tính theo tỷ lệ" |
| 6 | cohort | huỷ = hỏng, không lọc `REPORTABLE_ORDER` | `REPORTABLE_ORDER`; huỷ / không dấu vết / chưa gửi đếm riêng |
| 7 | thẻ tổng | bình quân tỷ lệ từng dòng (gồm ghi đè) | `orderLevel.projectedRate` của hợp đồng; bình quân cũ ở `assumedDeliveryRate` |
| 8 | huấn luyện | không cửa sổ | 180 ngày + H đo được, có trong khoá đệm và xuất xứ |
| 9 | `return-rate.ts` | `.catch(() => null)` | `projectionError` hiện là LỖI trên trang |
| 10 | dòng chưa đo được | lùi về lịch sử / 40% | `unmeasured`, in "—"; khoá dòng theo `product_id` |
| 11 | tỷ lệ QC | hai mẫu số cùng tên | `adsRatios()` trả ba tỷ lệ; thẻ = tổng chi, dòng tổng = đã quy kết; "chưa quy kết" đứng riêng |
| 12 | rủi ro TK | giá vốn 0 ⇒ rủi ro 0 | `cogsKnown` / `purchaseCostKnown`, in "—"; một mặc định 10% |
| 13 | ngưỡng | 55/70 · 60/75 · 0,65 | `SUCCESS_RATE_OK/GOOD` ở mọi nơi |
| 14 | `failedToReturnRate` | ghi cứng 60%, 2,9 s mỗi lượt mở trang | xoá |
| 15 | nhãn | "Tỷ lệ giao thành công" cho chỉ số sự kiện | "Phát thành công theo sự kiện ĐVVC"; "Chi phí test" → "Chưa quy kết" |

Kỳ vọng số học và thứ tự nguồn khoá ở `tests/projected-delivery.test.ts` và
`tests/reporting-parity.test.ts`; contract test `tests/contract-order-outcome.test.ts` không đổi.

## Ba câu đo production (chỉ đọc) để so trước / sau cho Q002–Q005, 30 ngày, mốc ĐVVC nhận

Xem mục "Truy vấn đối chiếu" ở cuối báo cáo bàn giao của bản này.
