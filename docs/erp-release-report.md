# BÁO CÁO RELEASE — ERP DATA TRUTH

Nhánh: `claude/erp-data-truth-p0` · tách từ `main` tại `cf90934`.
Kế hoạch: `CLAUDE_ERP_MASTER_PLAN.md` · Kiểm toán nền: `docs/erp-data-truth-audit.md`
Tiến độ từng task: `docs/claude-release-progress.md`

---

## 1. Việc đã làm

21 commit, 18 task, **73 tệp thay đổi**.

| # | Commit | Nội dung |
|---|---|---|
| 1 | `docs: audit ERP data truth architecture` | Kiểm toán 12 phát hiện F1–F12 |
| 2 | `feat: centralize canonical order shipment payment truth` | Bảng đăng ký năm chiều sự thật |
| 3 | `feat: harden ViettelPost event ingestion` | Cờ chiều cho hành trình · chống trùng gói tin · một hàm ghi trạng thái |
| 4 | `feat: add shipment reconciliation safeguards` | **Đóng F1 + F2** — quét chỉ đọc, chỉ tự sửa ca xác định |
| 5 | `feat: centralize ERP metric truth` | Lớp chỉ số + `docs/metrics-contract.md`, **đóng F4** |
| 6 | `chore: rebuild canonical historical ERP truth` | Chạy thử → cảnh báo → ghi, idempotent & resumable |
| 7 | `feat: turn data quality into ERP control tower` | 18 luật có bằng chứng và drill-down |
| 8 | `test: enforce ERP business truth invariants` | 12 bất biến; **tìm thêm 2 vi phạm còn sót** |
| 9 | `feat: standardize ERP financial truth` | Sáu con số tiền + bậc thang lợi nhuận |
| 10 | `feat: improve inventory truth and stock risk` | Năm trạng thái hàng, **đóng F5** |
| 11 | `feat: add product variant performance intelligence` | Hiệu quả theo mẫu mã + ma trận Màu × Size |
| 12 | `feat: add prioritized ERP action queue` | Hàng đợi việc có mức ưu tiên và người nhận |
| 13 | `feat: optimize ERP management dashboard` | Buồng lái 8 KPI, tách rõ ba con số tiền |
| 14 | `feat: add COD-aware ads profitability metrics` | Bốn mức ROAS theo kết quả đơn |
| 15 | `feat: add integration health observability` | **Đóng F8** — sức khoẻ cho mọi connector |
| 16 | `perf: optimize ERP critical paths` | Đo trước, sửa đúng chỗ chậm nhất |
| 17 | `feat: improve ERP business audit trail` | Nhật ký đủ sáu câu, che bí mật |
| 18 | `refactor: improve ERP UX consistency` | Bốn chiều không còn nhìn giống nhau |
| — | 3 commit sửa lỗi | lint, kiểm thử, và một hồi quy hiệu năng tự phát hiện |

---

## 2. Thay đổi kiến trúc / schema / migration

### Kiến trúc

- `lib/constants/truth.ts` — bảng đăng ký **năm chiều sự thật**, và allowlist hai luồng duy nhất
  được ghi `shipments.stage`.
- `lib/queries/metrics.ts` — hai population có tên + mọi vị ngữ và biểu thức tiền.
- `lib/constants/reconciliation.ts` + `lib/queries/control-tower.ts` — 18 luật đối soát, mỗi luật
  một câu truy vấn dùng chung cho đếm / ví dụ / drill-down.
- `lib/queries/financial-truth.ts` · `product-intelligence.ts` · `ads-roas.ts` ·
  `action-queue.ts` · `integration-health.ts` — năm lớp chỉ số mới, tất cả đi qua `ORDER_OUTCOME`.
- `lib/sync/backfill.ts` — dựng lại lịch sử an toàn.
- `lib/sync/consistency.ts` — viết lại thành quét/sửa tách bạch.

### Migration (3 bản, đều viết tay idempotent)

| Bản | Nội dung |
|---|---|
| `0032_webhook_dedupe.sql` | `webhook_events`: `dedupe_key` (unique) · `occurred_at` · `delivery_count` |
| `0033_action_queue.sql` | `notifications`: `assigned_to` · `assigned_at` · `acknowledged_by` · `acknowledged_at` + index |
| `0034_perf_indexes.sql` | 2 index riêng phần cho hai truy vấn chạy trên từng vận đơn |

**Không sửa migration nào đã áp dụng ở production (0000–0031).**

> Ghi chú quan trọng: bản `drizzle-kit generate` sinh tự động cho 0032 **gộp cả** những migration
> viết tay 0027–0031 (vì chúng chưa có snapshot), nên chạy nguyên bản đó sẽ `CREATE TABLE` đè lên
> bảng production. Đã thay bằng bản viết tay chỉ chứa thay đổi của chính nó.

