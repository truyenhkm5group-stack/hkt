# Bàn giao · Agent K · Gia cố năm chỗ hở (không migration)

Nhánh `claude/cos-gia-co`, dựng trên `origin/main` `8602b942`. Năm commit, mỗi mục một commit. Không
migration, không đổi ngưỡng nghiệp vụ, không đổi mặc định cưỡng chế duyệt (vẫn TẮT mọi nhóm).
Kiểm thử: `tests/company-os-hardening.test.ts` (5 khối, đăng ký ngay trước bài QA trong
`tests/sync-fixtures.test.ts`; dữ liệu mang tiền tố `cos-k-` / mã `COSK`).

## 1. Vòng đời mẫu trong CÙNG giao dịch nghiệp vụ (yêu cầu của C)

- `lib/db-transaction.ts` (mới): `DbOrTx`, `isOpenTransaction()`. Kiểm bằng `is(db, PgTransaction)` của
  drizzle, KHÔNG `instanceof`: đo trên PGlite, `tx instanceof PgTransaction` trả `false` cho giao dịch thật
  (pg-core bị nạp hai bản — ESM qua `import()` động trong `db/index.ts` và CJS ở tệp gọi).
- `transitionModelCore(db | tx)`: được trao giao dịch đang mở thì chạy thẳng trong nó — không savepoint.
- Lõi topic / giá thành / mẫu (tạo · gửi duyệt · phán quyết) / lệnh SX (`followPoLink(tx)`) gọi
  `followModelLifecycle(tx, …)` TRONG giao dịch của mình. Giữ lũy đẳng theo `sourceEventId`, chỉ cạnh tiến.
  Lượt chuyển NÉM ⇒ hành động nghiệp vụ huỷ; hành động đổ (kể cả lúc COMMIT) ⇒ không lượt chuyển mồ côi.
  Lỗi NGHIỆP VỤ của lượt chuyển (`{ error }`) không ghi gì, không huỷ hành động — như C thiết kế.

## 2. `getSettingJson` với giá trị nguyên thuỷ (C báo)

- Hàm thuần `mergeSettingJson(raw, fallback)`: mặc định là object (kể cả mảng) ⇒ Y NGUYÊN luật cũ
  `{ ...fallback, ...parsed }`. Mặc định nguyên thuỷ / `null` ⇒ trả giá trị nguyên thuỷ đã lưu nếu CÙNG
  KIỂU (hoặc mặc định `null`); khác kiểu (chuỗi `"true"` cho cờ boolean), JSON `null`, JSON hỏng ⇒ mặc định.
- Bằng chứng không đổi khoá object: bài kiểm quét 61 lời gọi `getSettingJson` trong lib · app · scripts,
  giải mặc định từng lời gọi (hằng số export / object literal), so 32 khoá × 13 dạng giá trị = 793 phép so
  với luật cũ. Khoá nguyên thuỷ DUY NHẤT: `production.requireApprovedDesign`.
- `requireApprovedDesignFlag` bỏ bản đọc thẳng dòng, đọc `getSettingJson<boolean>(…, false) === true`
  (cùng hành vi mọi nhánh). Các chỗ đọc thẳng dòng khác đọc thẳng vì lý do KHÁC, không phải lỗi này —
  giữ nguyên: công tắc QC khẩn cấp (không được nuốt lỗi CSDL), cấu hình creative / ngưỡng tồn chậm (kẹp
  trước khi trộn mặc định), mẫu đặt tên + sổ bản tin (CAS), cổng duyệt (parse v2 riêng).

## 3. Lời duyệt không mất khi thao tác được duyệt hỏng (G) + `approval.executed` LIVE

Ba cách thanh toán một lượt tiêu thụ (`ApprovalSettlement`, `lib/approvals/service.ts` điểm 4):

| Đường | Nơi gọi | Thành công | Hỏng |
|---|---|---|---|
| `IN_TRANSACTION` | cổng nhận giao dịch nghiệp vụ đang mở — hôm nay: `createStockReceipt` (tách lõi `lib/inventory/receipt-create.ts::writeStockReceiptCore`) | lật `EXECUTED` + `approval.executed` cùng giao dịch với phiếu | tất cả huỷ, lời duyệt còn `APPROVED`; `recordApprovalExecutionError` ghi `execution_error` |
| `DEFERRED` | 15 server action gọi `guardSecondApproval` TRƯỚC thân — thân bọc `withApprovalExecution` (`lib/approvals/execution.ts`, AsyncLocalStorage) | lật ở cổng = GIỮ CHỖ; `confirmApprovalExecution` phát sự kiện cùng giao dịch với lượt khẳng định | action trả `{ error }` / ném ⇒ `releaseApprovalExecution`: về `APPROVED`, bỏ `executed_at`, ghi `execution_error`; làm lại dùng đúng lời duyệt cũ |
| `IMMEDIATE` | lời gọi ngoài phạm vi (client gọi thẳng action cổng; `setReturnDisposition`) | hành vi cũ + sự kiện trong một giao dịch nhỏ | lời duyệt đã mất (như trước) |

