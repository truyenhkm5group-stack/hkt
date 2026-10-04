# KẾT QUẢ ĐƠN HÀNG — đặc tả bắt buộc

> **Đây là nguồn chân lý duy nhất.** Mọi thay đổi về "đơn giao thành công / đơn hoàn" phải sửa
> tài liệu này TRƯỚC, và chỉ khi chủ sở hữu kho mã yêu cầu. Không agent nào được tự diễn giải lại.
>
> Cài đặt: `lib/queries/return-rate.ts` → `ORDER_OUTCOME` (và `ORDER_OUTCOME_VERIFIED`).
> Kiểm thử khoá: `tests/contract-order-outcome.test.ts`.

## 1. Ba chiều tách bạch

| Chiều | Câu hỏi | Nguồn sự thật | KHÔNG được suy từ |
|---|---|---|---|
| **Logistics** | Hàng đang ở đâu, đã tới tay khách chưa? | Sự kiện ĐVVC (`shipment_events`): Viettel Post (nguồn `VTP_*`); GHN / GHTK (nguồn `GHN_WEBHOOK` / `GHTK_WEBHOOK`, mục 4.1) | tiền, COD, `cod_status`, trạng thái Pancake |
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

1. **Mã trạng thái cuối của ĐVVC** — Viettel Post kèm cờ chiều (mục 4, 5); GHN / GHTK theo bảng mục 4.1.
2. **Trạng thái vận đơn dựng từ hành trình** (`lib/integrations/viettelpost/state.ts`): sự kiện mới
   nhất theo **mốc thời gian của ĐVVC**, chỉ tính nguồn `VTP_WEBHOOK / VTP_IMPORT / VTP_POLL / MANUAL`
   và `GHN_WEBHOOK / GHTK_WEBHOOK`.
3. **Quy tắc tiền** — CHỈ khi vận đơn không có bất kỳ chứng từ nào từ ĐVVC.

Bản sao hành trình từ Pancake **không** được quyền kết luận: mốc thời gian của nó là giờ Pancake
ghi nhận, không phải giờ sự kiện của ĐVVC.

## 4. Mã trạng thái cuối theo tài liệu webhook chính thức

Viettel Post: chỉ sáu mã là trạng thái cuối: `101 · 107 · 201 · 501 · 503 · 504`. Hãng khác: mục 4.1.

| Mã + cờ | Nghĩa thật | Kết quả đơn |
|---|---|---|
| `501` + `IS_RETURNING = false` | phát tới tay khách | **DELIVERED** |
| `501` + `IS_RETURNING = true` | phát thành công **chiều hoàn về shop** | **RETURNED** |
| `504` | chuyển trả người gửi | RETURNED |
| `503` | **tiêu huỷ** theo yêu cầu khách | RETURNED (hàng KHÔNG về kho) |
| `101 / 107 / 201` | huỷ | CANCELLED |

### 4.1. Hãng khác Viettel Post — GHN, GHTK (chủ shop chốt 04/10/2026)

> **Quyết định của chủ shop, 04/10/2026** (hỏi trực tiếp khi nối GHN / GHTK cho «POS tự chủ»): «Có, như Viettel Post» —
> trạng thái cuối của GHN / GHTK được tính là chứng từ để kết luận kết quả đơn (giao thành công / hoàn / huỷ), như mã cuối
> của Viettel Post. Ngưỡng tiền 50K / 100K, «tiền không suy ra giao hàng» và «hàng hoàn chờ kho xác nhận» giữ nguyên.

Phạm vi: vận đơn ERP tạo bằng tài khoản GHN / GHTK của chính tổ chức (`docs/verticals/pos-tu-chu.md`), sự kiện đến THẲNG
từ webhook của hãng (nguồn `GHN_WEBHOOK` / `GHTK_WEBHOOK`). Mã của mỗi hãng chỉ đọc trên sự kiện của CHÍNH hãng đó, và
KHÔNG BAO GIỜ dịch bằng bộ dịch Viettel Post. Bảng duy nhất trong mã: `lib/constants/carrier-status.ts`.

