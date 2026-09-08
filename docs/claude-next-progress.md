# Tiến độ `CLAUDE_ERP_NEXT_TASKS_NO_DIRECT_VTP_V2.md`

Cập nhật 08/09/2026. **Chưa deploy** — gom một lần sau FINAL GATE (TASK 18).

| Task | Trạng thái | Commit |
|---|---|---|
| **1** · Data Quality P0.5 cleanup | **XONG** | `d7e2741`, `dcb89b1`, `1fd1d8f` |
| **2** · Shipment state rebuild / reconciliation hardening | **XONG** | `0f3a667`, `c4234c9` |
| **3** · Multi-shipment / return / partial delivery semantics | **XONG** | `a145b11`, `9b7e3ae`, `3b2ea4c` |
| **4** · Metric consistency / KPI contract | **XONG** | `a88c765` |
| **5** · COD / financial reconciliation | **XONG** | `3b5221f` |
| **5A** · Time-aware cost allocation *(P0)* | **XONG** | `5d92efe`, `a88c765` |
| 6 · Inventory truth | chưa | |
| 7 · Action Queue | chưa | |
| 8 · Integration health | chưa | |
| 9 · Performance audit | chưa | |
| 10 · UI/UX consistency | chưa | |
| 11 · Audit log / manual override safety | chưa | |
| 12 · Business invariant regression suite | **phần lớn XONG** (16/16 bất biến) | |
| 13 · Security / reliability | chưa | |
| 14 · Dashboard cockpit | chưa | |
| 15 · Reporting / product intelligence | chưa | |
| 16 · Ads profitability | chưa | |
| 17 · Background self-healing | chưa | |
| 18 · FINAL RELEASE GATE | chưa | |

## Đã làm ở phiên này

**TASK 5A — sửa bug tính sai lợi nhuận theo khoảng ngày.** Báo cáo lọc doanh thu theo khoảng người
dùng chọn nhưng cộng **nguyên khoản** chi phí nếu `occurred_at` rơi vào khoảng đó. Thuê 2.000.000đ
ghi 01/09 → tuần 01–07/09 gánh **đủ 2.000.000đ**, tuần 08–14/09 được **0đ**. Cả hai đều sai.

- Bốn phương pháp phân bổ (`EVENT_DATE`, `PERIOD_PRORATA`, `ORDER_ATTRIBUTED`, `ACTUAL_DATED_SPEND`).
- Tính bằng **hiệu hai số luỹ kế**, không nhân phân số — cộng 30 ngày lẻ vẫn đúng chính xác trọn khoản.
- Sửa cả **điều kiện lọc**: khoản theo kỳ lọt vào báo cáo khi **kỳ chồng lấn**, không phải khi
  `occurred_at` trong khoảng.
- Migration `0036`: thêm cột, **không phá dữ liệu cũ**, mọi dòng giữ nguyên hành vi.
- Khoản cũ thuộc nhóm theo kỳ chỉ được **đánh dấu**, **không tự đoán kỳ**.
- Một chỗ tính duy nhất, có **cả bản TypeScript lẫn SQL**, kiểm thử chạy song song hai bản.

**Hai tỷ lệ quảng cáo** `QC / Doanh số POS` và `QC / DT giao thành công` — đã tính, đã **hiện trên
Báo cáo lợi nhuận**, mẫu số khác nhau có chủ đích, mẫu số 0 ⇒ `null`.

**Luật `EXPENSE_NEEDS_ALLOCATION_REVIEW`** để cờ `needs_allocation_review` có nơi hiện ra.

## Ba lỗi bộ kiểm thử bắt được của chính tôi

1. Hàm đếm ngày dùng lịch **UTC** → `2026-09-01T00:00+07:00` đọc thành 31/08, tháng 9 hoá 31 ngày,
   tuần đầu ra 516.129đ thay vì 466.667đ.
2. Khẳng định "hai tỷ lệ phải khác nhau" **sai** khi chi quảng cáo = 0 — lúc đó cả hai đúng bằng 0.
3. Chuỗi nháy ngược lọt vào câu SQL của luật mới, tạo câu lệnh không hợp lệ.

## Trạng thái

`npm test` **TẤT CẢ KIỂM THỬ ĐẠT** · **16/16 bất biến** · typecheck sạch · lint 0 lỗi · build thành công.

Production đang chạy `1fd1d8f` (P0.5). `main` đi trước 4 commit, **chưa deploy** theo đúng chính sách
"chỉ deploy một lần sau FINAL GATE".

## Backlog

`PENDING_DIRECT_VTP_FULFILLMENT` — không làm trong phase này.
