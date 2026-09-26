# Bàn giao · Agent N · Gửi lại tin Lark/Telegram hỏng · Dọn lời duyệt kẹt (migration 0146)

Nhánh `claude/cos-thu-lai-lark-va-duyet-ket`, dựng trên `origin/main` `66dd128b`. Không thêm lịch, không
thêm job, không đổi ngưỡng nghiệp vụ, không gửi tin thật (mọi kiểm thử tiêm bộ gửi giả, URL `.invalid`).
Kiểm thử: `tests/company-os-retry-sweep.test.ts` (3 khối, đăng ký trong `tests/sync-fixtures.test.ts` ngay
sau khối K, trước QA; dữ liệu mang tiền tố `cos-n-`, dòng thông báo tự xoá).

## 1. Gửi lại tin cảnh báo hỏng

Trước: `evaluateAlerts` chỉ gửi dòng VỪA TẠO; hỏng ⇒ `notified_at` NULL mãi mãi, không ai gửi lại.

Nay mọi lần gửi (lần đầu + gửi lại) đi qua MỘT đường: `lib/alerts/notification-delivery.ts::deliverNotifications`,
gọi trong chính lượt `alerts` (10 phút/lần + sau webhook).

| Bảo đảm | Cách giữ |
|---|---|
| Không gửi trùng khi hai lượt chạy chồng | NHẬN trước, gửi sau: `UPDATE … SET notify_attempts + 1, notify_last_attempt_at = now WHERE <điều kiện> RETURNING` — điều kiện nằm TRONG câu UPDATE, Postgres kiểm lại trên phiên bản dòng mới nhất, lượt kia thấy mốc vừa ghi (nhịp lùi chưa qua). Lần đầu nhận bằng `notify_attempts IS NULL`. |
| Đã gửi là xong | `notified_at` ghi khi ≥ 1 kênh nhận (giữ nghĩa cũ); dòng có `notified_at` không bao giờ được nhận lại. |
| Không gửi lại dòng đã đóng | `resolved_at IS NULL` trong điều kiện nhận. |
| Không gửi tin cũ | Cửa sổ `NOTIFY_RETRY_WINDOW_MINUTES` = 360 tính từ `created_at`; dòng quá cửa sổ vẫn nằm trên `/alerts`. |
| Có trần, có nhịp lùi | `NOTIFY_MAX_ATTEMPTS` = 5 (kể cả lần đầu); lùi 10·20·40·80 phút (`NOTIFY_BACKOFF_BASE_MINUTES` = 10 = nhịp job). Kiểm thử khoá: tổng nhịp lùi < cửa sổ. |
| Không "gửi lại" thứ chưa từng định gửi | Chỉ dòng có `notify_attempts ≥ 1`. NULL = dòng trước 0146 / dòng do đường khác tạo / dòng không có kênh ⇒ không bao giờ. Không kênh nào cấu hình ⇒ không nhận dòng (không đốt lượt thử). |
| Câu lỗi đã che | `maskDeliveryError`: che URL, chuỗi dạng token Telegram (`bot<id>:<khoá>`), chuỗi ≥ 32 ký tự giống khoá; cắt 300 ký tự. Áp cho `notify_last_error` VÀ câu lỗi trả về job (`lark.error` / `telegram.error` giờ đã che — trước đây là câu lỗi thô của `fetch`). |
| Bỏ cuộc thấy được | Tổng kết job: `gửi lại N · chờ gửi lại N · BỎ CUỘC N`. Trang `/alerts` hiện dải đỏ khi có dòng đang chờ gửi lại / đã bỏ cuộc (còn mở, trong cửa sổ) + lỗi gần nhất (đã che) — `notificationDeliveryStatus()` trong `lib/queries/notifications.ts`. |

Tin gửi lại mang đuôi "· gửi lại sau lỗi". Nhóm tin: (loại cảnh báo × lần đầu/gửi lại), tối đa 15 dòng liệt kê
như cũ; `ADS_BILLING` vẫn đi nhóm thanh toán nếu có.

Hằng số là THAM SỐ KỸ THUẬT, khai MỘT chỗ: `lib/constants/notification-retry.ts`.

**Migration `drizzle/0146_notification_retry.sql`** (journal idx 146, `when` 1790006661389, viết tay, idempotent):
`notifications.notify_attempts integer`, `notify_last_attempt_at timestamptz`, `notify_last_error text` — cả ba
NULL được, KHÔNG DEFAULT, KHÔNG backfill. Đã thêm vào `MOI` của `tests/migration-upgrade-path.test.ts` + khối
khẳng định (dòng cũ NULL cả ba, không UPDATE, không DEFAULT).

