# Operational Care Engine — hợp đồng backend (chốt 11/09/2026)

Backend cho "Vận đơn & care". UI mới chỉ gọi đúng service / Server Action dưới đây; không tự tính.
Kiểu ở `lib/care/contracts.ts` — **thêm được trường, không đổi tên / đổi nghĩa**.

## 1. Hai chiều tách tuyệt đối

| Chiều | Nguồn | Ai ghi |
|---|---|---|
| `carrier_status` = `shipments.stage` + sự kiện ĐVVC | chứng từ Viettel Post | chỉ `materializeShipmentState` |
| `care_status` = `shipment_care.care_status` | đội làm tới đâu | chỉ `lib/care/service.ts` |

Đội bấm RESOLVED không đổi chặng ĐVVC. Kiện được giao không tự đóng case — nó chỉ **rời hàng đợi**
(điều kiện cần care hết); lịch sử giữ nguyên.

## 2. Vòng đời case (`CARE_TRANSITIONS`)

```
NEW → ASSIGNED → IN_PROGRESS → WAITING_CUSTOMER | WAITING_CARRIER | WAITING_REDELIVERY
                             → RESOLVED | ESCALATED | CANCELLED
RESOLVED / CANCELLED  —reopen→  ASSIGNED (còn người) | NEW
```

Tự động: giao người cho NEW ⇒ ASSIGNED; bỏ người khỏi ASSIGNED ⇒ NEW; note trên NEW/ASSIGNED ⇒
IN_PROGRESS; hẹn theo dõi trên NEW/ASSIGNED/IN_PROGRESS ⇒ WAITING_* (mặc định WAITING_CUSTOMER).
Đổi trạng thái sai đường ⇒ bị bỏ qua và nêu lý do trong `skipped` (hàng loạt không hỏng cả mẻ).

## 3. Lịch sử chỉ-thêm (`care_case_events`)

Mỗi hành động một dòng: `actor`, `source` (UI/API/AI/SYSTEM), `action` (STATUS · ASSIGN · NOTE ·
FOLLOW_UP · RESOLVE · REOPEN · CANCEL · CARRIER_REQUEST · CARRIER_RESULT · CARRIER_MANUAL), `note`,
`previousStatus → nextStatus`, `previousOwner → nextOwner`, `followUpAt`, ảnh chụp `sla`, `payload`,
`createdAt`. Kèm một dòng `audit_logs` (`care.<action>`). Không có API sửa / xoá.

## 4. Đọc (`lib/queries/care-workbench.ts`)

| Hàm | Trả về | Ghi chú |
|---|---|---|
| `getCareQueue()` | `CareQueue` | **actionable population**: `cases` (CUSTOMER_ACTION + CARRIER_ACTION + đã đóng 7 ngày), `dataGaps` (DATA_FRESHNESS, không phải backlog), `counts`, `byReason`, `byOwner`, `moneyAtRisk`, `overdue`, `unassigned`. Đệm 30 giây; mọi ghi xoá đệm. |
| `getCareCaseDetail(shipmentId)` | `CareCaseDetail \| null` | đơn + khách + lần gửi + hành trình thô + COD + care + `events` + care actions + yêu cầu ĐVVC + `capabilities` từng hành động |
| `getCareEvents(shipmentId)` | `CareEvent[]` | mới nhất trước |
| `getCareReport(period)` | `CareReport` | `lib/queries/care-report.ts` |

Góc nhìn (`careViewOf`, thuần, dùng được ở client): NEW/ASSIGNED/IN_PROGRESS ⇒ `care`; WAITING_* ⇒
`waiting`, tới hạn `followUpAt` ⇒ `care`; ESCALATED ⇒ `escalated`; RESOLVED/CANCELLED ⇒ `done`, nhưng
`queueSince > doneAt` ⇒ mở lại ⇒ `care` + `reopened`.

SLA (`slaOf`): phản hồi đầu 2 giờ, đóng/escalate 24 giờ, tính từ `queueSince` (lần giao hụt gần nhất
→ tin cuối). Kiện DATA_FRESHNESS không tính SLA care.

## 5. Ghi (`lib/care/service.ts`; Server Action `lib/actions/care-workbench.ts`)

Mọi hàm nhận `actor: CareActor` (service) — Server Action tự lấy từ phiên và kiểm quyền
(`shipments:view` cho care, `shipments:manage` cho ĐVVC). Kết quả `CareResult<T>`.

| Hàm | Input | Output |
|---|---|---|
| `setCareStatus` | `{ shipmentIds[], status, note? }` | `CareBulkResult` |
| `reopenCase` | `{ shipmentId, note? }` | `CareState` |
| `setCareOwner` | `{ shipmentIds[], ownerId \| null }` | `CareBulkResult` |
| `setCareFollowUp` | `{ shipmentId, at \| null, waitingFor? }` | `CareState` |
| `addCareNote` | `{ shipmentId, note, kind? }` | `CareState` |
| `requestCarrierAction` | `{ shipmentId, actionKey, note?, edit? }` | `{ request: CarrierRequestView; message }` |
| `markCarrierManualDone` | `{ requestId, note? }` | `CarrierRequestView` |

Client vá dòng bằng `CareState` trả về + `careViewOf` / `slaOf`; không cần tải lại trang.

## 6. Yêu cầu ĐVVC

Xem `docs/vtp-capability-matrix.md`. Không bao giờ ghi thành công trước khi ĐVVC xác nhận bằng sự kiện.

## 7. Báo cáo (`CareReport`)

Backlog (theo lý do, theo người, dataGaps riêng) · phản hồi đầu · đóng trong SLA · mở lại · giao hụt →
kết cục chia **có can thiệp / không** · phát lại thành công · yêu cầu ĐVVC theo trạng thái · theo nhân
viên xếp theo COD cứu được. **Attribution chặt**: can thiệp = hành động care của người ghi SAU lần giao
hụt và TRƯỚC sự kiện giao/hoàn; hành động ghi sau kết cục không tính công; không suy ngược từ dữ
liệu thiếu actor.

## 8. Detector (hàng đợi Cần xử lý)

Cùng kiện + cùng lý do = một việc (`dedupeKey` không kèm ngày, `refresh: true`); điều kiện hết ⇒ tự
đóng nhãn AUTO. Kiện im lặng là **độ tươi dữ liệu**, thân bài nói rõ "chưa phải kết luận đơn hỏng".
