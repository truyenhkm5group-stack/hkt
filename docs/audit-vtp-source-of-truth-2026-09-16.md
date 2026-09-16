# Audit: Viettel Post có đang là nguồn sự thật cho `/shipments` không? (16/09/2026)

Đọc mã nguồn trước khi sửa một dòng nào. Mục đích: tìm **vì sao ERP khác Viettel Post**, và
tách rõ cái gì ĐÃ CÓ (không làm lại) với cái gì THẬT SỰ THIẾU.

---

## 1. Hiện trạng — những gì đã đúng, không được làm lại

| Hạng mục | Nơi | Kết luận |
|---|---|---|
| Webhook VTP | `app/api/webhooks/viettelpost/route.ts` | Có xác thực bí mật (thiếu bí mật ⇒ 503 ở production), lưu gói tin thô vào `webhook_events` với `dedupe_key = mã + trạng thái + MỐC CỦA ĐVVC`, đếm `delivery_count` khi VTP gửi lại, xử lý trong `after()` nên **trả HTTP 200 gần như tức thì**. Tìm gói tin lồng qua tối đa 4 tầng (Pancake chuyển tiếp). |
| Lịch sử vận đơn | `shipment_events` | Đã là bảng **append-only** có `source` · `status` · `status_name` · `occurred_at` (mốc ĐVVC) · `created_at` (mốc ERP nhận) · `raw` · `normalized_stage` · `leg_type` · `source_reference`. Khoá chống trùng `(shipment_id, source, status, occurred_at)`. |
| Trạng thái hiện tại | `lib/integrations/viettelpost/state.ts::deriveShipmentState` | **Đã derive từ lịch sử**, không phải ô nhớ bị ghi đè: thắng theo `occurred_at`, hoà thì theo thứ hạng nguồn. Sự kiện đến muộn **không kéo lùi** trạng thái. Chỉ `materializeShipmentState()` được ghi `shipments.stage`. |
| Một bộ dịch duy nhất | `lib/integrations/viettelpost/status.ts::resolveVtpStatus` | Mã số → chữ → nhóm mã → `UNKNOWN`. Không có `switch/case` rải rác. |
| Chiều đi / chiều hoàn | `leg_type` + `onReturnLeg()` | Mã 501 chiều hoàn ⇒ `RETURNED`, không phải `DELIVERED`. |
| Care tách khỏi ĐVVC | `shipment_care`, `care_case_events`, `care_business_actions`, `care_actions` | Hai chiều hoàn toàn riêng. Care **không** ghi `shipments.stage`. |
| KPI tách khỏi ĐVVC | `ORDER_OUTCOME` (`lib/queries/return-rate.ts`) | Luật COD < 100K là biểu thức đọc, **không** sửa `vtp_status_name`. |
| 1P1 | `legBaseCode()` + `LEG_RULE` | Vận đơn chiều về là **dòng riêng**, vẫn được sync đủ; đơn gốc bị đánh dấu hoàn. |
| Nhập tệp | `lib/integrations/viettelpost/import-run.ts` | Đọc XLSX/CSV, tự nhận loại tệp, giữ tệp gốc, idempotent theo `(shipment, source, status, occurred_at)`, **không hạ trạng thái** khi dòng tệp cũ hơn. |
| Sức khoẻ tích hợp | `lib/queries/integrations.ts::viettelPostHealth`, `lib/queries/logistics-freshness.ts` | Webhook 24h/7d, gửi lại, lệch ERP↔VTP, webhook chưa áp được, **mã trạng thái lạ**, độ tươi theo chặng. |

**Kết luận phần này: phần lớn Phase 2/3/5/6/7 của đề bài đã tồn tại.** Việc còn lại là bịt lỗ, không phải xây lại.

---

## 2. Nguyên nhân gốc — vì sao ERP vẫn khác Viettel Post

### RC-1 (nặng nhất). Đối chiếu qua API **không tồn tại trên thực tế**

`shipments.tracking_capability` ghi lại một sự thật đã đo: tài khoản API partner của shop **không
đọc được** vận đơn do Pancake tạo (chúng thuộc tài khoản VTP khác). Nguồn `VTP_POLL` sinh ra **0 sự
kiện từ trước tới nay**; `sync_runs` ghi "lượt thứ 548 liên tiếp API không thấy vận đơn nào".

Hệ quả: **webhook là cơ chế DUY NHẤT**. Webhook rơi một gói ⇒ ERP sai cho tới khi có ai đó nhập tệp
tay. Đề bài nói thẳng "webhook không được là cơ chế duy nhất" — và hiện tại nó đang là.

`syncViettelPostShipments` lại **không có sổ theo dõi riêng cho từng kiện**: không `next_sync_at`,
không `sync_attempts`, không `last_error`. Thứ tự tra cứu chỉ là `last_vtp_sync_at asc` — nghĩa là
một kiện "đang đi giao" (cần tra mỗi vài phút) bị xếp ngang hàng với một kiện "chờ lấy hàng" ba ngày.

### RC-2. Trạng thái ERP chưa hiểu bị **nuốt ở lớp ảnh chụp**

Sự kiện vẫn được lưu (tốt), và `viettelPostHealth().unknownStatuses` vẫn đếm được (tốt). Nhưng:

* `deriveShipmentState()` **lọc bỏ** mọi sự kiện `stage = UNKNOWN`, nên `shipments.vtp_status_name`
  giữ nguyên trạng thái CŨ. Màn hình hiện một trạng thái cũ mà **không có dấu hiệu gì** cho biết
  VTP vừa nói một câu ERP không hiểu.