## 2. Dọn lời duyệt kẹt giữa giữ chỗ và thanh toán (mục mở của handoff-k)

`lib/approvals/reservation-sweep.ts::releaseStuckApprovalReservations`, gọi cuối `evaluateAlerts` (lỗi không
làm hỏng lượt cảnh báo). MỘT câu UPDATE, bốn điều kiện:

1. `status = 'EXECUTED'` (và `executed_at` có).
2. KHÔNG có `approval.executed` (khoá `approvalExecutedDedupeKey`) — có là thành công, không bao giờ động vào.
3. Nhật ký cổng `approval.execute:*` của yêu cầu mang `detail.settlement = 'DEFERRED'`. Lý do: `IMMEDIATE` và
   `IN_TRANSACTION` lật + phát sự kiện trong CÙNG giao dịch nên không kẹt được; còn yêu cầu `EXECUTED` từ TRƯỚC
   khi `approval.executed` LIVE (Agent K) cũng không có sự kiện nhưng ĐÃ chạy thật — nhật ký của chúng không
   có `settlement`. Thiếu điều kiện này là hồi sinh lời duyệt của việc đã làm.
4. `executed_at ≤ now − APPROVAL_RESERVATION_TIMEOUT_MINUTES` (= 120 phút; lý do ghi ở hằng số: action chạy
   trong một request HTTP, proxy cắt sau vài phút, thao tác nặng nhất đo bằng giây ⇒ 120 phút là hơn hai bậc
   độ lớn; vẫn nhỏ so với hạn 72 giờ của lời duyệt).

