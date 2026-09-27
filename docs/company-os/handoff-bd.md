# Company OS — Bàn giao Agent BD (Bảng quy trình mẫu: mọi mẫu ở bước nào, việc tiếp theo là gì)

Nhánh `claude/cos-bang-quy-trinh` (từ `origin/main` `07d70ac4`) · **không migration** · không đường ghi mới.

## Vì sao

Sơ đồ 13 bước của chủ shop (creative → set camp → thắng/scale → topic hỏi giá → giá thành & lên mẫu → duyệt
mẫu → bảng số lượng → sản xuất → nhập kho → đẩy đơn → đẩy tồn → xử lý hoàn → đơn mới). ERP đã có đủ mảnh
(Company OS), nhưng đo production 27/09 (ops company-os-summary): 0 topic, 0 bảng giá thành, 0 mẫu xưởng,
0 phiếu nối lệnh, 0 cú bấm buồng lái. Thiếu MỘT màn hình cho thấy mỗi mẫu đang ở bước nào và bước tiếp theo
là nút nào.

## Đã dựng

| Phần | Tệp |
|---|---|
| Phép chiếu thuần: 12 cột, `pipelineColumnOf` (toàn phần), nhãn suy ra `pipelineChips` (≤ 2), `pickNextAction`, bộ lọc / số đếm / khoá đệm, `daysInState` | `lib/constants/model-pipeline.ts` (mới) |
| Đọc theo lô: `getModelPipelineBoard(access, filters)` (đệm 60 s, khoá = quyền + bộ lọc), `pipelineSuggestions` / `pipelineGap` (đúng phép dựng của khối Đề xuất trang 360) | `lib/queries/model-pipeline.ts` (mới) |
| Tóm tắt sản xuất theo lô `getModelProductionSummariesBatch(ids)`; `getModelProductionSummary` nay gọi chính nó với một mẫu (một công thức) | `lib/queries/model-production.ts` |
| Cổng từng khối dùng chung (trước là hàm cục bộ của trang 360) | `lib/models/block-access.ts` (mới), `app/(dashboard)/models/[id]/page.tsx` |
| Khung vẽ (Server Component, không `"use client"`) | `app/(dashboard)/models/pipeline-board.tsx` (mới) |
| `/models?view=bang` + chip "Xem: Danh sách · Bảng quy trình" trên cả hai chế độ; lọc người phụ trách / phòng ban / tìm / "Chỉ mẫu cần làm" | `app/(dashboard)/models/page.tsx` |
| Neo `#de-xuat` cho khối Đề xuất trang 360 (nút chuyển vòng đời nằm ở đó) | `app/(dashboard)/models/[id]/blocks.tsx` |
| Lối vào: menu (sổ module, phòng Sản xuất, `models:view`, icon `KanbanSquare`) · "Xem bảng quy trình" ở khối Cần anh quyết (trang chủ) và đầu `/cockpit` — gác `models:view` | `lib/constants/department-modules.ts`, `components/app-sidebar.tsx`, `app/(dashboard)/owner-decisions.tsx`, `app/(dashboard)/cockpit/page.tsx` |
| Kiểm thử | `tests/company-os-pipeline-board.test.ts` (đăng ký sau `testCompanyOsBulkDeclareDb`) |

## Bảng ánh xạ (khai MỘT lần ở `PIPELINE_COLUMNS`)

| Cột | Bước | Trạng thái KHAI |
|---|---|---|
| Chưa khai | — | `NULL` (dưới đầu cột: "Khai theo gợi ý cho cả lô" → `/models?state=NONE&khai=goi-y`, chỉ `models:write`) |
| Ý tưởng / Creative | 1 | IDEA, CREATIVE |
| Test QC | 2 | ADS_TESTING |
| Thắng / Triển vọng | 3 | WINNER |
| Bàn SX | 4 | PRODUCTION_DISCUSSION |
| Giá thành & mẫu | 5 | COSTING, SAMPLING |
| Duyệt mẫu | 6 | SAMPLE_REVIEW |
| Kế hoạch SL | 7 | APPROVED, PRODUCTION_PLANNING |
| Đang SX | 8–9 | IN_PRODUCTION |
| Đang bán | 10, 13 | SELLING |
| Đẩy tồn / Hoàn | 11–12 | CLEARANCE |
| Dừng (thu gọn) | — | LOSER, DISCONTINUED |

