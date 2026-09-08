# Tiến độ release "ERP Data Truth"

Nhánh: `claude/erp-data-truth-p0` · tách từ `main` tại `cf90934`.
Quy tắc: mỗi task một commit riêng, KHÔNG deploy giữa chừng, KHÔNG merge `main` giữa chừng.
Chỉ deploy MỘT LẦN sau khi FINAL GATE đạt.

Kế hoạch gốc: `CLAUDE_ERP_MASTER_PLAN.md` (chủ shop giao).
Kiểm toán nền: `docs/erp-data-truth-audit.md`.

| Task | Nội dung | Trạng thái | Commit |
|---|---|---|---|
| 1 | Kiểm toán kiến trúc & data truth | ✅ xong | `docs: audit ERP data truth architecture` |
| 2 | Chuẩn hoá lớp chân lý nghiệp vụ | ✅ xong | `feat: centralize canonical order shipment payment truth` |
| 3 | Cứng hoá nạp dữ liệu Viettel Post | ✅ xong | `feat: harden ViettelPost event ingestion` |
| 4 | Bộ máy đối soát | ✅ xong | `feat: add shipment reconciliation safeguards` |
| 5 | Lớp chân lý chỉ số | ✅ xong | `feat: centralize ERP metric truth` |
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

### TASK 2 — Lớp chân lý nghiệp vụ

Thêm `lib/constants/truth.ts`: bảng đăng ký năm chiều (`TRUTH_DIMENSIONS`) nêu rõ với mỗi chiều
câu hỏi nó trả lời, nơi lưu, nguồn sự thật và danh sách **cấm suy ra từ**. Không có công thức mới:
`ORDER_OUTCOME` vẫn là bản duy nhất ở `lib/queries/return-rate.ts`.

Gộp các danh sách nguồn sự kiện vốn bị chép cứng ở 4 tệp thành hai hằng số có ý nghĩa khác nhau:

- `CARRIER_EVENT_SOURCES` (có `MANUAL`) — được quyền dựng trạng thái vận đơn;
- `CARRIER_DOCUMENT_SOURCES` (không có `MANUAL`) — chứng từ máy, chỉ nhóm này được đọc mã cuối.

`state.ts`, `return-rate.ts`, `integrations.ts`, `logistics.ts` nay đọc chung hai hằng số đó.

Thêm `OUTCOME_GROUP` / `isFinishedOutcome()` để màn hình thôi liệt kê tay
`('RETURNED','RETURNED_BY_RULE')`, và `legTypeFromReturningFlag()` cho cờ `IS_RETURNING`.

`tests/canonical-truth.test.ts` khoá đủ 8 tình huống kế hoạch yêu cầu, cộng kiểm tra bảng đăng ký
khớp enum trong schema.

### TASK 3 — Cứng hoá nạp dữ liệu Viettel Post

Đóng F3, F6, F7.

- **F3** — bước hành trình nay có cờ chiều. `normalizeTracking` đọc `IS_RETURNING` của TỪNG bước;
  `journeyLegType()` chỉ gán cờ khi bước có cờ riêng, hoặc khi bước mang MÃ TRẠNG THÁI CUỐI thì
  lấy cờ của bản ghi chính. Bước trung gian để trống — một vận đơn đi rồi quay về có cả hai chiều
  trong cùng hành trình, gán bừa sẽ hỏng các mốc "lần đầu lấy hàng / lần đầu đi phát".
- **Một hàm duy nhất ghi trạng thái vận đơn.** `applyVtpTracking` thôi ghi
  `stage / vtp_status* / is_final / các mốc`; chỉ `materializeShipmentState()` ghi, và nó dựng từ
  lịch sử. Trước đây hai chỗ cùng ghi nên luồng chạy sau thắng kể cả khi mang sự kiện cũ hơn.
- **F6/F7** — `webhook_events` thêm `dedupe_key` (unique), `occurred_at`, `delivery_count`
  (migration `0032_webhook_dedupe.sql`, viết tay idempotent). Lần gửi lại rơi vào đúng dòng cũ và
  vẫn được xử lý lại (xử lý vốn idempotent) nên gói tin hỏng lần đầu còn cơ hội chữa.
- **Trạng thái lạ nhìn thấy được**: `viettelPostHealth()` trả `unknownStatuses` + `redelivered`,
  hiển thị trên trang Kết nối dữ liệu.

