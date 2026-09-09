# Kiểm toán GRAIN của báo cáo đơn hàng

Ngày 09/09/2026. Đây là kiểm toán **tính đúng đắn nghiệp vụ**, tách hẳn khỏi việc tăng tốc — cố ý
không xử lý lẫn trong P0.3, vì đổi grain là đổi con số và đó phải là một quyết định riêng.

---

## 0. Câu hỏi

Gần như mọi báo cáo đều viết:

```sql
from orders o left join shipments s on s.order_id = o.id
```

Nếu một đơn có **nhiều** vận đơn, phép nối này sinh **nhiều dòng cho cùng một đơn** — và mọi
`count(*)` sẽ đếm đơn đó nhiều lần, mọi `sum(revenue)` sẽ cộng doanh thu đó nhiều lần.

Câu hỏi: chuyện đó **có đang xảy ra không**, và ở đâu thì nguy hiểm?

## 1. Đo trên production — hiện KHÔNG có nhân đôi

```
tổng đơn                    2.430
đơn có > 1 vận đơn              0
số dòng thừa do phép nối        0
nhiều vận đơn nhất / đơn        1
```

**Không một đơn nào có quá một vận đơn gắn vào.** Nên hôm nay grain "(đơn × vận đơn)" và grain
"(đơn)" cho ra **cùng một con số**, và mọi báo cáo hiện hành đều đúng.

## 2. Vì sao lại như vậy — CSDL CƯỠNG CHẾ, không phải may mắn

Điều tra tiếp đã tìm ra thứ thật sự đang bảo vệ mọi con số: **ràng buộc UNIQUE trên
`shipments.order_id`**, có từ `drizzle/0000_init.sql`:

```sql
CONSTRAINT "shipments_order_id_unique" UNIQUE("order_id")
```

**Một đơn KHÔNG THỂ có hai vận đơn.** Không phải hiếm — là bất khả thi. Đã kiểm chứng bằng cách thử
chèn dòng thứ hai: cơ sở dữ liệu từ chối.

Một lớp bảo vệ thứ hai xếp chồng lên: **luật 7 của `AGENTS.md`** bắt vận đơn chiều hoàn mang
`order_id NULL`, nên nguồn sinh vận đơn thứ hai phổ biến nhất còn không chạm tới được ràng buộc đó.

### Điều đáng lo hơn: ràng buộc này VÔ HÌNH trong mã

Nó chỉ tồn tại trong SQL; `db/schema.ts` **không khai nó**. Ai đọc mã đều tưởng nhiều vận đơn cho một
đơn là hợp lệ — và có thể vô tình gỡ nó ra trong một lần sinh migration. **Đã khai lại trong
`db/schema.ts`** kèm giải thích hệ quả, và khoá bằng kiểm thử chứng minh CSDL thật sự từ chối.

### Hệ quả vận hành cần biết

Gửi lại một đơn bằng **vận đơn mới** sẽ bị CSDL **từ chối**. Đó là một giới hạn thật của hệ thống
hiện tại. Nếu shop cần làm việc đó, phải xử lý như một **quyết định nghiệp vụ** — và cùng lúc quyết
định luôn cách đếm — chứ không được nới ràng buộc ra để cho qua một ca lẻ: nới ra là mở đường cho
tiền bị cộng đôi trong im lặng ở mọi báo cáo.

## 3. Báo cáo nào ở grain nào

| Báo cáo | Grain thật | Đếm gì | Rủi ro nếu đơn có 2 vận đơn |
| --- | --- | --- | --- |
| `getFinancialTruth` | đơn × vận đơn | `count(*)`, `sum(revenue)` | **doanh thu và số đơn nhân đôi** |
| `getReturnRateSummary` / `ByVariant` | đơn × vận đơn | `count(*)` theo kết quả | tỷ lệ GTC lệch |
| `adsRoas` | đơn × vận đơn | `count(*)`, `sum(revenue)` | ROAS thổi lên |
| `getDashboardData` | đơn × vận đơn | `count(*)`, `sum(revenue)` | KPI trang chủ thổi lên |
| `getProfitReport` | đơn × vận đơn | tiền | lợi nhuận sai |
| `orderSummary` (trang Đơn hàng) | đơn × vận đơn | `count(*)` | số đơn sai |
| `shipmentSummary` (trang Vận đơn) | **vận đơn** | `count(*)` | **đúng thiết kế** — grain của nó là vận đơn |
| Sổ kho (`variantSalesSubquery`) | dòng đơn × vận đơn | `sum(quantity)` | **tồn kho sai** |
| `canonical_order_outcome` | đơn × vận đơn | — | giữ **đúng** grain của báo cáo, cố ý |

## 4. Kết luận và khuyến nghị

1. **Hôm nay không có lỗi nào cần sửa.** Số liệu đang đúng vì không đơn nào có hai vận đơn.
2. **Không đổi grain trong lượt tăng tốc.** Bảng vật chất hoá giữ nguyên grain (đơn × vận đơn) chính
   là để parity đạt 100% và KPI không đổi một con số nào. Đúng như chủ shop chốt.
3. **Rủi ro là ở TƯƠNG LAI**, và nó im lặng: ngày đầu tiên một đơn có hai vận đơn, doanh thu của đơn
   đó bị cộng hai lần và **không có gì báo**. Nên việc cần làm không phải đổi grain ngay, mà là **có
   người canh**.

### Đã làm

- **Khai lại ràng buộc trong `db/schema.ts`** — nó không còn vô hình.
- **Kiểm thử chứng minh CSDL từ chối** vận đơn thứ hai, thay vì chỉ ghi nhận "hiện chưa có ca nào".
- **Luật đối soát `ORDER_WITH_MULTIPLE_SHIPMENTS`** trong Trung tâm điều khiển, mức NGHIÊM TRỌNG,
  **không tự sửa** (máy không biết vận đơn nào là thật). Khi ràng buộc còn nguyên nó luôn im; nó chỉ
  bật nếu một ngày hàng rào kia bị gỡ — và ngày đó có người biết ngay thay vì phát hiện sau ba tháng
  khi mọi báo cáo lịch sử đã sai.

### Chưa làm, và cố ý

**Không đổi grain.** Khi chưa thể có nhân đôi, đổi grain là đổi con số mà không sửa được lỗi nào, và
làm hỏng parity 100% của lớp tăng tốc. Nếu ngày nào ràng buộc phải nới ra, việc cần làm cùng lúc là
chuyển các báo cáo TIỀN sang `count(distinct order_id)` — chứ không phải nới trước rồi sửa sau.