---

## 3. Thay đổi logic nghiệp vụ và chỉ số

### Sửa lỗi làm SAI SỐ LIỆU

| # | Lỗi | Ảnh hưởng trước khi sửa |
|---|---|---|
| F1 | Job `data-check` suy `DELIVERED` từ `cod_status` rồi ghi đè `shipments.stage` | Tiền về ngân hàng biến vận đơn chưa giao thành "giao thành công" ⇒ doanh thu và GTC bị thổi lên |
| F2 | Job `data-check` hạ `cod_status` đơn hoàn về `NOT_APPLICABLE` | Xoá sạch dấu vết thu hộ ⇒ không đòi được tiền Viettel Post |
| F3 | Bước hành trình ghi không kèm cờ chiều | Mã 501 của **chiều hoàn** đẩy vận đơn thành "giao thành công" |
| F4 | Tổng quan lấy doanh thu và giá vốn theo hai tập đơn khác nhau | Lợi nhuận ước tính lệch |
| F5 | Cảnh báo thiếu hàng bằng ngưỡng cứng `tồn <= 5` | Ba nơi cho ba con số khác nhau; bỏ sót mẫu mã bán chạy |
| — | Pancake giữ **bản thứ hai** của luật dựng trạng thái | Bản sao chậm có thể lật trạng thái đã có chứng từ ĐVVC |
| — | `statement-db` ghi thẳng `stage` rồi mới dựng lại | Một chỗ nữa có thể lệch |

### KHÔNG đổi

`ORDER_OUTCOME` **giữ nguyên từng ký tự** về mặt logic — chỉ thay danh sách nguồn chép cứng bằng
hằng số cùng giá trị. Ngưỡng 50.000 / 100.000 / 10.000 không đổi. Contract test 14 tình huống xanh.

### Chỉ số mới

Sáu con số tiền tách bạch · bốn mức ROAS · hiệu quả theo mẫu mã · năm trạng thái hàng · điểm ưu
tiên việc · bốn mức sức khoẻ tích hợp. Hợp đồng đầy đủ ở `docs/metrics-contract.md`.

---

## 4. Kết quả backfill

**Chưa chạy trên production** — và đó là chủ ý. Bộ máy backfill mặc định CHẠY THỬ, và
`backfillWarnings()` chặn tay khi có bất thường (hơn 20% vận đơn sẽ đổi, hoặc có đơn đang giao
thành công bị lật). Việc lật doanh thu đã chốt phải do chủ shop duyệt (AGENTS.md §7).

Trên dữ liệu kiểm thử: chạy thử không ghi gì · ghi xong dựng lại lần hai báo **0 thay đổi** ·
dữ liệu gốc, tiền và mốc kho nhận hàng hoàn không bị đụng · chạy tiếp được theo lô.

**Việc cần làm sau deploy:** chạy `canonical-backfill` ở chế độ chạy thử trên production, đọc con số
"đơn lật từ giao thành công sang hoàn", rồi mới quyết định có ghi hay không.

---

## 5. Chất lượng dữ liệu — trước / sau

| | Trước release | Sau release |
|---|---|---|
| Số luật đối soát | 0 (chỉ 7 nhóm truy vấn rời rạc) | **18 luật** có mức nghiêm trọng, bằng chứng, việc cần làm |
| Luật ERP được phép tự sửa | không giới hạn rõ ràng; job sửa cả ca nhập nhằng | **3 luật xác định**, mỗi lần sửa ghi nhật ký |
| Xung đột tiền ↔ giao hàng | tự "sửa" bằng cách lật trạng thái giao hàng | phát hiện, xếp mức **NGHIÊM TRỌNG**, không bao giờ tự sửa |
| Trạng thái ĐVVC chưa hiểu | im lặng | hiện trên Kết nối dữ liệu + là một luật đối soát |
| Gói tin chưa xử lý được | chỉ có ở Viettel Post | có ở mọi connector, kèm mức sức khoẻ |

Trên CSDL trống: 18/18 luật sạch. Con số production phải đo sau deploy.

---

## 6. Hiệu năng — trước / sau

Đo bằng `scripts/perf-audit.ts` trên CSDL fixture (PGlite):

| Truy vấn | Trước | Sau |
|---|---|---|
| Tổng quan | **324 ms** | **284 ms** |
| Chân lý tài chính | 40 ms | 42 ms |
| Trung tâm điều khiển | 26 ms (nối tiếp) | 32 ms (song song) |
| Mọi trang còn lại | < 45 ms | < 45 ms |

