# Company OS — Bàn giao Agent T (topic sản xuất mở SỚM cho mẫu TRIỂN VỌNG)

Nhánh `claude/cos-topic-som` (từ `origin/main` `bf58dead`) · migration `0140_company_os_early_topic`
(journal `when` = 1790006243217).

Quy tắc chủ shop 25/09/2026 (nguyên văn): *"Phần topic sản xuất thì có thể tạo topic trao đổi sản xuất cho
những mẫu có chỉ số tốt mà chưa win (tiềm năng sẽ win và lên mã), ko phải chỉ cho những mẫu đã win."*

## 1. Quyết định thiết kế

- **"Chỉ số tốt mà chưa win" = tín hiệu TRIỂN VỌNG** của bảng gộp có sẵn (`deriveModelSignal`) — không
  ngưỡng mới. Mẫu chỉ có thiết kế TK (chưa có mã Pancake) lên TRIỂN VỌNG khi thiết kế THẮNG.
- **Topic mở sớm là LUỒNG SONG SONG.** Vòng đời KHÔNG đổi khi topic mở trên mẫu còn trước THẮNG —
  `followModelLifecycle` của C chỉ đi cạnh tiến, nên nó tự đứng yên (giữ nguyên, có bài kiểm).
- **Khai THẮNG khi sản xuất đã đi trước** ⇒ máy đề xuất chuyển tiếp tới đúng chỗ sản xuất đang đứng, lý do
  điền sẵn `Sản xuất đã đi trước lúc mẫu thắng: …`; người bấm, qua `transitionModel`. Mẫu ≥ THẮNG giữ tự
  động hoá của C.

## 2. Đã dựng

| Phần | Tệp |
|---|---|
| Luật thuần: `topicOpeningMode` (NORMAL/EARLY), `suggestsTopicOpening`, `buildTopicOpenContext`, `isEarlyOpen`, `describeTopicOpenContext`, `topicOpenNotice`, `productionTrackState`, `winnerFollowUp`; `BEFORE_PRODUCTION_DISCUSSION_STATES` (một bản — `model-360.ts` dẫn xuất từ đây) | `lib/constants/early-topic.ts` (mới) |
| Đọc: `designModelLinks` (thiết kế → mẫu → topic đang mở), `modelSignalsForPicker` (lô của S, hạn giờ 2,5 s) | `lib/queries/early-topic.ts` (mới) |
| Trang 360 · khối Đề xuất: TRIỂN VỌNG ⇒ "Cân nhắc mở topic sản xuất SỚM" + link "Mở topic sản xuất sớm" (chỉ `production:write`), KHÔNG kèm chuyển vòng đời; đã khai THẮNG mà sản xuất đi trước ⇒ đề xuất chuyển tiếp | `lib/constants/model-360.ts`, `app/(dashboard)/models/[id]/blocks.tsx` |
| Trang 360 · ô đổi trạng thái: vừa khai THẮNG mà sản xuất đi trước ⇒ khung "Chuyển tiếp sang …" một cú bấm | `app/(dashboard)/models/[id]/{page,model-controls}.tsx` |
| Tab Thiết kế (`/marketing/creatives?tab=thiet-ke`): thiết kế Đang test / Thắng có mẫu trong sổ ⇒ "Mở topic sản xuất" (hoặc "Topic sản xuất đang mở"); chưa vào sổ ⇒ "Đồng bộ sổ mẫu trước" → `/models` (không tự đăng ký). Chỉ với `production:write` | `app/(dashboard)/marketing/creatives/{design-tab,page}.tsx` |
| `/production/topics/new`: ô chọn mẫu KHÔNG lọc trạng thái (C cũng không lọc) — gắn nhãn trạng thái khai + tín hiệu (chỉ khi có `models:view`); câu nhắc "Mở SỚM — vòng đời không đổi" / "vòng đời tự đi theo" | `app/(dashboard)/production/topics/new/{page,topic-form}.tsx` |
| Ảnh chụp lúc mở: `signalAtOpen` (chỉ NHÃN, không câu chi tiết) · `signalErrorAtOpen` · `lifecycleAtOpen` trong `evidence_snapshot` (jsonb, không cột mới); tín hiệu đọc hỏng không chặn mở topic | `lib/actions/production-topics.ts`, `lib/constants/production-os.ts` (3 trường tuỳ chọn trên kiểu) |
| Trang topic: nhãn "Mở sớm — mẫu đang Triển vọng / Test quảng cáo" + hai dòng bối cảnh; topic cũ ⇒ "—", không đoán | `app/(dashboard)/production/topics/[id]/page.tsx` |
| Buồng lái: loại `MODEL_EARLY_TOPIC` "Mẫu TRIỂN VỌNG — cân nhắc mở topic sản xuất sớm", ngay SAU `MODEL_SCALE`; CÙNG nguồn đọc (một lượt `getModelSignalsBatch` sinh cả hai loại), cùng quyền `models:view` + `expenses:view` + phạm vi ADS; khoá `modelWinnerSourceKey` (tín hiệu nằm trong khoá ⇒ không trùng khoá THẮNG) | `lib/constants/owner-decisions.ts`, `lib/queries/owner-decisions.ts` (`modelEarlyTopicCandidates`, `modelEarlyTopicToItems`) |
| CHECK loại của `recommendation_decisions` mở rộng (DROP IF EXISTS + ADD, idempotent) | `drizzle/0140_company_os_early_topic.sql`, `db/schema.ts`, `_journal.json` |
| Tài liệu | `target-architecture.md` §3/§9, `shared-contracts.md` §1 (ghi chú) + §7 |

