# Company OS — Bàn giao Agent QA (kiểm thử E2E một vòng đời mẫu)

Nhánh `claude/cos-qa-e2e` (= mọi gói Company OS A–G đã gộp trên `main`). Không migration.

## Bài kiểm

`tests/company-os-e2e-lifecycle.test.ts` — đăng ký ở CUỐI `main()` của `tests/sync-fixtures.test.ts`
(sau `testFeedAutomation`, để không đổi tổng của bài nào khác):

- `testCompanyOsE2ePure()` — khoá mức đơn vị cho hai lỗi bài E2E tìm ra (nhãn + chiều của sự kiện).
- `testCompanyOsE2eLifecycle(db)` — MỘT mẫu `COSQA-01` đi hết 11 bước trên PGlite.

Chạy: `npm test` (dòng `✓ QA-1 … QA-11`). Chạy riêng khi sửa: tạo một tệp chạy tạm gọi
`ensureMigrated()` + hai hàm trên (xem đầu `tests/sync-fixtures.test.ts`), rồi XOÁ tệp ấy — bài
`dang-ky-bai-kiem` bắt tệp kiểm thử không đăng ký.

### Đường ghi được dùng

| Nguồn | Đường trong bài |
|---|---|
| Sản phẩm Pancake | `mapProduct` + `upsertProduct` (đường đồng bộ thật) |
| Sổ mẫu / vòng đời | `syncModelRegistry`, `transitionModelCore`, `setModelOwnerCore` |
| Creative · QC · đơn | chèn thẳng `creative_batches/variants`, `fb_ads`, `ad_spends` (hạt mẩu), `orders` (bên ngoài: Facebook / Pancake) |
| Sản xuất | `createTopicCore`, `addTopicMessageCore`, `setTopicStatusCore`, `create/update/finalizeCostSheetCore`, `createSampleCore`, `submitSampleCore`, `reviewSampleCore`, `savePoPlanCore`; gợi ý máy từ `buildMatrixForProduct` |
| Kho | `validateProductionLink` + ghi phiếu như `createStockReceipt` (không có lõi riêng) |
| Viettel Post | `normalizeTracking` + `applyVtpTracking` (đường webhook thật), bảng kê `applyStatementDetailRows` |
| Hàng hoàn | `markReturnsArrived`, `recordItemInspection`, `setReturnDispositionCore`, `deleteStockReceiptCore` |
| Duyệt hai bước | `setEnforceGroupCore`, `guardSecondApprovalCore` (làm cổng thật cho lõi của D và E), `decideApprovalCore`, `consumeApprovedRequest` |
| Đọc | `modelCreativeSummary`, `variantMetrics`, `getModelAdsSummary`, `getModelProductionSummary`, `getModelStockStates`, `getModelReturnDispositions`, `getModelEconomics`, `getAdsDecision`, `ORDER_OUTCOME(_VERIFIED)`, work adapters, `collectWorkItems`, `getModelEvidence`, `getModelTimeline` |

Quyền duyệt (`production:approve`, `approvals:decide`) đọc bằng `can(role, …)` của chính ERP rồi truyền
vào lõi như server action truyền.

### Đồng hồ (luật 50, 65)

Lõi phát `domain_events` bằng đồng hồ thật (`emitDomainEvent` mặc định `new Date()`), nên mọi mốc bài
gieo cũng đi theo đồng hồ thật, lấy tại bước gieo qua `tick()` đơn điệu; mốc ĐVVC làm tròn lên giây kế
tiếp. Kỳ báo cáo = hôm qua → ngày mai theo giờ VN, dựng từ chính lúc chạy. Không mốc tuyệt đối, không
cửa sổ "N giờ trước" trỏ vào ngày cố định. Các khẳng định thứ tự dùng `≤` (hai sự kiện cùng giao dịch
có thể trùng mili giây).

### Dọn

`finally` xoá mọi dòng `cosqa-` / mã `COSQA…` (kể cả bảng append-only — CSDL kiểm thử dùng một lần;
append-only khoá bằng quét mã nguồn), mẫu mà lượt đồng bộ sổ của bài tạo thêm cho sản phẩm khác của
CSDL dùng chung, và trả lại hai khoá `settings` (`approval.enforce.v2`, `production.requireApprovedDesign`)
đúng giá trị trước bài. Ngoại lệ đã biết: `vtp_status_registry` là sổ đếm theo (mã, chữ) dùng chung — lượt
webhook chỉ cộng số lần quan sát của mã đã có, không có dòng mang tiền tố để xoá.

## 11 bước