Mức cải thiện ở đây bị giới hạn vì **PGlite chỉ có MỘT kết nối** nên `Promise.all` vẫn xếp hàng;
trên Postgres production có connection pool thì các truy vấn thật sự chạy song song. Quan trọng
hơn con số hiện tại là **độ dốc**: trung tâm điều khiển trước đây cứ thêm một luật là thêm một
bậc chờ, nay không.

Hai index riêng phần nhắm vào hai truy vấn chạy trên **từng vận đơn** — chi phí của chúng tăng
theo bình phương khi shop lớn dần.

---

## 7. Kiểm thử

- **22 tệp kiểm thử**, 69 khối kiểm thử in `✓`, chạy trong `npm test`.
- `npm test` đã là **điều kiện CHẶN** của workflow *Deploy ERP to VPS* nên bộ bất biến nằm trong CI sẵn.
- Bộ mới của release: `canonical-truth` · `vtp-ingestion` · `reconciliation` · `metrics-contract` ·
  `backfill` · `business-invariants` · `financial-truth` · `product-intelligence` · `action-queue` ·
  `ads-roas` · `audit-trail` · `ui-consistency`.

**Bộ kiểm thử bất biến đã trả về giá trị ngay khi viết**: nó tìm ra hai vi phạm còn sót
(`pancake/sync.ts` và `statement-db.ts` cùng ghi `shipments.stage`) mà đọc mã bằng mắt đã bỏ qua.

---

## 8. FINAL GATE — kết quả

| # | Kiểm tra | Kết quả |
|---|---|---|
| 1 | `git status` sạch | ĐẠT |
| 2 | Tự soát toàn bộ diff của release | ĐẠT — tìm ra 1 hồi quy hiệu năng do chính release gây ra, đã sửa (`81a33c3`) |
| 3 | Đồng bộ với `main` | ĐẠT — `main` không tiến kể từ lúc tách nhánh, không có xung đột |
| 4 | Giải quyết xung đột | Không có |
| 5 | `npm run typecheck` | ĐẠT — sạch |
| 6 | `npm run lint` | ĐẠT — 0 lỗi (3 cảnh báo có sẵn từ trước release) |
| 7 | Kiểm thử đơn vị | ĐẠT |
| 8 | Kiểm thử tích hợp | ĐẠT (cùng bộ, chạy trên CSDL thật PGlite) |
| 9 | Bộ bất biến nghiệp vụ | ĐẠT — 12/12 |
| 10 | `npm run build` | ĐẠT |
| 11 | Migration chạy thử | ĐẠT — cả trên CSDL trống **và** trên CSDL đã có 0000–0031 (mô phỏng production); chạy lại lần hai không lỗi; 36 bảng / 133 index giống hệt nhau ở cả hai đường |
| 12 | Kiểm tra idempotency của backfill | ĐẠT — dựng lại lần hai báo 0 thay đổi |
| 13 | Quét chất lượng dữ liệu | ĐẠT trên CSDL trống (18/18 luật sạch); production đo sau deploy |
| 14 | Quét nhất quán KPI | ĐẠT — `consistency` + `metrics-contract` |
| 15 | Kiểm tra an toàn | ĐẠT — không có bí mật trong diff; `redactSecrets()` che token trước khi ghi nhật ký |
| 16 | Kiểm tra hồi quy hiệu năng | ĐẠT — xem mục 6 |
| 17 | Kế hoạch quay lui | Xem mục 10 |

---

## 9. Giới hạn đã biết

1. **Chưa đo được số liệu production.** Môi trường này không truy cập được CSDL production, nên mọi
   con số trong báo cáo là số trên CSDL kiểm thử. Phần đối chiếu trước/sau trên production
   (AGENTS.md §6.5) phải làm sau deploy.
2. **Backfill chưa chạy trên production** — cố ý, xem mục 4.
3. **`leg_type` của dữ liệu lịch sử vẫn trống.** Sự kiện cũ được ghi trước khi ERP đọc cờ
   `IS_RETURNING` thì không thể bổ sung ngược — ERP không đoán. Vận đơn cũ vẫn dựa vào hai bằng
   chứng còn lại (vận đơn chiều hoàn, doanh thu bị sửa sau khi giao).
4. **`UNSELLABLE` chỉ đếm phần hụt đo được từ chênh lệch phiếu**, chưa có luồng ghi nhận hàng lỗi
   do kho tự khai.
5. **ROAS chỉ quy kết được đơn có `ad_id`.** Phần không quy kết được hiện riêng, không chia đều —
   đây là giới hạn của dữ liệu, không phải của công thức.
