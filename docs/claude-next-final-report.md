# Tổng kết `CLAUDE_ERP_NEXT_TASKS_NO_DIRECT_VTP_V2.md` — 08/09/2026

**Đã phát hành lên production.** Commit `b067913d96d8` · nhánh `main` · `/api/health` `ok: true`.

## Task đã hoàn thành

| Task | Kết quả |
|---|---|
| 1 · Data Quality P0.5 | **xong** — cảnh báo 432 → 50, 0 nghiêm trọng |
| 2 · Shipment state rebuild | **xong** — lệch 70 → 0 |
| 3 · Multi-shipment / return / partial delivery | **xong** — bất biến 13, 16, 17 |
| 4 · Metric consistency | **xong** |
| 5 · COD / tài chính | **xong** |
| **5A · Time-aware cost allocation (P0)** | **xong** |
| 6 · Inventory truth | **xong** — 2 luật mới |
| 7 · Action Queue | **xong** — 2 loại việc mới |
| 8 · Integration health | **xong** — tách người gửi |
| 9 · Performance audit | **xong** — đo được, không có nút thắt |
| 10 · UI/UX consistency | **xong** — 36 trạng thái |
| 11 · Audit log | **xong** |
| 12 · Invariant suite | **xong** — 17/17 |
| 13 · Security / reliability | **xong** |
| 14 · Dashboard cockpit | **xong** |
| 15 · Product intelligence | **đã có sẵn, đã kiểm** |
| 16 · Ads profitability | **đã có sẵn, đã kiểm** — 4 loại ROAS |
| 17 · Self-healing | **xong** — `data-check` vào lịch |
| 18 · Final gate | **ĐẠT 14/14 → đã deploy** |

## Commit (17)

`5d92efe` phân bổ chi phí · `a88c765` metric consistency · `3b5221f` COD · `1aa6dcc` tồn kho ·
`7b768c3` action queue · `e10247f` integration health · `7d1b75e` perf · `fd554ac` UX ·
`99a52f7`+`fac79d2` audit log · `fcf791c` bất biến 17 · `b58797c` security · `2e39534` cockpit ·
`e78aa23` self-healing · `51bbe69`+`b067913` tài liệu.

## Kiểm thử

`npm test` → **TẤT CẢ KIỂM THỬ ĐẠT** · **71 bộ** · **17/17 bất biến** · typecheck sạch ·
lint **0 lỗi** · production build thành công.

## Schema

| | |
|---|---|
| Migration mới | **`0036`** — thêm `period_start`, `period_end`, `allocation_method`, `needs_allocation_review` vào `expenses` + 2 ràng buộc `CHECK` |
| An toàn | **9** câu lệnh có bảo vệ idempotent · **0** câu phá huỷ · ràng buộc `NOT VALID` |
| Đã áp trên production | ✔ **5/21** khoản chi được đánh dấu cần khai kỳ (đúng 5 khoản `SOFTWARE`) |

## Chất lượng dữ liệu trước → sau

| | Đầu phiên | Sau phát hành |
|---|---|---|
| Nghiêm trọng | 0 | **0** |
| Cảnh báo | 432 | **50** |

Còn lại đều có lý do: 13 vận đơn chưa ghép được đơn · 13 xung đột thật · 12 nhập nhằng không được ép
ghép · 11 COD quá hạn · 1 vận đơn treo.

## KPI trước → sau phát hành

| | Trước | Sau |
|---|---|---|
| `DELIVERED` | 404 | **404** |
| `RETURNED` | 781 | **781** |
| `IN_TRANSIT` | 307 | **307** |
| `UNKNOWN` | 13 | **13** |
| `NOT_SHIPPED` | 156 | **156** |
| `CANCELLED` | 293 | **293** |
| Lệch ảnh chụp | 0 | **0** |

**Không một con số nào đổi** — đúng như dự đoán trong báo cáo cổng ra. Bản phát hành không chạm công
thức kết quả đơn.

## Phân bổ chi phí trước → sau

Thuê mặt bằng 2.000.000đ/tháng ghi ngày 01/09:

| Khoảng xem | Trước | Sau |
|---|---|---|
| 01/09 – 30/09 | 2.000.000đ | 2.000.000đ |
| **01/09 – 07/09** | **2.000.000đ** ❌ | **466.667đ** ✔ |
| **08/09 – 14/09** | **0đ** ❌ | **466.666đ** ✔ |
| Cộng 30 ngày lẻ | — | **đúng 2.000.000đ** |

Chưa khoản chi nào trên production khai kỳ, nên **con số lợi nhuận hiện tại không đổi**. Cơ chế đã
sẵn sàng; 5 khoản `SOFTWARE` đang chờ chủ shop khai kỳ thật.

## Hai tỷ lệ quảng cáo

| Chỉ số | Mẫu số | Trạng thái |
|---|---|---|
| `QC / Doanh số POS` | doanh số đã chốt trên Pancake | ✔ hiện trên Báo cáo lợi nhuận |
| `QC / DT giao thành công` | doanh thu theo `ORDER_OUTCOME` | ✔ hiện trên Báo cáo lợi nhuận |

Mẫu số **không thay thế cho nhau**; mẫu số 0 ⇒ `null` ⇒ hiện "—". Khoá bằng kiểm thử hợp đồng chỉ số.

## Sức khoẻ production

`ok: true` · `/login` 200 · webhook `GET` 200 · **POST token sai → 401** · Pancake realtime chảy đều ·
0 gói lỗi trong 24 giờ · CPU load 0,20 · RAM 556/1.963 MB.

## Năm lỗi bộ kiểm thử bắt được của chính tôi trong phiên

1. Hàm đếm ngày dùng lịch **UTC** → tháng 9 hoá 31 ngày, tuần đầu ra 516.129đ thay vì 466.667đ.
2. Khẳng định "hai tỷ lệ phải khác nhau" **sai** khi chi quảng cáo = 0.
3. Chuỗi nháy ngược lọt vào câu SQL của luật mới.
4. **Commit khi typecheck đang đỏ** (khoá trùng trong danh mục nhãn) — sửa ngay ở `fac79d2`.
5. Hành động chép tay chưa có nhãn tiếng Việt nên sẽ hiện mã thô trên giao diện nhật ký.

## Backlog

**`PENDING_DIRECT_VTP_FULFILLMENT`** — không làm trong phase này.

**Đơn ↔ vận đơn đang là 1:1, chưa phải 1:N.** `shipments.order_id` mang ràng buộc `UNIQUE`. Các lần
gửi khác tồn tại như dòng riêng (`order_id` NULL, `order_reference` trỏ về vận đơn gốc). **Cố ý chưa
gỡ**: mọi báo cáo tính ở grain *đơn × vận đơn*, cho một đơn gắn N vận đơn mà chưa đổi grain là
**nhân đôi doanh thu**. Bất biến 17 khẳng định ràng buộc này kèm cảnh báo cho người sửa sau. Gỡ nó
là một phase riêng, phải đi kèm việc đổi grain toàn bộ lớp chỉ số.

**5 khoản `SOFTWARE` cần chủ shop khai kỳ hiệu lực** — hiện ở Chất lượng dữ liệu, luật
`EXPENSE_NEEDS_ALLOCATION_REVIEW`.

**13 xung đột Pancake ↔ ĐVVC cần người xem**, đáng chú ý nhất là 3 ca đơn huỷ trên Pancake mà gói
hàng vẫn đang đi hoặc đã giao.

## Chưa bật, đúng lệnh

WRITE BACKFILL toàn cục · direct VTP fulfillment · tạo vận đơn VTP thật · xoay secret.

## Phase kế tiếp đề xuất

1. Chủ shop khai kỳ cho 5 khoản chi → lợi nhuận theo tuần/tháng chính xác hoàn toàn.
2. Xử lý 13 xung đột thật, ưu tiên 3 ca đơn huỷ mà hàng vẫn đi.
3. Nếu cần 1:N thật: đổi grain lớp chỉ số **trước**, gỡ ràng buộc **sau**.
