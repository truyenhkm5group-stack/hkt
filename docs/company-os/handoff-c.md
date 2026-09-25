# Company OS · Agent C — Bàn giao: sản xuất nửa đầu (topic → giá thành → mẫu → bản duyệt → lệnh SX)

Nhánh `claude/cos-c-production` (từ `origin/claude/cos-nen-mau-va-kho` dba26e0d) · migration
`0136_company_os_production` (journal `when` = 1790006000000 theo chỉ đạo Tech Lead, muộn hơn 0133 của F) ·
hợp đồng `docs/company-os/shared-contracts.md` mục 5 (C viết).

## 1. Đã dựng

| Phần | Tệp |
|---|---|
| Lược đồ: 7 bảng (khối cuối `db/schema.ts` `// ═══ Company OS · Agent C · sản xuất nửa đầu ═══`) + 3 cột trên `production_orders` (sửa tại chỗ, + chỉ mục một phần) | `db/schema.ts`, `drizzle/0136_company_os_production.sql`, `drizzle/meta/_journal.json` |
| Luật thuần: trạng thái / nhãn / màu topic, mẫu, giá thành · `checkTopicTransition` · `computeCostSheet` (hao hụt %) · `checkSampleReview` · `checkCostFinalize` · `LIFECYCLE_FOLLOW` + `lifecycleTarget` · `diffCells` / `checkOverride` · `checkSendWithoutDesign` · `designWarning` · ánh xạ trạng thái sang hàng đợi | `lib/constants/production-os.ts` |
| Lõi dịch vụ (không `"use server"`, nhận `Actor`): topic · giá thành · mẫu + duyệt + bản thiết kế · lệnh SX (bản duyệt / gợi ý / lý do) · vòng đời đi theo | `lib/production/{topics,costing,samples,orders,lifecycle}.ts` |
| Server action: `createProductionTopic`, `addProductionTopicMessage`, `setProductionTopicStatus` · `createCostSheet`, `updateCostSheetDraft`, `finalizeCostSheet` · `createSample`, `updateSample`, `submitSample`, `reviewSample` | `lib/actions/production-{topics,costing,samples}.ts` |
| Lệnh SX: `saveProductionOrder` nhận `designVersionId` · `fromSuggestion` · `suggestionBasis` · `overrideReason`; máy chủ tính lại gợi ý; `setProductionStatus` áp cờ bản duyệt | `lib/actions/production.ts` (sửa tại chỗ) |
| Truy vấn: danh sách topic, bàn sản xuất của mẫu, chi tiết topic, cờ `requireApprovedDesignFlag`, bản duyệt cho lệnh | `lib/queries/production-os.ts` |
| Hàm đọc cho trang 360: `getModelProductionSummary(modelId)` | `lib/queries/model-production.ts` |
| Sổ sự kiện: 11 tên C chuyển `LIVE` + tên mới `sample.submitted`, nhãn dòng thời gian | `lib/constants/domain-events.ts` (khối C), `tests/company-os-models.test.ts` (một dòng trong danh sách hợp đồng) |
| Quyền `production:write`, `production:approve`; `production:approve` vào `ROLE_BUILDER_FORBIDDEN` kèm lý do riêng | `lib/auth/permissions.ts`, `lib/constants/access-scope.ts`, `lib/validation/access.ts`, `app/(dashboard)/settings/users/roles-panel.tsx` |
| Nguồn việc `PRODUCTION_TOPIC`, `SAMPLE_REVIEW` + luật hạn / phòng + hai adapter | `lib/constants/work-sources.ts`, `work-sla.ts`, `work-ownership.ts`, `lib/queries/work-adapters.ts` |
| Màn hình `/production` (danh sách topic) · `/production/topics/new?model=<id>` · `/production/topics/[id]` · `/production/models/[id]` (bàn sản xuất của mẫu không qua topic) + khung xương | `app/(dashboard)/production/**` |
| Trình sửa lệnh SX: ô chọn bản duyệt, cảnh báo thiếu bản duyệt, bảng "máy gợi ý → người chốt" theo ô, ô lý do bắt buộc; trang lệnh in bản duyệt + gợi ý vs số chốt | `app/(dashboard)/inventory/planning/orders/{production-editor.tsx,new/page.tsx,[id]/page.tsx,[id]/edit/page.tsx}` |
| Module `/production` (phòng PRODUCTION, khai `why`), icon `MessagesSquare`, smoke | `lib/constants/department-modules.ts`, `components/app-sidebar.tsx`, `scripts/smoke.ts` |
| Nhãn nhật ký cho 10 hành động + 3 thực thể | `lib/constants/audit.ts` |
| Kiểm thử | `tests/company-os-production.test.ts` (đăng ký sau Agent D trong `tests/sync-fixtures.test.ts`), `tests/migration-upgrade-path.test.ts` (+0135: 7 bảng rỗng, lệnh cũ ba cột NULL, không dòng cờ), `tests/ui-consistency.test.ts` (form mở topic là trang không-menu có lý do) |

