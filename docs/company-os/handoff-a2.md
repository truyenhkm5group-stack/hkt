# Company OS — Bàn giao Agent A2 (trang Model 360 · tín hiệu mẫu · ý tưởng → mẫu)

Nhánh `claude/cos-a2-model-360` (tích hợp A · D · G · F + `origin/main` có B) · migration `0138_company_os_idea_model`.

## 1. Đã dựng

| Phần | Tệp |
|---|---|
| Trang `/models/[id]`: đầu trang (của A) + nhãn tín hiệu + ý tưởng đã nối · bộ lọc kỳ (nuqs `period/from/to`, mặc định 30 ngày) · Trạng thái khai · Giai đoạn quan sát · **Tín hiệu mẫu** · **Đề xuất** · **Creative & quảng cáo** · **Đơn · giao · hoàn** · **Tồn kho** · **Kinh tế: ước tính vs thực đạt** · **Sản xuất** (chỗ chờ) · Lịch sử vòng đời · Dòng thời gian (gồm cả ý tưởng) | `app/(dashboard)/models/[id]/{page,blocks,suggestion-transition}.tsx` |
| Bảng gộp tín hiệu (thuần, không ngưỡng) | `lib/constants/model-signal.ts` → `deriveModelSignal` |
| `getModelSignal(modelId, range?)` | `lib/queries/model-signal.ts` |
| Phần thuần của trang: `loadSource` (không sập trang), in số `countText/moneyText/pctText/ratioText`, quyền theo khối, `deriveModelSuggestions`, `mergeTimelines`, **`MODEL_360_PENDING_SOURCES` (điểm nối C/E)** | `lib/constants/model-360.ts` |
| Hàm đọc: `getModelOrderOutcome` (dòng chiều mã của bảng quyết định /ads), `getModelInventoryDecisions`, `getModelLinkedIdeas`, `ideaTimelineEntries` | `lib/queries/model-360.ts` |
| Ý tưởng → mẫu: lõi một giao dịch gọi `registerModelCore` của A + ghi `marketing_ideas.model_id` | `lib/models/idea-link.ts`, `lib/actions/model-ideas.ts` (`registerModelFromIdea`, quyền `models:write`) |
| Nút "Đăng ký thành mẫu" / link "Mẫu Q…" trên trang ý tưởng | `app/(dashboard)/ideas/[id]/{page,register-model}.tsx`, `lib/queries/ideas.ts` (`IdeaDetail.model`) |
| Cột `marketing_ideas.model_id` (NULL, FK `product_models` ON DELETE SET NULL, chỉ mục), không backfill | `db/schema.ts`, `drizzle/0138_company_os_idea_model.sql`, `_journal.json` (idx 137, when 1790006120000) |
| `/models`: dải "Lọc nhanh: Tất cả · Chưa khai" (facet trạng thái khai đã có từ A) | `app/(dashboard)/models/page.tsx` |
| Kiểm thử | `tests/company-os-model-360.test.ts` (đăng ký sau `testCompanyOsModelsQueries`), `tests/migration-upgrade-path.test.ts` (+0137) |

Mỗi khối: một ranh giới `Suspense`, đọc nguồn qua `loadSource` (lỗi ⇒ "Không đọc được nguồn X" + ⓘ câu lỗi), số + link sang màn hình chủ, giải thích trong ⓘ, cảnh báo dữ liệu thu thành "⚠ n". Không khối nào truy vấn CSDL trực tiếp.

**Quyền theo khối** (`MODEL_360_BLOCK_ACCESS`): trang 360 không là cửa sau — Quảng cáo `expenses:view` (+ phạm vi ADS), Creative `ideas:view`, Đơn `reports:returns` (+ REPORTS), Tồn `products:view`, Kinh tế `reports:nominal` (+ REPORTS), Quyết định tồn / Sản xuất `planning:view`. Không quyền ⇒ khối nói cần quyền gì, không in số; lý do của tín hiệu bị che câu chi tiết (giữ nhãn). Ô "Chi QC 30 ngày" ở thẻ quan sát của A nay cũng che khi không có quyền quảng cáo.

## 2. Bảng tín hiệu (khai đầy đủ trong đầu `lib/constants/model-signal.ts`)