**Cột chỉ theo lời khai.** Sự thật máy suy ra chỉ gắn nhãn (tối đa 2, thứ tự): *Thiếu chứng từ* (P2) ·
*Hoàn gần hết / Hàng chết* (đỏ) / *Vốn nằm chết* (vàng) — lớp tệ nhất của Hàng chậm (V) · *Mẫu chờ duyệt*
(mẫu mới nhất ĐÃ GỬI, trừ cột Duyệt mẫu) · *Topic SX đang mở* (chỉ khi mẫu còn trước Bàn SX — luồng mở sớm T).
Tín hiệu (S) là nhãn riêng trên thẻ.

**Việc tiếp theo** — thứ tự nhặt (`NEXT_ACTION_ORDER`): chỗ hở lời khai ≠ chứng từ (P2) → gợi ý khai của máy
cho mẫu chưa khai (Q, chỉ người `models:write`) → đề xuất của trang 360 (A2 `deriveModelSuggestions` gồm luật
T + chuyển tiếp C, ghép X `mergeStockFeedbackSuggestions`), ưu tiên đề xuất đẩy bước (`STEP_ADVANCING_SUGGESTION_KEYS`
= bốn khoá mục 3 của A2), không có thì đề xuất đầu tiên. Nút đi tới link đầu của đề xuất; đề xuất không link
(chuyển vòng đời / không quyền tạo topic) ⇒ `/models/<id>#de-xuat`. Không bộ máy nào nói gì ⇒ không nút.

## Chỗ lệch đề bài (và vì sao)

1. **"Thắng / Triển vọng (WINNER, or signal PROMISING while testing)", "Bàn SX (… or an open topic)", "Đẩy tồn
   (… or stock class)"** đọc theo câu "declared state wins; derived facts only annotate": mẫu Test QC tín hiệu
   Triển vọng ở cột Test QC mang nhãn tín hiệu; mẫu có topic mở sớm mang nhãn "Topic SX đang mở"; mẫu Đang bán
   hoàn gần hết mang nhãn đỏ. Dời mẫu theo suy luận là máy tự khai (Q3).
2. **"Chưa khai" đứng ĐẦU** bảng (không phải gần cuối như danh sách đề bài): 18/25 mẫu production chưa khai —
   để cuối là đẩy phần lớn sổ ra ngoài màn hình.
3. **Mốc "số ngày ở bước"** = `max(product_model_state_history.occurred_at)`; chưa khai và chưa có dòng lịch sử ⇒
   "vào sổ n ngày" (`created_at`); đã khai mà không có dòng lịch sử ⇒ `—`.
4. **Không có hàm lô cho tóm tắt sản xuất của C** ⇒ viết `getModelProductionSummariesBatch` ngay trong tệp của
   C và cho bản một-mẫu gọi lại nó (một công thức; bài kiểm so hai đường trên mọi mẫu). Chỗ hở P2 dựng từ
   CHÍNH tóm tắt ấy (`evidenceFactsOfSummary`, đúng đường ô vàng trang 360) thay vì `listModelEvidenceFacts` —
   0 truy vấn thêm.
5. **Nhãn "Topic SX đang mở" gác quyền khối Sản xuất** (đếm từ tóm tắt C), không lấy từ số topic của lô tín hiệu
   (không gác).
