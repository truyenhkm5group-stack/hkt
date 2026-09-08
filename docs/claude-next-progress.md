# Tiến độ `CLAUDE_ERP_NEXT_TASKS_NO_DIRECT_VTP_V2.md`

Cập nhật 08/09/2026. **ĐÃ DEPLOY** — một lần duy nhất sau FINAL GATE, đúng chính sách.
Production đang chạy `b067913d96d8` trên `main`, `/api/health` `ok: true`.

Tổng kết đầy đủ: `docs/claude-next-final-report.md`.

| Task | Trạng thái | Commit |
|---|---|---|
| **1** · Data Quality P0.5 cleanup | **XONG** | `d7e2741`, `dcb89b1`, `1fd1d8f` |
| **2** · Shipment state rebuild / reconciliation hardening | **XONG** | `0f3a667`, `c4234c9` |
| **3** · Multi-shipment / return / partial delivery semantics | **XONG** | `a145b11`, `9b7e3ae`, `3b2ea4c` |
| **4** · Metric consistency / KPI contract | **XONG** | `a88c765` |
| **5** · COD / financial reconciliation | **XONG** | `3b5221f` |
| **5A** · Time-aware cost allocation *(P0)* | **XONG** | `5d92efe`, `a88c765` |
| **6** · Inventory truth | **XONG** | `1aa6dcc` |
| **7** · Action Queue | **XONG** | `7b768c3` |
| **8** · Integration health | **XONG** | `e10247f` |
| **9** · Performance audit | **XONG** | `7d1b75e` |
| **10** · UI/UX consistency | **XONG** | `fd554ac` |
| **11** · Audit log / manual override safety | **XONG** | `99a52f7`, `fac79d2` |
| **12** · Business invariant regression suite | **XONG** — 17/17 bất biến | `fcf791c` |
| **13** · Security / reliability | **XONG** | `b58797c` |
| **14** · Dashboard cockpit | **XONG** | `2e39534` |
| **15** · Reporting / product intelligence | **XONG** — đã có sẵn, đã kiểm | — |
| **16** · Ads profitability | **XONG** — 4 loại ROAS, đã kiểm | — |
| **17** · Background self-healing | **XONG** — `data-check` vào lịch, chỉ quét | `e78aa23` |
| **18** · FINAL RELEASE GATE | **ĐẠT 14/14 → đã deploy** | `51bbe69`, `b067913` |

## Đã làm ở phiên này

**TASK 5A — sửa bug tính sai lợi nhuận theo khoảng ngày.** Báo cáo lọc doanh thu theo khoảng người
dùng chọn nhưng cộng **nguyên khoản** chi phí nếu `occurred_at` rơi vào khoảng đó. Thuê 2.000.000đ
ghi 01/09 → tuần 01–07/09 gánh **đủ 2.000.000đ**, tuần 08–14/09 được **0đ**. Cả hai đều sai.

- Bốn phương pháp phân bổ (`EVENT_DATE`, `PERIOD_PRORATA`, `ORDER_ATTRIBUTED`, `ACTUAL_DATED_SPEND`).
- Tính bằng **hiệu hai số luỹ kế**, không nhân phân số — cộng 30 ngày lẻ vẫn đúng chính xác trọn khoản.
- Sửa cả **điều kiện lọc**: khoản theo kỳ lọt vào báo cáo khi **kỳ chồng lấn**, không phải khi
  `occurred_at` trong khoảng.
- Migration `0036`: thêm cột, **không phá dữ liệu cũ**, mọi dòng giữ nguyên hành vi.
- Khoản cũ thuộc nhóm theo kỳ chỉ được **đánh dấu**, **không tự đoán kỳ** — production có **5/21**
  khoản được cờ, tất cả là `SOFTWARE`, chờ chủ shop khai kỳ thật.
- Một chỗ tính duy nhất, có **cả bản TypeScript lẫn SQL**, kiểm thử chạy song song hai bản.

**Hai tỷ lệ quảng cáo** `QC / Doanh số POS` và `QC / DT giao thành công` — đã tính, đã **hiện trên
Báo cáo lợi nhuận**, mẫu số khác nhau có chủ đích, mẫu số 0 ⇒ `null`.

**Luật `EXPENSE_NEEDS_ALLOCATION_REVIEW`** để cờ `needs_allocation_review` có nơi hiện ra.

**Tách người gửi trên kênh Viettel Post** (TASK 8) — điểm mù đã mất gần ba ngày để phát hiện: gộp
chung thì một đường chết vẫn thấy "có dữ liệu".

**Bất biến 17** (TASK 3/12) — một đơn giữ được nhiều lần gửi, lần sau không nuốt lần trước, kèm
khẳng định tường minh rằng `shipments.order_id` đang là `UNIQUE`.

## Năm lỗi bộ kiểm thử bắt được của chính tôi

1. Hàm đếm ngày dùng lịch **UTC** → `2026-09-01T00:00+07:00` đọc thành 31/08, tháng 9 hoá 31 ngày,
   tuần đầu ra 516.129đ thay vì 466.667đ.
2. Khẳng định "hai tỷ lệ phải khác nhau" **sai** khi chi quảng cáo = 0 — lúc đó cả hai đúng bằng 0.
3. Chuỗi nháy ngược lọt vào câu SQL của luật mới, tạo câu lệnh không hợp lệ.
4. **Commit khi typecheck đang đỏ** (khoá trùng trong danh mục nhãn) — sửa ngay ở `fac79d2`.
5. Hành động chép tay chưa có nhãn tiếng Việt nên sẽ hiện mã thô trên giao diện nhật ký.

## Trạng thái

`npm test` **TẤT CẢ KIỂM THỬ ĐẠT** · **71 bộ** · **17/17 bất biến** · typecheck sạch · lint 0 lỗi ·
production build thành công.

Sau phát hành: KPI **không đổi một con số nào** (giao 404 · hoàn 781 · đang giao 307 · chưa rõ 13 ·
chưa gửi 156 · huỷ 293 · lệch 0). Chất lượng dữ liệu **0 nghiêm trọng**, 50 cảnh báo đều có lý do.

## Backlog

`PENDING_DIRECT_VTP_FULFILLMENT` — không làm trong phase này.

**Đơn ↔ vận đơn vẫn là 1:1.** `shipments.order_id` mang ràng buộc `UNIQUE`; **cố ý chưa gỡ** vì mọi
báo cáo tính ở grain *đơn × vận đơn*, gắn N vận đơn vào một đơn khi chưa đổi grain là **nhân đôi
doanh thu**. Gỡ được, nhưng phải đổi grain lớp chỉ số **trước**.

**5 khoản `SOFTWARE` chờ chủ shop khai kỳ hiệu lực.**

**13 xung đột Pancake ↔ ĐVVC cần người xem**, đáng chú ý nhất là 3 ca đơn huỷ trên Pancake mà gói
hàng vẫn đang đi hoặc đã giao.
