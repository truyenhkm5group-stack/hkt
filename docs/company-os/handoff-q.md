# Company OS — Bàn giao Agent Q (Khai theo gợi ý: máy gợi ý, người bấm)

Nhánh `claude/cos-khai-theo-goi-y` từ `origin/main` `3db871cc` · **không migration**.

## Vì sao

Đo production 27/09/2026 03:26 UTC (ops company-os-summary): 25 mẫu, 7 mẫu có sản phẩm Pancake (đã khai
đủ), **18 mẫu thiết kế TK đều "Chưa khai"**. Không ai khai từng mẫu một, trong khi máy đã tính sẵn giai đoạn
quan sát (`observeModelStage`, ƯỚC TÍNH) cho từng mẫu. Q đặt gợi ý ấy trước mặt người để họ XÁC NHẬN (hoặc
chọn khác) cả lô trong một cú bấm. Máy vẫn không bao giờ tự ghi (target-architecture Q3, luật 8.8, 34, 35).

## Đã dựng

| Phần | Tệp |
|---|---|
| **Chứng cứ theo lô** `getModelsEvidenceBatch(modelIds, { now? })`: mỗi nguồn đọc MỘT lần cho cả lô rồi cắt theo sản phẩm — chi QC 30 ngày (`excluded = false`), đã-từng-ghép qua `spendMappedProductIds` (cùng điều kiện `spendMappedFor`; chưa ghép ⇒ `null`), đơn lên (`orderCountedCond`, một điều kiện cho cả hai đường), lệnh SX nháp/đã gửi, tồn qua ĐÚNG `variantSalesSubquery`/`variantReceiptsSubquery`/`stockKnownExpr`/`erpStockExpr` gộp theo sản phẩm. Không đệm (dùng cho thao tác khai). `getModelEvidence` nhận thêm `opts.now` (mặc định bây giờ — hành vi cũ không đổi) và dùng chung `evidenceBase` / `designEvidence` / `evidenceSince` / `orderCountedCond` với lô. | `lib/queries/models.ts` |
| Phần thuần: `buildDeclarePreview`, hằng `BULK_DECLARE_MAX = 200` (trần kỹ thuật), lý do điền sẵn, nguồn `ui:/models:bulk-suggest` / `ui:/models/<id>:suggest`, kết cục từng dòng | `lib/constants/model-bulk-declare.ts` (mới) |
| Lõi `declareModelsFromSuggestionCore(db, { items, reason, actor, source, now? })`: từ chối actor không khoá / lý do ngắn / lượt rỗng / > 200; tính lại gợi ý Ở MÁY CHỦ; mỗi mẫu MỘT giao dịch: `SELECT … FOR UPDATE` → còn `NULL` không (hàng rào màn hình cũ) → `transitionModelCore(tx, actorKind "USER", metadata { suggested, accepted, basis: "ESTIMATED", suggestedReasons })`. Mỗi dòng một kết cục: `DECLARED` · `SKIPPED_ALREADY_DECLARED` (kèm trạng thái hiện tại) · `SKIPPED_NO_SUGGESTION` · `NOT_FOUND` · `FAILED` (câu lỗi GỐC, không in cả câu SQL). | `lib/models/bulk-declare.ts` (mới) |
| Server action `declareModelsFromSuggestion({ items: [{ modelId, state, expectedState: null }], reason, from? })` — `models:write`, zod (trùng mẫu bị từ chối), actor = `users.id` + tên đọc từ phiên, một dòng `audit` tóm tắt `MODEL_BULK_DECLARE` (chỉ khi khai được ≥ 1), `revalidatePath("/models", "layout")` ở MỌI nhánh thành công (kể cả khai 0 dòng: màn hình đang cũ). | `lib/actions/models.ts`, nhãn ở `lib/constants/audit.ts` |
| `/models`: chip "Khai theo gợi ý" (chỉ người `models:write`, khi còn mẫu chưa khai) → `?khai=goi-y` ⇒ khối bảng xem trước: ☐ · Mã · Mẫu (ảnh + tên) · Máy gợi ý (nhãn "Ước tính") · Căn cứ (lý do đầu + ⓘ tất cả + ⚠ ô chưa biết) · Khai là (chọn khác được). Mẫu không gợi ý: "Chưa đủ dữ liệu để gợi ý", ô tick khoá. Lý do điền sẵn sửa được. Nút "Khai N mẫu". Dòng không khai được hiện ngay dưới đầu khối. Tập mẫu = mẫu CHƯA KHAI khớp ô tìm / "Nối với" đang áp, KHÔNG cắt theo trang, tối đa 200. Lô chứng cứ chỉ đọc khi bảng được mở. | `app/(dashboard)/models/{page,bulk-declare-panel}.tsx` |
| Trang 360: mẫu CHƯA KHAI mà máy có gợi ý ⇒ ô khai chọn sẵn gợi ý + điền sẵn cùng lý do; "Lưu trạng thái" đi CÙNG lõi (một dòng, nguồn `ui:/models/<id>:suggest`). Mẫu đã khai / không gợi ý: như cũ (`transitionModel`). | `app/(dashboard)/models/[id]/{page,model-controls}.tsx` |
| Kiểm thử | `tests/company-os-bulk-declare.test.ts` (đăng ký sau `testCompanyOsEvidenceGapsDb`), `tests/action-refresh-once.test.ts` (+ tệp bảng vào `SACH`) |

## Chỗ lệch đề bài

