# Company OS — Bàn giao Agent H (buồng lái chủ shop · "Cần anh quyết")

Nhánh `claude/cos-h-cockpit` (dựng trên A · B · C · D · E · F · G · A2) · migration `0139_company_os_cockpit`
(journal `when` = 1790006180000).

## 1. Đã dựng

| Phần | Tệp |
|---|---|
| Luật thuần: 9 loại quyết định + quyền màn hình chủ từng loại (`OWNER_DECISION_KIND_SPEC`), kiểu `OwnerDecisionItem` (CÁI GÌ · VÌ SAO · SỐ LIỆU · TÁC ĐỘNG · NÚT · khoá nguồn), `checkDecisionRequest`, `foldLatestDecisions`, `repeatsLatest`, `applyDecisions`, `groupByKind`, `allowedKinds`, `sourcesFor`, in `datumText` / `impactText` | `lib/constants/owner-decisions.ts` |
| Gom nguồn: 7 hàm đổi hình dạng thuần (`approvalsToItems` … `inventoryToItems`), 7 bộ đọc nguồn, `getOwnerDecisionQueue` (hạn giờ + hỏng mềm từng nguồn, nêu tên nguồn hỏng), `viewerKinds` (quyền + phạm vi ADS), `findOwnerDecisionItem` (máy chủ dựng lại đúng đề xuất để chụp), `listRecentDecisions` | `lib/queries/owner-decisions.ts` |
| Lõi ghi (không `"use server"`, nhận `Actor`): dòng sổ + sự kiện `recommendation.decided` CÙNG giao dịch, bấm đúp không ghi thêm, máy (`id: null`) không ghi được | `lib/owner-decisions/service.ts` |
| Server action `decideRecommendation` (requireUser → `dashboard:view` → zod → dựng lại đề xuất qua quyền màn hình chủ → lõi → `audit` → `revalidatePath("/", "/cockpit")`) | `lib/actions/owner-decisions.ts` |
| Bảng `recommendation_decisions` (append-only, CHECK loại / quyết định / lý do bỏ qua / ngày nhắc, `decided_by_user_id` NOT NULL FK RESTRICT, `snapshot` jsonb) | `db/schema.ts` (khối cuối), `drizzle/0139_company_os_cockpit.sql`, `drizzle/meta/_journal.json` |
| Sự kiện `recommendation.decided` RESERVED → **LIVE** (emitter `lib/owner-decisions/service.ts`) + nhãn dòng thời gian | `lib/constants/domain-events.ts` |
| Khối "Cần anh quyết" trên trang chủ — sau Bản tin, TRÊN "Việc cần làm hôm nay", `Suspense` riêng; mỗi loại: số đếm + 3 dòng; dòng ẩn đếm riêng; nguồn hỏng nêu tên | `app/(dashboard)/owner-decisions.tsx`, `app/(dashboard)/page.tsx` (thêm 1 khối, không bỏ khối nào) |
| Trang `/cockpit`: lọc theo loại (`?kind=`), mọi dòng, danh sách ĐANG ẨN (`?an=1`: ai quyết, lúc nào, lý do), 20 phản ứng gần đây | `app/(dashboard)/cockpit/{page,decision-list,decision-controls,loading}.tsx` |
| Module `/cockpit` (phòng MANAGEMENT, `dashboard:view`, có `why`), icon `Gavel`, smoke | `lib/constants/department-modules.ts`, `components/app-sidebar.tsx`, `scripts/smoke.ts` |
| Nhãn nhật ký `RECOMMENDATION_DECIDED` / `RECOMMENDATION` | `lib/constants/audit.ts` |
| Kiểm thử | `tests/company-os-cockpit.test.ts` (đăng ký sau Agent E trong `tests/sync-fixtures.test.ts`), `tests/migration-upgrade-path.test.ts` (+0138 vào `MOI` + 5 khẳng định) |

## 2. Nguồn — mỗi loại đọc lại ĐÚNG hàm của màn hình chủ

