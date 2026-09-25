# Bàn giao — Company OS · Agent F · Kinh tế theo mẫu

Nhánh `claude/cos-f-economics` (từ `origin/main` 5a3a7ee6). Migration `0134_company_os_economics`.

## Đã dựng

1. **CPO hoà vốn trên bảng quyết định `/ads` — MỘT công thức.**
   `lib/constants/break-even-cpo.ts::maxAdCostPerOrder` là đường chia duy nhất; `adsCeiling`
   (tab Lợi nhuận danh nghĩa) được viết lại để gọi `breakEvenSpend` + `spendPerOrder` của cùng tệp —
   cùng số học, không đổi con số nào. `buildDecisionRow` thêm `breakEvenCpo` (LN góp đo được ÷ đơn
   chốt), `projectedBreakEvenCpo` (LN góp tạm tính ÷ đơn chốt), `breakEvenCpoBasis` (theo `basis` của
   khuyến nghị) và `cpoHeadroom` (hoà vốn − CPO thực). Hai câu hỏi khác nhau thật sự (LN góp ở `/ads`
   vs LN ròng danh nghĩa ở tab báo cáo) mang ba nhãn khác nhau `BREAK_EVEN_CPO_LABEL`; tooltip cả hai
   màn hình nói rõ khác tử số. Bảng `/ads`: tầng ba của ô "Đơn chốt · CPO · hoà vốn" + bốn dòng trong
   phần mở rộng. Chỉ THÊM trường — chữ ký `getAdsDecision` không đổi (Agent B đọc song song).
2. **Sổ quyết định chụp dự phóng.** Ba cột NULLABLE `projected_profit_after_ads`,
   `projected_headroom`, `applied_delivery_rate`; job `marketing-decision-ledger` chép từ đúng dòng.
   Đường ghi tách thành `upsertLedgerValues()` để kiểm được. Không backfill; không đụng dòng ngày cũ.
3. **`getModelEconomics(productId, range)`** (`lib/queries/model-economics.ts`)
   — 12 dòng, mỗi dòng ba ô `estimated` / `realized` / `projected` (`number | null` + nhãn "Ước tính" /
   "Thực đạt" / "Tạm tính" + nguồn + ghi chú). `cogsBasis` khai rõ cả hai bộ máy dùng giá vốn SỐNG,
   không dùng `recognized_cogs`. Hàm thuần `buildModelEconomics` cho kiểm thử.
4. **Báo cáo chênh lệch giá SX** (`lib/queries/production-variance.ts`) — mở rộng bảng "theo mã" có
   sẵn ở `/inventory/workshop?tab=cost` (không tạo bảng thứ hai): giá SX thực tế · giá lệnh SX · giá
   ước tính · giá báo MKT, mỗi ô có "chênh = phiếu kho − giá ấy", mốc là giá phiếu kho (ⓘ giải thích
   vì sao). Mã chỉ có lệnh SX vẫn có dòng.

## Tệp

Mới: `lib/constants/break-even-cpo.ts`, `lib/queries/model-economics.ts`,
`lib/queries/production-variance.ts`, `drizzle/0134_company_os_economics.sql`,
`tests/company-os-economics.test.ts`, tệp này.
Sửa: `lib/queries/ads-decision.ts`, `lib/constants/estimated-cost.ts`,
`lib/marketing/decision-ledger.ts`, `lib/queries/workshop-ledger.ts` (chỉ `export latestReceiptCost`),
`app/(dashboard)/ads/decision-table.tsx`, `app/(dashboard)/inventory/workshop/page.tsx`,
`app/(dashboard)/reports/ads-ceiling-table.tsx` (chỉ tooltip), `db/schema.ts` (ba cột trong bảng
`ads_decision_ledger`, sửa tại chỗ theo §0), `drizzle/meta/_journal.json`,
`tests/sync-fixtures.test.ts`, `tests/migration-upgrade-path.test.ts`, `docs/ads-decision-contract.md`.

## Lệch khỏi đề bài — và lý do

- **Không thêm cột `profit_basis`**: `ads_decision_ledger.basis` (ACTUAL/PROJECTED) đã có từ 0111.
  Thay vào đó thêm `projected_headroom` + `applied_delivery_rate` — hai thứ cần để đo sai số dự báo.
- **`projected_profit_after_ads = NULL` khi dòng không biết số chi** (`spendKnown = false`) — số
  trước QC giả làm số sau QC là nói dối (mục 42).
- **Không thêm tham số lọc theo mã vào `getNominalProfitReport`**: dòng của một mã phụ thuộc cả shop
  (vận hành/cố định chia theo tỷ trọng doanh số), lọc xuống một mã thì hoặc sai hoặc không rẻ hơn.
  Gọi báo cáo đầy đủ qua `memo` (tham số `…, true, false, false` — trùng khoá cache với bảng lương)
  rồi nhặt dòng. Bằng nhau theo cấu trúc, có kiểm thử.
