# Company OS — Bàn giao Agent ST (lời khai đi SAU thực tế: máy đề xuất cập nhật, người bấm)

Nhánh `claude/cos-trang-thai-theo-thuc-te` (từ `origin/main` `1a9ad5ed`) · **không migration** · không job, không ngưỡng.

## Vì sao

Đo production 27/09/2026 12:41 UTC (ops company-os-summary): 31 mẫu, đội vừa khai 22 mẫu qua "Khai theo gợi ý"
(21 → Làm creative, 1 → Test quảng cáo). Lời khai là ẢNH CHỤP của người: khi vòng creative đưa thiết kế TK sang
Đang test / THẮNG / Loại, hay sản xuất đi tiếp (topic, giá thành, mẫu thử, lệnh gửi xưởng, hàng về kho) thì lời
khai cũ đi — và Bảng quy trình mẫu (BD) xếp thẻ theo LỜI KHAI, nên thẻ đứng sai cột. P2 đã bắt chiều lời khai đi
TRƯỚC chứng cứ; ST bắt chiều ngược lại và đặt MỘT cú bấm trước mặt người. Máy không bao giờ tự chuyển (Q3).

## Đã dựng

| Phần | Tệp |
|---|---|
| Luật thuần `staleStateSuggestion(declared, facts)` → `{ to, reasons, short } \| null`, `staleFactsOf`, bảng dịch dữ kiện → TÊN SỰ KIỆN (`SAMPLE_STATUS_EVENT`, `PRODUCTION_FACT_EVENT`), hai dữ kiện đuôi `STALE_TAIL_FACTS`, lý do điền sẵn, nguồn `ui:/models:stale-update` · `ui:/models/<id>:stale` | `lib/constants/model-stale-state.ts` (mới) |
| Đọc theo lô: `getLinkedReceiptCountsBatch` (một câu), `getModelsStaleFactsBatch` (= `getModelsEvidenceBatch` của Q + `getModelProductionSummariesBatch` của C + phiếu nối), `listStaleStatePreview` | `lib/queries/model-stale-state.ts` (mới) |
| Lõi của Q MỞ RỘNG (không đường ghi thứ hai): dòng `expectedState` khác `null` = lượt CẬP NHẬT — máy chủ tính lại đề xuất từ đúng lời khai người thấy, `FOR UPDATE` + lời khai phải còn nguyên (lệch ⇒ `SKIPPED_STATE_CHANGED`, kết cục mới), lịch sử `metadata { kind: "STALE_UPDATE", suggested, accepted, reasons }` | `lib/models/bulk-declare.ts`, `lib/constants/model-bulk-declare.ts` (`buildStalePreview`, `DeclarePreviewRow.current`) |
| Action `declareModelsFromSuggestion` thêm `kind: "declare" \| "stale"` (không trộn hai luồng một lượt), nhật ký `MODEL_STALE_UPDATE` | `lib/actions/models.ts`, `lib/constants/audit.ts` |
| Bảng quy trình: nguồn việc `STALE` ngay SAU chỗ hở chứng từ (P2), trước gợi ý khai (Q) và đề xuất 360; nhãn `Cập nhật → <cột> (<căn cứ>)`, mở `/models/<id>#trang-thai-khai`; chỉ người `models:write`; chứng cứ creative đọc CÙNG lô với gợi ý khai; phiếu nối gác cổng Sản xuất | `lib/constants/model-pipeline.ts`, `lib/queries/model-pipeline.ts` |
| Trang 360: ô khai hiện câu chứng cứ, CHỌN SẴN đích, ĐIỀN SẴN lý do (sửa được), lưu qua lõi của Q (`kind: "stale"`) | `app/(dashboard)/models/[id]/{page,model-controls}.tsx` |
| `/models`: chip "Cập nhật theo thực tế (N)" → `?capnhat=thuc-te` ⇒ bảng xem trước CÙNG thành phần của "Khai theo gợi ý" (`mode="stale"`: thêm cột Đang khai, tick / chọn khác / xác nhận) | `app/(dashboard)/models/{page,bulk-declare-panel}.tsx` |
| Kiểm thử | `tests/company-os-stale-state.test.ts` (đăng ký sau `testCompanyOsPipelineBoardDb`); sửa kỳ vọng ở `tests/company-os-pipeline-board.test.ts` và hai regex ở `tests/company-os-bulk-declare.test.ts` |

