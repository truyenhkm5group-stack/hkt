# Company OS — Bàn giao Agent W (đo mức dùng + làm ấm buồng lái)

Nhánh `claude/cos-do-luong-va-lam-nong` từ `origin/main` `66dd128b` (toàn bộ Company OS đã gộp và deploy).
**Không migration.** Không lịch mới (AGENTS.md mục 7) — chỉ mở rộng job `dashboard-warm` có sẵn.

## 1. Đã dựng

| Phần | Tệp |
|---|---|
| Job `dashboard-warm` làm ấm thêm 5 bộ máy CẢ SHOP có đệm mà "Cần anh quyết" đọc: quyết định vốn tồn, quyết định quảng cáo chiều chiến dịch (kỳ buồng lái) và chiều mã hàng (kỳ vòng phản hồi tồn), **tín hiệu mẫu theo lô** (MODEL_SCALE + MODEL_EARLY_TOPIC), trang Mua hàng (cửa sổ mặc định). `runWarms` chạy TUẦN TỰ, mỗi mục một `try/catch`, ghi thời gian từng mục; `warmDetail` là dòng `sync_runs.detail` | `lib/queries/warm.ts` |
| Kỳ 30 ngày của buồng lái được XUẤT ra (`ownerDecisionAdsPeriod`) để job dùng đúng kỳ trang đọc — trước là hằng cục bộ `ADS_PERIOD` | `lib/queries/owner-decisions.ts` (đổi tên + export, không đổi hành vi) |
| `memoKeys()` — tập khoá đệm đang giữ (chỉ chẩn đoán / kiểm thử) | `lib/cache.ts` |
| Chi tiết job = `warmDetail(r)`; mô tả job nói thêm buồng lái | `lib/sync/jobs.ts` |
| Script ops `company-os-summary` — CHỈ ĐỌC, CHỈ SỐ ĐẾM, qua kênh `[ops:tom-tat] ` | `scripts/company-os-summary.ts` |
| Thao tác ops: `options`, `OPS_THAO_TAC_MA_HOA`, làn `DOC_NANG`, nhánh `company-os-summary)` | `.github/workflows/ops-vps.yml` |
| Kiểm thử | `tests/company-os-warm.test.ts`, `tests/company-os-summary.test.ts` (đăng ký sau Agent X trong `tests/sync-fixtures.test.ts`) |
| Tài liệu | `docs/ops-doc-ket-qua.md` (dòng danh sách), `docs/security-2026-09-24-ops-log-leak.md` (bảng mục 6) |

## 2. Làm ấm — vì sao đúng những mục này

- **Làm ấm BỘ MÁY, không làm ấm HÀNG ĐỢI**: `getOwnerDecisionQueue` lọc theo quyền từng người và không có đệm —
  gọi nó từ job là tính cho không ai. Các nguồn không có đệm (yêu cầu duyệt, mẫu chờ duyệt, topic chờ quyết)
  đọc thẳng bảng 50–260 ms, không có gì để làm ấm.
- **Cùng khoá đệm, không gõ lại**: kỳ lấy từ `ownerDecisionAdsPeriod()` và `STOCK_FEEDBACK_ADS_PERIOD`. Bài kiểm
  KHÔNG so tên khoá gõ tay: xoá đệm → `warmCockpit()` → chụp tập khoá; xoá đệm → `getOwnerDecisionQueue` của người
  xem đủ quyền → chụp tập khoá; tập sau ⊆ tập trước (trên CSDL kiểm thử: 16 khoá, 0 thiếu). Cùng phép so cho
  `getModelSignalsBatch()` kỳ MẶC ĐỊNH (biểu mẫu mở topic sớm, cột Tín hiệu `/models`).
- **Thứ tự**: bảng điều khiển trước (thứ người mở nhiều nhất), rồi tồn → QC chiến dịch → QC mã hàng → tín hiệu
  mẫu (đọc lại tồn + QC mã hàng từ đệm vừa ấm) → Mua hàng.
- **Thời gian trong nhật ký**: `sync_runs.detail` = `ấm 7/7 mục (30d … ms · brief:30d … ms · cockpit:… ms …) · … ms`.
  Mục trúng đệm CŨ đo ra gần 0 ms (memo trả số cũ, làm mới phía sau) — số nhỏ KHÔNG có nghĩa nguồn rẻ.