- **Giá vốn dự tính KHÔNG áp** trong `getModelEconomics` (luật 2 của `estimated-cost.ts`: chỉ tab
  danh nghĩa + một ngoại lệ được bật; `tests/estimated-cost.test.ts` quét và đã bắt bản đầu có công
  tắc tuỳ chọn). Mã chưa có giá vốn thật: ô tiền in số kèm ghi chú "CAO HƠN THẬT" như tab danh nghĩa.
- **Chênh lệch = phiếu kho − nguồn** (không phải nguồn − phiếu kho) để giữ nguyên dấu cột "Chênh lệch"
  cũ; con số cũ (phiếu kho − giá xưởng) giờ nằm dưới ô "Giá SX thực tế", cùng giá trị, cùng dấu.
- **Cột "giá báo MKT" trong tên mã** của bảng cũ chuyển thành một cột riêng.
- `CPO hoà vốn · LN góp` ở `/ads` dùng %CP khác = 0 — đúng phạm vi mọi ô khác của bảng quyết định
  (`profitAfterAds`, `headroom` đều không trừ khoản đó). Bất biến `cpoHeadroom ≈ profitAfterAds ÷ đơn`.

## Kiểm thử

`tests/company-os-economics.test.ts` (đăng ký sau `testMarketingDecisionLedger`): A — CPO hoà vốn
khớp `adsCeiling` trên 4 bộ đầu vào + khớp bảng quyết định, bất biến dư địa, null/NaN/0 đơn, số âm,
căn cứ tạm tính, ba nhãn, quét mã nguồn; B — sổ chép dự phóng, không `?? 0`, dòng cũ đứng nguyên,
chạy lại trong ngày cập nhật; C — `getModelEconomics` bằng đúng dòng danh nghĩa/quyết định trên
fixture, nhánh rỗng toàn null, dòng giả kiểm từng trường; D — chênh lệch: dấu, null, giá báo theo
`now` cố định, mã chỉ có lệnh SX, chọn lệnh gần nhất có giá (bỏ 0 ₫/NULL/huỷ), quét: không tệp nào
ngoài trang Giá SX import báo cáo, báo cáo không đọc bốn bảng sổ xưởng, không báo cáo tiền nào import
`model-economics`. `migration-upgrade-path`: dòng sổ gieo trước 0134 giữ NULL cả ba cột.

Đột biến (13/13 bị bắt): bỏ chặn 0 đơn · dư địa luôn theo số đo · adsCeiling chia riêng · sổ không
chặn khi thiếu số chi · upsert bỏ cột dự phóng · Ước tính LN ròng đọc nhầm trường · đảo dấu chênh ·
giá báo bỏ qua `now` · null thành 0 · CPO hoà vốn đọc số tạm tính · backfill dòng sổ cũ · lệnh SX lấy
giá 0 · lệnh SX lấy lệnh huỷ.

Kết quả cổng (Windows, cây riêng `wt-cos-f`): `npm run typecheck` sạch · `npm run lint` sạch ·
`npm test` in **TẤT CẢ KIỂM THỬ ĐẠT** (kể cả `chatbot` trên Windows ở lượt này) · `npm run build` thoát 0.
Ba bộ gác sẵn có đã bắt bản đầu và được sửa ĐÚNG gốc, không nới luật: `marketer-price` (báo cáo chênh
lệch đọc giá báo — thêm vào danh sách được phép, kèm lý do: chỉ hiển thị), `estimated-cost` (bỏ công
tắc giá dự tính khỏi `getModelEconomics`), `duplicate-metrics` (đổi tên hàm trợ giúp `v`). Bài
`migration-upgrade-path` bản đầu gieo dòng sổ ở bước 1 trong khi bảng sổ (0108) còn thuộc nhóm
migration mới — đã chuyển sang kiểm "không DEFAULT + tệp 0134 không có UPDATE".

## Còn lại

- Trang 360 (Agent A2) chưa gọi `getModelEconomics` — hàm sẵn sàng, chưa có màn hình riêng.
- Chưa có màn hình đo SAI SỐ DỰ BÁO (so `projected_profit_after_ads` của ngày D với số đo khi cohort
  chín) — cần vài tuần dữ liệu sau khi deploy 0134 mới có gì để đo.
- Quần thể đơn của hai bộ máy khác nhau (danh nghĩa: chưa huỷ theo ngày lên đơn; quyết định:
  `confirmed`) — đã khai trong `notes`, chưa hợp nhất (ngoài phạm vi, đổi số liệu báo cáo).
- Đánh số: `0134` với `idx 133` nhảy qua 131/132 (của A, D). Tech Lead đánh lại số/`when` lúc gộp
  nếu cần; `when = 1790005588245`.

## HUMAN GATE

- Deploy migration 0134 (thuần bổ sung, NULLABLE) — cần lượt deploy thường.
- Nếu chủ shop muốn `getModelEconomics` dùng giá vốn DỰ TÍNH cho mẫu mới (mở rộng ngoại lệ của
  `estimated-cost.ts` luật 2 + danh sách `choPhep` của `tests/estimated-cost.test.ts`) — quyết định của
  chủ shop, hiện KHÔNG áp.
- Không đổi ngưỡng, không đổi số liệu báo cáo nào đã có.