| Hãng | Mã cuối | Nghĩa (tài liệu chính thức của hãng) | Kết quả đơn |
|---|---|---|---|
| GHN | `delivered` | giao hàng thành công | **DELIVERED** |
| GHN | `returned` | đã trả hàng về người gửi | RETURNED |
| GHN | `lost` · `damage` · `scrap` | mất · hư hỏng · tiêu huỷ | RETURNED (hàng KHÔNG về kho — như `503`) |
| GHN | `cancel` | huỷ | CANCELLED |
| GHN | `exception` | đơn ngoại lệ, cần xử lý tay | **không kết luận** — sự kiện được lưu, không dựng chặng |
| GHTK | `5` · `6` | đã giao (chưa / đã đối soát) | **DELIVERED** |
| GHTK | `21` · `11` | đã trả hàng · đã đối soát công nợ trả hàng | RETURNED |
| GHTK | `13` | bồi hoàn (hàng mất) | RETURNED (hàng KHÔNG về kho — như `503`) |
| GHTK | `-1` | huỷ | CANCELLED |

Mã không có trong bảng ⇒ chặng `UNKNOWN`: lưu nguyên văn, không kết luận. Mã chưa cuối dựng chặng hành trình theo cùng
bảng (chờ lấy / đã lấy / đang giao / giao thất bại / đang hoàn). «Lấy hàng thất bại / hoãn lấy» là `PENDING` — KHÔNG phải
mốc bàn giao (AGENTS mục 41). Tiền thu hộ của GHN / GHTK đi theo chứng từ tiền như mọi hãng — trạng thái «đã đối soát»
(`6` của GHTK) KHÔNG phải số thực thu.

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
| **đơn tạo tay (`erp-`), không vận đơn, có phiếu giao ký nhận còn hiệu lực** (mục 11) | bất kỳ — phiếu giao KHÔNG phải chứng từ tiền | **`DELIVERED`**; tiền: `UNVERIFIED` cho tới khi CHỨNG TỪ THANH TOÁN (`order_payments`) thu đủ ⇒ `DELIVERED` ở `ORDER_OUTCOME_VERIFIED` |
| đơn tạo tay, có chứng từ thu đủ nhưng **chưa có phiếu giao** | đã thu đủ | như cũ: `NOT_SHIPPED` — tiền KHÔNG bao giờ suy ra giao hàng |
| đơn tạo tay, chưa có phiếu giao | bất kỳ | như cũ: `NOT_SHIPPED` (huỷ ⇒ `CANCELLED`) — không bao giờ `DELIVERED` |
| đơn tạo tay, **giao không thành công** (người bấm, có lý do — mục 11.2) | bất kỳ | **`RETURNED`** (stage `RETURNED`, không vận đơn) — hàng quay lại tồn ngay |

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
- Suy "đã giao" từ chứng từ thanh toán của đơn tay, hoặc cộng chứng từ đã HUỶ vào bất kỳ con số tiền nào (mục 11).
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
| **Payment / doanh thu** | **Chứng từ thanh toán** (`order_payments`, 0181) — KHÔNG phải phiếu giao | Phiếu giao **không** chứng minh đã thu tiền. Chưa có chứng từ ⇒ **chưa xác minh** (`UNVERIFIED` ở `ORDER_OUTCOME_VERIFIED`), không phải 0 và không phải "đã thu". Chứng từ còn hiệu lực thu đủ số khách phải trả ⇒ tiền **đã xác minh** (mục 11.1) |
| **Inventory** | Phiếu giao có ký nhận | Giao thành công ⇒ hàng ĐÃ rời kho: vào "đã xuất" (tồn thực tế giảm), thôi giữ ở khả dụng. Không lập phiếu XUẤT TAY cho đơn tay nữa — làm cả hai là trừ hai lần |

Hệ quả bắt buộc:

- `ORDER_OUTCOME` có ĐÚNG MỘT nhánh cho việc này, đứng đầu bảng và chỉ khớp đơn `erp-` không có vận
  đơn mang phiếu còn hiệu lực. Không nhánh nào khác đổi.