Buồng lái / Lark: KHÔNG thêm gì (bài kiểm khoá `owner-decisions.ts` không có loại mới).

## Bảng luật

| Lời khai | Dữ kiện | Đề xuất |
|---|---|---|
| Ý tưởng | thiết kế TK bất kỳ | Làm creative |
| Ý tưởng / Làm creative | thiết kế Đang test / THẮNG / Loại, hoặc chi QC đã ghép > 0 | Test quảng cáo |
| Test quảng cáo | thiết kế THẮNG / Loại | Thắng test / Thua test (chỉ từ đây) |
| Ý tưởng · Làm creative · Test QC | topic, giá thành, mẫu thử, lệnh, phiếu | **không gì** — luồng song song của T |
| Thắng test trở đi | topic chưa đóng · giá thành · mẫu thử (5 trạng thái) · bản duyệt · lệnh trỏ bản duyệt | đích = `LIFECYCLE_FOLLOW[sự kiện]` của C, lấy đích XA NHẤT |
| Thắng test … Lên kế hoạch SX | lệnh ĐÃ GỬI xưởng | Đang sản xuất (ngoài bảng C) |
| Đang sản xuất | ≥ 1 phiếu NHẬP HÀNG nối lệnh / lô, không còn lệnh gửi nào đang chờ hàng | Đang bán (ngoài bảng C) |
| Chưa khai · Thua test · Ngừng | mọi thứ | không (chưa khai là việc của Q) |

Chỉ đi TỚI theo thứ tự `MODEL_STATES`. Ô CHƯA BIẾT không phải chứng cứ.

## Chỗ lệch đề bài (và vì sao)

1. **Chứng cứ sản xuất cho mẫu ≥ THẮNG lấy đích xa nhất** (vd. Thắng + mẫu đã duyệt ⇒ Mẫu đã duyệt), không chỉ một
   bước — cùng kết luận với `winnerFollowUp` của T (bài kiểm so hai đường trên mọi tổ hợp).
2. **Làm creative + thiết kế THẮNG ⇒ Test quảng cáo, không Thắng**: đề bài chỉ cho phán quyết từ Test quảng cáo.
3. **Thiết kế "Đưa vào sản xuất"** (người đặt, bất kỳ lúc nào) không chứng minh đã test ⇒ chỉ tính là "đã có thiết kế".
4. **Không đề xuất lùi kể cả cạnh tiến SAMPLE_REVIEW → SAMPLING, SELLING → PRODUCTION_PLANNING** — bộ đi theo của C
   lo đúng lúc hành động xảy ra; đề xuất chúng từ dữ kiện cũ là kéo lùi.
5. **Hai dữ kiện ngoài bảng của C** (C không phát sự kiện khi gửi lệnh; phiếu nối không kéo vòng đời). Khai trong
   `STALE_TAIL_FACTS`, bài kiểm khoá: không trùng giá trị của `LIFECYCLE_FOLLOW`, mỗi đích là một cạnh tiến có sẵn.
6. **Phiếu nối LÔ đếm theo dòng phiếu** (mẫu mã nhập vào), không đọc bảng lô xưởng — sổ công nợ chỉ bốn tệp của nó
   được chạm (`tests/workshop-ledger.test.ts`). Phiếu nối lệnh lấy sản phẩm của lệnh.
7. **P2 vẫn đứng trước**: mẫu vừa thiếu chứng từ vừa có đề xuất (vd. khai "Mẫu đã duyệt" chưa có bản duyệt, lệnh đã
   gửi) hiện nút chứng từ trước; cập nhật ở 360 vẫn làm được.
8. **Bảng quy trình dùng quyền đọc sản xuất của người xem** (như BD); lõi ghi và `/models` tính với đủ dữ kiện.
   Người có `models:write` mà không có `planning:view` chỉ thấy đề xuất creative trên bảng.
9. **Kỳ vọng BD đổi**: mẫu Test QC có thiết kế THẮNG nay có việc "Cập nhật → Thắng" (trước: không nút / mở topic
   sớm); mẫu Thắng + topic chốt: "Cập nhật → Bàn SX" thay `lifecycle-production-ahead`. Đề xuất mở topic sớm của T
   vẫn hiện với người chỉ xem (khẳng định giữ nguyên).
10. `/models` luôn đọc bảng xem trước cho người khai được (số N trên chip cần nó) — ba lô, không truy vấn theo mẫu.

