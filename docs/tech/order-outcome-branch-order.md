# Thứ tự nhánh THẬT của `ORDER_OUTCOME` — và câu chữ AGENTS 3.2 dễ đọc nhầm

> Ghi chú kỹ thuật, KHÔNG phải luật. Luật nằm ở `docs/business-rules/ORDER_OUTCOME.md` và mã nguồn
> `lib/queries/return-rate.ts` (`ORDER_OUTCOME`, khoảng dòng 262–300). Ghi chú này không đổi luật nào;
> nó chỉ nói mã nguồn đang xét các nhánh theo thứ tự nào, để không ai báo «GTC sai» từ một cách đọc
> câu chữ.

## Vì sao cần

AGENTS.md mục 3.2 viết: *«(a) CHỨNG TỪ ĐVVC trước … (b) Chưa có mã cuối mới xét doanh thu COD thực»*.
Đọc lướt, câu ấy giống như **mã 501 chiều đi thắng tiền**: có 501 + `IS_RETURNING = false` ⇒ giao
thành công, bất kể thực thu.

Mã nguồn **không** làm như vậy cho ca thực thu dương nhỏ. Ngày 25/10/2026 đã có một lần báo nhầm
«409/1.112 đơn 501 chiều đi thực thu < 50K đang tính giao thành công ⇒ GTC bị thổi phồng» — sai:
`outcome-explain` trên 8 mã mẫu ra `RETURNED` cả 8.

## Thứ tự nhánh trong `CASE` (đọc từ trên xuống, nhánh đầu tiên khớp thắng)

| # | Điều kiện (rút gọn) | Kết quả |
|---|---|---|
| 1 | Đơn tay ERP, không vận đơn, có phiếu giao ký nhận | `DELIVERED` |
| 2 | Có dòng vận đơn nhưng không có dấu vết ĐVVC nào, đơn còn sống | `UNKNOWN` |
| 3 | `VTP_RETURNED`: 504 · 503 · **501 + RETURN** · mã hoàn của hãng khác | `RETURNED` |
| 4 | Đơn tay ERP còn sống mà lần gửi bị hãng huỷ | `NOT_SHIPPED` |
| 5 | `VTP_CANCELLED`: 101 · 107 · 201 · mã huỷ hãng khác | `CANCELLED` |
| 6 | `stage = DELIVERED` **và** `GOODS_CAME_BACK` (có vận đơn chiều hoàn `order_reference` = mã gốc, hoặc doanh thu bị sửa sau mốc giao) | `RETURNED` |
| 7 | `stage = DELIVERED` **và** `0 < thực thu + trả trước < RETURN_COD` (50.000 ₫) | `RETURNED` |
| 8 | `stage = DELIVERED` **và** `0 < thực thu + trả trước ≤ MAX_COD` (100.000 ₫) | `RETURNED_BY_RULE` |
| 9 | `VTP_DELIVERED`: **501 + OUTBOUND** · mã giao của hãng khác | `DELIVERED` |
| 10+ | Các nhánh chặng / tiền tạm tính / Pancake | … |

Ngưỡng đọc từ `RETURN_RULE` (`lib/constants/returns.ts`) — không chép số vào đây ngoài để minh hoạ.

## Hệ quả cần nhớ

- **501 chiều đi KHÔNG thắng tiền dương nhỏ.** Nhánh 7–8 đứng TRƯỚC nhánh 9. Vận đơn có 501 + OUTBOUND
  mà thực thu 30.000 ₫ ra `RETURNED`, không phải `DELIVERED`.
- **Vận đơn chiều hoàn thắng 501 chiều đi** (nhánh 6 trước nhánh 9) — đúng đối chứng `PKE1508909058`.
- **Thực thu = 0 / chưa biết không kích hoạt nhánh 7–8** (vế `> 0`): CHƯA BIẾT không phải 0 ₫ (AGENTS
  mục 0.3). Ca ấy rơi xuống nhánh 9 nếu có 501 chiều đi.
- «Chứng từ ĐVVC trước» trong 3.2 đúng với **mã hoàn / huỷ** (nhánh 3, 5), không đúng với 501 chiều đi
  khi đã có thực thu dương dưới ngưỡng.

## Chỗ sai thật (25/10/2026) nằm ở chiều LOGISTICS, không ở kết quả đơn

Viettel Post gửi 501 «Phát thành công» trên **mã gốc** với `IS_RETURNING = false` khi kiện HOÀN về tới
shop. Kết quả đơn vẫn đúng (nhánh 6/7), nhưng chặng `DELIVERED` hiện «Giao thành công» trên nhật ký
vận đơn, trang đơn hàng, danh sách vận đơn. Nhãn «Hoàn về shop» đọc ra lúc xem bằng
`lib/queries/shipment-return-arrival.ts` (hằng số + căn cứ số đo ở `lib/constants/return-arrival.ts`);
dòng chứng từ của VTP giữ nguyên (AGENTS 47).

## Trước khi nói «một nhóm đơn bị tính sai kết quả»

1. Chạy ops `outcome-explain` trên vài mã mẫu, hoặc tính lại bằng chính `ORDER_OUTCOME`.
2. Tách rõ **sai kết quả đơn** (tiền, GTC, lương, tồn) với **sai nhãn logistics** (chặng hiển thị).