- **Chi phí CPU**: job chạy mỗi 4 phút, TTL các bộ máy 90–120 s ⇒ mỗi lượt thường là một lượt trúng-đệm-cũ +
  làm mới nền. Thêm tải thật = một lượt tính mỗi bộ máy mỗi 4 phút. Sau deploy nên đọc `smoke` / `perf` một lượt
  (máy 2 nhân — tiền lệ ghi ở đầu `warm.ts`).

## 3. `company-os-summary` — in gì

Mỗi mục MỘT câu đọc (tuần tự); mục không đọc được in `—: (không đọc được: <lỗi>)`, **không bao giờ 0** (mục 42).
Bảng đọc được mà rỗng ⇒ 0 thật. Từ vựng đã biết in đủ (trạng thái không có dòng = 0), khoá lạ in kèm "(lạ)".

| Mục | Nguồn |
|---|---|
| Mẫu: tổng · có sản phẩm · chỉ thiết kế · chưa có cả hai · người gõ mã · theo vòng đời (kể cả "chưa khai") | `product_models` |
| Sổ mẫu xem trước: chờ đăng ký · chờ nối · **số** mã mơ hồ | `previewModelRegistry()` (cùng `planModelRegistry` của đường ghi) |
| Job `model-registry` (lượt cuối · trạng thái · số lượt 7 ngày) · job `dashboard-warm` (lượt cuối · trạng thái · số mục lỗi · **ms của tín hiệu mẫu** — dùng để xác nhận Task 1 sau deploy) | `sync_runs` |
| Sự kiện theo tên (7 ngày / tổng) + tên LIVE chưa phát lần nào | `domain_events` + `DOMAIN_EVENTS` |
| Topic theo trạng thái · mở SỚM (bằng CHÍNH `describeTopicOpenContext`) · tín hiệu lúc mở TRIỂN VỌNG · ảnh chụp cũ không bối cảnh | `production_topics` |
| Giá thành DRAFT/FINAL · mẫu xưởng theo trạng thái | `cost_sheets`, `samples` |
| Bản thiết kế · lệnh SX trỏ / không trỏ — tổng và **lập sau bản thiết kế đầu tiên** | `design_versions`, `production_orders` |
| "Cần anh quyết": theo phản ứng + loại × phản ứng (7 ngày / tổng) | `recommendation_decisions` |
| Tin Lark `owner.digest`: BẬT / TẮT / chưa khai / giá trị hỏng (`—`) · ngày xét cuối · gửi cuối · số khoá gấp đã báo | `settings` + `parseOwnerDigestLedger` |
| Hàng hoàn: DÒNG SỔ kết cục theo loại (dòng / món / món không nhãn) · món không nhãn theo trạng thái × có / chưa mẫu mã | `return_dispositions`, `return_unidentified` |
| Yêu cầu duyệt theo trạng thái (7 ngày / tổng) · `execution_error` · sự kiện `approval.executed` | `approval_requests`, `domain_events` |
| Phiếu nhập RECEIPT gắn lệnh SX / lô xưởng (tổng + 30 ngày) | `stock_receipts` |

Không cột nào mang tên / SĐT / email / địa chỉ / tiêu đề / ghi chú / mã được đọc (bài kiểm quét các câu SQL).
Mã mẫu mơ hồ chỉ ĐẾM. Không import tệp nào tạo trong nhánh này (chỉ `lib/` đã có trên `main` `66dd128b`).

### Chỗ lệch đề bài

1. **Làn `DOC_NANG`, không `DOC_NHE`**, và **CÓ trong `OPS_THAO_TAC_MA_HOA`** — đề bài bảo "như stock-wait-summary"
   và bảo kiểm cách nó được xếp rồi làm y hệt: `stock-wait-summary` nằm ở `DOC_NANG` + mã hoá. Ngoài ra
   `tests/ops-concurrency.test.ts` CẤM làn `DOC_NHE` dựng `npx tsx` (làn chạy song song không trần, RAM 1,9 GB).
   Dòng tóm tắt vẫn ra log công khai ngay (kênh `[ops:tom-tat]`), không cần giải mã.
2. "Lệnh SX có/không `design_version_id` từ 0136": `when` trong journal là mốc dựng lại, không phải ngày áp —
   mốc được dựng TỪ DỮ LIỆU: lệnh lập sau bản thiết kế đã duyệt ĐẦU TIÊN (chưa có bản nào ⇒ `—`, không `0/n`).
3. Hàng hoàn in **dòng sổ** (append-only), không phải tình trạng hiện tại đã gập — dòng in nói rõ điều đó.

## 4. Lệnh cho Tech Lead sau khi gộp

