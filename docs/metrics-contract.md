# HỢP ĐỒNG CHỈ SỐ — VNXcommerce ERP

> **Bất biến:** cùng một chỉ số · cùng một kỳ · cùng bộ lọc ⇒ **cùng một con số**, ở mọi trang và
> mọi API. Lệch nhau nghĩa là một trang sai, không phải "cách tính khác".
>
> Cài đặt: `lib/queries/metrics.ts` (population + vị ngữ + tiền) trên nền `ORDER_OUTCOME`
> (`lib/queries/return-rate.ts`). Kiểm thử khoá: `tests/consistency.test.ts`,
> `tests/metrics-contract.test.ts`.
>
> Luật nghiệp vụ ràng buộc: `docs/business-rules/ORDER_OUTCOME.md`. Năm chiều sự thật:
> `lib/constants/truth.ts`.

---

## 0. Hai POPULATION, không được dùng lẫn

| Khoá | Nghĩa | Điều kiện | Dùng cho |
|---|---|---|---|
| `confirmed` | Đơn đã xác nhận trên Pancake | `orders.stage IN (CONFIRMED, PACKING, READY_TO_SHIP, SHIPPED, DELIVERED, PAID, RETURNING, PARTIAL_RETURN, RETURNED)` | doanh thu · lợi nhuận · lương · quảng cáo · Tổng quan |
| `reportable` | Mọi đơn đã chốt, kể cả huỷ | `orders.stage <> 'NEW'` | tỷ lệ giao thành công · bảng kết quả đơn · chất lượng dữ liệu |

Hai tập KHÁC NHAU đúng ở đơn huỷ/xoá. Trộn hai tập trong cùng một phép tính là lỗi đã từng xảy ra:
Tổng quan lấy doanh thu giao thành công theo `confirmed` nhưng giá vốn theo `reportable`, nên lợi
nhuận ước tính lệch (F4 trong `docs/erp-data-truth-audit.md`).

**Trường ngày mặc định:** `orders.inserted_at` (ngày lên đơn). Báo cáo lợi nhuận cho phép chuyển
sang `coalesce(shipments.delivered_at, orders.inserted_at)` bằng tham số `basis=delivered`; khi đó
nhãn trên màn hình PHẢI nói rõ.

**Tiền tệ:** VND, số nguyên, không thập phân. Không quy đổi ngoại tệ ở bất kỳ chỉ số nào.

---

## 1. Chỉ số đơn hàng

### `orders` — Số đơn lên trong kỳ

| | |
|---|---|
| Ý nghĩa | Số đơn khách chốt trong kỳ, chưa nói gì tới việc giao được hay không |
| Tử số | `count(*)` |
| Mẫu số | — |
| Population | `confirmed` |
| Loại trừ | `ORDER_OUTCOME = 'CANCELLED'` |
| Trường ngày | `orders.inserted_at` |
| Nguồn sự thật | Pancake |
| Cài đặt | `metrics.ts::COUNT_BOOKED` |

### `deliveredOrders` — Đơn giao thành công

| | |
|---|---|
| Ý nghĩa | Đơn đã tới tay khách VÀ có tiền vượt ngưỡng (hoặc có chứng từ 501 chiều đi) |
| Tử số | `count(*) filter (where ORDER_OUTCOME = 'DELIVERED')` |
| Population | `confirmed` (Tổng quan, lợi nhuận) · `reportable` (báo cáo GTC) |
| Nguồn sự thật | chứng từ Viettel Post trước, tiền có chứng từ sau |
| Cấm | suy từ trạng thái Pancake, từ `cod_status`, từ settlement |
| Cài đặt | `metrics.ts::COUNT_DELIVERED` |

### `returnedOrders` — Đơn hoàn

`RETURNED` và `RETURNED_BY_RULE` **luôn** gộp làm một. Không màn hình nào được tách chúng ra khi
tổng hợp. Cài đặt: `metrics.ts::COUNT_RETURNED`.

### `successRate` — Tỷ lệ giao thành công (GTC)

| | |
|---|---|
| Tử số | đơn `DELIVERED` |
| Mẫu số | đơn `DELIVERED` + đơn hoàn — tức **đơn ĐÃ KẾT THÚC** |
| Loại trừ khỏi mẫu số | đơn huỷ · đơn đang giao · đơn chưa gửi |
| Giá trị khi mẫu số = 0 | **`null`**, hiển thị `—`. KHÔNG phải 0% |
| Cài đặt | `metrics.ts::successRate()` |

Tỷ lệ hoàn = `100 − GTC` trên cùng mẫu số.

---

## 2. Chỉ số tiền

Ba con số dưới đây **không bao giờ được coi là một**. Nhãn trên giao diện phải phân biệt rõ.