| Loại | Nguồn (không công thức mới) | Khoá nguồn | Tác động | Quyền để thấy |
|---|---|---|---|---|
| `APPROVAL` | `listApprovalRequests()` PENDING, **bỏ yêu cầu do chính người xem xin** | `approval:<id>` | số tiền trên yêu cầu (nói rõ: QUY MÔ, không phải tiền treo) | `alerts:view` + `approvals:decide` |
| `SAMPLE_REVIEW` | `adaptSampleReviews` (phép chiếu `/work`) + đọc cost/xưởng/ảnh theo id | `sample:<id>` | `null` (không có tiền đo được) | `planning:view` + `production:approve` |
| `TOPIC_DECISION` | `adaptProductionTopics`, CHỈ `OPTIONS_READY`/`WAITING_DECISION` + yêu cầu của topic | `topic:<id>:<status>` | `null` | `planning:view` + `production:write` |
| `ADS_CUT` | `adaptAdsDecisions` (tập + tiền, chỉ `money.atRisk !== null`) + ô số từ `getAdsDecision(30d,"campaign")` cùng đệm | `ads:CUT:campaign:<id>:<ACTUAL\|PROJECTED>` | lỗ sau QC của phép chiếu (đo được / tạm tính) | `expenses:view` + phạm vi `ADS` ≠ NONE |
| `INVENTORY_STOCKOUT` / `_REORDER` / `_CLEARANCE` | `getInventoryDecisionReport()` (decideInventory, đã trừ hàng đặt xưởng) | `inventory:<decision>:<variantId>` | lãi gộp ƯỚC TÍNH / vốn cần / vốn giải phóng (chưa biết giá ⇒ `—`) | `planning:view` |
| `PRODUCTION_LATE` | `getPurchasingReport().openOrders` với `lateDays !== null` (lệnh SENT quá hẹn) | `po:<id>:due:<ngày hẹn>` | `committed` (> 0; 0 = chưa nhập giá ⇒ `—`) | `planning:view` |
| `MODEL_SCALE` | `getAdsDecision(30d,"product")` SCALE + `spendKnown` → mẫu có `product_id` đó → trạng thái khai ∈ `BEFORE_PRODUCTION_DISCUSSION` (A2) → không topic mở → `getModelAdsSummary` = `OK` (chi đã ghép) | `model:SCALE:<modelId>` | `null` (xem Kinh tế ở 360) | `models:view` + `expenses:view` + phạm vi `ADS` |

Nguồn của loại người xem không được thấy **không được đọc** (không phải đọc rồi giấu). Mỗi nguồn hạn 2,5 s
trên trang chủ (cùng mức `/work`); quá hạn / ném lỗi ⇒ trả rỗng, nêu tên ở dòng "Chưa đọc được: …" (ⓘ có câu lỗi).
Khi GHI, máy chủ dựng lại đề xuất với hạn 20 s rồi mới chụp — ảnh chụp là thứ ERP đề xuất, không phải thứ
trình duyệt gửi.

## 3. Phản ứng (sổ `recommendation_decisions`)

- **Chấp nhận**: dòng VẪN hiện (mang dấu "Đã chấp nhận · ai · ngày") tới khi điều kiện ở nguồn hết — chấp
  nhận "cắt chiến dịch" không cắt chiến dịch (luật 19).
- **Bỏ qua**: lý do ≥ 5 ký tự (ứng dụng) / khác rỗng (CHECK). Ẩn tới khi KHOÁ NGUỒN đổi.
- **Nhắc lại sau**: ngày (giờ VN, ẩn tới 00:00 ngày đó); nút nhanh Ngày mai / 3 ngày / 1 tuần là TIỆN ÍCH NHẬP
  LIỆU, không phải ngưỡng nghiệp vụ.
