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
| Grain đơn cho đường tiền | **xong, sau khi vá thiếu** — xem mục 9 |
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

## 9. Việc rà lần đầu THIẾU 12 phép nối — và cách nó lộ ra

Lần rà đầu áp `PRIMARY_ATTEMPT` cho 21 phép nối ở 14 tệp, rồi ghi "xong". Rà lại bằng cách đối chiếu
máy móc hai danh sách — *tệp có nối `shipments`* (26) với *tệp có dùng `PRIMARY_ATTEMPT`* (14) — cho
ra **12 phép nối ở 9 tệp chưa canh**:

| Tệp | Cái bị nhân đôi |
| --- | --- |
| `reports.ts` (2 chỗ) | doanh thu, giá vốn, số lượng theo mẫu mã |
| `orders.ts` | số đơn, doanh thu, COD, số lượng trên trang Đơn hàng |
| `staff-performance.ts` | doanh thu chốt / đã giao, giá vốn theo nhân sự |
| `customers.ts` (2 chỗ) | doanh thu và số đơn theo khách |
| `crm.ts` | doanh thu theo nhóm khách |
| `expenses.ts` | doanh thu đối chiếu quảng cáo |
| `sales-funnel.ts` (2 chỗ) | doanh thu đã giao theo nguồn |
| `products.ts` | số lượng bán 30 ngày ⇒ **tồn kho** |
| `cashflow.ts` (2 chỗ) | COD đang giữ, vốn nằm trong hàng |

Cộng ba chỗ nữa ngoài `lib/queries`: hai luật đối soát tồn kho ở `control-tower.ts` và hai truy vấn
cảnh báo ở `alerts/rules.ts`.

### Vì sao sót — và đây mới là phần đáng ghi

Trước Phase 2, thứ giữ mọi con số đúng **không phải mã nguồn** mà là ràng buộc CSDL: nó khiến mọi
phép nối `orders → shipments` đúng một cách miễn phí, kể cả những phép nối viết ra mà không ai nghĩ
tới grain. Gỡ ràng buộc ra là **rút nền** khỏi 26 tệp cùng lúc.

Và bài kiểm CASE E không bắt được, vì nó **tự viết** một câu truy vấn có `PRIMARY_ATTEMPT` rồi kiểm
câu đó trả một dòng. Nó chứng minh *công cụ chạy được*, không chứng minh *công cụ đã được dùng ở
đâu*. Một bài kiểm như thế xanh mãi mãi dù nửa kho mã quên gọi.

### Nay có hai lớp canh, và cả hai đã được thử cho đỏ

1. `tests/shipment-join-grain.test.ts` — quét **mã nguồn**: nối vận đơn phải có canh, hoặc nằm trong
   danh sách miễn trừ **kèm lý do**; danh sách miễn trừ cũng bị kiểm rác.
2. `tests/multi-attempt-money.test.ts` — kiểm **hành vi** qua chính 8 hàm báo cáo thật: thêm một lần
   gửi *sao y* vào một đơn có sẵn thì 23 con số tiền/đếm phải không đổi.

Bài kiểm hành vi phải dựng ba lần mới đúng, và hai lần hụt đáng ghi lại:

- lần gửi thêm mang trạng thái **đang giao** ⇒ bị bộ lọc "chỉ đơn giao thành công" gạt đi, nên gỡ
  canh của Báo cáo lợi nhuận mà bài kiểm vẫn xanh. **Nhân đôi chỉ cắn khi cả hai lần gửi cùng lọt
  một bộ lọc.**
- lần gửi thêm mang **tiền đã thu** ⇒ bài kiểm đỏ, nhưng đỏ *sai*: COD của đơn chuyển từ "chưa về"
  sang "đã về" là đúng nghiệp vụ, vì dữ kiện tiền thật sự đã đổi.

Chỉ **bản sao y** tách được "số dòng đổi" khỏi "sự thật đổi" — và đó là điều duy nhất bài kiểm này
được phép nói.