## 2. Hợp đồng mục 5 như đã làm

Xem `docs/company-os/shared-contracts.md` mục 5 — cột, CHECK, FK, sự kiện, vòng đời, quyền, việc, route.

## 3. Chỗ lệch đề bài / hợp đồng — và vì sao

1. **Tên sự kiện mới `sample.submitted`** (không có ở bảng mục 2). Lượt SAMPLING → SAMPLE_REVIEW khi gửi
   mẫu cần một `sourceEventId` (Q3); không tên nào đã cấp nói đúng việc đó. Thêm vào sổ khai (C, LIVE) và
   vào danh sách hợp đồng trong `tests/company-os-models.test.ts` (một dòng). **Tech Lead: cập nhật bảng
   mục 2.**
2. **Vòng đời đi theo SAU giao dịch nghiệp vụ**, không cùng giao dịch: `transitionModelCore` (Agent A) nhận
   `Db` và tự mở giao dịch. Sự kiện gây ra đã chốt trước, lượt chuyển lũy đẳng theo `sourceEventId`; hỏng
   ở bước vòng đời không huỷ hành động nghiệp vụ (vòng đời là hệ quả) và được báo lên toast/nhật ký.
   Lượt chuyển ghi `actor_kind = SYSTEM`, `actor_id = NULL`, người bấm ở `metadata.triggeredBy*`.
3. **REJECT không kéo vòng đời** (mẫu đứng ở SAMPLE_REVIEW cho tới khi người quyết); chỉ
   REQUEST_CHANGES đi SAMPLE_REVIEW → SAMPLING. Topic mở cho mẫu đang SELLING (tái sản xuất) KHÔNG kéo lùi.
4. **Bất biến của FINAL không dùng trigger**: mã (mọi UPDATE mang `status = 'DRAFT'`, dòng thay sau
   `FOR UPDATE` + kiểm DRAFT, một tệp ghi) + CHECK `cost_sheets_final_check` + bài kiểm quét mã nguồn.
   UPDATE thẳng bằng SQL tay vẫn đổi được `total_unit_cost` của bảng FINAL — muốn chặn ở CSDL thì cần
   trigger (Tech Lead quyết).
5. **`samples.supplier_id` NULL được** ("chưa chọn xưởng", in "—") — danh mục xưởng có thể chưa đủ, và bắt
   buộc sẽ chặn ghi mẫu thật. **`cost_vnd` NULL = chưa biết**.
6. **Đính kèm là URL**: không có kho ảnh chung phù hợp (`creative_images` có luật xoá điểm ảnh của mẫu
   thua; `marketing_idea_images` gắn cứng ý tưởng). Lưu `string[]` URL http(s).