1. **Gợi ý do máy chủ tính lại lúc ghi**, không nhận từ client: `accepted` so với gợi ý của máy chủ; mẫu mà máy chủ không còn gợi ý ⇒ `SKIPPED_NO_SUGGESTION` dù client gửi. Nếu chứng cứ đổi giữa lúc xem và lúc bấm, lịch sử ghi gợi ý LÚC GHI.
2. `metadata` thêm `suggestedReasons` (câu lý do của máy) ngoài ba khoá đề bài.
3. Tham số `from: "list" | "detail"` chỉ đổi NGUỒN ghi vào lịch sử; trang 360 dùng `ui:/models/<id>:suggest`.
4. "Mẫu trong view" = mẫu chưa khai theo ô tìm + bộ lọc "Nối với" đang áp (bỏ phân trang), không phải chỉ 25 dòng của trang hiện tại.
5. Không có thêm bất kỳ ngưỡng nghiệp vụ nào; 200 là trần kỹ thuật.

## Kiểm thử + đột biến

Thuần: chỉ mẫu chưa khai vào bảng · không gợi ý ⇒ không chọn, không tick · chi QC `null` không sinh "Test quảng cáo" và được NÓI RA · lý do điền sẵn qua được cổng lý do. Mã nguồn: lõi chỉ được gọi từ server action · chuỗi nguồn khai ở một chỗ · `lib/sync`, `lib/jobs*`, `lib/integrations`, `scripts`, `app/api` không chạm luồng này · `actorKind: "USER"` · `FOR UPDATE` và hàng rào đứng trước lượt chuyển · trang chỉ đọc lô khi mở bảng · trang 360 chọn sẵn + điền sẵn. CSDL (PGlite, mã `cos-q-`/`COSQ`, dữ liệu 2003–2004, `now` cố định, tự dọn): **lô = `getModelEvidence` trên MỌI mẫu của CSDL kiểm thử × 2 mốc**; ô chưa biết là `null`; khai 8 dòng một lượt: chấp nhận / chọn khác (`accepted false`, trạng thái là của người) / không gợi ý / người khác vừa khai (không đè) / trigger CSDL ném (dòng đó lùi, dòng SAU vẫn khai) / không tồn tại / đã khai từ trước; lịch sử + sự kiện mang `USER` + `users.id`, lý do, nguồn, `historyId` khớp; bấm lại 0 dòng mới; hai lượt đồng thời ⇒ một `DECLARED` + một `SKIPPED`.

**Đột biến 18/18 bị bắt** (mỗi cái áp riêng, chạy bộ Q, hoàn nguyên): M1 bỏ hàng rào chưa-khai · M1b hàng rào vô hiệu nhưng giữ chữ (bắt bởi bài CSDL) · M2 chi chưa ghép thành 0 · M3 lô đếm đơn huỷ · M4 tick sẵn mẫu không gợi ý · M5 máy chủ nhận mẫu không gợi ý · M6 dòng hỏng kéo cả lượt · M7 `accepted` luôn true · M8 `actorKind` SYSTEM · M9 nhận actor không khoá · M10 lô cộng chi bị loại · M11 trang đọc lô vô điều kiện · M12 action bỏ revalidate · M13 lô bỏ mốc `now` · M14 trang 360 đi đường cũ (lượt đầu KHÔNG bắt — regex chỉ khẳng định lời gọi tồn tại; đã thêm khẳng định điều kiện + chọn sẵn + điền sẵn, chạy lại: đỏ) · M14b 360 không chọn sẵn · M15 xem trước giữ mẫu đã khai · M16 bỏ `FOR UPDATE` (chỉ bài mã nguồn bắt được: PGlite một kết nối không dựng được hai giao dịch chen nhau thật).

## Đường bấm (next start + PGlite + seed-admin + seed-demo + `syncModelRegistry` + 4 thiết kế TK + 1 mẫu trống, Chrome headless qua playwright-core, 1440px)

- `/models`: "Chưa khai (15)" → bấm "Khai theo gợi ý" ⇒ bảng 15 dòng: QDEMO-TRONG "Chưa đủ dữ liệu để gợi ý" (ô tick khoá); SP001–SP010 "Ước tính · Đang bán" (căn cứ "n đơn lên trong 30 ngày", ⚠ 2 ô chưa biết: chi QC chưa ghép, chưa phiếu nhập); TK-01 Test quảng cáo, TK-02 Làm creative, TK-03 Thua test, TK-04 Thắng test. Không cuộn ngang, 0 lỗi console.
- Bỏ tick SP001, đổi SP002 Đang bán → **Xả tồn**, lý do để nguyên ⇒ nút "Khai 13 mẫu" → toast "Đã khai 13 mẫu"; bảng còn QDEMO-TRONG, SP001; chip "Chưa khai (2)".
- `/models/<SP001>`: ô khai chọn sẵn "Đang bán · máy gợi ý (ước tính)", lý do điền sẵn.
- `/models/<SP002>`: lịch sử "Chưa khai → Xả tồn · Quản trị viên · Lý do: Khai lần đầu theo gợi ý của ERP (giai đoạn ước tính)".

## Cổng

Windows, cây `wt-cos-q`: `npm run typecheck` sạch · `npm run lint` sạch · `npm test` **TẤT CẢ KIỂM THỬ ĐẠT** · `npm run build` thành công (`/models` 6,45 kB · `/models/[id]` 5,21 kB). Chưa chạy trên bản checkout sạch theo SHA — việc của Tech Lead lúc gộp.

## HUMAN GATE

Không migration, không job, không ngưỡng. Sau deploy chủ shop / người có `models:write` thấy chip "Khai theo gợi ý" trên `/models`; 18 mẫu TK sẽ được gợi ý theo phán quyết thiết kế (DRAFT → Làm creative, TESTING → Test quảng cáo, WIN → Thắng test, LOSE → Thua test, PRODUCTION → Bàn sản xuất). Mỗi lời khai là của người bấm — nên đọc lướt cột "Căn cứ" trước khi bấm.