- Chọn đường theo nơi gọi: phiếu kho có thân là MỘT giao dịch nên cổng đặt vào trong được. Các action khác
  gọi nhiều lệnh ghi rời + `audit()` + hàm tự lấy `getDb()` — đặt cổng vào giao dịch là tái cấu trúc từng
  miền (lương, chi phí, lệnh SX…), nên dùng giữ chỗ + thanh toán. Thân action giữ nguyên (`git diff -w`:
  chỉ dòng bọc).
- Sự kiện KHÔNG phát lúc giữ chỗ: `domain_events` append-only, một "đã thực hiện" cho việc rồi hỏng thì
  không rút lại được ⇒ phát ở lượt khẳng định (cùng giao dịch với lượt ghi trạng thái). Lệch nhẹ khỏi câu
  chữ "cùng giao dịch với lượt lật" ở đề bài — ghi ở đây có chủ đích.
- `releaseApprovalExecution` có hàng rào: chỉ khi `EXECUTED` VÀ chưa có `approval.executed` ⇒ lượt đã
  khẳng định không bao giờ bị hồi sinh. Hạn 72 giờ vẫn tính từ lúc DUYỆT.
- `lib/approvals/execution.ts` KHÔNG là server action (một hàm "trả lời duyệt về APPROVED" mở cho trình
  duyệt là cửa dùng một lời duyệt nhiều lần) — bài kiểm khoá.
- Cổng gọi trong giao dịch mà không kèm `auditSink` ⇒ ném lỗi lập trình (`audit()` giữa giao dịch là khoá
  chết trên PGlite). Nhật ký cổng ghi SAU khi giao dịch chốt; giao dịch đổ thì không ghi.
- Khoá chống trùng sự kiện: `approval.executed:<id yêu cầu>` (tiền tố tên như mọi sự kiện khác của sổ).
- Hệ quả phụ: `approval.executed` là sự kiện USER (CHECK cấm `actor_id` NULL) nên XOÁ CỨNG một tài khoản
  đã thực hiện việc được duyệt sẽ bị CSDL chặn (FK SET NULL đụng CHECK) — giống mọi sự kiện USER khác của
  sổ. Hai bài kiểm cũ (G, QA) dọn sự kiện của người thử trước khi xoá tài khoản.

## 4. `stock_receipt.linked_production` LIVE

- `writeStockReceiptCore` phát khi phiếu mang `production_order_id` / `production_batch_id`, CÙNG giao
  dịch với phiếu; khoá chống trùng `stock_receipt.linked_production:<id phiếu>`.
- `model_id` = mẫu của sản phẩm trong lệnh (ưu tiên), không có thì của lô; sản phẩm chưa vào sổ mẫu ⇒ NULL
  (không đoán). Bảng lô chỉ đọc qua `batchLinkFacts` (sổ đặt xưởng, thêm trường `productId`) và đọc TRƯỚC
  giao dịch. Chiều Kho trên dòng thời gian mẫu đã khai sẵn; nhãn "Phiếu nhập nối lệnh / lô sản xuất".

## 5. "Không có topic" = một định nghĩa (T)

- `TOPIC_BLOCKS_NEW_SUGGESTION` + `countTopicsBlockingSuggestion` (`lib/constants/production-os.ts`) = mọi
  trạng thái TRỪ `CLOSED`, KỂ CẢ `SELECTED`. Lý do: Đã chốt phương án là đường sản xuất ĐÃ CÓ (bước tiếp là
  giá thành / mẫu thử trên chính topic ấy; phương án đổ vỡ thì topic quay lại `DISCUSSING` — vẫn chặn).
  `CLOSED` không chặn vì đóng có thể là bỏ dở — đúng lý do `productionTrackState` vốn đã dùng.