`tests/vtp-ingestion.test.ts` khoá cả bốn điểm, kèm kiểm tra mã nguồn để `applyVtpTracking` không
lặng lẽ ghi lại `stage` trong tương lai.

Lưu ý về migration: `drizzle-kit generate` sinh ra bản gộp cả 0027–0031 (những migration viết tay
chưa có snapshot) — chạy nguyên bản đó sẽ `CREATE TABLE` đè lên bảng production. Đã thay bằng bản
viết tay chỉ chứa thay đổi của 0032, đúng lối idempotent các migration 0025–0031 đang dùng.

### TASK 4 — Bộ máy đối soát

**Đóng F1 và F2 — hai vi phạm nghiêm trọng nhất của release này.**

`lib/constants/reconciliation.ts` là bộ luật: 15 luật, mỗi luật có mức nghiêm trọng
(ERROR/WARNING/INFO), nghĩa thật, việc nên làm, và cờ **có được tự sửa hay không**.

`lib/sync/consistency.ts` viết lại thành hai hàm tách bạch:

- `scanReconciliation()` — CHỈ ĐỌC, chạy được mọi lúc, hỗ trợ quét gia tăng (`since=N`);
- `repairReconciliation({ apply })` — mặc định chạy thử; chỉ sửa 3 luật XÁC ĐỊNH, và cả ba đều lấy
  nguồn sự thật của **chính chiều đó**: dựng lại ảnh chụp vận đơn từ lịch sử sự kiện, khôi phục mốc
  giao từ lịch sử, và sửa nhãn "không thu hộ" theo chính số tiền thu hộ. Mỗi lần sửa ghi
  `audit_logs`.

Đã **bỏ hẳn** ba hành vi sai của bản cũ:

1. suy `stage = 'DELIVERED'` từ `cod_status` (F1) — nay là luật `PAYMENT_DELIVERED_CONFLICT`
   mức ERROR, chỉ báo cáo;
2. hạ `cod_status` đơn hoàn/huỷ về `NOT_APPLICABLE` (F2) — bỏ hoàn toàn;
3. lấy `updated_at` của ERP làm mốc giao khi thiếu — nay dựng từ lịch sử, không có thì để trống.

`tests/reconciliation.test.ts` khoá: tiền về ngân hàng KHÔNG biến vận đơn thành đã giao · đơn hoàn
giữ nguyên dấu vết thu hộ · chạy thử không ghi gì · sửa xác định thì phải đúng theo lịch sử · mỗi
lần sửa để lại nhật ký · quét hai lần cho cùng kết quả.

### TASK 5 — Lớp chân lý chỉ số

Đóng F4 và F9.

`lib/queries/metrics.ts` giữ hai POPULATION có tên (`confirmed` / `reportable`), bộ lọc chuẩn
`metricScope()`, các vị ngữ theo kết quả đơn và các biểu thức tiền. Không có công thức kết quả đơn
mới — tất cả đi qua `ORDER_OUTCOME`.

**F4 đã sửa:** Tổng quan tính `successRevenue` và `successCogs` trong CÙNG một câu truy vấn, cùng
population. Trước đây giá vốn là một truy vấn riêng thiếu bộ lọc "đơn đã xác nhận", nên lợi nhuận
ước tính lấy doanh thu của một tập đơn và giá vốn của tập đơn khác. Trên fixture: doanh thu GTC
4.903.000đ, giá vốn 3.600.000đ, GTC 34,7% — khớp mọi màn hình.

`docs/metrics-contract.md` ghi với từng chỉ số: ý nghĩa · tử số · mẫu số · population · loại trừ ·
trường ngày · nguồn sự thật · cài đặt. Nêu rõ ba con số tiền không bao giờ được coi là một
(lên đơn / giao thành công / thực nhận).

`tests/metrics-contract.test.ts` khoá bất biến "cùng chỉ số + cùng kỳ + cùng bộ lọc ⇒ cùng con số",
kèm chốt chặn giá vốn không được vượt doanh thu của chính tập đơn đó.

## Backlog (phát hiện ngoài phạm vi, không tự sửa)

- `npm run lint` có sẵn 3 cảnh báo từ trước release này (0 lỗi):
  `production-editor.tsx` biến `matrixTotals` không dùng · `lib/cs/failed-delivery.ts:205` biểu thức
  không gán · `lib/landing/sheet.ts` `fetchJson` không dùng.