Kết quả: `APPROVED`, `executed_at = NULL`, `execution_error = STUCK_RESERVATION_ERROR` ("Máy dừng giữa lúc
thực thi — lời duyệt được trả lại. Kiểm tra việc đã được ghi chưa trước khi làm lại."), một dòng nhật ký
`approval.reservation_released:<action>` (SYSTEM). Người xin làm lại ĐÚNG việc ⇒ dùng lại ĐÚNG lời duyệt.
Lũy đẳng; hai lượt quét chồng ⇒ một hiệu lực, một dòng nhật ký.

## 3. Lệch khỏi đề bài / rủi ro còn lại — nói thẳng

- **Trả lại lời duyệt kẹt có thể cho làm một việc HAI LẦN.** "Kẹt" không phân biệt được (a) chết TRƯỚC khi
  thao tác ghi với (b) thao tác ghi XONG rồi chết trước lượt khẳng định — hoặc (c) lượt khẳng định hỏng vì CSDL
  chập chờn (`execution.ts::thanhToan` nuốt lỗi, để `EXECUTED`). Đề bài yêu cầu trả lại; tôi làm đúng vậy và
  để câu `execution_error` bảo người xin KIỂM TRA trước khi làm lại. Commit thứ hai (mục 6) đưa câu này lên
  màn hình TRƯỚC khi ai bấm làm lại.
- Tiến trình chết TRƯỚC khi ghi dòng nhật ký cổng (khe vài mili giây sau lượt lật) ⇒ yêu cầu nằm lại
  `EXECUTED` (phía an toàn, không dọn).
- Gửi tin: tiến trình chết giữa lúc Lark nhận tin và lúc ghi `notified_at` ⇒ lần sau gửi lại (trùng một lần).
  Telegram nhận mà Lark hỏng (hoặc ngược lại) ⇒ `notified_at` ghi, kênh hỏng KHÔNG được gửi lại (không có cột
  theo từng kênh — thêm là một migration khác).
- Sửa `lib/sync/jobs.ts`: CHỈ chuỗi `detail` của job `alerts` (thêm số gửi lại / bỏ cuộc / lời duyệt trả lại).
  Không đụng khối `dashboard-warm` của W. `AlertRunResult` thêm `delivery`, `approvalSweep`.
- `fmtAt` chuyển từ `rules.ts` sang `notification-delivery.ts` (rules import lại) để không có bản sao.

## 4. Đột biến — 17/17 ĐỎ

M1 lần đầu nhận cả dòng đã thử · M2 gửi lại đọc-rồi-lật không kiểm lại · M3 bỏ nhịp lùi · M4 bỏ cửa sổ ·
M5 gửi lại dòng đã đóng · M6 coi dòng chưa từng thử là đủ điều kiện · M7 bỏ trần · M8 không che câu lỗi ·
M9 không đóng dấu `notified_at` · M10 bỏ cuộc không đếm · M11 rules.ts không đưa dòng vừa tạo vào đường gửi ·
M12 không lưu câu lỗi · S1 bỏ hàng rào `approval.executed` · S2 bỏ điều kiện giữ chỗ DEFERRED · S3 bỏ hạn giữ
chỗ · S4 đọc-rồi-lật theo id (hai lượt quét chồng) · S5 rules.ts không gọi lượt dọn.

Ghi chú: "không nhận dòng chưa từng thử" được giữ ba lớp (`notify_attempts IS NOT NULL`; `notify_last_attempt_at`
NULL ⇒ phép so nhịp lùi ra NULL; `notify_attempts` NULL ⇒ khoảng lùi `power(2, NULL)` ra NULL). Đột biến M6
gỡ cả ba; gỡ một lớp thì bài vẫn xanh — đúng thiết kế, không phải bài yếu. Tương tự điều kiện `status =
'EXECUTED'` của lượt dọn được `executed_at IS NOT NULL` giữ kèm (dòng đã trả lại có `executed_at` NULL).

## 6. Câu nhắc "lần thực thi trước không hoàn tất" (commit thứ hai, theo yêu cầu Tech Lead)

- `lib/approvals/execution-note.ts::approvalExecutionNote` (hàm thuần, MỘT câu cho mọi màn hình): có ⇔
  `execution_error` khác rỗng — "Lần thực thi trước không hoàn tất: <lỗi> — kiểm tra việc đã được ghi chưa
  trước khi làm lại".
- `/alerts`, mục duyệt: trước đây chỉ liệt kê yêu cầu PENDING — mà lời duyệt bị trả lại là `APPROVED`, tức là
  KHÔNG hiện ở đâu cả. Nay `listApprovalSectionItems` (lib/queries/approvals.ts) = đang chờ + lời duyệt BỊ TRẢ
  LẠI (`APPROVED` + `execution_error` + chưa thực thi + còn trong hạn 72 giờ; hết hạn thì không làm lại được
  nữa nên không liệt kê). Mỗi dòng có câu nhắc màu hổ phách + LÚC hỏng (dòng nhật ký `approval.execute_failed:*`
  / `approval.reservation_released:*` gần nhất; không có ⇒ "chưa rõ lúc nào", không đoán bằng `decided_at`).
  Dòng trả lại không có nút duyệt. `listPendingApprovals` giữ tên, chỉ đọc phiên rồi gọi hàm trên.
- `/work`, `adaptApprovals`: CỘNG THÊM câu nhắc + lúc hỏng vào `summary` và `evidence.detail`. Không đổi trạng
  thái, không đổi tập việc: lời duyệt bị trả lại vẫn là `APPROVED` ⇒ `DONE` với người duyệt; nó chỉ hiện ở
  `/work` khi nằm trong cửa sổ việc đã đóng. Biến nó thành việc MỞ của người xin là đổi phép chiếu — chưa làm.
- Lượt làm lại: `GuardResult.priorExecutionError` (tuỳ chọn, cộng thêm) mang câu lỗi của lời duyệt vừa tiêu
  thụ — cột `execution_error` bị xoá ngay lúc tiêu thụ, nên đây là chỗ duy nhất còn giữ nó; cũng ghi vào nhật
  ký `approval.execute:*` (`detail.priorExecutionError`). `consumeApprovedRequest` nhận tham số `out` tuỳ chọn,
  kiểu trả về giữ nguyên.
- **KHÔNG làm phần thông báo (toast) lúc làm lại**: 15 server action đi đường DEFERRED trả kiểu kết quả RIÊNG
  của từng miền, và không action nào chuyển `GuardResult` về trình duyệt khi `PROCEED`. Đưa câu nhắc lên toast
  là sửa 15 action + client của chúng — không rẻ, và đổi kiểu trả về đang dùng. Bù lại: câu nhắc đứng ở mục
  duyệt `/alerts` TRƯỚC khi bấm, và lượt làm lại để lại vết trong nhật ký.
- Đột biến thêm E1–E11 (câu nhắc luôn null / cả khi rỗng · bỏ dòng trả lại · bỏ câu nhắc · không vẽ ở
  approval-section · /work thiếu ở bằng chứng / tóm tắt · tiêu thụ không mang lỗi cũ · dòng trả lại vẫn duyệt
  được · liệt kê cả lời duyệt sạch · không đọc lúc hỏng) — tổng 28/28 ĐỎ.

## 5. Chưa làm

- Chưa chạy trình duyệt / chưa đo production (phiên không có quyền). Sau deploy nên đọc tổng kết job `alerts`
  vài lượt và đếm `notifications where notify_attempts >= 5 and notified_at is null`.
