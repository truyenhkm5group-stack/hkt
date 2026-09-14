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

```
tốc độ thô = số món bán ròng trong cửa sổ ÷ số ngày cửa sổ
```

"Bán ròng" = không tính đơn huỷ, không tính đơn hoàn, không tính hàng tặng. Hàng hoàn **không phải
nhu cầu** — tính nó vào sẽ đặt thừa đúng bằng phần hoàn.

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
số ngày còn đủ hàng = tồn khả dụng ÷ tốc độ bán
tồn khả dụng = tồn thực tế − hàng đã chốt đơn còn trong kho
```

**Bốn trường hợp biên, và không trường hợp nào được ra một con số bịa:**

| Tình huống | Kết quả | Vì sao |
|---|---|---|
| Không bán được cái nào | `null` → hiện "—" | Chia cho 0 là vô cực, không phải "đủ hàng mãi mãi" |
| Tồn âm | 0 ngày, trạng thái **Hết hàng** | Tồn âm là dấu hiệu sai lệch, không phải kho có nợ |
| Chưa có phiếu nhập nào | `null`, trạng thái **Chưa có phiếu nhập** | "Nhập = 0" là THIẾU DỮ LIỆU, không phải "nhập 0 cái" |
| Chưa đủ lịch sử bán | Vẫn tính, nhưng cửa sổ ngắn thì không cắt đột biến | Ít dữ liệu vẫn hơn không có |

**Không bao giờ hiện `Infinity`.**

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
số gõ tay. Tỷ lệ hoàn dùng số của chính mẫu mã khi có ≥ 20 đơn đã kết thúc, không đủ thì dùng số
toàn shop.

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
2. **Không tính hàng hoàn vào nhu cầu.**
3. **Không dùng tồn Pancake** thay tồn ERP — tồn ERP đi từ phiếu kho và sự kiện Viettel Post.
4. **Không coi "ĐVVC báo đã hoàn" là hàng đã về kho.** Chỉ phiếu tái nhập với số đếm thực tế mới
   cộng tồn.
5. **Không hiện vô cực, không hiện số âm giả** ở bất kỳ ô nào.
6. Ngưỡng chỉ sửa ở `lib/constants/planning.ts` và trang Kế hoạch SX, không hard-code nơi khác.
