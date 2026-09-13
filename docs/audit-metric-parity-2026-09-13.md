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