Lá phiếu: Quảng cáo SCALE/HOLD → tốt · WATCH → trung tính · FIX_DELIVERY → đáng lo · CUT → xấu · INSUFFICIENT/NO_SPEND/không dòng/**chi chưa ghép (`SPEND_UNMAPPED`)** → chưa đủ. Mẫu mã: gộp `classifyProduct` từng mẫu mã, thận trọng trước (LOSER > RISK > WINNER > NEUTRAL > INSUFFICIENT). Creative: có WIN → tốt · PROMISING → hứa hẹn · còn chạy/chờ → đang thử · mọi mẩu đã phán tắt/loại → xấu · chỉ UNJUDGED/chưa phán → chưa đủ. Thiết kế: WIN/PRODUCTION → tốt · DRAFT/TESTING → đang thử · LOSE → xấu.

Tầng THỊ TRƯỜNG (quảng cáo × mẫu mã), thứ tự thận trọng LOẠI < CẦN THÊM DỮ LIỆU < ĐANG THỬ < TRIỂN VỌNG < THẮNG:

| QC \ Mẫu mã | tốt | trung tính | đáng lo | xấu | chưa đủ |
|---|---|---|---|---|---|
| tốt | THẮNG | ĐANG THỬ | ĐANG THỬ ⚡ | LOẠI ⚡ | TRIỂN VỌNG |
| trung tính | ĐANG THỬ | ĐANG THỬ | ĐANG THỬ | LOẠI | ĐANG THỬ |
| đáng lo | ĐANG THỬ ⚡ | ĐANG THỬ | ĐANG THỬ | LOẠI | ĐANG THỬ |
| xấu | LOẠI ⚡ | LOẠI | LOẠI | LOẠI | LOẠI |
| chưa đủ | TRIỂN VỌNG | ĐANG THỬ | ĐANG THỬ | LOẠI | → tầng thử |

⚡ = xung đột, lấy phía thận trọng. Tầng THỬ (khi thị trường chưa đủ cả hai): tốt/hứa hẹn → TRIỂN VỌNG, đang thử → ĐANG THỬ, xấu → LOẠI, lấy mức thận trọng nhất; không nguồn nào ⇒ CẦN THÊM DỮ LIỆU. Khi thị trường đã kết luận, nhãn thử chỉ HẠ: THẮNG + nhãn thử xấu ⇒ TRIỂN VỌNG + xung đột; LOẠI + nhãn thử tốt ⇒ giữ LOẠI + xung đột. Tồn kho và trạng thái khai KHÔNG bỏ phiếu — chỉ thêm xung đột (tín hiệu tốt mà có mẫu mã chôn vốn/nên xả; LOẠI mà kho kêu đặt thêm; khai WINNER/LOSER ngược tín hiệu).

## 3. Điểm nối cho C và E

`MODEL_360_PENDING_SOURCES` trong `lib/constants/model-360.ts` — danh sách chờ DUY NHẤT: `getModelProductionSummary` (C · khối Sản xuất) và `getModelReturnDispositions` (E · khối Tồn kho). Khi hàm có thật: gỡ dòng khỏi danh sách và gọi hàm qua `loadSource` trong khối tương ứng ở `blocks.tsx` (tìm "ĐIỂM NỐI"). Bài kiểm ĐỎ ngay khi một trong hai hàm được `export` ở `lib/` mà dòng chờ còn nguyên. Hôm nay khối Sản xuất chỉ có số lệnh SX nháp/đã gửi (từ `getModelEvidence` của A) + link `/inventory/planning/orders`.

## 4. Chỗ lệch đề bài (và vì sao)

1. **Một nhãn thử cũ không kéo mẫu đang có lãi thật xuống LOẠI** — chỉ chặn THẮNG (hạ TRIỂN VỌNG) và nêu xung đột. Đọc câu "lấy phía thận trọng" theo nghĩa đen sẽ để thiết kế "Loại" từ vòng test xoá bằng chứng tiền thật.
2. **TỐT × TRUNG TÍNH = ĐANG THỬ** (không phải TRIỂN VỌNG): lấy mức thận trọng nhất của hai nguồn đã kết luận, không có ngoại lệ.
3. **Đề xuất sản xuất** là đề xuất CHUYỂN TRẠNG THÁI sang `PRODUCTION_DISCUSSION` (lý do điền sẵn, sửa được, người bấm; đi `transitionModel` của A), hiện khi tín hiệu THẮNG và trạng thái khai ∈ {chưa khai, IDEA, CREATIVE, ADS_TESTING, WINNER}. Không link route của C.
4. **Đơn/giao/hoàn đọc dòng chiều mã của `getAdsDecision(range, "product")`** (ORDER_OUTCOME qua `ORDER_OUTCOME_FAST`, rời kho theo `SHIPMENT_LEFT_WAREHOUSE`), không `getReturnRateByVariant` (hàm toàn shop, cohort theo ngày bàn giao, không đệm). Cùng dòng B và F đọc ⇒ ba khối không nói ba số đơn. Không có dòng ⇒ 0 đơn THẬT (quần thể đã quét hết), tỷ lệ `—`.
5. `getModelSignal(modelId, range?)` thêm tham số kỳ tuỳ chọn (mặc định 30 ngày) so với chữ ký hợp đồng §6.
6. `/models` đã có facet trạng thái khai + ô "Chưa khai" từ A; A2 chỉ thêm dải lọc nhanh.
7. Tệp ngoài danh sách sở hữu, chỉ thêm: `lib/models/idea-link.ts` (thư mục của A — lõi mới, không sửa lõi cũ), `lib/queries/ideas.ts` (trường `model`), `app/(dashboard)/ideas/[id]/page.tsx` (nút).

## 5. Lỗi của agent khác — BÁO, KHÔNG SỬA

- **F `getModelEconomics`**: mã có đơn mà `ad_spends` chưa từng ghép chiến dịch ⇒ dòng Chi QC / CPO in **0 ₫** ở cả Ước tính lẫn Thực đạt, lợi nhuận sau QC tính trên chi 0 — trong khi B (`getModelAdsSummary`) trả `SPEND_UNMAPPED` ⇒ `—` cho cùng mã (luật 42, 67). Thấy thật trên dữ liệu demo (SP001). Trang 360 gắn cảnh báo đỏ ở khối Kinh tế khi B nói `SPEND_UNMAPPED`, không đổi số của F. F nên áp cờ ghép chi của B.
- **A `getModelEvidence`**: "Chi QC 30 ngày" in `0 ₫` cho mã chưa ghép chiến dịch (A đã tự khai ở handoff-a). Chưa sửa.

## 6. Kiểm thử

`testCompanyOsModel360Pure` + `testCompanyOsModel360Db`: 8.448 tổ hợp đầu vào (× 6 trạng thái tồn × 4 trạng thái khai), bảng thị trường 5×5 và bảng thử 6×4 so từng ô với bảng khai + cờ xung đột; bất biến: THẮNG ⇔ hai nguồn thị trường tốt và không nhãn thử xấu, thiếu nguồn thị trường không bao giờ THẮNG, chi chưa ghép luôn "chưa đủ", tồn kho/trạng thái khai không đổi tín hiệu, tầng thử chỉ hạ, tất định. Đề xuất: không sinh từ nguồn trống / NO_ROW / SPEND_UNMAPPED / DATA_INSUFFICIENT / tín hiệu khác THẮNG; số đặt = tổng `suggestedQty` (đã trừ hàng đặt xưởng), thiếu ⇒ "—" + lưu ý cổng dữ liệu. `loadSource` bắt lỗi ném đồng bộ/bất đồng bộ/không phải Error. In số: 0 ≠ `—`. Mã nguồn: `model-signal.ts` không có hằng số nào ngoài thứ hạng 0–4; đầu vào `classifyProduct` dựng đúng như `/products/performance`; mọi khối async đứng sau `Suspense` riêng và đọc qua `loadSource`; trang không import `@/db`; danh sách chờ C/E nói thật. CSDL: ý tưởng → mẫu (IDEA, lịch sử NULL→IDEA mang khoá, sự kiện `source = ui:/ideas/<id>`, trạng thái ý tưởng giữ nguyên), lần hai / mã trùng / actor không khoá / ý tưởng không tồn tại bị từ chối, **hai lượt đồng thời ⇒ đúng một mẫu, lượt thua lùi cả mẫu (không mồ côi)**, mẫu không sản phẩm ⇒ CẦN THÊM DỮ LIỆU không ném, kỳ không đơn (2001) ⇒ 0 đơn / tỷ lệ `null`. `migration-upgrade-path`: ý tưởng cũ giữ `model_id` NULL, FK chặn mẫu lạ, xoá mẫu ⇒ NULL.

**Đột biến (19/19 bị bắt)**: M1 bỏ chặn TRIỂN VỌNG khi thiếu một nguồn · M2 chi chưa ghép dùng hành động · M3 đảo thứ tự gộp mẫu mã · M4 bỏ hạ THẮNG khi nhãn thử xấu · M5 tồn kho đổi tín hiệu · M6 đề xuất QC khi chi chưa ghép · M7 đề xuất đặt từ DATA_INSUFFICIENT · M8 `loadSource` ném lại · M9 `countText(null)` ra 0 · M10 bỏ hàng rào `model_id IS NULL` (bắt bởi bài hai lượt đồng thời) · M11 bỏ `Suspense` quanh khối Tồn kho (lượt đầu KHÔNG bắt — regex quá lỏng, đã siết rồi chạy lại: đỏ) · M12 thêm ngưỡng số vào bảng gộp · M13 C export `getModelProductionSummary` mà dòng chờ còn · M14 tỷ lệ 0 thay `null` · M15 chi QC mặc định 0 trong `classifyProduct` · M16 bỏ che lý do theo quyền · M17 FK `ON DELETE cascade` · M18 đề xuất sản xuất cho TRIỂN VỌNG · M19 không lọc dòng tồn theo mã. Khôi phục cả 19: xanh.

## 7. Kiểm đường bấm (máy này)

`npm run build` + `next start` trên PGlite riêng (seed-admin + seed-demo + đồng bộ sổ mẫu: 10 mẫu `SP00x` trạng thái NULL), Chrome headless qua `playwright-core`, 1440px:
- `/models/<SP001>` (NULL, có đơn, chưa phiếu nhập, chưa ghép chi QC): 200, 0 lỗi console, không cuộn ngang; tín hiệu "Đang thử · chưa ngả" (QC chưa đủ vì chi chưa ghép · mẫu mã Đáng lo); đơn 84 · giao 52 · hoàn 24 · GTC 68,4%; tồn "Chưa có phiếu nhập"/`—`; kinh tế 12 dòng 3 cột; Sản xuất "Chưa nối".
- `/models/<A2DEMO1>` (không sản phẩm, không dữ liệu): 200, 0 lỗi; tín hiệu "Cần thêm dữ liệu", mọi khối in "— Mẫu chưa có sản phẩm Pancake…", không số 0 giả.
- `/ideas/<id>`: bấm "Đăng ký thành mẫu" → gõ "a2 demo 2" → Đăng ký ⇒ sang `/models/<mới>` mã `A2DEMO2`, đầu trang và dòng thời gian hiện ý tưởng; quay lại ý tưởng: nút ẩn, hiện link "Mẫu A2DEMO2".
- `/models?state=NONE`: dải lọc nhanh "Tất cả (11) · Chưa khai (10)", 10 mẫu.
- Chưa bấm thử được nút đề xuất chuyển trạng thái (dữ liệu demo không có mẫu THẮNG) — nút gọi `transitionModel` có sẵn.

## 8. Cổng

Windows, cây `wt-cos-a2`: `npm run typecheck` sạch · `npm run lint` sạch · `npm test` **TẤT CẢ KIỂM THỬ ĐẠT** · `npm run build` thành công (`/models/[id]` 3,97 kB). Chưa chạy trên bản checkout sạch theo SHA — việc của Tech Lead lúc gộp.

## 9. HUMAN GATE

1. Bảng gộp tín hiệu (mục 2) là một quyết định kinh doanh về CÁCH đọc các phán quyết — chủ shop xác nhận, đặc biệt hai chỗ lệch ở mục 4.1–4.2.
2. Migration 0137 (thêm cột, không backfill) áp khi deploy.
3. Quyền theo khối (mục 1): người chỉ có `models:view` sẽ thấy ít khối hơn — đúng ý đồ, nhưng cần báo trước.
