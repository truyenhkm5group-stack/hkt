# Báo cáo phát hành — 08/09/2026

Bản phát hành của `CLAUDE_ERP_NEXT_TASKS_NO_DIRECT_VTP_V2.md`, gộp **16 commit** từ `1fd1d8f`.

## Cổng ra (14/14 ĐẠT)

| # | Mục | Kết quả |
|---|---|---|
| 1 | `git status` sạch | ✔ |
| 2 | Review diff | ✔ 16 commit |
| 3 | `typecheck` | ✔ sạch |
| 4 | `lint` | ✔ **0 lỗi** (3 cảnh báo có từ trước) |
| 5–7 | Unit + tích hợp + bất biến nghiệp vụ | ✔ **71 bộ**, **17/17 bất biến**, *TẤT CẢ KIỂM THỬ ĐẠT* |
| 8 | Production build | ✔ |
| 9 | Migration | ✔ `0036` — **9** câu lệnh có bảo vệ idempotent, **0** câu phá huỷ |
| 10 | Quét Chất lượng dữ liệu | ✔ 0 nghiêm trọng |
| 11 | Quét nhất quán KPI | ✔ ghi mốc trước deploy |
| 12 | Rà soát an toàn | ✔ `docs/erp-security-reliability.md` |
| 13 | Kiểm tra hồi quy hiệu năng | ✔ `docs/erp-perf-audit.md` — không có nút thắt |
| 14 | Kế hoạch rollback | ✔ deploy lại `1fd1d8f`; mọi migration đều **cộng thêm** nên bản cũ chạy được trên schema mới |

## Nội dung phát hành

**Sửa bug tính sai lợi nhuận theo khoảng ngày (P0).** Báo cáo lọc doanh thu theo khoảng người dùng
chọn nhưng cộng **nguyên khoản** chi phí. Thuê 2.000.000đ/tháng ghi 01/09 → tuần 01–07/09 gánh **đủ
2.000.000đ**, tuần 08–14/09 được **0đ**.

- Bốn phương pháp phân bổ; khoản theo kỳ chia theo ngày chồng lấn.
- Tính bằng **hiệu hai số luỹ kế** — cộng 30 ngày lẻ vẫn đúng **chính xác** trọn khoản.
- Sửa cả **điều kiện lọc**, không chỉ phép cộng.
- Một chỗ tính duy nhất, **cả bản TypeScript lẫn SQL**, kiểm thử chạy song song hai bản.
- Migration `0036` **không phá dữ liệu cũ**; khoản cũ chỉ được **đánh dấu**, không tự đoán kỳ.

**Hai tỷ lệ quảng cáo** `QC / Doanh số POS` và `QC / DT giao thành công` — mẫu số khác nhau có chủ
đích, mẫu số 0 ⇒ `null`.

**Năm luật Chất lượng dữ liệu mới**: `EXPENSE_NEEDS_ALLOCATION_REVIEW`, `NEGATIVE_STOCK`,
`STOCK_MISSING_OPENING_BALANCE`, và (từ P0.5) `AMBIGUOUS_ORDER_SHIPMENT_MAPPING`.

**Tách người gửi trên kênh Viettel Post** — điểm mù đã mất gần ba ngày để phát hiện: gộp chung thì
một đường chết vẫn thấy "có dữ liệu".

**`data-check` vào lịch chạy hằng ngày**, **chỉ quét, không sửa**.

**Bất biến 17**: một đơn giữ được nhiều lần gửi, lần sau không nuốt lần trước.

**Nhóm đơn `UNKNOWN` lên bảng điều khiển** — trước đó nằm lẫn trong "chưa kết thúc".

## KPI trước deploy

| | |
|---|---|
| `DELIVERED` | 404 |
| `RETURNED` | 781 |
| `IN_TRANSIT` | 307 |
| `UNKNOWN` | 13 |
| `NOT_SHIPPED` | 156 |
| `CANCELLED` | 293 |
| Lệch ảnh chụp | **0** |

**Dự kiến KPI KHÔNG đổi vì bản phát hành này.** Không có thay đổi nào chạm công thức kết quả đơn;
thay đổi chi phí chỉ ảnh hưởng Báo cáo lợi nhuận khi khoản chi **có kỳ hiệu lực**, mà production
hiện **chưa có khoản nào** khai kỳ. Con số duy nhất có thể đổi là hai tỷ lệ quảng cáo — vốn chưa
từng tồn tại.

## Phát hiện quan trọng, chưa xử lý

**`shipments.order_id` mang ràng buộc `UNIQUE`** — schema ép 1:1 đơn ↔ vận đơn, chưa phải 1:N như
kế hoạch đòi. Các lần gửi khác tồn tại như dòng riêng (`order_id` NULL, `order_reference` trỏ về vận
đơn gốc), đúng quy ước đang dùng cho 250 vận đơn chiều hoàn.

**Cố ý chưa gỡ.** Mọi báo cáo tính ở grain *đơn × vận đơn*; cho một đơn gắn N vận đơn mà chưa đổi
grain là **nhân đôi doanh thu** — hỏng nặng hơn nhiều so với việc thiếu một quan hệ. Bất biến 17
khẳng định ràng buộc này tường minh kèm cảnh báo cho người sửa sau.

## Chưa bật, đúng lệnh

`PENDING_DIRECT_VTP_FULFILLMENT` · WRITE BACKFILL toàn cục · xoay secret · tạo vận đơn VTP thật.