- Dòng mới nhất của khoá có hiệu lực; bấm lại đúng phản ứng đang có hiệu lực ⇒ không ghi (tinh thần luật 61).
- `audit()` action `RECOMMENDATION_DECIDED` được thêm vào `KHONG_DOI_SO_LIEU` (lib/audit.ts): nó không đổi
  con số nào; để ngoài thì mỗi cú bấm trên trang chủ xoá sạch đệm và lượt mở kế tiếp tính lại bảng quyết
  định quảng cáo (~6 s nguội).

## 4. Chỗ lệch đề bài — và vì sao

1. **Khoá quảng cáo KHÔNG mang ngày** (`ads:CUT:campaign:<id>:<basis>`, đề bài ví dụ `…:<date>`): khoá có
   ngày làm "Bỏ qua" hết hiệu lực sau 24 giờ, tức gộp BỎ QUA với NHẮC LẠI 1 NGÀY làm một. Khoá đổi khi căn
   cứ đổi (tạm tính ↔ đo được) — đó là lúc khuyến nghị thật sự là một điều khác.
2. **`MODEL_SCALE` không dùng `getModelSignal`**: hàm của A2 đọc hiệu quả mẫu mã TỪNG mẫu — không đủ rẻ cho
   trang chủ. Nguồn là lá phiếu quảng cáo chiều mã hàng, lọc bằng các cổng A2 đã dựng (chi đã ghép,
   `BEFORE_PRODUCTION_DISCUSSION`, không topic mở); nhãn nói "quảng cáo đề nghị TĂNG", KHÔNG nói "THẮNG";
   nút mở trang 360 nơi có tín hiệu đầy đủ.
3. **Yêu cầu duyệt cần thêm `approvals:decide`** (ngoài quyền màn hình `/alerts`), mẫu cần
   `production:approve`, topic cần `production:write`: "Cần anh quyết" là quyết định, người không quyết được
   thì không có gì để quyết. Yêu cầu do chính người xem xin bị loại.
4. **Lệnh SX nháp quá hẹn không vào** — nguồn là cam kết đang mở (SENT) của trang Mua hàng; lệnh nháp chưa là
   lời hẹn với xưởng. Trang Mua hàng chỉ liệt kê 50 lệnh mở: khi `overdueCount` lớn hơn số đọc được, khối in
   câu nói ra phần thiếu.
5. **Sổ có thêm cột `decided_by`** (ảnh chụp tên, luật 34) ngoài danh sách cột của đề bài.
6. **Tệp ngoài vùng sở hữu, chỉ THÊM**: `lib/audit.ts` (một khoá vào `KHONG_DOI_SO_LIEU`, của G),
   `lib/constants/audit.ts` (2 nhãn), `app/(dashboard)/page.tsx` (một khối), `scripts/smoke.ts`,
   `components/app-sidebar.tsx`. Không sửa tệp truy vấn nào của agent khác (chỉ đọc).
7. Tổng các loại KHÔNG cộng thành "tổng tiền cần quyết": tác động của các loại là những đại lượng khác nhau
   (quy mô yêu cầu, lỗ QC, lãi gộp ước tính, vốn cần, vốn giải phóng) — cộng là đếm năm thứ dưới một nhãn.

## 5. Lark — CHƯA làm (theo đề bài), cách làm khi mở

Không gửi tin nào trong gói này. Khi mở: KHÔNG thêm job/lịch mới — thêm một mục "Cần anh quyết" vào bản tin
sáng (`lib/work/morning-brief.ts`: một tin mỗi ngày giờ VN, khoá `settings["work.morning-brief.sent"]`, chỉ
nhóm Quản lý, gửi hỏng không ghi khoá), đọc `getOwnerDecisionQueue` với người xem là tài khoản chủ shop.
Muốn báo trong ngày thì dùng mẫu `decideShortageDigest` (`lib/constants/stock-shortage.ts`): sổ "đã báo" theo
khoá nguồn, chỉ gửi khi có khoá MỚI hoặc NẶNG thêm, dòng đã Bỏ qua / đang hẹn nhắc không kích tin. Tin chỉ mang
link mở `/cockpit?kind=…` (Custom Bot không nhận nút bấm).