## Kiểm thử · đột biến · đường bấm

Thuần: 15.552 tổ hợp lời khai × dữ kiện (5.148 có đề xuất) — chỉ đi tới, không từ chưa khai / Thua / Ngừng, trước
THẮNG không phụ thuộc sản xuất (T), từ THẮNG không phụ thuộc creative, phán quyết chỉ từ Test QC, mọi ô chưa biết ⇒
`null`, trùng `productionTrackState` của T; 36 dòng bảng đặt tên; thứ tự việc tiếp theo. Mã nguồn: luật thuần, đích
sản xuất qua `LIFECYCLE_FOLLOW[eventName]`, không gõ lại sáu đích của C, không số; không job / đồng bộ / webhook chạm
luồng; chỉ lõi ghi. CSDL (PGlite, `cos-st-`, 2002, `now` cố định): lô = đường một mẫu trên MỌI mẫu; phiếu nối lệnh /
lô, phiếu hoàn không đếm; bảng xem trước đúng 10 mẫu; bảng quy trình có / không nút theo quyền và = đường một mẫu;
lõi: chấp nhận / chọn khác, lời khai lệch ⇒ bỏ qua, T giữ ở máy chủ, USER + `users.id`, `STALE_UPDATE`, bấm lại / đồng
thời không ghi thêm, thẻ dời cột.

**Đột biến 20/20 ĐỎ** (mỗi cái áp riêng, chạy bộ ST + Q + BD, hoàn nguyên): lùi · sản xuất kéo mẫu trước THẮNG · phán
quyết từ Làm creative · chi chưa biết thành chứng cứ · đề xuất từ Thua · bảng thứ hai · phiếu nối từ mọi lời khai ·
bỏ điều kiện lệnh còn chờ · bỏ hàng rào lời khai · nhận đề xuất từ client · thiếu `kind` · nút cho người không khai
được · STALE đứng sau · phiếu nối không gác Sản xuất · bảng gửi hàng rào `null` · đếm phiếu hoàn · 360 không qua
luồng stale · lô bỏ sản xuất · ghi SYSTEM · bảng xem trước giữ dòng không đề xuất.

**Đường bấm** (`npm run build` + `next start` + PGlite: seed-admin + seed-demo + `syncModelRegistry`; thiết kế
TK-260927-91 NHÁP khai **Làm creative** rồi chuyển Đang test; TK-260927-92 Đang test khai **Test quảng cáo** rồi chuyển
THẮNG; Chrome headless qua `playwright-core`, 1440px, 0 lỗi console, không cuộn ngang):
- `/models?view=bang`: thẻ TK-91 ở cột "Ý tưởng / Creative" mang nút **"Cập nhật → Test QC (thiết kế đã lên camp)"**;
  TK-92 ở "Test QC" mang "Cập nhật → Thắng / Triển vọng (thiết kế thắng test)".
- Bấm nút TK-91 ⇒ `/models/<id>#trang-thai-khai`: ô xanh "Thực tế đã đi trước lời khai “Làm creative” — đề xuất cập
  nhật sang “Test quảng cáo”", ô chọn sẵn "Test quảng cáo · bước tiếp · theo thực tế", lý do điền sẵn "Cập nhật theo
  thực tế: Thiết kế đã lên camp test quảng cáo (Đang test)" ⇒ **Lưu trạng thái** ⇒ toast "Đã cập nhật", lịch sử
  "Làm creative → Test quảng cáo". Quay lại bảng: thẻ TK-91 **sang cột Test QC**, hết nút.
- `/models`: chip **"Cập nhật theo thực tế (1)"** ⇒ bảng xem trước 1 dòng "TK-260927-92 · Đang khai Test quảng cáo ·
  Theo chứng từ Thắng test" ⇒ **Cập nhật 1 mẫu** ⇒ chip "(0)", bảng báo không còn mẫu; trên bảng quy trình TK-92 sang
  cột "Thắng / Triển vọng" với việc tiếp theo "Cân nhắc mở topic sản xuất cho mẫu".
- 390px `/models?capnhat=thuc-te`: không cuộn ngang.

## HUMAN GATE

Không migration, không job, không ngưỡng. Sau deploy người có `models:write` thấy chip "Cập nhật theo thực tế (N)"
trên `/models` và nút "Cập nhật → …" trên Bảng quy trình; mỗi cập nhật là lời khai của người bấm — đọc cột "Căn cứ".