6. **3 cảnh báo lint có sẵn** từ trước release (`production-editor.tsx`, `lib/cs/failed-delivery.ts`,
   `lib/landing/sheet.ts`) — không đụng tới vì ngoài phạm vi.

---

## 10. Kế hoạch quay lui

**Mức 1 — quay lui mã nguồn (5 phút).** `git revert` merge commit rồi chạy lại workflow deploy.
Ba migration mới **chỉ THÊM cột và index**, không xoá và không đổi cột nào, nên bản mã cũ vẫn chạy
bình thường trên schema mới. Không cần quay lui CSDL.

**Mức 2 — nếu số liệu trông sai sau deploy.** Không cần quay lui: mọi lớp chỉ số mới đều là truy
vấn đọc. Tắt bằng cách không mở các trang mới; `ORDER_OUTCOME` không đổi nên số liệu cũ vẫn nguyên.

**Mức 3 — nếu đã lỡ chạy backfill và muốn hoàn tác.** Không cần bản sao lưu: trạng thái vận đơn là
**hàm xác định của tập sự kiện**, và backfill không đụng tới lịch sử sự kiện. Chạy lại
`canonical-backfill --apply` sẽ đưa về đúng trạng thái tính được từ lịch sử. Dữ liệu gốc, tiền và
mốc kho nhận hàng hoàn chưa bao giờ bị backfill chạm vào.

**Điều KHÔNG cần quay lui:** không migration nào xoá dữ liệu, không job nào trong release này ghi
hàng loạt khi chưa được bật tường minh (`fix=1` / `apply=1`).

---

## 10b. Trạng thái deploy — CHƯA CHẠY

`main` đã có toàn bộ release (`adff461`) và đã push lên GitHub. **Deploy chưa chạy.**

Lý do: workflow *Deploy ERP to VPS* chỉ kích hoạt bằng `workflow_dispatch`, và môi trường làm việc
này không có `gh` CLI lẫn token GitHub nên không bấm chạy được. Đây là giới hạn công cụ, không phải
cổng kiểm tra nào chưa đạt — FINAL GATE đã đạt 17/17.

**Chủ shop bấm chạy:** GitHub → repo `hkt` → tab **Actions** → **Deploy ERP to VPS** → **Run
workflow** → nhánh `main` → để `reset_env` = false → Run.

Workflow tự chạy `tsc --noEmit` và `npm test` TRƯỚC khi đụng tới máy chủ; contract test đỏ thì
deploy dừng. Cả hai vừa xanh trên chính `main` sau khi merge.

## 11. Danh sách kiểm tra sau deploy

Mở lần lượt và xác nhận trang lên được, số liệu có nghĩa:

- [ ] `/` Tổng quan — 8 thẻ KPI, ba con số tiền khác nhau, thẻ "Dữ liệu sai nghiêm trọng"
- [ ] `/orders` Đơn hàng
- [ ] `/shipments` Vận đơn
- [ ] `/cod` Đối soát COD
- [ ] `/reports?tab=truth` **Sáu con số tiền** (tab mới)
- [ ] `/reports/returns` Tỷ lệ giao thành công
- [ ] `/data-quality` **Trung tâm điều khiển** (mục mới) — bấm thử một luật để mở danh sách
- [ ] `/integrations` **Sức khoẻ tích hợp** (bảng mới) — bốn connector đều có mức và lý do
- [ ] `/inventory` và `/inventory/planning`
- [ ] `/alerts` **Hàng đợi việc** (mục mới) — bấm "Tôi nhận" một việc rồi kiểm tra nhật ký
- [ ] `/ads` **ROAS theo kết quả đơn** (mục mới)

Kiểm tra hệ thống:

- [ ] `/api/health` trả OK
- [ ] Log khởi động không có lỗi migration (0032, 0033, 0034 áp dụng xong)
- [ ] Số lỗi máy chủ không tăng bất thường
- [ ] Webhook Viettel Post và Pancake vẫn về (xem "Nhận tin gần nhất" ở Sức khoẻ tích hợp)
- [ ] GTC trên Tổng quan **bằng** GTC ở `/reports/returns` cho cùng một kỳ
- [ ] Doanh thu giao thành công trên Tổng quan **bằng** con số ở tab Sáu con số tiền

Sau khi mọi thứ ổn định:

- [ ] Chạy `data-check` (không `fix`) đọc báo cáo đối soát trên dữ liệu thật
- [ ] Chạy `canonical-backfill` **chế độ chạy thử**, đọc số "đơn lật từ giao thành công sang hoàn"
- [ ] Chỉ chạy `apply=1` **sau khi chủ shop duyệt** con số đó