### `bookedRevenue` — Doanh thu LÊN ĐƠN

| | |
|---|---|
| Ý nghĩa | Tổng giá trị đơn đã chốt. Chưa giao, chưa thu tiền |
| Tử số | `sum(orders.total_price_after_discount)` |
| Population | `confirmed`, loại `ORDER_OUTCOME = 'CANCELLED'` |
| Nguồn sự thật | Pancake |
| Cài đặt | `metrics.ts::BOOKED_REVENUE` |

### `deliveredRevenue` — Doanh thu GIAO THÀNH CÔNG (earned)

| | |
|---|---|
| Ý nghĩa | Giá trị đơn đã tới tay khách. Vẫn CHƯA phải tiền trong tài khoản |
| Tử số | `sum(orders.total_price_after_discount) filter (where ORDER_OUTCOME = 'DELIVERED')` |
| Population | `confirmed` |
| Cài đặt | `metrics.ts::DELIVERED_REVENUE` |

### `cashReceived` — TIỀN THỰC NHẬN

| | |
|---|---|
| Ý nghĩa | Tiền đã về tài khoản shop theo bảng kê Viettel Post + khách chuyển trước |
| Nguồn sự thật | `cod_batches` (theo ngày đối soát) + `cod_statement_lines`; KHÔNG phải trạng thái vận đơn |
| Trường ngày | `cod_batches.received_at` — **khác** trường ngày của hai chỉ số trên |
| Cài đặt | `profit-cash.ts::getCashProfitReport().cashIn` |

`deliveredRevenue ≠ cashReceived`. Chênh lệch là tiền Viettel Post còn giữ, đo ở trang Đối soát COD.

### `prepaid` — Tiền khách TRẢ TRƯỚC (chuyển khoản / đặt cọc / tiền mặt lúc lên đơn)

Chủ shop chốt 11/09/2026: **dòng tiền theo ngày tiền thực trả, lợi nhuận theo kỳ hưởng lợi**. Cùng
một con số trên đơn (`orders.prepaid + transfer_money + cash`) nhưng hai báo cáo dùng hai mốc, và
đó là cố ý:

| Báo cáo | Mốc | Population | Cài đặt |
|---|---|---|---|
| **Dòng tiền** (`/reports` tab Dòng tiền, lương cơ sở dòng tiền) | `orders.inserted_at` — Pancake ghi tiền trả trước lúc lên đơn, không có mốc thanh toán riêng | đơn có trả trước > 0, **không** phải `CANCELLED` (đơn huỷ giữ số trả trước nhưng không có chứng từ tiền về) | `profit-cash.ts::cashIn.prepaid` |
| **Lợi nhuận / Chân lý tài chính / Báo cáo tổng hợp** | kỳ đơn (`inserted_at`) **và** đơn giao thành công — doanh thu được hưởng | `DELIVERED` | `financial-truth.ts`, `reports.ts` |

Không đếm trùng: tiền trả trước vào dòng tiền **một lần** ở tháng tiền về; giao xong không cộng lại.
Phần đã trả cho đơn **chưa kết thúc** là **số dư trả trước** (`pending.prepaidUnallocated`) — nghĩa vụ
giao hàng, chưa vào lợi nhuận kỳ nào. Trả trước của đơn đã hoàn được nêu riêng
(`cashIn.prepaidOnReturned`): tiền đã vào nhưng có thể phải trả lại; ERP không có chứng từ hoàn tiền
nên chỉ nêu, không trừ. Kiểm thử: `tests/prepaid-cash.test.ts`.

### `deliveredCogs` — Giá vốn của đơn giao thành công

Phải **cùng population và cùng bộ lọc** với `deliveredRevenue`, và nên tính trong CÙNG một câu
truy vấn để không thể lệch. Cài đặt: `metrics.ts::DELIVERED_COGS`.

Giá vốn một dòng đơn tính "sống" theo thứ tự: phiếu nhập ERP gần nhất → giá vốn Pancake → giá nhập
mẫu mã (`lib/queries/cogs.ts`). Đơn đã giao đọc giá vốn **đã ghi nhận** (`recognized_cogs`, chốt
lúc giao; chưa có phiếu thì tạm tính; chốt lại đúng một lần khi có phiếu, có nhật ký — xem
`docs/cogs-recognition-contract.md` mục 8). Đơn không tra được giá nào ⇒ giá vốn ghi nhận là NULL
(CHƯA BIẾT), báo cáo tính 0 và **nêu** ở Chất lượng dữ liệu (`missing-cogs`) và luật
`COGS_BASIS_UNVERIFIED` — **không** im lặng coi lợi nhuận là đúng.

### `estimatedProfit` — Lợi nhuận ước tính (Tổng quan)