- ~~Mọi con số tiền dựng trên `ORDER_OUTCOME = 'DELIVERED'` không được tăng vì một đơn tay đã giao mà chưa
  có chứng từ thanh toán.~~ **Thay bằng mục 11.3 (chủ shop HSLC 03/10/2026):** ở tổ chức KHÔNG đồng bộ đơn,
  doanh thu + giá vốn DANH NGHĨA của đơn tay tính khi đã giao; tiền THẬT vẫn chỉ theo chứng từ thanh toán.
- Phép so marketer (AGENTS 3.9) vẫn loại đơn tay ở tổ chức đồng bộ Pancake (mục 11.3).
- Phiếu ghi nhầm được **huỷ** (bắt buộc lý do, có nhật ký), không xoá cứng; huỷ phiếu ⇒ đơn quay về
  như chưa giao (`CONFIRMED`, hàng lại nằm trong khả dụng-giữ, tồn thực tế cộng lại).
- Một đơn tối đa MỘT phiếu còn hiệu lực; chỉ đơn `CONFIRMED` mới xác nhận giao được (`NEW` / `WAITING`
  / `CANCELLED` bị từ chối); đơn đã giao không sửa / huỷ được cho tới khi huỷ phiếu.

**Đơn tay đã lỡ lập phiếu XUẤT TAY (`ISSUE`) trước bản này:** tồn thực tế của nó sẽ bị trừ hai lần
khi xác nhận giao. ERP KHÔNG tự sửa dữ liệu kho. Trang đơn nêu phiếu ISSUE có tham chiếu tới đơn; người
kho lập MỘT phiếu **Điều chỉnh tăng** (`ADJUSTMENT`, số dương) đúng bằng số lượng của phiếu ISSUE đó,
tham chiếu ghi `hoàn phiếu xuất <mã phiếu> — đơn <mã đơn> đã xác nhận giao`, rồi mới (hoặc ngay sau khi)
xác nhận giao. Phiếu ISSUE cũ giữ nguyên làm vết.

### 11.1. Chứng từ thanh toán của đơn tay (chủ nền tảng yêu cầu 30/09/2026)

> «Actual Revenue phải dựa trên payment evidence phù hợp, không tự coi Delivered = Paid. Không hard-code cho khách nào.»

**Nguồn sự thật của chiều tiền đơn tay** là bảng `order_payments` trong CSDL của tổ chức (SILO — "tổ chức" của một chứng
từ là CSDL chứa nó). Mỗi dòng là MỘT chứng từ: loại (`RECEIPT` thu của khách · `REFUND` trả lại khách), phương thức
(`CASH` · `BANK_TRANSFER` · `COD` · `OTHER`), số tiền nguyên dương, **mốc tiền đổi tay** (`paid_at`), số tham chiếu, ghi chú,
người ghi (khoá `users.id`), trạng thái (`CONFIRMED` · `VOIDED`). Chỉ đơn `erp-` nhận chứng từ (CHECK ở CSDL); đơn Pancake
/ đơn có vận đơn đi theo bảng kê ĐVVC như mục 1–10.

- **TIỀN ĐÃ XÁC MINH của đơn tay = Σ phiếu THU − Σ phiếu HOÀN, chỉ chứng từ `CONFIRMED`.** Phiếu đã huỷ không vào phép
  tính nào; phiếu hoàn LUÔN trừ.
- **Trạng thái thanh toán của đơn** tính lúc đọc, không lưu cột (R = Σ thu, F = Σ hoàn, net = R − F, D = số khách phải trả
  = tiền hàng sau chiết khấu + phí ship): `UNPAID` (R = F = 0 — chưa có chứng từ) · `REFUNDED` (F > 0 và net ≤ 0) · `PAID`
  (net ≥ max(D, 1); net > D vẫn là `PAID`, phần dư hiện riêng là **thu thừa** để người xử lý) · `PARTIALLY_PAID` (còn lại).
  Đơn không tạo tay KHÔNG có trạng thái này — hiển thị `N/A`, không bao giờ `UNPAID`.