Script chạy được NGAY sau khi gộp (ops lấy script từ `main`, chỉ import `lib/` đã có trên ảnh đang chạy):

```
Actions → "Vận hành ERP trên VPS" → Run workflow
  action = company-os-summary
  arg    = (để trống)
```

hoặc `gh workflow run ops-vps.yml -f action=company-os-summary -f arg=` . Đọc khối **"Tóm tắt do script tự khai"**
trong log bước SSH (≈ 25 dòng). Bản mã chỉ cần khi muốn xem lỗi đầy đủ.

Phần làm ấm cần **deploy** (mã `lib/` chạy trong container). Sau deploy ≥ 4 phút, chạy lại `company-os-summary`:
dòng `JOB dashboard-warm` phải có `tín hiệu mẫu <n> ms` (trước deploy in `— (lượt cuối chưa làm ấm buồng lái)`)
và `mục lỗi 0`. Rồi mở trang chủ buổi sáng: khối "Cần anh quyết" không còn "Chưa đọc được: Tín hiệu mẫu".

## 5. Kiểm thử · cổng · đột biến

`testCompanyOsWarmPure` / `testCompanyOsWarmDb` / `testCompanyOsSummaryPure` / `testCompanyOsSummaryDb`:
- Cô lập lỗi: mục ném `Error` và ném chuỗi trần đều được ghi tên + lỗi, mục sau vẫn chạy, mỗi mục một dòng thời
  gian; chi tiết ≤ 900 ký tự; job vẫn `observeOnly`, gọi `warmDashboard` + `warmDetail`.
- Tập khoá (mục 2) + `warmDashboard` thật chạy đủ mục buồng lái, sau mục bảng điều khiển, 0 lỗi.
- Script: `null`/`NaN` ⇒ `—`, 0 ⇒ `0`, mục hỏng ⇒ `—` + lý do (không số 0 nào), từ vựng, gói dòng không rơi mẩu,
  ≤ 60 dòng × 300 ký tự với dữ liệu dài, sổ sự kiện hỏng ⇒ `approval.executed —`; quét SQL: không câu ghi, không cột
  người / mã, `name` chỉ ở `domain_events`; `ERP_READ_ONLY` trước `@/db`; mọi import `@/…` có tệp; nhánh ops đúng khuôn.
- PGlite: đo trước → gieo 3 mẫu, 1 topic mở sớm, 1 sự kiện, 1 yêu cầu duyệt lỗi, 1 lệnh SX, 1 phiếu nhập gắn lệnh,
  bật `owner.digest` (mọi chữ mang chuỗi bí mật + SĐT) → đo sau: 20 khẳng định ĐỘ CHÊNH, 0 chuỗi bí mật trong dòng
  in; giá trị `owner.digest` hỏng ⇒ `null`; tự dọn, trả lại `owner.digest` cũ.

Đột biến (13/13 bị bắt, mỗi cái một chỗ rồi hoàn nguyên): kỳ tín hiệu mẫu 7d · bỏ `catch` · bỏ mục Mua hàng
(bắt bởi phép so tập khoá: `purchasing:90`) · bỏ mục tín hiệu mẫu · `null` in 0 · đọc `name` của mẫu · câu `for
update` · JSON hỏng thành TẮT · mục hỏng in 0 · gói dòng rơi mẩu · in mã mơ hồ · rời lớp mã hoá · đếm "mở sớm"
theo chữ thay vì hàm chung.

Cổng (Windows, cây `wt-cos-w`, Bash): `npm run typecheck` sạch · `npm run lint` sạch · `npm test` **TẤT CẢ KIỂM THỬ
ĐẠT** (bốn dòng `✓ Company OS · W`) · `npm run build` thành công. Chưa chạy trên bản checkout sạch theo SHA — việc
của Tech Lead lúc gộp.

Hai bài kiểm có sẵn phải chạm (chỉ THÊM, không nới luật):
- `tests/company-os-returns.test.ts`: `DUOC_DOC` (tệp được đọc `return_dispositions`) thêm
  `scripts/company-os-summary.ts` kèm lý do — script chỉ đếm dòng + số món; `tests/company-os-summary.test.ts` quét
  SQL của nó để chặn mọi cột tiền (`value_estimate`, `unit_cost_estimate`, `cost_basis`, `amount`…).
- `tests/test-hygiene.test.ts` KHÔNG sửa: bài của W dựng chuỗi `ERP_READ_ONLY` từ mảnh thay vì xin miễn trừ.