```
deliveredRevenue − deliveredCogs − cước ĐVVC − phí hoàn − chi quảng cáo − chi phí vận hành
```

Là **ước tính**: chi phí lấy theo kỳ, không phân bổ theo từng đơn. Con số quyết toán nằm ở
Báo cáo lợi nhuận (`profit-nominal.ts` danh nghĩa, `profit-cash.ts` tiền thật).

**Cước ĐVVC và phí hoàn lấy từ bậc thang của Sự thật tài chính** (`financial-truth.ts`): cước chỉ
của đơn đã giao thành công và đơn hoàn (`coalesce(shipping_fee vận đơn, partner_fee đơn)`), phí hoàn
chỉ của đơn hoàn. Trước 11/09/2026 thẻ Tổng quan tự cộng `orders.partner_fee` của MỌI đơn không huỷ
trong kỳ (kể cả đơn mới, đang giao) nên cùng nhãn "Lợi nhuận ước tính" ở Tổng quan và ở tab Sự thật
tài chính là hai con số. Nay là một.

**Population của Báo cáo lợi nhuận (`/reports`)** cũng là đơn đã xác nhận (`CONFIRMED_ORDER`) —
trước đây gom cả `NEW`/`WAITING`, nên "N đơn" của cùng kỳ ở `/reports` và Tổng quan khác nhau.

---

## 3. Chỉ số tồn kho

| Chỉ số | Công thức | Nguồn sự thật | Cài đặt |
|---|---|---|---|
| Tồn thực tế | tổng phiếu kho − đã xuất qua ĐVVC | phiếu kho + trạng thái vận đơn | `stock.ts::erpStockExpr` |
| Khả dụng bán | tồn thực tế − đã chốt đơn chưa xuất | như trên | `stock.ts::availableStockExpr` |
| Đã xuất | `SHIPMENT_LEFT_WAREHOUSE` | mốc lấy hàng / trạng thái vận đơn | `return-rate.ts` |
| Days of cover | khả dụng ÷ tốc độ bán | phiếu kho + đơn không hoàn | `constants/planning.ts::computePlan` |

**Tồn kho KHÔNG dùng `ORDER_OUTCOME`** — đó là định nghĩa theo tiền. Hàng rời kho lúc bưu tá lấy
hàng, không phải lúc khách trả tiền. Mẫu mã chưa có phiếu nhập nào ⇒ `stockKnown = false`, hiển thị
"Chưa có phiếu nhập", **không hiển thị số 0**.

---

## 4. Chỉ số đối soát

| Chỉ số | Ý nghĩa | Nguồn sự thật |
|---|---|---|
| `Viettel Post phải trả` | tiền thu hộ của đơn ĐÃ GIAO THÀNH CÔNG mà chưa thấy trên bảng kê | `ORDER_OUTCOME` + `cod_statement_lines` |
| `Đã trả` | tổng dòng bảng kê đã ghép được | `cod_statement_lines` |
| `Quá hạn` | giao xong quá `COD_OVERDUE_DAYS` ngày mà chưa có dòng bảng kê | như trên |
| `Giao nhưng hoàn` | ĐVVC ghi phát thành công nhưng bảng kê chỉ trả một phần nhỏ | `SettlementStatus` |

`cod_collected = 0` là **CHƯA BIẾT**, không phải "thu 0đ". Vận đơn có mặt trên một bảng kê nào đó
KHÔNG chứng minh đã thu 0đ — bảng kê tách phần COD và phần cước.

---

## 5. Completeness — nói rõ độ đầy đủ khi cần

Chỉ số nào có thể còn thay đổi khi chứng từ về sau thì phải kèm dấu hiệu:

- `IS_PROVISIONAL` — đơn đang được kết luận bằng số TẠM TÍNH (chưa có chứng từ tiền);
- `ORDER_OUTCOME_VERIFIED = 'UNVERIFIED'` — có tín hiệu giao xong nhưng không đọc được đồng nào;
- `stockKnown = false` — mẫu mã chưa có phiếu nhập.

Không được thay giá trị chưa biết bằng 0 rồi hiển thị như số đã xác minh.

---

## 6. Quy tắc cho người sửa code sau

1. Thêm chỉ số mới ⇒ thêm một mục vào tài liệu này TRƯỚC.
2. Không viết lại điều kiện `stage` ở trang mới — dùng `ORDER_OUTCOME` và các vị ngữ trong
   `lib/queries/metrics.ts`.
3. Không tự chia tỷ lệ — gọi `successRate()`.
4. Đổi population của một chỉ số đang có ⇒ phải sửa mọi nơi dùng nó cùng lúc, và ghi lại số
   trước/sau trong commit message.
5. Mẫu số 0 ⇒ trả `null`, đừng trả 0.
