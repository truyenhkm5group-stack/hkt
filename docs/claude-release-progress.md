# Tiến độ release "ERP Data Truth"

Nhánh: `claude/erp-data-truth-p0` · tách từ `main` tại `cf90934`.
Quy tắc: mỗi task một commit riêng, KHÔNG deploy giữa chừng, KHÔNG merge `main` giữa chừng.
Chỉ deploy MỘT LẦN sau khi FINAL GATE đạt.

Kế hoạch gốc: `CLAUDE_ERP_MASTER_PLAN.md` (chủ shop giao).
Kiểm toán nền: `docs/erp-data-truth-audit.md`.

| Task | Nội dung | Trạng thái | Commit |
|---|---|---|---|
| 1 | Kiểm toán kiến trúc & data truth | ✅ xong | `docs: audit ERP data truth architecture` |
| 2 | Chuẩn hoá lớp chân lý nghiệp vụ | ⏳ | |
| 3 | Cứng hoá nạp dữ liệu Viettel Post | ⏳ | |
| 4 | Bộ máy đối soát | ⏳ | |
| 5 | Lớp chân lý chỉ số | ⏳ | |
| 6 | Dry-run lịch sử + backfill an toàn | ⏳ | |
| 7 | Trung tâm điều khiển Chất lượng dữ liệu | ⏳ | |
| 8 | Bộ kiểm thử bất biến nghiệp vụ | ⏳ | |
| 9 | Chân lý tài chính | ⏳ | |
| 10 | Chân lý tồn kho + rủi ro hết hàng | ⏳ | |
| 11 | Chỉ số theo mẫu mã | ⏳ | |
| 12 | Hàng đợi việc theo mức ưu tiên | ⏳ | |
| 13 | Tổng quan ra quyết định | ⏳ | |
| 14 | ROAS theo kết quả đơn | ⏳ | |
| 15 | Sức khoẻ tích hợp | ⏳ | |
| 16 | Hiệu năng | ⏳ | |
| 17 | Nhật ký truy vết | ⏳ | |
| 18 | Nhất quán giao diện | ⏳ | |
| — | FINAL GATE | ⏳ | |

## Nhật ký

### TASK 1 — Kiểm toán kiến trúc & data truth

Không sửa business logic. Kết quả: `docs/erp-data-truth-audit.md` với 12 phát hiện `F1`–`F12`.

Hai phát hiện nghiêm trọng, cùng nằm ở `lib/sync/consistency.ts` (job `data-check` với `fix=1`):

- **F1** — suy `DELIVERED` từ `cod_status` (`PAID_TO_BANK` / `RECONCILED`) rồi GHI ĐÈ
  `shipments.stage`. Vi phạm trực tiếp `docs/business-rules/ORDER_OUTCOME.md` mục 10 và phá bất
  biến "trạng thái vận đơn là hàm của lịch sử sự kiện".
- **F2** — hạ `cod_status` về `NOT_APPLICABLE` cho đơn hoàn/huỷ, mâu thuẫn với
  `codStatusForAmount` và với `applyVtpTracking`. Xoá dấu vết thu hộ ⇒ không đòi được tiền ĐVVC.

Cả hai sẽ được sửa ở TASK 4 (bộ máy đối soát).

Nền đo được trước khi sửa: `typecheck` sạch · `lint` sạch · `npm test` **TẤT CẢ KIỂM THỬ ĐẠT**.

## Backlog (phát hiện ngoài phạm vi, không tự sửa)

*(chưa có)*