* Đường nhập tệp còn tệ hơn: `applyVtpOrderList` có `if (!m.shipmentId || m.mapped.stage === "UNKNOWN") continue;`
  — dòng mang trạng thái lạ **không sinh sự kiện nào**, tức chữ gốc của ĐVVC biến mất hoàn toàn.
* Không có sổ đăng ký trạng thái: mỗi lần muốn biết "VTP đang dùng những trạng thái nào" phải
  `group by` trên bảng sự kiện, và trạng thái đã biết không phân biệt được với trạng thái mới.

Đây chính là điều kiện nghiệm thu số 4 của đề bài ("Unknown status không bị mất") đang KHÔNG đạt ở
mức người dùng nhìn thấy.

### RC-3. Không biết trạng thái đang hiển thị **đến từ đâu**

`shipments` không có cột nào nói "ảnh chụp này do webhook / đối chiếu / nhập tệp quyết định".
`deriveShipmentState()` tính ra `decidedBy` rồi **vứt đi** — không ghi xuống. Nên khi số liệu bị
nghi ngờ, không tra được nguồn mà không mở bảng sự kiện.

### RC-4. Nhập tệp thủ công **không có chạy thử**, và cửa vào nằm sai chiều

Trang nhập ĐÃ CÓ: `/import-vtp` (`VtpImportForm`), gọi chung lõi `runVtpDataFileImport` với luồng
Gmail. Hai chỗ hở:

* **Không có chạy thử.** Chọn tệp là ghi thẳng. Nhập tệp là đường duy nhất mà một người, bằng một
  cú bấm, đổi trạng thái hàng trăm vận đơn bằng nội dung một tệp chưa ai đọc — mà đúng lúc API mù
  và webhook rơi thì đây lại là đường cứu duy nhất.
* **Cửa vào nằm ở chiều TIỀN.** Chỉ `/cod` và `/reports/returns` trỏ tới nó; `/shipments` — nơi
  người ta PHÁT HIỆN ra trạng thái sai — không có liên kết nào.
* **Không có sổ lần nhập.** Ai nhập tệp nào, lúc nào, đổi bao nhiêu dòng: chỉ còn trong
  `audit_logs` dưới dạng một dòng mỗi lượt, không tra được theo tệp và không có checksum nên
  "đã nhập tệp này chưa" là câu không trả lời được.

### RC-5. Không có nhật ký hợp nhất cho MỘT vận đơn

Sáu bảng cùng kể chuyện về một kiện (`shipment_events`, `care_case_events`, `care_business_actions`,
`care_actions`, `carrier_action_requests`, `audit_logs`). `getOrderTimeline()` gộp theo ĐƠN, không
theo VẬN ĐƠN, và **không gồm hành động của người**. Muốn biết "ai đã làm gì, lúc nào, và sau đó VTP
có đổi không" thì phải mở sáu chỗ.

### Những nghi vấn đã kiểm tra và **loại trừ**

* *Webhook trả chậm?* Không — xử lý nằm trong `after()`, phản hồi trả ngay.
* *Gói tin bị từ chối vì lược đồ?* Không — không có zod ở cửa webhook; `normalizeTracking` chịu được
  trường thiếu, và gói tin vẫn được lưu nguyên văn kể cả khi xử lý hỏng.
* *Trùng gói tin?* Có xử lý, hai tầng (webhook `dedupe_key` và `shipment_events` unique).
* *Sự kiện đến sai thứ tự?* Có xử lý — thắng theo `occurred_at`, không theo lượt ghi.
* *Dùng `received_at` thay mốc ĐVVC?* Không — `occurred_at` là mốc VTP, `created_at` là mốc ERP.
* *Cron ghi đè trạng thái mới bằng trạng thái cũ?* Không — chỉ `materializeShipmentState()` ghi `stage`.
* *Pancake đè dữ liệu VTP?* Không — `CARRIER_EVENT_SOURCES` loại `PANCAKE` khỏi quyền kết luận.

---

## 3. Việc phải làm (và chỉ những việc này)

1. **Chữ gốc của ĐVVC không bao giờ bị nuốt** — cột `vtp_raw_*` trên `shipments` ghi ở MỌI lượt nạp
   kể cả khi không dịch được; sổ đăng ký `vtp_status_registry` cho mọi mã/tên đã từng thấy.
2. **Ghi nguồn quyết định ảnh chụp** — `shipments.vtp_sync_source`.
3. **Đối chiếu có lịch riêng cho từng kiện** — `vtp_next_sync_at` / `vtp_sync_attempts` /
   `vtp_last_error`, nhịp theo độ nóng của chặng, lùi dần khi lỗi.
4. **Nhập tệp VTP có CHẠY THỬ + cửa vào từ `/shipments`** — xem trước rồi mới ghi, có sổ lần nhập
   (`vtp_import_batches`: tên tệp, checksum, ai, lúc nào, đổi bao nhiêu). Mở rộng trang
   `/import-vtp` đã có, KHÔNG dựng trang thứ hai.
5. **Nhật ký hợp nhất theo VẬN ĐƠN** — ĐVVC · hệ thống · người · nhập tệp · KPI, có TRƯỚC → SAU.

Không đụng: `ORDER_OUTCOME`, `RETURN_RULE`, `shipment_stage` enum, luồng care, các báo cáo tiền.