- **Delivered KHÔNG BAO GIỜ = Paid, Paid KHÔNG BAO GIỜ = Delivered.** `ORDER_OUTCOME` (logistics) không đọc chứng từ tiền.
  `ORDER_OUTCOME_VERIFIED` của đơn tay có phiếu giao: `PAID` ⇒ `DELIVERED`; mọi trạng thái khác ⇒ `UNVERIFIED`. Không áp
  ngưỡng 50K / 100K cho chứng từ đơn tay — đó là luật đọc bảng kê ĐVVC (bưu tá nhập lại doanh thu), không phải của chứng
  từ shop tự thu.
- **COD của đơn tay** = tiền shipper CỦA SHOP thu hộ khi giao — chỉ tính khi có phiếu THU phương thức `COD`. Đơn đã có vận
  đơn không nhận phiếu `COD` tay (COD của ĐVVC đi theo bảng kê; ghi thêm là đếm hai lần).
- **Luật ghi**: thu trước khi giao hợp lệ (không phụ thuộc phiếu giao); đơn đã HUỶ chỉ nhận phiếu HOÀN; phiếu HOÀN không vượt
  số đang thu ròng; HUỶ phiếu THU không được làm số hoàn vượt số thu; huỷ bắt buộc lý do, không xoá cứng; có nhật ký.
- **Doanh thu thực thu** (mốc khai rõ theo AGENTS 58): đơn tay được cộng theo Σ chứng từ còn hiệu lực có **`paid_at`
  trong kỳ** — mốc của chứng từ, không phải ngày lên đơn hay ngày giao. Hôm nay đúng MỘT chỗ đọc: dòng «Thực thu đơn tay»
  trong **Tiền thực nhận** của báo cáo Chân lý tài chính (`getFinancialTruth`). Các tổng tiền dựng trên
  `ORDER_OUTCOME = 'DELIVERED'` (doanh thu giao thành công, lợi nhuận, marketer, lương / hoa hồng…) là doanh thu
  DANH NGHĨA — từ 03/10/2026 có đơn tay ở tổ chức không đồng bộ đơn (mục 11.3); chúng không bao giờ thay cho thực thu.
- Tổ chức nhà (VNX) không đổi một con số: không đơn Pancake nào mang được chứng từ.

### 11.2. Giao KHÔNG thành công của đơn tay (chủ shop HSLC quyết 03/10/2026)

> Câu hỏi: «Đơn tay bị giao không thành công (khách không nhận / hoàn): hàng về kho thế nào?» — chủ shop chọn
> **«Tự cộng lại tồn ngay»** (không đợi kho xác nhận).

- Chỉ từ `CONFIRMED`, không vận đơn, cùng cổng với phiếu giao (`manualOrderGate` — tổ chức không đồng bộ đơn +
  `orders:write`), **bắt buộc lý do** (vào nhật ký `ORDER_MANUAL_DELIVERY_FAILED`). Đơn có phiếu giao còn hiệu lực phải huỷ
  phiếu trước.
- Đơn ⇒ stage `RETURNED` (mã Pancake 5 «Đã hoàn»). `ORDER_OUTCOME` dùng nhánh có sẵn `o.stage = 'RETURNED'` ⇒ **`RETURNED`**:
  tính là HOÀN trong tỷ lệ giao thành công; không doanh thu, không giá vốn, không phí giao.
- **Tồn kho — khác luật 4 / mục 9 của đơn qua ĐVVC, theo quyết định trên:** đơn không còn «giữ hàng» và chưa từng «rời kho»
  (không phiếu giao) ⇒ khả dụng cộng lại NGAY, không phiếu kho nào được tạo. Hàng hỏng / thất lạc trên đường về thì kho lập
  phiếu Điều chỉnh giảm như mọi chênh lệch kiểm kê.
- Ghi nhầm ⇒ **hoàn tác** (bắt buộc lý do, `ORDER_MANUAL_DELIVERY_FAILED_UNDO`) ⇒ `CONFIRMED`, giữ hàng lại. Đơn `RETURNED`
  không sửa / huỷ / xác nhận giao được cho tới khi hoàn tác. Bấm hai lần không ghi thêm.

### 11.3. Doanh thu đơn tay tính KHI ĐÃ GIAO + phí giao đồng giá (chủ shop HSLC quyết 03/10/2026)