- Dùng ở: lô tín hiệu (`productionTrackTopics`, đổi tên từ `openProductionTopics`), `MODEL_SCALE`,
  `MODEL_EARLY_TOPIC`, khối Đề xuất trang 360 (`production.trackTopics`, đổi tên từ `openTopics`),
  `suggestsTopicOpening`, `productionTrackState`.
- `TOPIC_OPEN_STATUSES` giữ nghĩa "còn việc để bàn": hàng đợi, bộ lọc "đang mở", ô "Topic đang mở" của
  khối Sản xuất, `getModelProductionSummary.openTopics`, link "Topic sản xuất đang mở" ở tab Thiết kế
  (`designModelLinks` — T có đột biến M19 khoá đúng nghĩa ấy; không đổi).

## 6. Tệp của agent khác đã sửa (thêm / đổi tên, không tái cấu trúc)

A: `lib/models/service.ts`, `lib/constants/domain-events.ts`, `lib/queries/models.ts` (chiều
`approval_request`). C: `lib/production/{topics,costing,samples,orders,lifecycle}.ts`,
`lib/actions/production.ts`, `lib/queries/production-os.ts`. G: `lib/approvals/service.ts`,
`lib/actions/approvals.ts`. D: `lib/actions/stock.ts`, `lib/queries/workshop-ledger.ts` (một trường).
A2/T/S/H: `lib/constants/{model-360,early-topic}.ts`, `lib/queries/{model-signal,owner-decisions}.ts`,
`app/(dashboard)/models/[id]/blocks.tsx`. Lương / chi phí / báo cáo: 7 tệp `lib/actions/*` chỉ thêm dòng bọc.
Bài kiểm cũ: `company-os-{control-plane,e2e-lifecycle,cockpit,early-topic,model-360,signal-batch}` (dọn sự
kiện · đổi tên trường). Tài liệu: `shared-contracts.md` (§1, §2, §5, §6), `docs/second-approval-policy.md` (4.6).

## 7. Đột biến (mỗi đột biến sửa MỘT chỗ, chạy lại khối tương ứng, rồi hoàn nguyên) — 15/15 ĐỎ

| Mục | Đột biến | Kết quả |
|---|---|---|
| 1 | đưa vòng đời giá thành ra SAU giao dịch | ĐỎ |
| 1 | `isOpenTransaction` luôn false (mở savepoint) | ĐỎ |
| 2 | bỏ kiểm cùng kiểu với mặc định | ĐỎ |
| 2 | áp luật nguyên thuỷ cho cả mặc định object | ĐỎ |
| 3 | bỏ hàng rào "không hồi sinh lượt đã khẳng định" | ĐỎ |
| 3 | thanh toán luôn khẳng định (bỏ qua `{ error }`) | ĐỎ |
| 3 | trong phạm vi vẫn IMMEDIATE | ĐỎ |
| 3 | phiếu đổ không ghi `execution_error` | ĐỎ |
| 3 | phát `approval.executed` lúc giữ chỗ | ĐỎ |
| 4 | không phát sự kiện | ĐỎ |
| 4 | không nối mẫu | ĐỎ |
| 4 | bỏ nhánh lô | ĐỎ |
| 5 | tập chặn bỏ `SELECTED` | ĐỎ |
| 5 | lô tín hiệu đếm như cũ | ĐỎ |
| 5 | trang 360 bỏ cổng | ĐỎ |

## 8. Còn mở

- `setReturnDisposition` (`lib/actions/return-dispositions.ts`, vùng Agent R) chưa bọc
  `withApprovalExecution` — cổng chạy IMMEDIATE (tiêu thụ + sự kiện ngay, hỏng sau đó là mất lời duyệt như
  trước). Bọc là MỘT dòng khi R xong; bài kiểm liệt kê nó ở `CONG_CHUA_THANH_TOAN`, xoá dòng đó là bài đỏ
  cho tới khi bọc.
- `deleteStockReceiptCore` gọi cổng TRƯỚC giao dịch xoá (DEFERRED qua action bọc). Đưa cổng vào trong giao
  dịch xoá cần đổi kiểu `ReceiptDeleteGate` (D) — chưa làm.
- Tiến trình chết giữa lúc giữ chỗ và lúc thanh toán ⇒ yêu cầu nằm `EXECUTED` không sự kiện (phía an toàn:
  không hồi sinh). Chưa có job dọn; đếm được bằng `status = 'EXECUTED'` thiếu `approval.executed`.
- Chưa chạy trình duyệt / chưa đo production (phiên này không có quyền).
