# Kiểm toán chuyển Order → 1:N ShipmentAttempt

Ngày 10/09/2026. Đây là task **tính đúng đắn nghiệp vụ**, tách hẳn khỏi lượt tăng tốc đã phát hành.

---

## 1. Ràng buộc đang chặn, và cái giá thật của nó

```sql
-- drizzle/0000_init.sql
CONSTRAINT "shipments_order_id_unique" UNIQUE("order_id")
```

Một đơn = tối đa **một** vận đơn. Cơ sở dữ liệu cưỡng chế, không phải quy ước.

Nên câu "production hiện có 0 đơn nhiều vận đơn" **không chứng minh nghiệp vụ là 1:1** — nó chỉ nói
rằng dữ liệu 1:N không thể tồn tại.

### Cái giá không nhìn thấy: gửi lại đơn là XOÁ lần gửi đầu

`lib/integrations/pancake/sync.ts` lấy vận đơn hiện có qua quan hệ `orders.shipment` (`one`), rồi:

```ts
if (existing) {
  await db.update(schema.shipments).set({ ...data }).where(eq(schema.shipments.id, existing.id));
}
```

Nghĩa là khi Pancake báo một **mã vận đơn MỚI** cho đơn đã có vận đơn, ERP **ghi đè lên dòng cũ**:
mã vận đơn, mã tra cứu, trạng thái, các mốc thời gian đều bị thay. Lần gửi đầu tiên **biến mất khỏi
sổ** — không có dòng nào, không có cảnh báo.

Đây mới là thiệt hại thật của mô hình 1:1. Không phải "không lưu được lần thứ hai", mà là **mất lần
thứ nhất**.

## 2. Nghiệp vụ thật là 1:N

Những tình huống có thật ở shop:

| Tình huống | Hiện tại ERP làm gì |
| --- | --- |
| Giao thất bại → gửi lại mã mới | ghi đè, mất lần đầu |
| Vận đơn bị huỷ → tạo lại | ghi đè |
| Đổi hàng → gửi vận đơn thay thế | ghi đè |
| Giao một phần | không mô hình hoá được |
| Vận đơn chiều hoàn | **né được** vì mang `order_id NULL` (luật 7 `AGENTS.md`) |

Chỉ chiều hoàn là an toàn, và an toàn nhờ một quy ước riêng chứ không nhờ mô hình.

## 3. Nơi mã nguồn giả định "một vận đơn"

| Nơi | Kiểu giả định |
| --- | --- |
| `db/schema.ts` — `ordersRelations.shipment: one(shipments)` | quan hệ một–một |
| `lib/integrations/pancake/sync.ts` | `existing?.shipment` rồi ghi đè |
| `app/api/refresh/route.ts` | `findFirst(where orderId = ...)` |
| `lib/queries/*` (18 tệp) | `orders LEFT JOIN shipments` rồi tính trên từng dòng |
| `canonical_order_outcome` | grain (đơn × vận đơn) — **đúng với hiện tại**, sẽ nhân đôi khi có 1:N |
| Trang Vận đơn | grain **vận đơn** — đúng thiết kế, không đổi |

## 4. Rủi ro số học khi mở 1:N

Ngày đầu tiên một đơn có hai vận đơn, **mọi báo cáo tiền đếm đơn đó hai lần**: doanh thu, số đơn, giá
vốn, tỷ lệ giao thành công, lợi nhuận. Và nó **im lặng**.

Nên mở 1:N mà không sửa đường tính tiền là tạo ra một lỗi tài chính có hẹn giờ. Hai việc phải đi
cùng nhau trong một lần phát hành:

1. mô hình cho phép nhiều lần gửi;
2. đường tính tiền chuyển sang **grain ĐƠN**, không còn nhân theo số vận đơn.

## 5. Thiết kế đích

```
Order 1 ─── N ShipmentAttempt
                ├── attemptNo      thứ tự lần gửi trong cùng đơn
                ├── direction      OUTBOUND · RETURN · REPLACEMENT
                └── (carrier, trackingCode) duy nhất
```

- **Bỏ** `UNIQUE(order_id)`.
- **Giữ** `UNIQUE(vtp_order_number)` — một mã vận đơn chỉ có một dòng.
- Kết quả đơn tính ở **mức ĐƠN**, tổng hợp từ mọi lần gửi. Case: lần 1 huỷ + lần 2 giao thành công
  ⇒ đơn **giao thành công**, đếm **một lần**.
- Chiều hoàn **không** làm tăng tỷ lệ giao thành công, đúng luật hiện hành.

## 6. Thứ tự an toàn

1. Mô hình + migration thuận (không phá dữ liệu cũ).
2. Đường tính tiền chuyển sang grain đơn, **trước khi** có dữ liệu 1:N.
3. Đường ghi thôi ghi đè: mã vận đơn mới ⇒ **lần gửi mới**, không thay lần cũ.
4. Kiểm thử tổng hợp cho 5 tình huống.
5. KPI trước/sau phải **y nguyên** — vì production chưa có đơn nhiều vận đơn.

## 7. Trạng thái

| Bước | Tình trạng |
| --- | --- |
| Kiểm toán | **xong** (tài liệu này) |
| Migration + schema (`0050`) | **xong** — bỏ `UNIQUE(order_id)`, thêm `attempt_no` + `direction` |
| Grain đơn cho đường tiền | **xong** — `PRIMARY_ATTEMPT` áp vào **21 phép nối** ở 11 tệp truy vấn |
| Đường ghi giữ mọi lần gửi | **xong** — mã vận đơn mới ⇒ lần gửi mới, không ghi đè |
| Kiểm thử A–E | **xong** |
| Luật đối soát | **đổi nghĩa** — xem mục 8 |

### Điều quan trọng nhất của lần này

Hai việc **đi cùng một lần phát hành**, và cố ý không tách:

1. mô hình cho phép nhiều lần gửi;
2. `PRIMARY_ATTEMPT` bảo đảm **mỗi đơn đúng một dòng** ở mọi đường tính tiền.

Tách ra thì giữa hai lần phát hành sẽ có một cửa sổ mà lần gửi lại đầu tiên **nhân đôi doanh thu
trong im lặng**. Với dữ liệu hôm nay (mỗi đơn một vận đơn) `PRIMARY_ATTEMPT` chọn đúng dòng duy nhất,
nên **KPI không đổi một con số nào**.

### Lần gửi nào quyết định kết quả đơn

1. **Lần tới tay khách thắng** — khách đã nhận hàng ở lần nào thì đơn là giao thành công; lần huỷ
   trước đó không xoá được sự thật ấy (đúng CASE A).
2. Chưa lần nào tới tay khách ⇒ lấy **lần gửi mới nhất** — đó là tình trạng hiện thời.
3. Chốt bằng `id` để kết quả ổn định giữa hai lần chạy.

## 8. Luật đối soát đổi nghĩa

`ORDER_WITH_MULTIPLE_SHIPMENTS` trước đây là **NGHIÊM TRỌNG** vì nhiều vận đơn nghĩa là số liệu sai.
Nay nhiều lần gửi là **hợp lệ**, nên luật đổi thành **CẢNH BÁO** và chỉ bật khi thật sự đáng ngờ:

> **hai lần gửi CÙNG ĐANG SỐNG** — chưa lần nào huỷ, hoàn hay giao xong.

Đó hoặc là ghép nhầm vận đơn vào đơn, hoặc là hai gói hàng thật đang cùng đi tới một khách — và cả
hai đều tốn cước. Báo đỏ mọi ca gửi lại là dạy người dùng bỏ qua cảnh báo.