6. **Không thêm `/models?view=bang` vào `scripts/smoke.ts`**: lá chắn phủ smoke cắt `?` nên `/models` đã phủ;
   lượt nguội của bảng (lô tín hiệu cả shop) có thể chậm trên VPS và làm đỏ smoke deploy — Tech Lead quyết.
7. Mục menu dùng href có query (`/models?view=bang`); khi đang ở bảng, mục được tô là "Vòng đời mẫu" (thanh bên
   so theo pathname).
8. Tệp ngoài phạm vi, chỉ thêm / tách: `app/(dashboard)/models/[id]/{page,blocks}.tsx` (cổng khối dùng chung, neo),
   `lib/queries/model-production.ts` (hàm lô), `owner-decisions.tsx`, `cockpit/page.tsx`.

## Hiệu năng (PGlite demo: seed-demo + `syncModelRegistry` + 2 thiết kế TK, 12 mẫu, 1.126 đơn)

`getModelPipelineBoard` đủ quyền: NGUỘI 833–1.159 ms (phần lớn là lô tín hiệu của S, đã đo 848–1.034 ms) ·
ẤM cùng khoá 0 ms · khoá lọc mới khi nguồn đã ấm 24–32 ms. Thẻ = đường một-mẫu trang 360: 12/12.

## Kiểm thử · đột biến · đường bấm

`tests/company-os-pipeline-board.test.ts` (4 hàm, đăng ký sau Agent Q):

- **Thuần**: 16 giá trị khai → đúng một cột mỗi giá trị, bảng ánh xạ khoá nguyên văn, 13 bước phủ đủ, chỉ cột
  Dừng thu gọn · nhãn: Đang bán + hoàn gần hết = nhãn đỏ và VẪN cột Đang bán, Bán chậm / Bình thường không nhãn,
  topic chỉ gắn khi trước Bàn SX (duyệt đủ 15 trạng thái), số topic chưa biết ≠ có topic, trần 2 nhãn theo thứ tự,
  gom cột không nhân bản thẻ · việc tiếp theo: không nguồn ⇒ `null`, chứng từ trước đề xuất, khai chỉ cho mẫu
  chưa khai, đề xuất đẩy bước đứng trước, không link ⇒ neo `#de-xuat` · lọc người / "chưa giao" / phòng / tìm
  không dấu / chỉ cần làm · số đếm mọi cột · khoá đệm không phụ thuộc thứ tự chọn.
- **Mã nguồn**: bốn khoá "đẩy bước" còn trong `deriveModelSuggestions` · tệp thuần không CSDL / đồng hồ và KHÔNG tự
  dựng đề xuất (`what:` / `transition:`) · đường đọc đi qua 10 hàm bộ máy có sẵn · mỗi nguồn lô gọi đúng một lần,
  phép dựng thẻ không `await` / không `db.` / không `getX(` · không dùng đường một-mẫu · 6 cổng quyền · khoá đệm
  chứa quyền + bộ lọc · không ghi (`insert/update/delete`, `"use server"`, `lib/actions`) · khung vẽ không
  `"use client"`, cuộn ngang trong khung · trang gác `models:view` TRƯỚC nhánh bảng · 360 và bảng dùng chung
  `modelBlockAccess` · link trang chủ / buồng lái gác `models:view`.
- **Cổng**: `/models?view=bang` ⇒ module `production`; mục menu phòng Sản xuất, `models:view`; thiếu quyền / module
  tắt (kể cả ADMIN) ⇒ ẩn.
