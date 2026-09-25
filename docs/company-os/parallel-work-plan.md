# Company OS — Kế hoạch làm song song

> Phiên chính = **Tech Lead / Integrator**: giữ hợp đồng, theo dõi agent, gộp, mở PR, xếp thứ tự PR.
> Mỗi agent: một worktree riêng + một nhánh riêng từ `origin/main` (AGENTS.md §9), chỉ sửa tệp mình sở
> hữu (`shared-contracts.md` mục 8), chạy đủ cổng, commit tiếng Việt có dấu, ghi
> `docs/company-os/handoff-<agent>.md`. Agent KHÔNG mở PR, KHÔNG gộp, KHÔNG deploy — Tech Lead làm.

## Wave 1 — chạy ngay (không phụ thuộc nhau)

### Agent A — Sổ mẫu · vòng đời · sự kiện · `/models` khung  (P0, đường găng)
Nhánh `claude/cos-a-model-foundation` · migration `0131`.
1. `product_models`, `product_model_state_history`, `domain_events` (hợp đồng mục 1–2).
2. `lib/constants/model-lifecycle.ts`, `lib/constants/domain-events.ts`, `lib/events/emit.ts`,
   `lib/models/service.ts`, `lib/queries/models.ts`, `lib/actions/models.ts`.
3. `/models` (danh sách + nút đồng bộ sổ + danh sách mã mơ hồ) và `/models/[id]` (đầu trang, chuyển
   trạng thái có lý do, giai đoạn quan sát ƯỚC TÍNH, lịch sử, dòng thời gian). Liên kết từ `/products/[id]`.
4. Quyền `models:view` / `models:write`; khai module ở `department-modules.ts`.
5. Kiểm thử: bảng cạnh, lý do bắt buộc, append-only (quét mã nguồn: không UPDATE/DELETE lịch sử và sự
   kiện), dedupe sự kiện, sổ khai `LIVE` trỏ tệp có thật, `planModelRegistry` với mã trùng ⇒ AMBIGUOUS.

### Agent B — Creative ↔ Ads theo mẫu  (P1)
Nhánh `claude/cos-b-creative-ads` · không migration.
1. FIX đếm đơn creative bỏ sót đường post→ad (dùng `ORDER_AD_ID`).
2. FIX `/ads/daily` chiều adset/ad in chi tiêu "chưa biết" dù đã có độ mịn ad (đối chiếu
   `ADS_DIMENSION_HAS_SPEND`).
3. EXTEND tab thư viện creative: lọc theo mẫu và khoảng ngày.
4. BUILD `lib/queries/model-ads.ts`: `getModelAdsSummary`, `getModelCreativeSummary` (chỉ gọi truy vấn có sẵn).
5. Hiện CPO / doanh thu làm BẰNG CHỨNG cạnh phán quyết creative — KHÔNG đổi ngưỡng WIN.

### Agent D — Sổ kho an toàn · trạng thái tồn  (P0/P2)
Nhánh `claude/cos-d-inventory` · migration `0132`.
1. FIX xoá phiếu kho: chặn xoá phiếu RETURN đang gắn phiếu kiểm hoàn (chỉ đường gỡ có sẵn), xoá phiếu
   đi qua duyệt hai bước như ADJUSTMENT/ISSUE, `audit()` mang ảnh chụp đầy đủ trước khi xoá.
2. FIX tổng tồn trang chủ cộng cả dòng âm: tách dòng âm thành con số riêng.
3. Cột `stock_receipts.production_order_id` / `production_batch_id` (NULL được) + ô chọn trên form nhập.
4. `getModelStockStates(productId)` (hợp đồng mục 6).
5. Ngưỡng chậm/chết/tồn dư vào `settings` (`inventory.slowMoving`), mặc định LẤY TỪ hằng số đang chạy.

### Agent F — Kinh tế theo mẫu  (P1/P3)
Nhánh `claude/cos-f-economics` · migration `0133`.
1. CPO hoà vốn / trần QC mỗi đơn trên bảng quyết định `/ads` — MỘT công thức với `adsCeiling` hoặc
   chứng minh bằng kiểm thử hai đường ra cùng số.
2. Lưu lợi nhuận DỰ PHÓNG vào `ads_decision_ledger` để đo độ chính xác dự báo sau này.
3. `lib/queries/model-economics.ts`: `getModelEconomics` (ước tính vs thực đạt, cạnh nhau, có nhãn).
4. Báo cáo chênh lệch giá sản xuất: giá báo MKT · giá ước tính · giá PO · giá thực xưởng · giá phiếu nhập.

### Agent G — Control plane: duyệt · audit · quan sát job  (P0)
Nhánh `claude/cos-g-control-plane` · migration `0134`.
1. FIX duyệt hai bước: yêu cầu đã duyệt được TIÊU THỤ đúng một lần khi người yêu cầu thực hiện lại
   (không đẻ yêu cầu mới), ghi `EXECUTED` + `executed_at`; `EXPIRED` theo hạn.
2. Màn hình bật/tắt `approval.enforce` (chỉ ADMIN; BẬT là việc của chủ shop).
3. Quyền `approvals:decide` giữ nguyên tập người đang duyệt được.
4. Nguồn việc `APPROVAL` trên `/work`.
5. `audit_logs`: cột `actor_kind`, `correlation_id`, `reason`; lỗi ghi audit in `console.error` thay vì nuốt.
6. Bọc `alerts`, `work-recurrence`, `work-escalation`, `work-snapshot`, `dashboard-warm` bằng `runSyncJob`.

## Wave 2 — bắt đầu khi PR của A đã vào `main`

- **Agent C — Sản xuất nửa đầu**: topic + trao đổi, costing phiên bản, sample + duyệt, bản thiết kế bất
  biến, PO trỏ bản duyệt (cờ), lưu gợi ý máy vs số người chốt, `getModelProductionSummary`, nguồn việc
  `PRODUCTION_TOPIC` / `SAMPLE_REVIEW`, quyền `production:*`. Chuyển vòng đời qua `transitionModelCore`.
- **Agent E — Hoàn**: kết quả SỬA LẠI / HUỶ nối sổ kho; `return.disposition_set`.
- **Agent A2 — Trang 360 đủ khối**: ráp hàm đọc của B/D/F/C; `getModelSignal`; `/ideas` → mẫu IDEA.

## Wave 3

- **Agent H — Cockpit "Cần anh quyết"** + lưu quyết định đề xuất (`recommendation.decided`).
- **Agent QA — E2E vòng đời** trên PGlite: tạo mẫu → creative → chi QC → đơn → WINNER → topic → costing
  → sample → duyệt → PO → nhập kho → đơn → vận đơn → giao → lợi nhuận → hoàn → tái nhập → kiểm tồn.
- **Vòng phản hồi xả tồn → creative/ads** (B + H).

## Thứ tự PR

Mỗi agent MỘT PR theo mạch việc (không PR vụn). Tech Lead gộp theo thứ tự: G → A → D → F → B (G và A
trước vì là nền; D/F/B độc lập, ai xong trước gộp trước). Trước mỗi PR: rebase lên `origin/main`, đánh
số lại migration nếu trùng, chạy cổng trên cây sạch, kiểm đột biến các hàng rào mới.

## Trạng thái

| Agent | Wave | Trạng thái | PR |
|---|---|---|---|
| A | 1 | đang làm | — |
| B | 1 | đang làm | — |
| D | 1 | đang làm | — |
| F | 1 | đang làm | — |
| G | 1 | đang làm | — |
| C, E, A2 | 2 | chờ A | — |
| H, QA | 3 | chờ Wave 2 | — |