Bản tin Lark (L): `OWNER_DIGEST_URGENT_KINDS` là danh sách tường minh `["APPROVAL", "SAMPLE_REVIEW"]` —
loại mới tự rơi vào "không gấp" ⇒ chỉ bản sáng. Không sửa tệp của L; bài kiểm khoá hành vi đó.

## 3. Chỗ lệch đề bài — và vì sao

1. **Có migration (0140)** dù đề bài dự kiến không: 0139 đặt CHECK trên `recommendation_decisions.kind`, nên
   không có nó thì bấm Chấp nhận / Bỏ qua trên dòng loại mới bị CSDL từ chối. **Agent X cũng thêm loại ⇒
   cũng phải thay CHECK: migration của X phải liệt kê CẢ `MODEL_EARLY_TOPIC`** (bài kiểm của H nay đọc CHECK
   ở migration MUỘN NHẤT có khai nó và so với `OWNER_DECISION_KINDS`, nên thiếu là đỏ).
2. **Cùng nguồn `MODEL_SCALE`** thay vì một nguồn mới: một lượt đọc lô, không phải sửa bài kiểm bản tin của
   L (nó giả nguồn theo tên), và `findOwnerDecisionItem` dựng lại đúng loại qua `spec.source`.
3. **Nhãn "Mở sớm" khi CHƯA KHAI chỉ gắn khi tín hiệu lúc mở là TRIỂN VỌNG.** Mẫu Pancake bán nhiều tháng
   cũng "chưa khai"; gắn "sớm" cho nó là khẳng định không chứng minh được.
4. **Mẫu đã khai THẮNG + tín hiệu TRIỂN VỌNG** ⇒ đề xuất mở topic thường (không "sớm", không kèm chuyển tay
   — mở topic thì C tự kéo sang Bàn sản xuất). Buồng lái vẫn gom nó vào `MODEL_EARLY_TOPIC` (đúng điều kiện
   đề bài: trạng thái trước Bàn sản xuất, kể cả THẮNG).
5. **Sửa bài kiểm của A2** (`tests/company-os-model-360.test.ts`): vòng lặp "chỉ THẮNG mới có đề xuất" là
   đúng luật CŨ; luật mới của chủ shop thêm TRIỂN VỌNG. Không phải bài kiểm hợp đồng `ORDER_OUTCOME`.
6. **Khối Sản xuất vẫn tự gọi `getModelProductionSummary`** (bài kiểm nguồn của A2 đòi đúng câu gọi đó);
   khối Đề xuất và ô đổi trạng thái dùng chung `productionOnce` (React `cache`).