7. **Gợi ý máy do MÁY CHỦ tính lại lúc lưu** (`buildMatrixForProduct` với đúng `coverDays` /
   `countIncoming` trang đã dùng), không nhận từ trình duyệt — nếu nhận thì gửi "gợi ý = số chốt" là né
   được lý do. Hệ quả: nếu kế hoạch đổi giữa lúc mở trang và lúc lưu, máy chủ báo "khác ở N ô" dù người
   chưa sửa gì — người điền lại hoặc ghi lý do. Lệnh đã có mà không bấm "Điền theo đề xuất" thì so với
   gợi ý ĐÃ LƯU. Ô của màu / size đã bỏ không còn được gửi lên (trước đây lọt vào `cells`).
8. **`getSettingJson` không đọc được boolean** (trải `{...fallback, ...parsed}` ⇒ `{}`) — cờ đọc thẳng dòng
   `settings`, chỉ JSON `true` mới bật. Không sửa `lib/settings.ts` (dùng chung).
9. **Hạn xử lý của hai nguồn việc là `null`** (cố ý không đặt): không có hằng số đang chạy nào để lấy lại
   (luật 22), gõ số mới là bịa (luật 38). Chủ shop đặt ở `work.sla`.
10. **Quyền xem màn hình sản xuất = `planning:view`** (mọi vai có qua `VIEW_ALL`), không thêm khoá xem riêng.
    `production:write` KHÔNG cho WAREHOUSE và không kéo theo từ `inventory:write`/`planning:write` (hai khoá
    đó nằm trong mẫu WAREHOUSE). Người lưu quyền tuỳ chỉnh kiểu cũ (không có ảnh chụp khoá) KHÔNG tự nhận
    hai khoá mới — hỏng về phía hẹp.
11. **Tệp ngoài danh sách sở hữu, chỉ thêm**: `lib/constants/domain-events.ts` (khối C, được giao),
    `tests/company-os-models.test.ts` (một tên), `lib/constants/access-scope.ts` + `lib/validation/access.ts`
    + `roles-panel.tsx` (lý do cấm theo từng khoá), `lib/constants/audit.ts` (nhãn), `tests/ui-consistency.test.ts`.
12. **`/production/models/[id]`** là route thêm (không có trong đề): hàng đợi "Mẫu chờ duyệt" cần một chỗ
    để mở khi phiên bản mẫu không gắn topic.

## 4. Kiểm thử

`tests/company-os-production.test.ts`:

- `testCompanyOsProductionPure`: công thức giá thành (%, không lãi kép, đảo thứ tự không đổi tổng) · luật
  duyệt mẫu / chốt giá thành · vòng đời chỉ cạnh tiến (chưa khai / SELLING không bị kéo) · lệch một ô là
  phải lý do · cờ bản duyệt tắt = cảnh báo, bật = chặn chỉ DRAFT → SENT · bản đồ trạng thái phủ hết · CHECK
  của migration = hằng số · quyền (MANAGER có cả hai, LEADER chỉ write, WAREHOUSE không; vai tuỳ chỉnh bị
  cắt ở cả lược đồ lẫn lúc tính) · nguồn việc (SOURCE, phòng theo `TEAM_DEPARTMENT`, hạn lấy từ sổ, chỉ nút
  MỞ) · quét mã nguồn: ba bảng append-only, `design_versions` chỉ INSERT ở `samples.ts`, hai bảng giá thành
  chỉ ghi ở `costing.ts`, mọi UPDATE mang DRAFT, ba cột lệnh SX chỉ ghi ở `orders.ts`, giá ước tính chỉ một
  người ghi (`lib/actions/estimated-cost.ts`), action đọc `can(user,"production:approve")`, lõi không
  `"use server"`, lệnh SX kiểm lý do TRƯỚC cổng duyệt, không truy vấn lợi nhuận/giá vốn/tồn nào đọc bảng C.