- **CSDL** (mã `cos-bd-` / `COSBD`, dữ liệu 2001, tự dọn): 9 mẫu gieo phủ P2 (Làm mẫu thiếu mẫu xưởng), T (Triển vọng
  chưa topic ⇒ mở sớm; có topic ⇒ nhãn, không nút), C+T (Thắng + topic đã chốt ⇒ chuyển tiếp), Q (chưa khai ⇒
  khai theo gợi ý), mẫu chờ duyệt, Dừng · mỗi mẫu của sổ đúng một thẻ · lọc người / phòng (qua
  `activeMembershipsByUser`) / chưa giao / tìm / cần làm · bộ quyền rỗng: không chỗ hở, không khai, không đề xuất
  quảng cáo / tồn, không nhãn, link tạo topic thành neo 360 + lưu ý "có thể đã có topic" · tóm tắt sản xuất theo
  lô = một-mẫu · **thẻ = đường một-mẫu trang 360 trên MỌI mẫu × 2 bộ quyền** (trong `npm test`: 17 mẫu).

**Đột biến 20/20 ĐỎ** (mỗi cái áp riêng, chạy bộ BD, hoàn nguyên): M1 CREATIVE hai cột · M2 Triển vọng dời sang
cột Thắng · M3 đề xuất trước chứng từ · M4 bỏ ưu tiên đẩy bước · M5 bịa nút "Mở mẫu" · M6 đọc quảng cáo không gác
· M7 lô sản xuất lấy mẫu thử cũ nhất · M8 khoá đệm thiếu bộ lọc · M9 nhãn topic mọi trạng thái · M10 bỏ trần 2 nhãn
· M11 lọc phòng vô hiệu · M12 gợi ý khai không gác `models:write` · M13 bỏ quyền tạo topic · M14 hoàn gần hết
thành nhãn vàng · M15 mẫu đã khai lấy mốc vào sổ · M16 nhãn topic lấy từ lô tín hiệu (không gác) · M17 đọc lô theo
từng thẻ · M18 sản xuất đọc không gác · M19 tìm không bỏ dấu · M20 "Chưa giao" lẫn mẫu có người. (M6, M12, M18 chỉ
bài mã nguồn bắt: CSDL kiểm thử không có dòng quảng cáo đủ để phân biệt.)

**Đường bấm** (`next start` + PGlite: seed-admin + seed-demo + `syncModelRegistry` + khai SP001 Đang bán · SP002 Làm
mẫu · SP003 Test QC + topic đang trao đổi · SP004 Thắng · SP005 Xả tồn · SP006 Thua; TK-260927-81 thiết kế THẮNG khai
Test QC; TK-260927-82 thiết kế đang test chưa khai), Chrome headless (playwright-core), 0 lỗi console:
- 1440px: 12 thẻ / 7 có việc; trang không cuộn ngang (khung bảng 2.268 / 1.392 px cuộn bên trong); tải trang 700–864 ms.
- Menu Sản xuất → "Bảng quy trình mẫu" ⇒ `/models?view=bang`. Trang chủ ("Xem bảng quy trình") và `/cockpit` có link.
- Bấm "Cân nhắc mở topic sản xuất SỚM…" (TK-…-81) ⇒ `/production/topics/new?model=…`, biểu mẫu in "Mở SỚM — mẫu đang
  Triển vọng / Test quảng cáo". Bấm "Ghi mẫu xưởng" (SP002, nhãn Thiếu chứng từ) ⇒ `/production/models/<id>`. Bấm
  "Khai “Đang bán” theo gợi ý" (SP007) ⇒ `/models/<id>#trang-thai-khai`, ô khai chọn sẵn "Đang bán · máy gợi ý".
- `?canlam=1` ⇒ 7/12 · `?q=TK-260927` ⇒ 2/12.
- 390px: không cuộn ngang, cột xếp chồng (rộng 366 px); bấm "Ghi mẫu xưởng" ⇒ `/production/models/<id>`.

## HUMAN GATE

Không migration, không job, không ngưỡng, không ghi. Sau deploy: menu Sản xuất có "Bảng quy trình mẫu"; chủ shop
thấy 18 mẫu ở cột Chưa khai với nút "Khai … theo gợi ý" (Q) và mọi mẫu khai trạng thái sản xuất mà thiếu chứng
từ mang nút mở đúng chỗ ghi chứng từ (P2).