7. Tệp của agent khác sửa (thêm, không tái cấu trúc): `production-os.ts` (3 trường tuỳ chọn), `model-360.ts`,
   `blocks.tsx`, `model-controls.tsx`, `page.tsx` (360), `design-tab.tsx`, `creatives/page.tsx`,
   `production/topics/**`, `production-topics.ts`, `owner-decisions.ts` ×2, `tests/company-os-cockpit.test.ts`
   (đọc CHECK ở migration muộn nhất), `tests/migration-upgrade-path.test.ts` (+0140).

## 4. Việc còn mở

- "Không topic ĐANG MỞ" theo `TOPIC_OPEN_STATUSES` (giống MODEL_SCALE): mẫu có topic Đã chốt phương án mà
  chưa khai THẮNG vẫn có thể được đề xuất mở topic sớm lần nữa. Muốn chặn thì đổi định nghĩa cho CẢ hai
  loại — việc của Tech Lead.
- `/production/topics/new?model=` đọc lô tín hiệu cả shop (đệm 90 s, hạn 2,5 s) chỉ để in một câu nhắc;
  lô lạnh thì câu nhắc chỉ dựa vào trạng thái khai.

## 5. Kiểm thử

`tests/company-os-early-topic.test.ts` (đăng ký sau Agent L trong `tests/sync-fixtures.test.ts`):

- **Thuần**: TRIỂN VỌNG đến từ bảng có sẵn; tệp luật không mang ngưỡng số · `topicOpeningMode` duyệt đủ
  5 tín hiệu × 16 trạng thái khai · trang 360 phân biệt SỚM / thường / đã khai THẮNG, link chỉ với
  `production:write`, topic đang mở hoặc chưa biết ⇒ đúng hành vi · ảnh chụp chỉ giữ NHÃN · `isEarlyOpen`
  (chưa khai chỉ "sớm" khi TRIỂN VỌNG) · nhãn trang topic, ảnh chụp cũ ⇒ không nhãn · chuyển tiếp sau khai
  THẮNG cho 11 hình dạng tóm tắt sản xuất (topic đóng / lệnh không trỏ bản duyệt không tính), lý do qua được
  `reasonIsEnough` · buồng lái: thứ tự sau MODEL_SCALE, quyền như MODEL_SCALE, ứng viên (0 topic thật, không
  Loại / Ngừng, THẮNG sang MODEL_SCALE), khoá tất định mang tín hiệu, không ngày · bản tin: có ở bản sáng,
  KHÔNG kích tin thêm trong ngày · quét mã nguồn (action chụp bối cảnh, nguồn sinh loại mới, tab Thiết kế
  gác quyền và không tự đăng ký, ô chọn mẫu không lọc, nút chuyển tiếp đi qua `transitionModel`).
- **CSDL (PGlite)**: mẫu TK chỉ có thiết kế THẮNG ⇒ buồng lái có dòng (lô THẬT `getModelSignalsBatch`) →
  mở topic được (không mã Pancake, vòng đời `UNDECLARED` đứng yên, ảnh chụp mang `signalAtOpen`) → dòng rời
  hàng đợi · mẫu ADS_TESTING qua topic + mẫu thử gửi duyệt VẪN ADS_TESTING, 0 dòng lịch sử · chốt topic →
  `winnerFollowUp(getModelProductionSummary)` = Duyệt mẫu → khai THẮNG (không tự kéo) → chuyển tiếp với lý do
  điền sẵn được lõi chấp nhận · `designModelLinks` (topic đang mở / đã chốt / thiết kế chưa vào sổ).
- `migration-upgrade-path`: +0140 — loại mới ghi được, đúng MỘT ràng buộc CHECK, loại lạ vẫn bị chặn.
- Không mốc đồng hồ thật (luật 50, 65): bản tin dùng một mốc truyền vào; phần CSDL không lọc theo thời gian.