## 6. Kiểm thử

`testCompanyOsCockpitPure` + `testCompanyOsCockpitDb`:
- Bảy hàm đổi hình dạng: đúng tập dòng (yêu cầu của chính mình / đã quyết, topic đang bàn, lệnh chưa quá hẹn,
  CẮT không biết số chi, SCALE ở nguồn cắt, HOLD/OVERSTOCK/DATA_INSUFFICIENT đều bị loại), đúng CÁI GÌ / VÌ SAO /
  NÚT, đúng cột tác động theo từng kết luận, khoá đổi khi ngày hẹn / căn cứ / trạng thái đổi, chưa biết ⇒ `—`
  (kể cả lệnh cam kết 0 ₫ và số nên đặt `null`), 0 thật vẫn là 0.
- Luật ghi, gập sổ, áp phản ứng, gom/xếp (chưa biết xếp sau cả 0), quyền (8 cấu hình), nguồn không được đọc
  khi không có loại nào của nó.
- Mã nguồn: không tệp nào UPDATE/DELETE sổ; chỉ lõi dịch vụ ghi; sự kiện LIVE và tệp phát thật; CHECK loại của
  migration = hằng số; khối trang chủ đứng trên `TopActions` trong `Suspense` riêng; gom nguồn không mang
  ngưỡng tiền.
- CSDL: máy không ghi được; bỏ qua không lý do bị chặn ở lõi VÀ ở CSDL; nhắc lại không ngày bị CSDL chặn; bấm
  đúp không ghi thêm; một phản ứng ⇒ đúng một sự kiện, cùng khoá chống trùng; ảnh chụp mang CÁI GÌ; hẹn nhắc
  ẩn tới đúng mốc (dựng từ `decided_at` CSDL ghi) rồi tự hiện; bỏ qua ẩn tới khi khoá đổi; CHẤP NHẬN không
  đóng việc, dòng rời hàng đợi khi nguồn hết; nguồn NÉM và nguồn TREO đều được nêu tên, nguồn lành vẫn hiện;
  quyền chặn cả đọc lẫn ghi (`FORBIDDEN`), đề xuất đã mất ở nguồn ⇒ `GONE`; bốn nguồn THẬT (yêu cầu của người
  khác, mẫu SUBMITTED, topic chờ quyết, lệnh SENT quá hẹn so với đồng hồ thật), người xin không thấy yêu cầu
  của mình; ba nguồn nặng (QC × 2, tồn) chạy thật không lỗi; sự kiện gắn `model_id` của mẫu.

KẾT QUẢ CỔNG VÀ ĐỘT BIẾN: xem mục 8.

## 7. HUMAN GATE

1. Migration 0138 (bảng mới, rỗng) áp khi deploy.
2. Chủ shop xác nhận **quyền theo loại** (mục 2) — đặc biệt: người có `alerts:view` mà không có
   `approvals:decide` sẽ không thấy yêu cầu duyệt ở buồng lái (vẫn thấy ở `/alerts`).
3. Chủ shop xác nhận cách đọc khoá quảng cáo (mục 4.1): "Bỏ qua" một chiến dịch CẮT có hiệu lực tới khi căn cứ
   đổi, không tự hết sau một ngày.
4. `MODEL_SCALE` là một LÁ PHIẾU quảng cáo, không phải tín hiệu mẫu đầy đủ — nếu chủ shop muốn chỉ hiện mẫu
   THẮNG theo A2 thì cần một bản tín hiệu mẫu đọc theo lô (việc của A2).

## 8. Cổng · đột biến · đường bấm