- `testCompanyOsProductionDb` (PGlite): luồng đủ topic → 5 lượt trao đổi → V1 nháp / V2 chốt (V1 còn, V2
  không sửa được, CHECK chặn FINAL không người chốt) → mẫu V1 yêu cầu sửa (ghi chú bắt buộc, một phán quyết,
  UNIQUE + CHECK ở CSDL) → V2 duyệt ⇒ bản thiết kế V1 (ảnh chụp mang giá thành V2 + yêu cầu topic; sửa
  topic sau không đổi nó) → lệnh SX trỏ bản duyệt (từ chối bản của mẫu khác; lệch gợi ý thiếu lý do ⇒
  không ghi gì; lưu lại y hệt không đẻ sự kiện) → lịch sử vòng đời 8 bước SYSTEM, mỗi bước trỏ đúng sự kiện
  · mẫu chưa khai không có dòng lịch sử nào · việc hiện / rời hàng đợi theo nguồn · `getModelProductionSummary`
  (đã nhận = `null` khi chưa phiếu nào nối) · `listTopics` / `getTopicDetail` · cờ chỉ nhận boolean `true`.
- Không mốc tuyệt đối, không cửa sổ "N giờ trước" (luật 50, 65).

Hai lỗi thật bài kiểm bắt được khi viết: câu con tương quan `${po.id}` / `${tp.id}` sinh cột `"id"` mơ hồ
(Postgres 42702) ở `getModelProductionSummary` và `listTopics`; `getSettingJson` không đọc được boolean.

### Cổng (Windows, cây `wt-cos-c`)

- `npm run typecheck` — sạch.
- `npm run lint` — sạch.
- `npm test` — **TẤT CẢ KIỂM THỬ ĐẠT** (453 dòng ✓, gồm cả `testChatbotImportGuards`); năm dòng ⚠ "CHƯA ĐO
  ĐƯỢC trên win32" là của các bài ops/flock có sẵn, không liên quan.
- `npm run build` — thành công (`/production` 1,44 kB · `/production/topics/[id]` 1,59 kB ·
  `/production/topics/new` 4,47 kB · `/production/models/[id]` 223 B). Chạy trên commit mã 57de16a4; commit
  sau chỉ đổi bài kiểm + tài liệu.

### Kiểm đột biến (mỗi đột biến sửa MỘT chỗ, chạy lại bộ C + bộ thuần của A, rồi hoàn nguyên)

23/23 BỊ BẮT. Lượt đầu 3 đột biến LỌT (M20, M22, M23) — bài kiểm được làm chặt (thêm V3 nháp mới hơn V2 đã
chốt; quét nhánh `if ("error" in ke) return` trước cổng duyệt; hai lượt đổi trạng thái đồng thời) rồi chạy
lại: cả ba ĐỎ. Bài đua đồng thời chạy lại 3 lần liền trên PGlite: ổn định.

| # | Đột biến | Kết quả |
|---|---|---|
| M1 | Bỏ kiểm DRAFT sau khi khoá dòng cha (sửa dòng của bảng chốt) | ĐỎ |
| M2 | UPDATE `cost_sheets` không mang điều kiện DRAFT | ĐỎ |
| M3 | Duyệt không cần `production:approve` | ĐỎ |
| M4 | Yêu cầu sửa không bắt buộc ghi chú | ĐỎ |
| M5 | Vòng đời đi theo cả cạnh không phải cạnh tiến | ĐỎ |
| M6 | Thêm ngưỡng: lệch 1 ô không cần lý do | ĐỎ |
| M7 | Cờ bản duyệt hồi tố lệnh đã gửi | ĐỎ |
| M8 | Cờ bật bằng chuỗi `"true"` | ĐỎ |
| M9 | Vai tuỳ chỉnh bó được `production:approve` | ĐỎ |
| M10 | UPDATE `sample_reviews` (phá append-only) | ĐỎ |
| M11 | Bỏ khoá chống trùng sự kiện ghi đè | ĐỎ |
| M12 | Lệnh trỏ được bản duyệt của mẫu khác | ĐỎ |
| M13 | Gõ thẳng phòng PRODUCTION (bỏ route luật 69) | ĐỎ |
| M14 | Action truyền `canApprove: true` thay vì đọc quyền | ĐỎ |
| M15 | Bỏ CHECK ghi chú của lượt loại / yêu cầu sửa (migration) | ĐỎ |
| M16 | Lượt chuyển vòng đời đứng tên người bấm (USER) | ĐỎ |
| M17 | Cho mở hai phiên bản mẫu cùng lúc | ĐỎ |
| M18 | Người ghi thứ hai của giá ước tính trong lõi giá thành | ĐỎ |
| M19 | Mẫu đã có phán quyết vẫn nằm hàng đợi | ĐỎ |
| M20 | Bản duyệt trỏ bảng giá thành NHÁP mới nhất | LỌT → làm chặt bài → ĐỎ |
| M21 | Bấm hai lần ghi thêm một lượt trao đổi | ĐỎ |
| M22 | Action lưu tiếp khi kiểm lý do / bản duyệt báo lỗi | LỌT → làm chặt bài → ĐỎ |
| M23 | Bỏ hàng rào trạng thái cũ của topic | LỌT → thêm bài đồng thời → ĐỎ |