| # | Bước | Kết quả |
|---|---|---|
| 1 | Pancake `COSQA-01` → `syncModelRegistry` ⇒ đúng 1 mẫu, `lifecycle_state` NULL, `registered_by SYNC`; đồng bộ lại 0 dòng; khai NULL → ADS_TESTING phải có lý do | PASS |
| 2 | Creative nối mẩu QC; chi 200.000 ₫ hạt mẩu; O1 qua `ad_id`, O2 qua bài viết ⇒ creative đếm 2 đơn (1 qua bài), chi 200.000, CPO 100.000; `getModelAdsSummary` OK, chi 200.000, 2 đơn, CPO 100.000 | PASS |
| 3 | WINNER (người) → topic ⇒ PRODUCTION_DISCUSSION (SYSTEM, trỏ `production_topic.created`); 6 lượt trao đổi; giá V1 nháp 115.000 / V2 chốt 120.000 (V1 còn, V2 sửa bị chặn, LEADER không chốt được); mẫu V1 yêu cầu sửa (ghi chú bắt buộc), V2 duyệt bởi MANAGER ⇒ bản thiết kế trỏ giá CHỐT; lịch sử 12 bước liền mạch (USER khai · SYSTEM trỏ sự kiện gây ra); sổ sự kiện đếm đúng từng tên (40 dòng) dù đã phát lại / bấm hai lần / lưu lại / đồng bộ lại | PASS |
| 4 | Lệnh SX trỏ bản duyệt; gợi ý máy tính ở máy chủ, lệch ⇒ lý do bắt buộc, `suggested_cells` + `override_reason` lưu; cờ tắt = cảnh báo, cờ bật = lệnh chưa trỏ bản duyệt bị chặn ở DRAFT → SENT | PASS (xem G1) |
| 5 | Phiếu RECEIPT nối lệnh ⇒ tồn thực tế 20/10, `stockKnown`, khả dụng trừ đã chốt; tóm tắt SX thấy 30/30 đã nhận | PASS (B1 đã sửa: đang sản xuất = 0 ngay sau phiếu nối lệnh, khẳng định chính xác) |
| 6 | Webhook VTP: Pancake "đã gửi" KHÔNG trừ tồn; lấy hàng trừ đúng số rời kho; O1 501 + bảng kê 350.000 ⇒ DELIVERED/DELIVERED (trước bảng kê: DELIVERED/UNVERIFIED); O2 505 → 504 ⇒ RETURNED; O3 ⇒ AWAITING_PICKUP; hàng hoàn chưa vào tồn; creative thấy O1 giao · O2 hoàn | PASS |
| 7 | Về kho (chờ kiểm M1 · L2) → kiểm từng món: M đủ ⇒ phiếu RETURN +1; L hỏng 2 ⇒ REWORK → nhập lại 1 (đúng một phiếu, gửi lại cùng khoá không nhân đôi) + huỷ 1 qua cổng duyệt THẬT (cưỡng chế bật, 120.000 ₫ dưới ngưỡng ⇒ `approval.skip`); tồn 28, hỏng 0; xoá phiếu nhập lại sau sửa bị chặn có thông điệp, 0 dòng nhật ký; tóm tắt kết cục của mẫu khớp | PASS |
| 8 | `getModelEconomics`: 12 dòng Ước tính cạnh Thực đạt; thực đạt 3 đơn, DT giao 350.000 (đúng đơn DELIVERED theo `ORDER_OUTCOME`), GTC 50%, chi 200.000; CPO hoà vốn = `maxAdCostPerOrder` trên cùng đầu vào; LN ròng thực đạt `null` kèm lý do | PASS |
| 9 | Công tắc v2 (chỉ ADMIN) bật INVENTORY_ADJUSTMENT → xoá phiếu điều chỉnh ⇒ PENDING (bấm lại không đẻ yêu cầu thứ hai) → người xin không tự duyệt → MANAGER duyệt → làm lại ⇒ EXECUTED, phiếu xoá, tồn về → lần sau là yêu cầu MỚI; việc APPROVAL hiện rồi biến mất; nhật ký có `actor_kind`, `reason`, `correlation_id` | PASS |
| 10 | PRODUCTION_TOPIC · SAMPLE_REVIEW · RETURN_DISPOSITION · APPROVAL hiện khi mở, tự rời khi miền đóng; chỉ nút MỞ; 0 dòng `work_items` | PASS |
| 11 | `getModelTimeline`: mới nhất trước; đúng thứ tự vào sổ → đơn đầu → topic → giá chốt → duyệt mẫu → lệnh SX → gửi xưởng → nhập hàng → nhận lệnh → kết cục hàng hoàn; mọi sự kiện có nhãn và đứng đúng chiều | PASS (sau khi sửa A1, A2) |

## Lỗi tìm được