**Đột biến: 23/23 bị bắt** (mỗi cái sửa một chỗ, chạy lại bộ T + thuần của A2 và H, rồi hoàn nguyên):
M1 TRIỂN VỌNG luôn "thường" · M2 bỏ cổng trạng thái (Loại được đề xuất) · M3 số topic chưa biết coi là 0 ·
M4 chưa khai luôn "sớm" · M5 ảnh chụp giữ câu chi tiết · M6 topic Đã đóng tính là sản xuất · M7 mẫu bị loại
→ Làm mẫu · M8 lệnh không bản duyệt tính · M9 đề xuất sớm kèm chuyển vòng đời · M10 bỏ nhánh chuyển tiếp ·
M11 ứng viên sớm nhận cả THẮNG · M12 nguồn không sinh loại sớm · M13 loại sớm thành gấp · M14 bớt quyền
`expenses:view` · M15 xếp trước MODEL_SCALE · M16 thêm cạnh ADS_TESTING → Bàn sản xuất · M17 bỏ gác quyền
tab Thiết kế · M18 action không chụp bối cảnh · M19 `designModelLinks` coi topic đã chốt là đang mở ·
M20 ô đổi trạng thái không giữ đề xuất chuyển tiếp · M21 `SELLING` thành "sớm" · M22 ảnh chụp cũ bị đoán
nhãn · M23 migration 0140 thiếu `MODEL_EARLY_TOPIC`.

## 6. Kiểm đường bấm (máy này)

`npm run build` + `next start` trên PGlite riêng (seed-admin + seed-demo + đồng bộ sổ mẫu; thêm 3 thiết kế:
TK-…-81 THẮNG, TK-…-82 đang test → khai Test quảng cáo + topic chốt + mẫu gửi duyệt, TK-…-83 đang test chưa
vào sổ), Chrome headless qua `playwright-core`, 1440px, 0 lỗi console, không cuộn ngang:

- `/models/<TK-81>` (chưa khai, tín hiệu Triển vọng): đề xuất "Cân nhắc mở topic sản xuất SỚM" + link
  "Mở topic sản xuất sớm" → biểu mẫu `/production/topics/new?model=…` in "Mở SỚM — mẫu đang Triển vọng /
  Chưa khai…" → bấm "Mở topic" → trang topic có nhãn "Mở sớm — mẫu đang Triển vọng / Chưa khai" và hai dòng
  bối cảnh; quay lại trang mẫu: đề xuất biến mất, trạng thái vẫn "Chưa khai".
- `/cockpit`: nhóm "Mẫu TRIỂN VỌNG — cân nhắc mở topic sản xuất sớm" có dòng TK-…-81.
- `/marketing/creatives?tab=thiet-ke`: 2 link "Mở topic sản xuất" (81, 82 — topic của 82 đã chốt nên không
  còn "đang mở") · 1 "Đồng bộ sổ mẫu trước" (83).
- `/production/topics/new`: 13 mẫu, ô chọn in "TK-990925-81 — Chưa khai · tín hiệu Triển vọng".
- `/models/<TK-82>` (Test quảng cáo, vòng đời KHÔNG đổi sau topic + mẫu): bấm "Lưu trạng thái" (Thắng test)
  ⇒ khung "Chuyển tiếp sang “Duyệt mẫu”" với lý do "Sản xuất đã đi trước lúc mẫu thắng: 1 topic đã chốt
  phương án · mẫu thử bản 1 đã gửi, chờ duyệt…" → bấm ⇒ trạng thái Duyệt mẫu, lý do nằm trong lịch sử.
- Lượt đầu tiên mở biểu mẫu ngay sau khi tạo dữ liệu KHÔNG in câu nhắc "Mở SỚM" (lô tín hiệu chưa kịp trong
  hạn 2,5 s); mở lại: có, 620–840 ms. Đúng hành vi đã khai (lô lạnh ⇒ thiếu nhãn, biểu mẫu vẫn dùng được).

## 7. Cổng (Windows, cây `wt-cos-t`)

`npm run typecheck` sạch · `npm run lint` sạch · `npm test` **TẤT CẢ KIỂM THỬ ĐẠT** (518 dòng ✓; các dòng ⚠
"CHƯA ĐO ĐƯỢC trên win32" và cảnh báo số hiệu 0041/0042 là có sẵn) · `npm run build` thành công
(`/models/[id]` 4,27 kB · `/production/topics/new` 4,59 kB · `/cockpit` 2,42 kB).