> «Báo cáo lợi nhuận: doanh thu + giá vốn đơn tay tính **khi đã giao** (danh nghĩa); lợi nhuận tiền thật chỉ phần đã có
> phiếu thu.» · «Phí vận chuyển đồng giá **40K / 1 đơn giao thành công**.»

- Phạm vi: **tổ chức KHÔNG đồng bộ đơn**, nhận ra bằng chính CSDL của tổ chức — không có đơn nào ngoài `erp-`
  (`IN_SALES_REPORTS` trong `lib/queries/manual-order-sql.ts`). Tổ chức đồng bộ Pancake (nhà) giữ nguyên: đơn `erp-` lọt vào
  vẫn đứng ngoài, luật 3.9 không đổi một đơn (`tests/pilot-orders.test.ts`).
- `REVENUE_RECOGNIZED_ON_DELIVERY = IN_SALES_REPORTS`: mọi tổng tiền dựng trên `DELIVERED` (báo cáo lợi nhuận, Tổng quan,
  marketer, lương / hoa hồng, sản phẩm, CRM…) cộng đơn tay đã giao — là doanh thu **danh nghĩa**. Báo cáo danh nghĩa (đơn đã
  xác nhận × tỷ lệ giao) cũng có đơn tay. Chiều **tiền thật** không đổi: `ORDER_OUTCOME_VERIFIED`, «Thực thu đơn tay» theo
  `paid_at`, trạng thái thanh toán — chỉ chứng từ `order_payments`. Phiếu giao vẫn KHÔNG BAO GIỜ là chứng từ tiền.
- **Phí giao đồng giá** (`settings['orders.manualDeliveryFee']`, số nguyên ₫, khai ở trang Đơn hàng — quyền cấu hình): khi
  xác nhận đã giao, số đó ghi vào `orders.partner_fee` của đơn (đường cước mà Profit Engine đã đọc cho đơn đã kết thúc); huỷ
  phiếu giao ⇒ 0; giao không thành công ⇒ 0. Chưa khai ⇒ không ghi gì (không đoán). Đổi mức phí không sửa đơn đã giao.
- Trang tỷ lệ giao thành công: tổ chức không bật module vận chuyển ⇒ mốc mặc định là **ngày lên đơn** (mốc «ngày gửi ĐVVC»
  không có vận đơn nào để đọc).

### 11.4. Đơn đủ thông tin = đã xác nhận (chủ shop HSLC quyết 04/10/2026)

> «Với HSLC thì đơn có đầy đủ thông tin đơn hàng: SĐT, địa chỉ, SKU được tính là đơn hàng luôn (không cần xác nhận), chỉ
> trừ đi những đơn có trạng thái huỷ thôi. Và với HSLC thì gần như không có hàng hoàn.»

- Công tắc THEO TỔ CHỨC `settings['orders.autoConfirmComplete']` (mặc định TẮT, nút trên trang Đơn hàng). Bật ⇒ đơn tay
  `NEW` có SĐT 8–15 số, địa chỉ ≥ 5 ký tự và ≥ 1 dòng hàng được ghi thẳng `CONFIRMED` ở lõi ghi đơn (chatbot, ghi đơn từ
  hội thoại, form tạo / sửa) — giữ hàng, phát `order.confirmed`, vào mọi báo cáo đếm đơn đã xác nhận. Lúc bật, đơn `NEW` đủ
  thông tin đang có được xác nhận qua đúng đường sửa đơn (có nhật ký từng đơn) và số đơn chuyển được báo lại người bấm.
- KHÔNG đổi `ORDER_OUTCOME` — đơn vẫn chỉ `DELIVERED` bằng phiếu giao (mục 11). «Gần như không hoàn» đi qua Giả định của
  báo cáo (`profit.assumptions.defaultReturnRate`), một con số dùng chung cho báo cáo lợi nhuận danh nghĩa và `/ads`.
- `WAITING` (chờ hàng) là lựa chọn của người ⇒ không tự đổi. Vượt hạn mức nợ của khách ⇒ giữ `NEW`.

