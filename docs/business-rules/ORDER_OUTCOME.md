# KẾT QUẢ ĐƠN HÀNG — đặc tả bắt buộc

> **Đây là nguồn chân lý duy nhất.** Mọi thay đổi về "đơn giao thành công / đơn hoàn" phải sửa
> tài liệu này TRƯỚC, và chỉ khi chủ sở hữu kho mã yêu cầu. Không agent nào được tự diễn giải lại.
>
> Cài đặt: `lib/queries/return-rate.ts` → `ORDER_OUTCOME` (và `ORDER_OUTCOME_VERIFIED`).
> Kiểm thử khoá: `tests/contract-order-outcome.test.ts`.

## 1. Ba chiều tách bạch

| Chiều | Câu hỏi | Nguồn sự thật | KHÔNG được suy từ |
|---|---|---|---|
| **Logistics** | Hàng đang ở đâu, đã tới tay khách chưa? | Sự kiện Viettel Post (`shipment_events`, nguồn `VTP_*`) | tiền, COD, `cod_status`, trạng thái Pancake |
| **Payment / COD** | Tiền đã thu bao nhiêu, đã về tài khoản chưa? | Bảng kê COD, sao kê ngân hàng | trạng thái giao hàng |
| **Inventory** | Hàng có nằm trong kho bán được không? | Kho xác nhận nhận hàng hoàn (`return_received_at`) | trạng thái `RETURNED` của ĐVVC |

**Ba chiều không được suy ra lẫn nhau.** Đây là quy tắc gốc; mọi điều bên dưới chỉ là hệ quả.

## 2. Thuật ngữ

- **Logistics state** — trạng thái vận đơn đã chuẩn hoá: `PENDING`, `PICKED_UP`, `IN_TRANSIT`,
  `OUT_FOR_DELIVERY`, `DELIVERY_FAILED`, `RETURNING`, `RETURNED`, `DELIVERED`, `CANCELLED`, `UNKNOWN`.
- **Outbound leg / Return leg** — chiều đi tới khách / chiều mang hàng về shop. Viettel Post gửi cờ
  `IS_RETURNING`; ERP lưu ở `shipment_events.leg_type` = `OUTBOUND` | `RETURN`.
- **Verified money** — tiền CÓ CHỨNG TỪ: số thực thu trên bảng kê COD, hoặc tiền đã về ngân hàng.
- **Order outcome** — kết luận cuối dùng cho MỌI báo cáo: `NOT_SHIPPED`, `IN_TRANSIT`, `DELIVERED`,
  `RETURNED`, `RETURNED_BY_RULE`, `CANCELLED`.

## 3. Thứ tự nguồn tin (cao xuống thấp)

1. **Mã trạng thái cuối của Viettel Post** kèm cờ chiều — xem bảng ở mục 5.
2. **Trạng thái vận đơn dựng từ hành trình** (`lib/integrations/viettelpost/state.ts`): sự kiện mới
   nhất theo **mốc thời gian của ĐVVC**, chỉ tính nguồn `VTP_WEBHOOK / VTP_IMPORT / VTP_POLL / MANUAL`.
3. **Quy tắc tiền** — CHỈ khi vận đơn không có bất kỳ chứng từ nào từ Viettel Post.

Bản sao hành trình từ Pancake **không** được quyền kết luận: mốc thời gian của nó là giờ Pancake
ghi nhận, không phải giờ sự kiện của ĐVVC.

## 4. Mã trạng thái cuối theo tài liệu webhook chính thức

Chỉ sáu mã là trạng thái cuối: `101 · 107 · 201 · 501 · 503 · 504`.

| Mã + cờ | Nghĩa thật | Kết quả đơn |
|---|---|---|
| `501` + `IS_RETURNING = false` | phát tới tay khách | **DELIVERED** |
| `501` + `IS_RETURNING = true` | phát thành công **chiều hoàn về shop** | **RETURNED** |
| `504` | chuyển trả người gửi | RETURNED |
| `503` | **tiêu huỷ** theo yêu cầu khách | RETURNED (hàng KHÔNG về kho) |
| `101 / 107 / 201` | huỷ | CANCELLED |

## 5. Hàng đã quay về dù ĐVVC ghi "phát thành công"

Xét **TRƯỚC** mã `501`. Hai bằng chứng, đều từ chính Viettel Post:

- **Có vận đơn chiều hoàn** — VTP tạo vận đơn riêng (mã gốc + `1P1`, hoặc `CHPKE…`) trỏ về mã gốc
  qua `order_reference`.
- **Doanh thu bị sửa sau khi giao** — bước "Nhập doanh thu" xảy ra từ mốc phát thành công trở đi.

Đối chứng thật: `PKE1508909058` mang mã 501, COD khai báo 849.000, nhưng thu hộ thật 30.000 và có
vận đơn `PKE15089090581P1` mang hàng về → **đơn hoàn**. `PKE1508909064` cũng 501, không vận đơn
chiều hoàn, không sửa doanh thu → **giao thành công**.

## 6. Bảng chân lý

| Logistics | Payment | Kết quả |
|---|---|---|
| `IN_TRANSIT` / `PICKED_UP` / `OUT_FOR_DELIVERY` / `DELIVERY_FAILED` | bất kỳ, kể cả đã thu > 100K | `IN_TRANSIT` |
| `RETURNING` / `RETURNED` | bất kỳ, kể cả `PAID_TO_BANK` | `RETURNED` |
| `CANCELLED` | bất kỳ | `CANCELLED` |
| `DELIVERED` + có vận đơn chiều hoàn **hoặc** sửa doanh thu sau giao | bất kỳ | `RETURNED` |
| `DELIVERED` | verified < 50.000 | `RETURNED` |
| `DELIVERED` | verified 50.000 – 100.000 (bao gồm hai đầu) | `RETURNED_BY_RULE` |
| `DELIVERED` | verified > 100.000 | `DELIVERED` |
| `DELIVERED` | chưa đủ chứng từ / UNKNOWN / PARTIAL / DISPUTED | `DELIVERED` ở `ORDER_OUTCOME`, **`UNVERIFIED`** ở `ORDER_OUTCOME_VERIFIED` |
| chỉ Pancake báo PAID / DELIVERED, không có chứng từ ĐVVC | bất kỳ | **không được kết luận `DELIVERED`** |

Ngưỡng đặt tập trung ở `lib/constants/returns.ts` (`maxCodForReturn` 50.000, `maxCodForFakeDelivery`
100.000). Không hard-code số ở nơi khác.

## 7. UNKNOWN không phải 0

**Ngưỡng tiền chỉ được áp khi BIẾT CHẮC số tiền, tức có số DƯƠNG.** Việc vận đơn xuất hiện trên
một bảng kê nào đó KHÔNG chứng minh "thu 0đ": bảng kê gửi qua email tách phần COD và phần cước,
một vận đơn nằm ở phần cước cũng có mã bảng kê mà không hề nói gì về COD. `cod_collected = 0` là
*chưa biết*, không phải *thu được 0đ* — không được dùng để kết luận đơn hoàn.



`NULL` nghĩa là **chưa biết**, không phải "bằng 0". Chưa có số thực thu thì kết luận là *chưa xác
minh*, không phải *thu được 0đ*. `ORDER_OUTCOME_VERIFIED` giữ riêng giá trị `UNVERIFIED` cho việc này.

## 8. Không phải verified money

COD khai báo trên đơn · `partner.cod` · `money_to_collect` · `MONEY_COLLECTION` trong webhook VTP ·
`cod_collected` kiểu cũ chưa có chứng từ · `cod_status` đơn thuần. Những trường này chỉ nói shop
**muốn** thu bao nhiêu, không nói đã thu được bao nhiêu.

## 9. Tồn kho

`RETURNED` **không** tự cộng lại tồn. Chỉ khi kho xác nhận thực nhận (`return_received_at`) hàng mới
vào tồn bán được. `RETURNING` là hàng đang trên đường về — tuyệt đối không xác nhận nhận hàng.

## 10. Cấm

- Suy `DELIVERED` từ tiền, COD, `cod_status`, settlement, hay trạng thái Pancake.
- Tính lại kết quả đơn ở dashboard / report / module khác thay vì dùng `ORDER_OUTCOME`.
- Để refund hay đối soát thanh toán ghi đè sự kiện logistics.
- Coi `501` của chiều hoàn là giao thành công.
- Sửa giá trị kỳ vọng của contract test để CI xanh.

Trạng thái vận đơn thô vẫn được dùng cho **màn hình theo dõi hành trình** và **chỉ số thời gian
giao vận**; nhưng KPI kết quả đơn thì bắt buộc dùng `ORDER_OUTCOME`.