**Cổng (Windows, cây `wt-cos-h`, Bash):** `npm run typecheck` sạch · `npm run lint` sạch · `npm run build` thành
công (`/cockpit` 2,42 kB; `/` 10,6 kB) · `npm test`: **ĐỎ ở một bài CÓ SẴN của nhánh gốc, không phải của gói
này** — `testCompanyOsModel360Pure` (A2) báo `getModelProductionSummary đã có ở lib/queries/model-production.ts —
nối vào trang 360 và gỡ khỏi MODEL_360_PENDING_SOURCES` (nhánh gốc đã gộp C, còn điểm nối của A2 chưa gỡ; H không
sửa tệp của A2). Chạy lại với đúng bài đó bọc TẠM `try/catch` (KHÔNG commit, hoàn nguyên ngay): **TẤT CẢ KIỂM THỬ
ĐẠT**, gồm hai dòng `✓ Company OS · H`. Chưa chạy trên bản checkout sạch theo SHA — việc của Tech Lead lúc gộp.

**Đột biến (23/23 bị bắt; mỗi đột biến sửa MỘT chỗ, chạy lại bộ H, rồi hoàn nguyên):** M1 yêu cầu của chính mình
vẫn hiện · M2 topic mọi trạng thái · M3 cam kết 0 thành 0 ₫ · M4 CẮT không biết số chi vẫn vào · M5 bỏ qua không ẩn
· M6 hẹn nhắc ẩn mãi · M7 chấp nhận thì ẩn · M8 bỏ qua không cần lý do · M9 bấm đúp ghi thêm · M10 bỏ bắt lỗi
nguồn · M11 bỏ hạn giờ nguồn (bắt bằng hàng rào 5 s của bài kiểm) · M12 bỏ quyền theo loại · M13 bỏ phạm vi ADS ·
M14 đọc nguồn của loại không được thấy · M15 không phát sự kiện · M16 chưa biết in 0 · M17 ghi không qua quyền màn
hình chủ · M18 máy ghi được (bắt bởi FK) · M19 migration bỏ CHECK lý do · M20 CHECK loại lệch hằng số · **M21 lõi
UPDATE sổ qua bí danh `r` — lượt đầu LỌT** (quét chỉ tìm `.update(schema.recommendationDecisions`), đã siết: tệp
nào chạm sổ thì không được có `.update(`/`.delete(` nào — chạy lại: ĐỎ · M22 chưa biết xếp như 0 · M23 tồn kho nhận
OVERSTOCK. Hoàn nguyên cả 23: xanh.

**Đường bấm (máy này):** `npm run build` + `next start -p 3310` trên PGlite riêng (seed-admin + seed-demo + một
kịch bản tạm gieo 1 yêu cầu duyệt của người khác, 1 mẫu SUBMITTED, 1 topic Chờ quyết, 1 lệnh SENT quá hẹn 4 ngày —
kịch bản không commit), Chrome headless qua `playwright-core`, 1440px:
- `/`: khối "Cần anh quyết" đứng TRÊN "Việc cần làm hôm nay", 4 loại × 1 dòng, đủ ba nút; tác động `4.5 tr` /
  `—` / `—` / `28.5 tr`; dòng cảnh báo nói Quyết định vốn tồn đang DỮ LIỆU CHƯA ĐỦ (dữ liệu demo chưa có phiếu nhập);
  không cuộn ngang; 0 lỗi console.
- Bấm **Chấp nhận** yêu cầu duyệt ⇒ dòng VẪN còn, mang "Đã chấp nhận · Quản trị viên 25/09/2026", nút Chấp nhận ẩn.
- **Bỏ qua** mẫu: nút xác nhận bị khoá khi lý do "abc"; gõ lý do đủ ⇒ nhóm mẫu biến mất khỏi khối.
- **Nhắc lại sau** topic → "3 ngày" ⇒ nhóm topic biến mất; chân khối in "1 đề xuất đã bỏ qua · 1 đang hẹn nhắc lại".
- `/cockpit?an=1`: 2 đang chờ · 2 đang ẩn; danh sách ẩn in "Bỏ qua · Quản trị viên · … · “lý do”" và "Nhắc lại sau
  tới 28/09/2026"; "Phản ứng gần đây" 3 dòng. `?kind=PRODUCTION_LATE` chỉ còn nhóm đó. 390px: không cuộn ngang.
