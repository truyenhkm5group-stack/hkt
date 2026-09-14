# Handoff cho phiên UI (Claude Opus 5) — Care Engine + AI Copilot backend

Nhánh backend: `claude/serene-hopper-bsfnnh` (Fable). **Chưa merge main, chưa deploy** — theo thoả
thuận làm song song. UI mới hãy dựng trên các hợp đồng dưới đây; không gọi CSDL trực tiếp.

## Đã xong ở backend

1. Vòng đời care chuẩn + bảng chuyển trạng thái: `lib/constants/care.ts` (`CARE_STATUSES`,
   `CARE_TRANSITIONS`, `canTransition`, nhãn/tooltip/tone cho từng trạng thái, `CARE_VIEWS`).
2. Lịch sử chỉ-thêm `care_case_events` (migration `0061_care_lifecycle`), yêu cầu ĐVVC ACK →
   ACKNOWLEDGED, thêm `raw_request`, `attempts`.
3. Hợp đồng kiểu: `lib/care/contracts.ts` — `CareQueue`, `CareCase`, `CareCaseDetail`, `CareEvent`,
   `CareState`, `CarrierRequestView`, `CarrierCapabilityView`, `CareResult`, `CareBulkResult`.
4. Đọc: `getCareQueue()`, `getCareCaseDetail(id)`, `getCareEvents(id)`, `getCareReport(period)`.
5. Ghi (Server Actions `lib/actions/care-workbench.ts`): `setCareStatus`, `reopenCase`,
   `setCareOwner`, `setCareFollowUp`, `addCareNote`, `requestCarrierAction`, `markCarrierManualDone`.
   Mọi hàm trả về mảnh trạng thái mới để vá tại dòng.
6. Ma trận năng lực Viettel Post: `docs/vtp-capability-matrix.md`, `carrierCapabilitiesFor()` — UI chỉ
   vẽ nút theo `CarrierCapabilityView.status`; `PERMISSION_MISSING`/`WEB_ONLY` hiện "làm tay" + `webUrl`.
7. Detector giao thất bại dedupe theo kiện (không kèm ngày).
8. AI Copilot backend: xem `docs/handoff-ai-copilot.md`.

## Điểm UI hiện tại cần đổi khi dựng mới

- `app/(dashboard)/shipments/workbench.tsx` đang dùng `CareWorkbench` (= `CareQueue`) và các trạng thái
  cũ đã được đổi tối thiểu để build xanh; UI mới nên đọc `CareQueue.cases` (actionable) và
  `CareQueue.dataGaps` riêng, hiện `byReason` làm chip, `byOwner` làm bộ lọc.
- Đổi trạng thái: chỉ đưa ra các đích trong `CARE_TRANSITIONS[current]`; case RESOLVED/CANCELLED dùng
  `reopenCase`.
- Hẹn theo dõi: `setCareFollowUp({ waitingFor })` để chọn chờ khách / ĐVVC / phát lại.
- Bulk: `setCareStatus` / `setCareOwner` với mảng id; đọc `skipped` để báo kiện nào không đổi được.

## Luật không được phá

- Không viết `shipments.stage` từ UI/AI. Không suy "đã giao" từ care_status.
- Không sửa / xoá `care_case_events`, `care_actions`, `carrier_action_requests`.
- Không đánh dấu yêu cầu ĐVVC là thành công khi chưa có sự kiện xác nhận.
