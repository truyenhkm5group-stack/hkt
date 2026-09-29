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

Đơn KHÔNG qua ĐVVC (đơn tạo tay ở tổ chức không có connector vận chuyển) lấy chiều logistics từ
**phiếu giao có ký nhận** thay cho sự kiện Viettel Post — xem mục 11. Hai chiều còn lại không đổi.

## 2. Thuật ngữ

- **Logistics state** — trạng thái vận đơn đã chuẩn hoá: `PENDING`, `PICKED_UP`, `IN_TRANSIT`,
  `OUT_FOR_DELIVERY`, `DELIVERY_FAILED`, `RETURNING`, `RETURNED`, `DELIVERED`, `CANCELLED`, `UNKNOWN`.
- **Outbound leg / Return leg** — chiều đi tới khách / chiều mang hàng về shop. Viettel Post gửi cờ
  `IS_RETURNING`; ERP lưu ở `shipment_events.leg_type` = `OUTBOUND` | `RETURN`.
- **Verified money** — tiền CÓ CHỨNG TỪ: số thực thu trên bảng kê COD, hoặc tiền đã về ngân hàng.
- **Order outcome** — kết luận cuối dùng cho MỌI báo cáo: `NOT_SHIPPED`, `UNKNOWN`,
  `AWAITING_PICKUP`, `IN_TRANSIT`, `DELIVERED`, `RETURNED`, `RETURNED_BY_RULE`, `CANCELLED`.
- **`UNKNOWN`** (chủ shop chốt 08/09/2026) — ERP KHÔNG có bất kỳ dấu vết nào của ĐVVC cho đơn này:
  không mã vận đơn, không mã tra cứu, không một sự kiện hành trình nào. Tách hẳn khỏi `IN_TRANSIT`
  vì "đang giao" là một khẳng định về vị trí gói hàng — phải có chứng từ mới nói được. Cũng khác
  `NOT_SHIPPED`, chỗ đó dành cho đơn chưa hề tạo vận đơn. `UNKNOWN` thuộc nhóm CHƯA KẾT THÚC nên
  không nằm trong tử số lẫn mẫu số của tỷ lệ giao thành công.
- **`AWAITING_PICKUP`** (chủ shop chốt 13/09/2026) — ĐÃ tạo vận đơn và ĐVVC ĐÃ biết đến kiện, nhưng
  KHÔNG có một chứng từ nào nói họ đã cầm hàng. Gói hàng còn trong kho shop, hoặc đang chờ bưu tá
  tới lấy. Đây là bước thứ ba của cùng một nguyên tắc mà `UNKNOWN` dựng lên: **"đang giao" là khẳng
  định về VỊ TRÍ gói hàng — phải có chứng từ mới nói được.** Khác `NOT_SHIPPED` (chỗ đó là đơn chưa
  hề tạo vận đơn: không có gì để theo dõi, không có ai để giục) và khác `IN_TRANSIT` (đã có chứng từ
  bàn giao). Thuộc nhóm CHƯA KẾT THÚC, và **KHÔNG nằm trong tập "đã gửi"** — kiện chưa rời kho thì
  chưa được gửi.

  Chứng cứ bàn giao đọc bằng ĐÚNG vị từ của hợp đồng mốc bàn giao
  (`lib/constants/carrier-handoff.ts::CARRIER_HANDOFF_KNOWN_SQL`), không có bản thứ hai.

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
| có sự kiện ĐVVC nhưng **KHÔNG có chứng từ bàn giao** (chưa `picked_up_at`, chưa sự kiện chặng đã-cầm-hàng) | bất kỳ | **`AWAITING_PICKUP`** — không phải `IN_TRANSIT`, không phải `NOT_SHIPPED` |
| `IN_TRANSIT` / `PICKED_UP` / `OUT_FOR_DELIVERY` / `DELIVERY_FAILED` **và có chứng từ bàn giao** | bất kỳ, kể cả đã thu > 100K | `IN_TRANSIT` |
| `RETURNING` / `RETURNED` | bất kỳ, kể cả `PAID_TO_BANK` | `RETURNED` |
| `CANCELLED` | bất kỳ | `CANCELLED` |
| `DELIVERED` + có vận đơn chiều hoàn **hoặc** sửa doanh thu sau giao | bất kỳ | `RETURNED` |
| `DELIVERED` | verified < 50.000 | `RETURNED` |
| `DELIVERED` | verified 50.000 – 100.000 (bao gồm hai đầu) | `RETURNED_BY_RULE` |
| `DELIVERED` | verified > 100.000 | `DELIVERED` |
| `DELIVERED` | chưa đủ chứng từ / UNKNOWN / PARTIAL / DISPUTED | `DELIVERED` ở `ORDER_OUTCOME`, **`UNVERIFIED`** ở `ORDER_OUTCOME_VERIFIED` |
| chỉ Pancake báo PAID / DELIVERED, không có chứng từ ĐVVC | bất kỳ | **không được kết luận `DELIVERED`** |
| **không có mã vận đơn, không mã tra cứu, không sự kiện ĐVVC** | bất kỳ, kể cả đã thu > 100K | **`UNKNOWN`** — không phải `IN_TRANSIT`, không phải `DELIVERED` |
| **đơn tạo tay (`erp-`), không vận đơn, có phiếu giao ký nhận còn hiệu lực** (mục 11) | bất kỳ — phiếu giao KHÔNG phải chứng từ tiền | **`DELIVERED`**; tiền: `UNVERIFIED` cho tới khi có chứng từ thanh toán |
| đơn tạo tay, chưa có phiếu giao | bất kỳ | như cũ: `NOT_SHIPPED` (huỷ ⇒ `CANCELLED`) — không bao giờ `DELIVERED` |

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
- Suy "đã thu tiền" / doanh thu thực thu / `payment_status` từ phiếu giao có ký nhận của đơn tay (mục 11).
- Sửa giá trị kỳ vọng của contract test để CI xanh.

