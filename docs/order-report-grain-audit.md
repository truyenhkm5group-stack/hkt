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

## 2. Vì sao lại như vậy — và điều đó có bền không

Không phải may mắn. Đó là hệ quả của **luật 7 trong `AGENTS.md`**:

> Vận đơn chiều về (mã gốc + `[số]P[số]`) là dòng `shipments` **riêng** (`order_id NULL`,
> `order_reference` = mã gốc).

Vận đơn chiều hoàn — nguồn sinh vận đơn thứ hai phổ biến nhất — **cố ý không gắn `order_id`**, nên nó
không bao giờ lọt vào phép nối. Đây là một quyết định thiết kế đang **âm thầm bảo vệ** mọi con số báo
cáo khỏi bị nhân đôi.

Nó bền tới chừng nào luật đó còn được giữ. Các đường có thể phá vỡ:

| Đường | Nguy cơ |
| --- | --- |
| Gửi lại đơn bằng **vận đơn mới** mà vẫn gắn cùng `order_id` | **CAO** — sinh dòng thứ hai thật sự |
| Ghép tay vận đơn mồ côi vào một đơn đã có vận đơn | **CAO** |
| Ai đó "sửa" luật 7 để gắn `order_id` cho vận đơn chiều hoàn | **RẤT CAO** — nhân đôi hàng loạt |
| Nhập tệp Viettel Post tạo trùng vận đơn | Trung bình (có khoá duy nhất `vtp_order_number`) |

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

### Việc đề xuất (một lượt riêng, không nằm trong P0.3)

- **Luật đối soát mới**: đếm đơn có > 1 vận đơn gắn vào. Ngưỡng kỳ vọng = 0. Khác 0 là báo ngay ở
  Trung tâm điều khiển — đây là loại lỗi mà phát hiện muộn thì mọi báo cáo lịch sử đều đã sai.
- Khi con số đó khác 0, mới quyết định: hoặc chuyển các báo cáo TIỀN sang `count(distinct order_id)`
  và `sum(revenue)` trên bảng đã khử trùng, hoặc siết lại đường sinh vận đơn thứ hai.
- **Không** làm việc đó trước khi có ca thật: đổi grain khi chưa có nhân đôi là đổi con số mà không
  sửa được lỗi nào, và làm hỏng parity của lớp tăng tốc.