Sau khi hoàn nguyên cả 23: xanh (`git status` sạch ngoài tệp bài kiểm đang sửa).

## 5. Yêu cầu tới agent khác

- **Agent A**: (a) cho `transitionModelCore` nhận `DbLike` (giao dịch đang mở) để lượt vòng đời đi CÙNG
  giao dịch với sự kiện gây ra nó; (b) chấp nhận `sample.submitted` vào bảng tên đã cấp.
- **Agent A2**: vẽ khối "Sản xuất" trên `/models/[id]` từ `getModelProductionSummary(modelId)`; đặt nút
  "Tạo topic sản xuất" trỏ `/production/topics/new?model=<id>` (quyền `production:write`) và liên kết
  `/production/models/<id>`. Ô "đã nhận" in "—" khi `receivedViaLinkedReceipts = null` (kèm `basis.received`).
- **Agent G**: `lib/settings.ts::getSettingJson` trả `{}` cho giá trị nguyên thuỷ — ai khác đọc cờ boolean
  qua nó sẽ luôn thấy TẮT.
- **Agent D**: `getModelProductionSummary` đọc `stock_receipts.production_order_id` của D (chỉ đọc).
- **Tech Lead**: gộp bảng mục 2 (thêm `sample.submitted`, 12 tên C LIVE); đánh số lại 0135 nếu `main` đã lấy.
  Tệp `docs/company-os/shared-contracts.md` được chép từ `origin/claude/company-os-audit` 2e21c6a4 rồi
  sửa mục 5 — khi gộp, lấy mục 5 của nhánh này.

## 6. HUMAN GATE

1. **Bật `production.requireApprovedDesign`** (`set-setting` giá trị JSON `true`) = từ đó lệnh chưa trỏ bản
   duyệt không gửi xưởng được. Mặc định TẮT; không bài kiểm / migration nào bật nó.
2. **Mặc định quyền**: `production:write` cho LEADER, `production:approve` cho MANAGER (qua phép trừ) —
   chủ shop xác nhận; người cần ký duyệt mẫu mà không phải MANAGER thì cấp tay TỪNG NGƯỜI.
3. **Chuyển nhóm việc sản xuất sang phòng PRODUCTION** khi phòng có người: ghi đè `work.ownership` cho
   `PRODUCTION_TOPIC`, `SAMPLE_REVIEW` (không cần deploy).
4. **Đặt hạn xử lý** cho hai nguồn việc (nếu muốn) ở `work.sla`.
5. "Dùng làm giá ước tính" ghi `profit.estimatedCosts` → đổi số Báo cáo lợi nhuận danh nghĩa của mã đó: là
   quyết định của người có `reports:assumptions`, không tự động.

## 7. Còn hở / chưa làm

- Chưa đo trên production (phiên này không có quyền). Chưa chạy trình duyệt trên dữ liệu thật — mới có
  typecheck / lint / test / build.
- Không có nút bỏ / thay ảnh mẫu sau khi gửi duyệt (cố ý: người duyệt phải xem đúng thứ đã gửi).
- Trang `/models/[id]` chưa có khối sản xuất (việc của A2).
