# Bảng giá sỉ · hạn mức nợ · công nợ khách hàng — Seafood OS / Đại lý sỉ · bước S1

> Migration `0188_price_lists_receivables`. Mã: `lib/constants/price-lists.ts` (luật thuần) ·
> `lib/queries/receivables.ts` (đọc công nợ) · `lib/records/trade.ts` (đường ghi) · `lib/actions/trade.ts`.
> Kiểm thử: `tests/price-lists-receivables.test.ts`. Chỉ áp cho **đơn tạo tay**, tức tổ chức khách không đồng bộ đơn
> Pancake. Tổ chức nhà không đổi một hành vi nào.

## 1. Bảng giá

Bảng giá dùng cho từng nhóm khách (đại lý, khách sỉ, CTV…). Mỗi bảng gồm các **bậc**:
`(mẫu mã, mua từ số lượng, đơn giá)`.

**Luật chọn giá.** Đây là một hàm thuần `quoteUnitPrice`, dùng chung cho form đơn tay, máy chủ và chatbot. Thứ tự tìm:
1. Bảng gán cho khách (lưu ở `customer_trade_terms.price_list_id`). Trong bảng đó, bậc có «mua từ» **lớn nhất mà vẫn
   ≤ số lượng** sẽ thắng.
2. Nếu bước 1 không có bậc khớp: bảng **mặc định**. Tối đa một bảng mặc định đang bật, ràng buộc bằng chỉ mục duy nhất
   ở CSDL.
3. Nếu vẫn không có: giá lẻ của mẫu mã.
4. Giá lẻ trống thì kết quả là **chưa có giá**, không phải 0đ (luật 42).

**Form đơn tay.** Giá lấy từ bảng chỉ là **gợi ý**: điền sẵn khi chọn mẫu mã, kèm nút «Áp bảng giá …». Ô đơn giá vẫn do
người bán quyết.

**Ngừng dùng một bảng** thay cho xoá:
- dữ liệu vẫn giữ;
- khách đang gán bảng đó sẽ rơi về bảng mặc định;
- đơn cũ giữ nguyên giá đã lưu.

## 2. Điều khoản bán của khách

Lưu ở bảng riêng `customer_trade_terms`, vì `customers` là bảng đồng bộ từ Pancake ở tổ chức nhà. Gồm bảng giá, hạn mức
nợ và số ngày được nợ. Ô **trống nghĩa là CHƯA KHAI**, không phải 0: không chặn và không tính quá hạn. Hạn mức `0` là
khai thật, nghĩa là không cho nợ đồng nào.

## 3. Công nợ — đọc từ chứng từ, không có bảng nợ

Công nợ của một đơn tay đang chốt hoặc đã giao:

```
số phải trả (tiền hàng sau chiết khấu + ship) − Σ phiếu thu còn hiệu lực + Σ phiếu hoàn
```

Đây đúng là `outstanding` của `manualPaymentStatus`, tính trên `order_payments` theo ORDER_OUTCOME.md mục 11.1.

| Phần | Gồm | Ý nghĩa |
|---|---|---|
| **Phải thu** | đơn có phiếu giao ký nhận còn hiệu lực | khách đã cầm hàng mà chưa trả đủ |
| **Đã chốt chưa giao** | đơn `CONFIRMED` chưa có phiếu giao | khoản sắp thành nợ |

- **Quá hạn** chỉ tính cho phần phải thu. Hạn trả = ngày giao (giờ VN) + số ngày được nợ.
- Khách **chưa khai số ngày được nợ** thì tuổi nợ là CHƯA BIẾT (`termsUnknown`). Hệ thống không đoán một con số mặc định.
- Đơn Mới, đơn Chờ hàng và đơn Huỷ không mang nợ.

## 4. Hạn mức chặn lượt CHỐT đơn

Mỗi khi một đơn tay được lưu ở trạng thái `CONFIRMED` (tạo mới, hoặc sửa từ trạng thái khác), hệ thống tính:

```
dư nợ của mọi đơn khác + phần CHƯA THU của chính đơn này
```

Nếu kết quả vượt hạn mức thì từ chối ở ô «Khách hàng» kèm số vượt. Chatbot bán hàng đi cùng đường này: bot chốt đơn
vượt hạn mức sẽ nhận lỗi và chuyển người. Đơn Mới không bị chấm. Phần đã thu của chính đơn được trừ ra, để khi sửa lại
một đơn đã thu một phần thì số đó không bị đếm hai lần.

## 5. Thu nợ gộp

Khách trả một khoản cho nhiều đơn:
- Hệ thống chia khoản đó vào các đơn còn nợ. **Đơn đã giao trả trước**, rồi theo mốc lên đơn cũ đến mới.
- Mỗi đơn được ghi **một phiếu THU** ở `order_payments`, không có bảng tiền thứ hai. Nhờ vậy trạng thái thanh toán từng
  đơn và dòng «Thực thu đơn tay» tự đúng.
- Quy trình: chia lại sau khi khoá dòng các đơn, rồi kiểm lại số còn nợ trong cùng giao dịch.
- Số tiền lớn hơn tổng nợ sẽ bị từ chối. Phần dư là thu thừa, người dùng ghi tay ở một đơn cụ thể.
- Không nhận COD: COD đi theo từng đơn.

## 6. Màn hình

- `/products/price-lists`: danh sách bảng giá, tạo và sửa bảng. Quyền `products:write`.
- `/customers/<id>` → «Điều khoản bán & công nợ»:
  - sửa điều khoản bán cần quyền `customers:write`;
  - thu nợ cần quyền `orders:write`.
- `/customers/receivables`: bảng công nợ toàn tổ chức, có nhóm tuổi nợ.
- Hai mục menu mới mang cờ `tenantOnly`, nên chỉ hiện ở tổ chức khách.

## 7. Bước sau

- Chatbot báo giá sỉ theo bảng giá. Mặc định TẮT, vì chủ shop chưa quyết cho bot tự báo giá sỉ (xem PR #450).
- Bán theo cân (kg) + cân lại khi đóng hàng.
- Nhắc mua lại theo chu kỳ.
