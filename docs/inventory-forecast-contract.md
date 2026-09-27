# Hợp đồng dự báo tồn kho & đặt sản xuất

Kèm `docs/business-rules/ORDER_OUTCOME.md` và luật SỔ KHO ở `AGENTS.md` §3.10. Mọi công thức dưới
đây nằm ở **một chỗ duy nhất**: `lib/constants/planning.ts`.

## Bốn con số, theo đúng thứ tự phụ thuộc

```
tốc độ bán  →  số ngày còn đủ hàng  →  ngày dự kiến hết hàng  →  số lượng nên đặt
```

Sai ở bước đầu thì cả ba bước sau đều sai, nên tốc độ bán là chỗ được bảo vệ kỹ nhất.

---

## 1. Tốc độ bán

> **MỘT định nghĩa cho mọi màn hình — quyết định 27/09/2026** (chủ shop giao Tech Lead: "Bạn làm thế
> nào tốt nhất thì làm"). Trước ngày đó shop có hai: Kế hoạch SX dùng tốc độ **gửi đi** (gộp), còn
> bảng Hàng chậm tự tính tốc độ **ròng** (bỏ đơn hoàn, bỏ hàng tặng) — cùng một mẫu mã hiện hai "số
> ngày còn đủ hàng" trên cùng một trang. Định nghĩa **của Kế hoạch SX thắng**, vì:
>
> 1. nó là định nghĩa đang **quyết định tiền** (số nên đặt sản xuất); đổi nó là đổi đơn đặt xưởng,
>    đổi bảng Hàng chậm chỉ đổi nhãn;
> 2. nó mô tả đúng cách kho **thật sự vơi**: hàng rời kho theo mọi đơn không huỷ (kể cả đơn sẽ hoàn,
>    kể cả hàng tặng), phần hoàn chỉ quay lại **sau** độ trễ hoàn đo được — tốc độ ròng giả vờ hàng
>    hoàn chưa từng rời kho, nên với mã hoàn nhiều nó báo "tồn đủ bán 140 ngày" cho lô hàng thật ra
>    đang đi hết trong 2 ngày;
> 3. phần hoàn được trừ **tường minh**, có tên, có số đo (tỷ lệ hoàn theo GTC của mã, tỷ lệ nhập lại
>    được, độ trễ hoàn) — in ra được trong lời diễn giải, thay vì bị giấu trong phép lọc đơn.
>
> Đo trước/sau trên production bằng ops `velocity-compare` (`docs/company-os/handoff-v.md`).

```
tốc độ gửi đi = số món của đơn KHÔNG HUỶ trong cửa sổ (gồm đơn đang giao, đơn đã hoàn, hàng tặng)
                ÷ số ngày cửa sổ   (sau khi bỏ ngày đột biến — mục dưới)
nhịp hao kho ròng = tốc độ gửi đi × (1 − tỷ lệ hoàn của mã × tỷ lệ nhập lại được)   — chỉ SAU độ trễ hoàn
```

Nơi DUY NHẤT dựng ba số này là `computePlan` (`lib/constants/planning.ts`); mọi nơi khác đọc chúng
từ dòng Kế hoạch SX (`paceOfPlanRow`, `getVariantPaceMap`, hoặc thẳng `getReplenishmentPlan().rows`).
Người đọc hiện tại: Kế hoạch SX, trang chi tiết sản phẩm, Quyết định vốn tồn, **Hàng chậm / vốn nằm
chết**, **Hiệu quả mẫu mã** (và nhãn mẫu mã dựng trên nó), **tệp khách xả hàng** (outreach), **vòng
phản hồi tồn** (gộp nhóm mẫu đang đẩy), cảnh báo đặt hàng. `tests/velocity-unify.test.ts` chặn mọi
phép chia cho tốc độ bên ngoài `lib/constants/planning.ts`.

Ngoại lệ đã khai: **đối chứng lịch sử** (`backtestInventoryDecisions`) dựng tồn tại một mốc cắt quá
khứ và không có GTC / độ trễ hoàn của thời điểm đó — nó là ƯỚC TÍNH có nhãn, không phải số của màn
hình vận hành.

### Chống một ngày đột biến

Một buổi livestream bán 60 cái trong cửa sổ 14 ngày đẩy tốc độ lên **4,4 cái/ngày**, trong khi ngày
thường bán 1 cái. Kế hoạch sẽ đặt sản xuất theo nhịp 4,4 cho cả tháng sau — thừa gấp bốn.

```
nếu (một ngày chiếm > 50% tổng bán cửa sổ) và (cửa sổ ≥ 7 ngày) và (còn ngày khác có bán):
    tốc độ = (tổng bán − ngày mạnh nhất) ÷ (số ngày − 1)
ngược lại:
    tốc độ = tốc độ thô
```

Ba điều kiện, mỗi điều kiện chặn một cách làm hỏng:

| Điều kiện | Chặn điều gì |
|---|---|
| ngày đó chiếm **> 50%** | Dập cả dao động bình thường ⇒ kế hoạch luôn đặt thiếu |
| cửa sổ **≥ 7 ngày** | Bỏ 1 ngày trong 3 ngày là bỏ một phần ba bằng chứng |
| **còn ngày khác có bán** | Cắt hết dữ liệu ⇒ kết luận "mẫu này không bán", sai hoàn toàn |

Ngày tính theo **giờ Việt Nam** — một buổi live tối muộn không được tách làm hai ngày.

Cả tốc độ **thô** và cờ **đã cắt** đều được giữ lại và hiện trên giao diện, để giải thích được vì
sao con số đề xuất khác cảm giác của người bán.

---

## 2. Số ngày còn đủ hàng

```
tồn khả dụng = tồn thực tế − hàng đã chốt đơn còn trong kho
nếu chưa đo được độ trễ hoàn, hoặc khả dụng ≤ tốc độ gửi đi × độ trễ hoàn:
    số ngày còn đủ hàng = khả dụng ÷ tốc độ gửi đi
ngược lại:
    số ngày còn đủ hàng = độ trễ hoàn + (khả dụng − tốc độ gửi đi × độ trễ hoàn) ÷ nhịp hao kho ròng
```

Một hàm: `coverDaysOf` (nghịch đảo `qtyForCoverDays` cho "mức tồn lành mạnh" của bảng Hàng chậm;
`pooledPace` gộp nhiều mẫu mã — độ trễ hoàn là số toàn shop nên cộng được). Làm tròn để in: một chỗ,
`roundCoverDays` (một chữ số thập phân). Ngưỡng Hàng chậm (`inventory.slowMoving`) **không đổi**;
bảng Hàng chậm xếp lớp trên số đã làm tròn — đúng con số nó in.

**Bốn trường hợp biên, và không trường hợp nào được ra một con số bịa:**

| Tình huống | Kết quả | Vì sao |
|---|---|---|
| Không bán được cái nào | `null` → hiện "—" | Chia cho 0 là vô cực, không phải "đủ hàng mãi mãi" |
| Có gửi đi nhưng hàng hoàn về bằng hàng đi (nhịp ròng ≤ 0) | `null` → hiện "—"; bảng Hàng chậm xếp **Vốn nằm chết** | Tồn không vơi — không có số ngày nào, nhưng kết luận thì có |
| Tồn âm | 0 ngày, trạng thái **Hết hàng** | Tồn âm là dấu hiệu sai lệch, không phải kho có nợ |
| Chưa có phiếu nhập nào | `null`, trạng thái **Chưa có phiếu nhập** | "Nhập = 0" là THIẾU DỮ LIỆU, không phải "nhập 0 cái" |
| Chưa đủ lịch sử bán | Vẫn tính, nhưng cửa sổ ngắn thì không cắt đột biến | Ít dữ liệu vẫn hơn không có |

**Không bao giờ hiện `Infinity`.**

### Gửi đi mà không giao được — lớp "Hoàn gần hết" (27/09/2026)

Tốc độ gửi đi dương **không phải** là bán được. Lượt đo production đầu tiên sau khi gộp (ops `velocity-compare`,
run 36306328239, 28 mẫu mã) có 1 mẫu đi **Hàng chết → Bình thường**: gửi đi đều, khách hoàn gần hết, số ngày phủ
ngắn nên phép xếp theo ngưỡng gọi nó "Bình thường". Chủ shop duyệt bản vá — một lớp tường minh trong CHÍNH phép
xếp lớp duy nhất (`classifyStockRisk`), xét trước mọi nhánh khác:

```
không giao thành công món nào trong cửa sổ hàng chết  (ORDER_OUTCOME = DELIVERED — cùng căn cứ luật hàng chết cũ)
và gửi đi > 0 trong cửa sổ                              (đơn không huỷ — cùng căn cứ "gộp" với tốc độ gửi đi)
và hoàn > 0 trong cửa sổ                                (RETURNED / RETURNED_BY_RULE)
    ⇒ RETURNED_OUT "Hoàn gần hết / gửi đi không giao được"
không gửi đi món nào                                    ⇒ Hàng chết như cũ
```

- **Cửa sổ** là `deadDays` của `inventory.slowMoving` — KHÔNG thêm ngưỡng nào.
- **Cần có món hoàn**: đơn còn đang đi là CHƯA BIẾT, không phải thất bại — một mẫu mới toàn đơn đang giao không
  được gắn nhãn "hoàn gần hết" (luật 3 / 42).
- Hai sự kiện cửa sổ đọc chung một câu với "lần cuối giao được" (`deadWindowFactsSubquery`); **không** phải định
  nghĩa tốc độ thứ hai — không chia cho số ngày, không vào số ngày phủ (số ngày phủ vẫn là của Kế hoạch SX).
- Đối xử **như hàng chết** ở mọi nơi dùng: toàn bộ tồn là vốn vượt mức; Quyết định vốn tồn ⇒ **Nên xả**, không đề
  xuất đặt thêm; vòng phản hồi tồn ⇒ việc chính là **xem lý do hoàn của mã** (không phải làm creative mới), câu lý
  do nói "xem lại chất lượng / mô tả trước khi đẩy thêm"; nhịp gửi đi của mẫu này không vào "đủ bán" của tệp khách
  xả hàng và của vòng phản hồi.

---

## 3. Ngày dự kiến hết hàng và mức rủi ro

```
ngày hết hàng = hôm nay + số ngày còn đủ hàng
```

Mức rủi ro so trực tiếp với **thời gian sản xuất**, vì đó mới là câu hỏi thật:

| Trạng thái | Điều kiện | Nghĩa |
|---|---|---|
| **Hết hàng** | khả dụng ≤ 0 | Đang mất doanh thu ngay bây giờ |
| **Hết trước khi SX xong** | còn đủ < thời gian sản xuất | Đặt ngay hôm nay vẫn đứt hàng |
| **Sắp thiếu** | còn đủ < thời gian SX + tồn an toàn | Đặt được nhưng không còn dư địa |
| **Đủ hàng** | trên mức đó | — |
| **Không bán** | tốc độ = 0, còn tồn | Vốn đang nằm chết |
| **Chưa có phiếu nhập** | chưa biết tồn | Không đề xuất gì |

Trạng thái nói về **HÔM NAY** nên tính trên tồn khả dụng, **không** cộng hàng sắp hoàn về: hàng
đang trên đường về không bán được ngay, gộp vào sẽ giấu mất mẫu mã đang đứt hàng.

---

## 4. Số lượng nên đặt

```
mục tiêu   = tốc độ × (thời gian SX + số ngày muốn đủ bán) + tồn an toàn
nguồn cung = tồn khả dụng + hàng sắp quay lại kho
đặt        = max(0, mục tiêu − nguồn cung)
```

**Hàng sắp quay lại kho** — phần này thường bị bỏ sót và gây đặt thừa nhiều nhất, vì shop có lượng
hoàn lớn hơn hẳn lượng đang giao:

```
từ đơn chờ hoàn về = số lượng × tỷ lệ nhập lại được kho
từ hàng đang đi    = số lượng × tỷ lệ hoàn × tỷ lệ nhập lại được kho
```

Hai tỷ lệ lấy từ **dữ liệu thật của shop** (phiếu tái nhập đã đếm ÷ hàng hoàn đã xử lý), không phải
số gõ tay. Tỷ lệ hoàn = 1 − tỷ lệ giao thành công của MÃ HÀNG theo thang bậc chung
(`lib/constants/delivery-rate.ts`, AGENTS.md mục 68) — từ 23/09/2026, thay cho "số của mẫu mã khi đủ
20 đơn, không thì số toàn shop".

### Làm tròn và mức đặt tối thiểu

```
đặt = làm tròn lên bội số
nếu 0 < đặt < mức xưởng nhận:  đặt = mức xưởng nhận  (và ghi nhận là ĐÃ NÂNG)
```

Đề xuất 5 cái trong khi xưởng chỉ nhận từ 50 là con số vô dụng — bảng trông chính xác trong khi đơn
hàng không đặt được. Nhưng mức tối thiểu **không được đẻ ra đơn đặt từ hư không**: đủ hàng rồi thì
đề xuất vẫn là 0.

Giao diện đánh dấu "(tối thiểu)" và giữ lại con số **trước khi nâng**, để chủ shop biết phần chênh
là do ràng buộc của xưởng chứ không phải do nhu cầu.

---

## Cấm

1. **Không đề xuất khi chưa biết tồn.** Đề xuất dựa trên dữ liệu bịa còn tệ hơn không đề xuất.
2. **Không tính hàng hoàn vào nhu cầu** — hàng hoàn nằm trong tốc độ GỬI ĐI (nó thật sự rời kho) và
   được trừ tường minh qua nhịp hao kho ròng sau độ trễ hoàn; không màn hình nào được tự tính một tốc
   độ "ròng" thứ hai.
3. **Không dùng tồn Pancake** thay tồn ERP — tồn ERP đi từ phiếu kho và sự kiện Viettel Post.
4. **Không coi "ĐVVC báo đã hoàn" là hàng đã về kho.** Chỉ phiếu tái nhập với số đếm thực tế mới
   cộng tồn.
5. **Không hiện vô cực, không hiện số âm giả** ở bất kỳ ô nào.
6. Ngưỡng chỉ sửa ở `lib/constants/planning.ts` và trang Kế hoạch SX, không hard-code nơi khác.