- Chưa bấm thử được dòng CẮT quảng cáo / mẫu đề nghị TĂNG / ba kết luận tồn trên dữ liệu thật: dữ liệu demo không
  sinh dòng nào (0 CẮT, tồn chưa có phiếu nhập). Ba nguồn này chạy THẬT trong bài kiểm CSDL không lỗi.

## 9. Yêu cầu tới Tech Lead / agent khác

- **Tech Lead**: `shared-contracts.md` §2 — `recommendation.decided` nay LIVE (H, emitter
  `lib/owner-decisions/service.ts`); cấp số 0138 (đánh lại nếu `main` đã lấy). Nhánh gốc đang ĐỎ ở bài của A2
  (mục 8) — cần gộp bản A2 nối `getModelProductionSummary` trước khi cổng xanh trên checkout sạch.
- **Agent G**: `lib/audit.ts::KHONG_DOI_SO_LIEU` có thêm `RECOMMENDATION_DECIDED` (lý do ở chú thích tại chỗ).
- **Agent A2**: nếu có `getModelSignal` đọc theo LÔ (nhiều mẫu một lượt), `MODEL_SCALE` nên chuyển sang tín hiệu
  THẮNG thật — thay bộ đọc `loadModelScale` trong `lib/queries/owner-decisions.ts`, giữ nguyên khoá `model:SCALE:<id>`
  (hoặc đổi khoá có chủ đích để lời bỏ qua cũ hết hiệu lực).

---

## 10. Agent S — `MODEL_SCALE` nay là tín hiệu THẮNG thật (nhánh `claude/cos-tin-hieu-hang-loat`)

Chỗ lệch 4.2 và HUMAN GATE 7.4 đã đóng: bộ đọc `loadModelScale` gọi `getModelSignalsBatch(30 ngày)` (A2/S) rồi
`modelWinnerCandidates` (thuần): tín hiệu = THẮNG · `openProductionTopics === 0` (CHƯA BIẾT không phải 0 — nguồn
topic hỏng thì bộ đọc NÉM để khối nêu tên nguồn) · trạng thái khai ∈ `BEFORE_PRODUCTION_DISCUSSION` — đúng ba cổng
của đề xuất "mở trao đổi sản xuất" ở trang 360.

- Nhãn loại: **"Mẫu THẮNG chưa mở topic sản xuất"**; nguồn: "Tín hiệu mẫu". Mã loại `MODEL_SCALE` GIỮ NGUYÊN
  (CHECK của 0138 và sổ phản ứng đã lưu nó).
- Ô số liệu = NHÃN phán quyết từng nguồn (Quảng cáo · Mẫu mã · Creative · Thiết kế · Tồn kho; nguồn không có ⇒
  `—`), không số — cùng mức trang 360 cho hiện khi che câu chi tiết. Xung đột (vd bối cảnh tồn) nêu trong "vì sao".
- **Khoá đổi có chủ đích**: `model:WINNER:<modelId>:<băm>` — băm (cyrb53, tất định) của tín hiệu + (nguồn · lá phiếu
  · nhãn) của BỐN nguồn bỏ phiếu. KHÔNG mang ngày; câu chi tiết / số đếm / bối cảnh tồn không vào khoá. Lời "bỏ
  qua" cũ trên khoá `model:SCALE:<id>` hết hiệu lực vì khuyến nghị đã là một điều khác (lá phiếu QC → tín hiệu đủ).
- Quyền giữ nguyên: `models:view` + `expenses:view` + phạm vi `ADS`.
- `tests/company-os-cockpit.test.ts` mục 1f viết lại theo định nghĩa mới (không nới): tập ứng viên (THẮNG + 0 topic
  + trạng thái trước Bàn SX; loại topic mở, topic chưa biết, đã qua Bàn SX, tín hiệu khác), khoá tất định / không
  ngày / đổi khi phán quyết nguồn đổi / không đổi khi câu chi tiết đổi, ô = nhãn nguồn, nguồn vắng ⇒ `—`.