### Đã sửa (cục bộ, có khẳng định mức đơn vị trong `testCompanyOsE2ePure`)

- **A1 · `return.disposition_set` thiếu nhãn** — Agent E chuyển sự kiện sang LIVE nhưng
  `DOMAIN_EVENT_LABEL` (`lib/constants/domain-events.ts`) không có dòng nào ⇒ trang 360 in mã thô
  "return.disposition_set". Thêm nhãn "Kết cục hàng hoàn không tái nhập". Bài thuần: mọi sự kiện LIVE
  phải có nhãn.
- **A2 · mọi sự kiện miền trên dòng thời gian mẫu mang chiều "Vòng đời"** — `getModelTimeline`
  (`lib/queries/models.ts`) gán cứng `dimension: "LIFECYCLE"`, viết từ Wave 1 khi chỉ có `model.*`.
  Sau C/E, "Chốt giá thành", "Mẫu được duyệt", "Kết cục hàng hoàn" đều mang huy hiệu "Vòng đời". Nay
  `domainEventDimension(name)` suy chiều từ `subjectType` đã khai trong sổ sự kiện (sản xuất →
  PRODUCTION, `return_inspection`/`stock_receipt` → INVENTORY, còn lại LIFECYCLE như cũ).

### Còn mở

- Không còn lỗi mở từ bài vòng đời. (B1 đã sửa — xem dưới.)

### Đã sửa sau khi bàn giao QA

- **B1 · "Đang sản xuất" đếm trùng hàng đã nhận qua phiếu nối lệnh — ĐÃ SỬA (Tech Lead quyết, Agent D
  làm).** `openPoQtyByVariant()` nay trừ số đã nhập qua phiếu `RECEIPT` nối lệnh
  (`stock_receipts.production_order_id`) theo từng mẫu mã (dùng lại phép ghép ô "màu|size" có sẵn);
  lô xưởng trừ phiếu nối lô (`production_batch_id`) trong `openBatchQtyByVariant`. MỘT phép trừ cho mọi
  nơi đọc: `openQtyAfterReceived` (lib/constants/workshop-ledger.ts) — đã trả (sổ công nợ) và đã nhập
  (chứng từ tồn) lấy SỐ LỚN HƠN, không cộng. Lệnh/lô không có phiếu nối (toàn bộ dữ liệu production hôm
  nay — cột mới từ 0132) ra ĐÚNG số như trước; có kiểm thử khoá. Bước 5 nay khẳng định chính xác
  `inProduction = 0` cho M, L và tổng mẫu thay cho dòng `⚠ CHƯA ĐẠT`.

### Chỗ hở của phạm vi kiểm (không phải lỗi, nói ra để không ai tưởng đã kiểm)

- **G1 · Ba thao tác của người không có lõi dịch vụ**: lập lệnh SX (`saveProductionOrder`), đổi trạng thái
  lệnh (`setProductionStatus` — nơi áp cờ bản duyệt), lập phiếu kho (`createStockReceipt`). Bài dựng lại
  phần kiểm của chúng bằng chính các hàm chúng gọi (`checkSendWithoutDesign` + `requireApprovedDesignFlag`,
  `validateProductionLink`) rồi ghi như action; vì vậy "cờ bật chặn SENT" được kiểm ở mức HỢP THÀNH, không
  qua action. Đề xuất tách lõi (`setProductionStatusCore`, `createStockReceiptCore`).
- **G2 · Đường "duyệt xong mới huỷ" của E + G chưa chạy trong bài**: lượt huỷ 120.000 ₫ dưới ngưỡng
  1.000.000 ₫ nên cổng cho qua (đã kiểm vết `approval.skip`). Đường vượt ngưỡng → chờ → duyệt → tiêu thụ
  chỉ được chạy với lõi xoá phiếu của D (bước 9).
- `stock_receipt.linked_production` và `approval.executed` vẫn RESERVED — nối phiếu với lệnh và tiêu thụ lời
  duyệt không để lại sự kiện miền; dòng thời gian vẫn chiếu phiếu nhập từ `stock_receipts`.

## Cổng

Windows, cây `wt-cos-qa`: `npm run typecheck` sạch · `npm run lint` sạch · `npm test` in **TẤT CẢ KIỂM THỬ ĐẠT** (bài QA chạy trên CSDL dùng chung, lượt đồng bộ sổ của bài đăng ký thêm 6 mã của fixture khác và dọn lại; năm dòng ⚠ CHƯA ĐO ĐƯỢC trên win32 là của các bài ops/flock có sẵn) · `npm run build` thoát 0. Chưa chạy cổng trên bản checkout sạch theo SHA (AGENTS.md §9) — việc của Tech Lead lúc gộp.