Trạng thái vận đơn thô vẫn được dùng cho **màn hình theo dõi hành trình** và **chỉ số thời gian
giao vận**; nhưng KPI kết quả đơn thì bắt buộc dùng `ORDER_OUTCOME`.

## 11. Đơn không qua ĐVVC — đơn tạo tay ở tổ chức không có connector vận chuyển

> **Quyết định G-ORDER — chủ nền tảng, 29/09/2026 (nguyên văn):** «G-ORDER: Có. Phiếu giao có ký nhận
> được coi là bằng chứng giao thành công. Fulfillment/delivery tách riêng payment: khi giao thành công
> thì trừ tồn và đánh Delivered; payment/revenue/payment_status vẫn theo chứng từ thanh toán, không tự
> coi là đã thu tiền.»

Phạm vi: CHỈ đơn tạo tay trên ERP (id tiền tố `erp-`, `lib/constants/manual-orders.ts`) và KHÔNG có
dòng vận đơn nào. Đơn tay chỉ tạo được ở tổ chức không đồng bộ đơn (không Pancake). Tổ chức nhà (VNX,
đơn Pancake + Viettel Post) **không đổi một hành vi nào**: vị ngữ mới không bao giờ khớp một đơn đồng
bộ, và mọi mục 1–10 giữ nguyên.

Ba chiều vẫn tách bạch (mục 1), chỉ khác NGUỒN của chiều logistics:

| Chiều | Đơn tay: nguồn sự thật | Kết luận |
|---|---|---|
| **Logistics** | **Phiếu giao có ký nhận** còn hiệu lực (`order_delivery_notes`, `voided_at IS NULL`): mốc người nhận ký, tên người ký, người ghi (khoá `users.id`) | Có phiếu ⇒ `DELIVERED` — ngang hàng mã cuối `501` chiều đi của ĐVVC. Chưa có phiếu ⇒ CHƯA giao (`NOT_SHIPPED` như trước; huỷ ⇒ `CANCELLED`) — không suy từ gì khác |
| **Payment / doanh thu** | Chứng từ thanh toán — KHÔNG phải phiếu giao | Phiếu giao **không** chứng minh đã thu tiền. Chưa có chứng từ ⇒ **chưa xác minh** (`UNVERIFIED` ở `ORDER_OUTCOME_VERIFIED`), không phải 0 và không phải "đã thu". Hôm nay ERP chưa có đường ghi chứng từ thanh toán cho đơn tay, nên mọi đơn tay đã giao đều là `UNVERIFIED` |
| **Inventory** | Phiếu giao có ký nhận | Giao thành công ⇒ hàng ĐÃ rời kho: vào "đã xuất" (tồn thực tế giảm), thôi giữ ở khả dụng. Không lập phiếu XUẤT TAY cho đơn tay nữa — làm cả hai là trừ hai lần |

Hệ quả bắt buộc:

- `ORDER_OUTCOME` có ĐÚNG MỘT nhánh cho việc này, đứng đầu bảng và chỉ khớp đơn `erp-` không có vận
  đơn mang phiếu còn hiệu lực. Không nhánh nào khác đổi.
- Mọi con số **tiền** dựng trên `ORDER_OUTCOME = 'DELIVERED'` (doanh thu giao thành công, lợi nhuận,
  marketer, lương / hoa hồng, landing, COD) **không** được tăng vì một đơn tay đã giao mà chưa có chứng
  từ thanh toán. Nơi nào cần hiện giá trị hàng đã giao của đơn tay thì gắn nhãn **danh nghĩa**.
- Phép so marketer (AGENTS 3.9) vẫn loại đơn tay.
- Phiếu ghi nhầm được **huỷ** (bắt buộc lý do, có nhật ký), không xoá cứng; huỷ phiếu ⇒ đơn quay về
  như chưa giao (`CONFIRMED`, hàng lại nằm trong khả dụng-giữ, tồn thực tế cộng lại).
- Một đơn tối đa MỘT phiếu còn hiệu lực; chỉ đơn `CONFIRMED` mới xác nhận giao được (`NEW` / `WAITING`
  / `CANCELLED` bị từ chối); đơn đã giao không sửa / huỷ được cho tới khi huỷ phiếu.

**Đơn tay đã lỡ lập phiếu XUẤT TAY (`ISSUE`) trước bản này:** tồn thực tế của nó sẽ bị trừ hai lần
khi xác nhận giao. ERP KHÔNG tự sửa dữ liệu kho. Trang đơn nêu phiếu ISSUE có tham chiếu tới đơn; người
kho lập MỘT phiếu **Điều chỉnh tăng** (`ADJUSTMENT`, số dương) đúng bằng số lượng của phiếu ISSUE đó,
tham chiếu ghi `hoàn phiếu xuất <mã phiếu> — đơn <mã đơn> đã xác nhận giao`, rồi mới (hoặc ngay sau khi)
xác nhận giao. Phiếu ISSUE cũ giữ nguyên làm vết.
