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

## 10c. THẨM ĐỊNH SAU DEPLOY — 08/09/2026

### Kết quả: production CHƯA chạy release này

| | |
|---|---|
| Thời điểm kiểm tra | 2026-09-08 05:56 UTC (12:56 giờ VN) |
| Địa chỉ | https://erp.vnxcommerce.com |
| `/api/health` | `{"ok":true,"commit":"cf909349c250","branch":"main"}` |
| Commit production đang chạy | **`cf909349c250`** — commit TRƯỚC release |
| Commit đáng lẽ phải chạy | `8a8f577e99fe` (`origin/main`), merge release `adff4611ba16` |

**Vì sao con số này đáng tin.** `ERP_COMMIT` không phải giá trị nướng sẵn lúc build. Luồng deploy là:
`bootstrap.sh` chạy `git fetch origin` rồi `git checkout -B main origin/main` (đặt thẳng về commit
của remote), sau đó `install-vps.sh` mới đọc `git rev-parse HEAD` và **ghi đè** `ERP_COMMIT` +
`ERP_BRANCH_NAME` vào `.env` ở MỖI lần chạy. Vậy nên giá trị `/api/health` trả về chính là commit
mà máy chủ đã checkout ở lần deploy **hoàn tất** gần nhất.

Cả `ERP_COMMIT` lẫn `ERP_BRANCH_NAME` đều nói `main@cf909349c250` ⇒ lần `install-vps.sh` chạy xong
gần nhất là bản deploy của release TRƯỚC. Bản deploy mới **chưa chạy tới bước đó**.

Đã gọi `/api/health` hai lần cách nhau ~80 giây, mốc `time` đổi theo thời gian thực và không có
header cache ⇒ không phải phản hồi cũ được lưu đệm.

### Ứng dụng vẫn khoẻ (bản cũ)

| Kiểm tra | Kết quả |
|---|---|
| `/api/health` | HTTP 200, `ok: true` ⇒ tiến trình sống, CSDL kết nối được |
| `/login` | HTTP 200 |
| `/`, `/orders`, `/data-quality`, `/alerts` | HTTP 307 → chuyển hướng đăng nhập (đúng, không có phiên) |
| `GET /api/webhooks/viettelpost` | HTTP 200 ⇒ điểm nhận webhook vẫn mở |

### Cổng deploy KHÔNG phải nguyên nhân

Chạy lại đúng ba bước cổng của workflow trên chính `8a8f577` (commit đang ở `origin/main`):

- `npx tsc --noEmit` → sạch;
- `npm test` → **TẤT CẢ KIỂM THỬ ĐẠT**;
- `package.json` và `package-lock.json` **không đổi** giữa `cf90934` và `8a8f577` ⇒ `npm ci` hành xử
  y hệt lần deploy thành công trước, không thể là chỗ hỏng.

### Ba khả năng còn lại — cần xem log workflow để phân biệt

1. **Workflow chạy TRƯỚC khi bản merge lên tới GitHub.** Máy chủ `git fetch` xong sẽ lấy đúng
   `origin/main` **tại thời điểm nó chạy**; nếu lúc đó `origin/main` vẫn là `cf90934` thì máy chủ
   dựng lại đúng bản cũ và deploy vẫn báo xanh.
2. **Workflow hỏng ở bước SSH / bootstrap.** Chính `bootstrap.sh` ghi chú: *"2 trong 3 lần deploy
   gần đây hỏng vì Failed to connect to github.com port 443"*. Nếu 4 lần thử đều trượt thì
   `install-vps.sh` không chạy và `.env` giữ nguyên commit cũ — khớp đúng những gì quan sát được.
3. **Workflow chưa được bấm chạy.**

**Cách phân biệt:** GitHub → repo `hkt` → **Actions** → *Deploy ERP to VPS* → mở lần chạy gần nhất.
Bước nào đỏ sẽ chỉ thẳng ra khả năng nào đúng. Nếu không có lần chạy nào sau 05:00 UTC 08/09 thì là
khả năng 3.

**Cách xử lý cho cả ba:** bấm chạy lại *Deploy ERP to VPS* trên nhánh `main` (nhánh nay đã ở
`8a8f577`), rồi kiểm tra lại `/api/health` phải trả `commit` bắt đầu bằng `8a8f577`.

### Những việc BỊ CHẶN vì chưa deploy

| Việc | Vì sao chưa làm được |
|---|---|
| Smoke test 11 màn hình | Bản đang chạy chưa có các mục mới; và môi trường này không có tài khoản đăng nhập (mọi trang trả 307) |
| Chạy thử dựng lại lịch sử trên production | Job `canonical-backfill` và `scripts/erp-backfill.ts` nằm trong release, bản đang chạy chưa có |
| Mô phỏng tác động KPI | Cần số liệu production |
| Đối chiếu chênh lệch tồn kho | Cần số liệu production |

Môi trường làm việc không có `DATABASE_URL` của production, không có `gh` CLI và không có token
GitHub, nên cũng không chạy được ops `db-query`. **Không có đường nào đọc dữ liệu production từ đây.**

### Công cụ đã chuẩn bị sẵn để chạy ngay sau khi deploy thật xong

`scripts/prod-readonly-probe.ts` — 12 truy vấn **chỉ đọc**, đo đúng những con số mà chạy thử backfill
sẽ báo, nhưng chỉ dùng các bảng đã có nên chạy được **kể cả trên bản cũ**. Đã chạy thử trên CSDL có
schema thật, cả 12 câu đều trả kết quả đúng.

Nội dung đo: ảnh chụp lệch lịch sử (theo từng cặp trạng thái) · vận đơn thiếu chứng từ ĐVVC · ghi
"đã giao" mà không có sự kiện phát thành công · **tiền đã về mà không có chứng từ giao hàng** · mã
501 chiều hoàn còn bị coi là đã giao · trạng thái ĐVVC chưa hiểu · mốc thời gian đi ngược · mẫu mã
tồn âm · tồn đọng gói tin webhook · sự kiện ĐVVC và đơn Pancake mới nhất.

Chạy từng câu qua ops `db-query` (một câu mỗi lần), hoặc chạy cả bộ trên VPS:

```
docker exec erp-app npx tsx --tsconfig tsconfig.json scripts/prod-readonly-probe.ts
```

## 10d. THẨM ĐỊNH SAU DEPLOY THẬT — 08/09/2026

### Deploy

| | |
|---|---|
| Lần chạy | *Deploy ERP to VPS* #151, dispatch qua GitHub API từ máy phát triển |
| Commit | `bc00d00aad63` → sau đó `b20c0c9a6c64` (bản vá guardrail) |
| Kết quả | mọi bước xanh, kể cả SSH bootstrap và kiểm tra HTTPS |
| `/api/health` | `{"ok":true,"commit":"bc00d00aad63","branch":"main"}` ⇒ **khớp `origin/main`** |
| Container | `erp-app` và `erp-scheduler` dựng lại; `erp-db` healthy |
| Migration | `[migrate] ✓ Migration đã áp dụng xong.` — 0032/0033/0034 áp dụng sạch |

**Vì sao lần "deploy" trước không lên:** lần chạy gần nhất trước đó là #150 lúc `02:13 UTC` trên
`cf909349c250` — tức deploy của bản CŨ, chạy **trước** khi release được merge. Không có lỗi pipeline
nào; đơn giản là chưa ai bấm chạy sau khi merge.

**Gián đoạn khi deploy:** Caddy trả 502 trong khoảng `06:15:20–06:15:35 UTC` (~20 giây) khi container
app bị thay. Trong cửa sổ đó có webhook Pancake bị từ chối. Không mất dữ liệu: job
`orders_incremental` chạy mỗi 3 phút đã đồng bộ lại ngay lúc `06:16:02`.

### SỰ CỐ CÓ TỪ TRƯỚC: webhook đã chết 2 ngày

Đây là phát hiện quan trọng nhất của đợt thẩm định, và **không phải do release này**.

| Nguồn | Gói tin cuối cùng nhận thành công |
|---|---|
| Pancake | `2026-09-06 11:23:16` |
| Viettel Post | `2026-09-06 11:33:09` |

Cả hai dừng gần như cùng lúc, **hai ngày trước** khi release được deploy. Log ứng dụng cho thấy gói
tin vẫn đang tới nhưng bị chặn: `[vtp-webhook] 401 sai tham số bí mật` (user-agent `mint/1.9.3`).
Release **không đụng** vào phần kiểm tra secret — phần tôi sửa nằm sau bước đó.

Hệ quả khác nhau ở hai nguồn:

- **Pancake vẫn khoẻ ở mức dữ liệu** vì có job kéo mỗi 3 phút bù lại: 109 đơn mới trong 24h, đơn
  mới nhất `06:16:59`, `orders_incremental` SUCCESS liên tục.
- **Viettel Post đứng hẳn**: 0 sự kiện trong 24h, sự kiện mới nhất từ `2026-09-06 11:32`. Đường bù
  duy nhất là `tracking_poll` thì trả `PARTIAL` — *"Đã kiểm tra 10 vận đơn · cập nhật 0 · API không
  thấy 10"*, đúng vấn đề phạm vi tài khoản API đã biết. **379 vận đơn chưa kết thúc, 179 trong đó
  quá 48h không có tin mới.**

**Bằng chứng cứng:** trong 200 dòng log gần nhất có **112 lần** `POST /api/webhooks/pancake/pk_…`
bị trả **401**, cộng các dòng `[vtp-webhook] 401 sai tham số bí mật`. Bên gửi vẫn đang thử lại liên
tục — nghĩa là sửa secret là dữ liệu chảy lại ngay.

Việc cần làm (một thao tác, thuộc về chủ shop vì nằm ở hệ thống bên ngoài): mở ERP → **Kết nối dữ
liệu**, lấy URL webhook hiện tại của Pancake và Viettel Post, dán lại vào cấu hình bên gửi. Secret
trên máy chủ và secret bên gửi đang dùng không khớp nhau.

### Smoke test (chưa đăng nhập được — nêu rõ phần nào chưa xác minh)

Môi trường này không có tài khoản ERP nên **không kiểm tra được giao diện sau đăng nhập**. Những gì
xác minh được:

| Đường dẫn | Mã | Ý nghĩa |
|---|---|---|
| `/api/health` | 200 | tiến trình sống, CSDL kết nối được, commit đúng |
| `/login` | 200 | Next.js dựng trang thật |
| `/`, `/orders`, `/shipments`, `/cod`, `/reports`, `/reports?tab=truth`, `/data-quality`, `/integrations`, `/inventory`, `/alerts`, `/ads`, `/products`, `/customers` | 307 | middleware chuyển hướng đăng nhập đúng, **không trang nào 5xx** |
| `/api/notifications` | 401 | chặn đúng khi chưa có phiên |
| `GET /api/webhooks/viettelpost` | 200 | điểm nhận webhook mở |

Thời gian phản hồi 0,13–0,26 giây.

**Bằng chứng gián tiếp về trang cần đăng nhập:** log sau deploy cho thấy người dùng thật đang dùng
bản mới — `/landing` trả **200** và `/api/events` (luồng SSE cần phiên đăng nhập) trả **200**. Log
ứng dụng **không có** lỗi render, `TypeError`, hay `digest` nào.

Toàn bộ 5xx quan sát được (14 lần 502) nằm gọn trong `06:44:30–06:44:53` — đúng ~23 giây container
bị thay khi deploy bản vá. Sau mốc đó chỉ còn 200/307/401.

### Chạy thử dựng lại lịch sử (DRY RUN — không ghi gì)

Chạy bằng job `canonical-backfill` không truyền `apply`, xong sau 13 giây.

| Chỉ số | Giá trị |
|---|---|
| Vận đơn quét | **1.751** |
| Không đổi | 1.524 |
| Sẽ đổi | **70** (4,0%) |
| Không có chứng từ ĐVVC nào | 157 |
| Mốc thời gian hỏng | 0 |
| Trạng thái ĐVVC chưa hiểu | **0** |
| Sự kiện thiếu chuẩn hoá | 0 |
| Ca nhập nhằng (ghi đã giao, lịch sử không có chứng từ giao) | **10** |

Ma trận chuyển trạng thái:

| Chuyển | Vận đơn | Đơn | Doanh thu lên đơn |
|---|---|---|---|
| `RETURNED → RETURNING` | 52 | 52 | 28.224.000đ |
| `DELIVERED → DELIVERY_FAILED` | 6 | 6 | 3.419.000đ |
| `DELIVERED → IN_TRANSIT` | 6 | 6 | 3.568.000đ |
| `DELIVERED → OUT_FOR_DELIVERY` | 3 | 3 | 1.872.000đ |
| `DELIVERED → RETURNING` | 2 | 2 | 1.348.000đ |
| `RETURNED → PENDING` | 1 | 1 | 849.000đ |

### Nhóm 17 đơn đang tính GIAO THÀNH CÔNG mà không có chứng từ giao

Đây chính là nhóm mà luật canonical không còn đủ căn cứ để coi là đã giao:

- **0/17 có bất kỳ sự kiện mã 501 nào** của Viettel Post;
- **0/17 có dòng chứng từ bảng kê** (`cod_statement_lines`);
- nhưng cả 17 đều có `cod_collected` **bằng đúng** `cod_amount` (499K–998K) và `cod_status = COLLECTED`;
- tên trạng thái do chính ĐVVC ghi là *"Chờ phát lại"*, *"Đang vận chuyển"*, *"Đang giao hàng"*.

Kiểm chứng bằng `outcome-explain` (công thức thật, không phải suy luận): cả nhóm hiện trả
`ketQua: DELIVERED`. Nghĩa là **"đã giao" và "đã thu tiền" của nhóm này đến từ khai báo Pancake,
không có một chứng từ logistics nào**. Đúng loại lỗi mà release này sinh ra để chặn.

Nhắc lại bất biến: COD · payment · reconciliation · paid_to_bank · cash received **KHÔNG** phải
bằng chứng logistics DELIVERED.

### Tác động KPI dự kiến

| Chỉ số | TRƯỚC | DỰ KIẾN SAU | Thay đổi |
|---|---|---|---|
| Giao thành công (đơn) | 424 | **407** | −17 (−4,0%) |
| Hoàn (đơn) | 755 | **756** | +1 |
| Đang giao (đơn) | 232 | **248** | +16 |
| Chưa gửi / Huỷ | 250 / 293 | 250 / 293 | không đổi |
| **GTC** | **35,96%** | **34,99%** | **−0,97 điểm** |
| Tỷ lệ hoàn | 64,04% | 65,01% | +0,97 điểm |
| Doanh thu đơn giao thành công | — | — | **−10.207.000đ** |

Trong 10.207.000đ rời khỏi nhóm giao thành công: 8.859.000đ chuyển sang *đang giao* (còn có thể
thành công), 1.348.000đ chuyển sang *hoàn*.

**COD / tiền mặt: KHÔNG đổi.** Backfill chỉ dựng lại chiều logistics, không đụng `cod_collected`,
`cod_status` hay bảng kê — đúng nguyên tắc ba chiều tách bạch.

Mức thay đổi 4% nằm dưới ngưỡng bất thường 20%, và hướng thay đổi là ĐÚNG: nó gỡ bỏ những đơn được
tính giao thành công mà không có chứng từ nào.

### Khiếm khuyết của chính guardrail — đã phát hiện và sửa trong đợt này

Bản chạy thử đầu tiên trả `deliveredToNotDelivered: 0` và `outcomeAfter` **bằng đúng** `outcomeBefore`.
Đọc thoáng sẽ kết luận "không có tác động, ghi thật an toàn" — trong khi sự thật là **CHƯA ĐO**:
kết quả đơn chỉ đổi sau khi trạng thái được ghi lại, mà chạy thử thì cố tình không ghi.

Hậu quả nghiêm trọng: `backfillWarnings()` sinh ra để **chặn** lệnh ghi khi có đơn giao thành công
bị lật, nhưng nó đọc phải con số 0 giả nên không bao giờ bắn. Đây đúng loại lỗi "chưa biết bị quy
về 0" mà cả release này sinh ra để chống, và nó nằm ngay trên đường đi của lệnh ghi kế tiếp.

Đã sửa ở `b20c0c9a6c64`: bốn trường trả `null` khi chạy thử, kèm cảnh báo mới. Chạy lại trên
production sau khi vá:

```
"warnings": [
  "Chạy thử KHÔNG đo được tác động lên kết quả đơn (70 vận đơn sẽ đổi trạng thái).
   Phải đo riêng số đơn lật từ GIAO THÀNH CÔNG sang hoàn trước khi cho ghi.",
  "10 vận đơn ghi 'đã giao' nhưng lịch sử không có chứng từ giao nào — không tự sửa, phải đối chiếu tay."
]
```

Vì có cảnh báo, job `canonical-backfill` nay **từ chối ghi** kể cả khi truyền `apply=1` — phải
thêm `force=1` một cách tường minh. Guardrail đã đúng.

### Sổ kho

| | |
|---|---|
| Mẫu mã tồn âm | **4** (`X001 L` −5, `Q003 XANH XL` −2, `Q003 XANH L` −1, `X001 XL` −1) |
| Tổng số âm | −9 |
| Trong đó chưa có phiếu nhập | **0** — cả 4 đều đã có phiếu nhập |
| Tổng phiếu kho toàn hệ thống | **2** (đều là phiếu NHẬP, phiếu sớm nhất **03/09/2026**) |
| Mẫu mã có phiếu / tổng | 28 / 38 |

**Nguyên nhân gốc: sổ kho KHÔNG CÓ SỐ DƯ ĐẦU KỲ.** Toàn hệ thống mới có 2 phiếu nhập, sớm nhất
03/09/2026, trong khi hàng đã được bán và xuất từ trước đó rất lâu. Phương trình
`tồn = phiếu kho − đã xuất` vì thế trừ một số "đã xuất" tích luỹ nhiều tháng vào một số "đã nhập"
chỉ bắt đầu từ 03/09 → ra số âm. Ví dụ `X001 L`: nhập 10, đã xuất 15 → −5.

Đây **không phải** lỗi của release: công thức đúng, dữ liệu đầu vào thiếu.

**Chưa xử lý (unresolved) — cố ý.** Cách chữa đúng là kho **kiểm kê thực tế** rồi lập phiếu đầu kỳ
với số đếm thật. Tôi không tạo phiếu bù cho số khớp: bịa một con số vào sổ kho là đúng loại sai mà
cả release này sinh ra để chống.

## 10e. KHÔI PHỤC INGESTION — điều tra 08/09/2026

### Nguyên nhân gốc của 401: secret bị xoay ngày 04/09, nhưng chỉ có hiệu lực từ ngày 06/09

> **ĐÍNH CHÍNH.** Bản trước của mục này quy cho ops run **#144** (06/09 11:22:37) chạy
> `rotate-webhook-secrets`. **Sai.** Run #144 là thao tác `status`. Chuỗi ký tự
> *"Đã tạo secret webhook mới…"* nằm trong khối `case` của workflow nên xuất hiện trong log của
> **mọi** lần chạy ops, kể cả lần không hề xoay secret. Đã quét lại toàn bộ 144 lần chạy ops trước
> mốc đó và đọc dòng `ACTION:` thật của từng lần.

| Mốc | Việc gì xảy ra |
|---|---|
| **04/09 13:00:50** | ops run **#4** — lần **DUY NHẤT** từng chạy `rotate-webhook-secrets`. Ghi secret mới vào `.env`, rồi `docker compose up -d app scheduler`. |
| 04/09 → 06/09 | Webhook **vẫn chạy bình thường**: 485 gói tin Viettel Post tiếp tục được nhận. |
| **06/09 11:23:16** | Gói tin Pancake cuối cùng được nhận. |
| **06/09 11:27:50 – 11:39:20** | **Deploy #86** — build lại image, tạo lại container. |
| **06/09 11:33:09** | Gói tin Viettel Post cuối cùng được nhận. Sau mốc này: 401 liên tục. |

**Vì sao xoay ngày 04/09 mà tới 06/09 mới hỏng:** `docker-compose.yml` nạp biến qua
`env_file: .env`. Sửa **nội dung** tệp đó không làm Compose tạo lại container, nên tiến trình Node
đang chạy vẫn giữ secret CŨ trong `process.env` suốt 2 ngày 22 giờ. Lần xoay **trông như không có
tác dụng gì** — webhook vẫn xanh — nên không ai đi cập nhật bên gửi. Đến khi deploy #86 tạo lại
container thì secret mới trong `.env` mới thực sự có hiệu lực, và cả hai kênh đứt cùng lúc.

Đây là **lỗi hỏng trễ**: nguyên nhân và triệu chứng cách nhau gần ba ngày, nên mọi phép "xem thay
đổi gì ngay trước lúc hỏng" đều dẫn sai hướng.

**Đây là request THẬT, không phải probe.** Bằng chứng:

- Pancake POST tới `/api/webhooks/pancake/pk_<32 ký tự hex>` — đúng định dạng
  `pk_$(openssl rand -hex 16)` mà `install-vps.sh` sinh ra. Bên gửi CÓ mang secret, chỉ là secret cũ.
- Log VTP ghi `[vtp-webhook] 401 · vận đơn=PKE1511633373` — mã vận đơn thật.
- Route VTP chỉ trả 401 khi `expected` **khác rỗng** và không khớp ⇒ biến môi trường trên máy chủ
  ĐANG có giá trị, không phải bị thiếu hay không truyền vào container.
- `middleware.ts` cho `/api/webhooks` đi qua ⇒ 401 đến từ chính route handler, không phải lớp đăng nhập.

Không có mismatch tên biến, tên tham số, path, reverse proxy hay encoding.

### Không có đường API nào để phục hồi dữ liệu Viettel Post

Chạy `vtp-debug` trực tiếp lên API Viettel Post bằng token production:

| Phép thử | Kết quả |
|---|---|
| `user/Login` | 200 OK, token 255 ký tự |
| `user/info` | 200 — đúng tài khoản *"HMT shop"* |
| `user/listInventory` | 33 kho |
| `order/getOrderDetailV3` (một mã) | `data: []` |
| `order/order-filter` 7 ngày | `data: []` |
| `order/order-filter` **33 kho × 14 ngày** | `data: []` |
| `order/list-data-push-his` | HTTP 403 |
| Job `sync-vtp-import` 30 ngày | *"Nhập 0 vận đơn"* |

`sync_state.viettelpost:api-scope` = `{"missingStreak": 189, "lastFoundAt": null}` — API **chưa từng
một lần** thấy vận đơn nào.

Tài khoản API hợp lệ nhưng **không sở hữu vận đơn nào**: vận đơn do Pancake tạo thuộc tài khoản
Viettel Post của Pancake. Vì vậy **polling và reconciliation qua API là bất khả thi** — webhook là
kênh thời gian thực DUY NHẤT, và kênh bù duy nhất là nhập tệp danh sách vận đơn xuất từ
viettelpost.vn.

### Nhóm 17 đơn — bảng điều tra đầy đủ

Mọi dòng cùng một hình mẫu: Pancake nói `DELIVERED`, ảnh chụp ERP nói `DELIVERED`, nhưng **sự kiện
mới nhất của chính ĐVVC** nói khác.

| Mã vận đơn | Đơn | Sự kiện ĐVVC mới nhất | Lúc | Nguồn | COD khai/thu | 501? | Dòng bảng kê? |
|---|---|---|---|---|---|---|---|
| PKE1507585179 | 3134 | **505 Tồn - Thông báo chuyển hoàn** | 06/09 08:23 | WEBHOOK | 849K/849K | 0 | 0 |
| PKE1511633368 | 3652 | 400 Nhận bảng kê đến | 06/09 07:44 | WEBHOOK | 524K/524K | 0 | 0 |
| PKE1508898018 | 2489 | **505 Tồn - Thông báo chuyển hoàn** | 06/09 07:31 | WEBHOOK | 499K/499K | 0 | 0 |
| PKE1508908993 | 2911 | Chờ phát lại | 06/09 04:55 | IMPORT | 499K/499K | 0 | 0 |
| PKE1511633341 | 3678 | Đang giao hàng | 06/09 00:47 | IMPORT | 524K/524K | 0 | 0 |
| PKE1510195651 | 3357 | Đang vận chuyển | 06/09 00:43 | IMPORT | 998K/998K | 0 | 0 |
| PKE1511633402 | 3613 | Chờ phát lại | 05/09 12:52 | IMPORT | 524K/524K | 0 | 0 |
| PKE1511614363 | 3609 | Chờ phát lại | 05/09 11:43 | IMPORT | 524K/524K | 0 | 0 |
| PKE1508909078 | 2525 | Chờ phát lại | 05/09 09:39 | IMPORT | 499K/499K | 0 | 0 |
| PKE1507577540 | 3111 | Chờ phát lại | 05/09 08:40 | IMPORT | 524K/524K | 0 | 0 |
| PKE1512545995 | 3435 | Đang vận chuyển | 04/09 20:26 | IMPORT | 499K/499K | 0 | 0 |
| PKE1510203466 | 3248 | Đang vận chuyển | 04/09 14:50 | IMPORT | 499K/499K | 0 | 0 |
| PKE1511633340 | 3680 | Đang vận chuyển | 04/09 14:02 | IMPORT | 524K/524K | 0 | 0 |
| PKE1511633399 | 3614 | Đang vận chuyển | 04/09 08:23 | IMPORT | 524K/524K | 0 | 0 |
| PKE1508909035 | 2634 | Chờ phát lại | 04/09 02:51 | IMPORT | 849K/849K | 0 | 0 |
| PKE1508908990 | 2922 | Đang giao hàng | 02/09 08:06 | IMPORT | 849K/849K | 0 | 0 |
| PKE1508909045 | 2587 | Đang giao hàng | 01/09 07:38 | IMPORT | 499K/499K | 0 | 0 |

**0/17 có bất kỳ sự kiện mã 501 nào. 0/17 có dòng chứng từ bảng kê. 17/17 có `cod_collected` bằng
đúng `cod_amount`.**

Kết luận thận trọng: ERP **không có** bằng chứng logistics cho việc giao thành công của nhóm này —
nhưng **cũng chưa thể khẳng định chúng không được giao**. Sự kiện mới nhất có từ 01/09–06/09, mà
webhook chết từ 06/09 11:33; mọi mã 501 phát sinh sau mốc đó đều không tới được ERP. Riêng hai vận
đơn mang mã **505 (yêu cầu chuyển hoàn)** thì gần như chắc chắn là đơn hoàn.

### Chạy thử lại (TASK F)

Chạy lại sau khi vá guardrail: **kết quả y hệt** — 1.751 quét, 70 sẽ đổi, 10 ca nhập nhằng. Đúng như
mong đợi vì **không có một sự kiện Viettel Post mới nào** kể từ lần chạy trước (kênh nạp vẫn đứt).
Hai lần cho cùng con số ⇒ bộ máy xác định, nhưng con số vẫn dựa trên lịch sử THIẾU.

### Sổ kho (TASK H) — vẫn UNRESOLVED, đã định lượng được nguyên nhân

| | |
|---|---|
| Toàn bộ sổ kho ERP | **2 phiếu, cùng ngày 03/09/2026**, tổng 1.948 món |
| Hàng đã xuất TRƯỚC mốc đó | **1.349 đơn · 1.508 món** |
| Mẫu mã tồn âm trong ERP | 4 (tổng −9) |
| Tồn theo Pancake (nguồn độc lập) | `Q003 XANH L` −119 · `Q003 XANH XL` −116 · `X001 L` −23 · `X001 XL` −16 |
| Tổng tồn Pancake toàn hệ thống | **−2.496** |

Nguyên nhân gốc: **sổ kho không có số dư đầu kỳ**. Phương trình `tồn = phiếu kho − đã xuất` trừ
1.508 món xuất từ trước vào một cuốn sổ chỉ bắt đầu ngày 03/09.

Quan trọng: **Pancake cũng âm** (−2.496 toàn hệ thống), nên **không hệ thống nào có số đủ tin cậy để
làm số dư đầu kỳ**. Chỉ còn cách đếm thực tế.

Quy trình đề xuất (cần kho thực hiện, không tự làm được):

1. Chốt mốc: chọn một thời điểm, tạm dừng xuất hàng.
2. Kho **đếm tay** từng mẫu mã đang có trong kho.
3. Nhập số đếm bằng phiếu `RECEIPT` (hoặc `ADJUSTMENT`) ghi rõ lý do *"số dư đầu kỳ theo kiểm kê
   ngày …"* — con số ĐẾM ĐƯỢC, không phải con số suy ra.
4. Từ mốc đó phương trình sổ kho tự đúng; ERP đã hiển thị "Chưa có phiếu nhập" cho mẫu mã chưa có
   phiếu nên không bịa số.

**Không tạo phiếu bù cho số khớp** — bịa một con số vào sổ kho đúng là loại sai mà release này sinh
ra để chống.

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

## 10f. XÁC MINH END-TO-END WEBHOOK — 08/09/2026 (HIỆU CHỈNH CHẨN ĐOÁN)

### Có HAI người gửi khác nhau trên cùng một endpoint

Phân tích `user-agent` của toàn bộ gói tin từng tới `/api/webhooks/viettelpost`:

| User-agent | Số gói | Từ | Đến | Là ai |
|---|---|---|---|---|
| `mint/1.9.3` | **485** | 05/09 03:48 | 06/09 11:33 | **Pancake** (cùng UA với `/api/webhooks/pancake`, 3.767 gói) |
| `Apache-HttpClient/4.5.13 (Java/1.8.0_471)` | **2** | 05/09 03:11 | 07/09 07:42 | **Viettel Post Partner** |

Cả **2** gói tin từ Viettel Post Partner đều là **gói tin TEST**, không phải dữ liệu thật:
`ORDER_NUMBER: 123456789101112` · `RECEIVER_FULLNAME: "KHACH HANG"` ·
`ORDER_STATUSDATE: 22/01/2026 09:36:53` · `GROUPADDRESS_ID: 0` · bưu cục Bình Dương (shop ở Hà Nội).

**⇒ Viettel Post Partner CHƯA TỪNG gửi một sự kiện hành trình thật nào.** Toàn bộ dữ liệu vận đơn
thật đến ERP đều đi qua Pancake.

### Cấu hình webhook Viettel Post Partner: ĐÚNG — và đã được chứng minh

Gói tin test lúc **2026-09-07 07:42:30** đến từ Viettel Post Partner **SAU** khi secret mới có hiệu
lực (06/09 11:39) và **được ERP lưu lại** (`status = IGNORED`, ghi chú *"Gói tin lặp — trạng thái đã
đúng"*). Gói tin chỉ được lưu **sau khi đã qua bước kiểm tra secret**.

⇒ URL và secret bên Viettel Post Partner **khớp**, đúng như chủ shop kiểm tra. Không cần đụng vào.

### Cái đang hỏng là cấu hình CHUYỂN TIẾP bên PANCAKE

Log tươi lúc 08/09 ~07:45:

| Đường dẫn | Mã | Số lần | Người gửi |
|---|---|---|---|
| `/api/webhooks/pancake/pk_…` | **200** | 90 | Pancake — **đã sửa, đang chạy** |
| `/api/webhooks/pancake/pk_…` | 401 | 39 | Pancake — cấu hình cũ còn sót |
| `/api/webhooks/viettelpost` | **401** | **47** | **Pancake** (`ua=mint/1.9.3`) — **token cũ** |

Log ứng dụng: 129 dòng `[vtp-webhook] 401 sai tham số bí mật · ua=mint/1.9.3 · vận đơn=PKE…` — mã
vận đơn thật, bên gửi vẫn thử lại liên tục.

**⇒ Chỉ còn một chỗ sai: token trong cấu hình Pancake dùng để chuyển tiếp hành trình Viettel Post
sang ERP vẫn là token CŨ có từ trước lần xoay ngày 04/09.**

### Kiểm chứng cơ chế bảo vệ (bằng lưu lượng thật, không phải test giả)

| Yêu cầu | Kết quả | Bằng chứng |
|---|---|---|
| Secret đúng → 2xx | ĐẠT | 90 × 200 trên endpoint Pancake; gói tin Partner 07/09 được lưu |
| Secret sai/thiếu → 401 | ĐẠT | 47 × 401 endpoint VTP, 39 × 401 endpoint Pancake |
| Sự kiện thật được lưu | ĐẠT | 43 gói tin trong 30 phút, `status = PROCESSED` |
| Payload gốc được giữ | ĐẠT | `webhook_events.payload` giữ nguyên khối `DATA` đầy đủ |
| Chống trùng hoạt động | ĐẠT | **43/43 gói có `dedupe_key`**, đã gộp **47 lần gửi lại** |
| Kết quả đơn không dùng COD | ĐẠT | nhóm 17 là `DELIVERED` do `stage` (Pancake) + có chứng từ ĐVVC, **không** do COD |

Cơ chế chống trùng của release lần đầu được kiểm chứng bằng lưu lượng production thật.

### Điều tra quyền sở hữu tài khoản

**Tài khoản của token API ERP đang dùng:**
`user/info` → *HMT shop* · `0886833448` · Ocean Park 1, Gia Lâm, Hà Nội ·
`user/listInventory` → **33 kho**, `cusId: 18757294`.

**Kho gửi hàng ghi trong payload webhook thật:** `GROUPADDRESS_ID` = **30727118**, **30741855**,
**30263749** — **cả ba đều nằm trong danh sách 33 kho của chính tài khoản đó**.

⇒ Địa chỉ kho gửi **thuộc đúng** tài khoản Viettel Post của shop.

**Nhưng token API không đọc được vận đơn nào:**

| Phép thử (kể cả vận đơn mới tạo `PKE1515089248` ngày 07/09) | Kết quả |
|---|---|
| `order/getOrderDetailV3` GET / POST | `data: []` |
| `order/order-filter` 7 ngày | `data: []` |
| `order/order-filter` 33 kho × 14 ngày | `data: []` |
| `order/list-data-push-his` (lịch sử đẩy webhook) | **HTTP 403** |
| `sync_state.viettelpost:api-scope` | `missingStreak: 189`, `lastFoundAt: null` |

**Giải thích nhất quán với mọi bằng chứng:** Viettel Post giới hạn quyền đọc đơn và quyền xem lịch
sử đẩy webhook theo **partner/ứng dụng API đã TẠO đơn**, không theo địa chỉ kho gửi. Vận đơn của
shop do **Pancake** tạo qua tích hợp Viettel Post của Pancake, nên:

- token API của shop → không thấy đơn (`data: []`), không xem được lịch sử đẩy (403);
- webhook Partner của shop → không nhận được đẩy thật (chỉ nhận gói tin test).

Đó cũng chính là lý do `list-data-push-his` trả 403 chứ không phải rỗng: tài khoản không phải chủ
của các lần đẩy đó.

### Vì sao ERP vẫn hiện DEGRADED

Các con số ERP hiển thị đều **đúng sự thật**, không phải lỗi hiển thị:

- *"webhook gần nhất khoảng 1 ngày trước"* = gói tin **test** của Viettel Post Partner lúc
  `2026-09-07 07:42:30`. Đó là gói tin cuối cùng qua được kiểm tra secret.
- *events/hour = 0* — sự kiện hành trình thật cuối cùng: `2026-09-06 11:32:34`, 0 sự kiện trong 30 phút.
- *379 vận đơn chưa kết thúc, 184 quá 48h* — hệ quả trực tiếp: không có nguồn cập nhật nào.

## 10g. TOKEN CHUYỂN TIẾP TRONG PANCAKE — kiểm tra cụ thể 08/09/2026

### Route `/api/webhooks/viettelpost` chấp nhận secret ở đâu

`extractSecret()` gom **12 vị trí** rồi so khớp với đúng **một** giá trị `VIETTELPOST_WEBHOOK_SECRET`;
khớp ở bất kỳ vị trí nào là qua:

| Nhóm | Các khoá được chấp nhận |
|---|---|
| Thân JSON | `TOKEN`, `token`, `secret`, `SECRET` |
| Header | `token`, `x-token`, `secret`, `x-secret`, `x-webhook-secret`, `x-api-key` |
| Header `Authorization` | `Bearer <giá trị>` hoặc `Token <giá trị>` (đã bỏ tiền tố) |
| **Query string** | **`?token=`**, `?access_token=`, `?secret=` |

⇒ **`?token=` được hỗ trợ.** Cách Pancake đang gửi là ĐÚNG CƠ CHẾ; chỉ sai GIÁ TRỊ.

Không có secret riêng cho từng bên gửi: Viettel Post Partner (điền ở ô *Tham số bí mật*) và Pancake
(nhét vào `?token=`) dùng **chung một** `VIETTELPOST_WEBHOOK_SECRET`. Sửa một chỗ là ảnh hưởng cả hai.

Cảnh báo về `if (expected && …)`: nếu biến môi trường **rỗng** thì bước kiểm tra bị **bỏ qua hoàn
toàn** — endpoint thành công khai. Hiện tại biến có giá trị (bằng chứng: có 401), nhưng đây là điểm
cần nhớ khi ai đó "tạm xoá secret cho dễ test".

### Kiểm chứng trực tiếp trên production (08/09/2026)

| Phép thử | Kỳ vọng | Thực tế |
|---|---|---|
| `GET /api/webhooks/viettelpost` | 200, thông báo sẵn sàng | **200** |
| `POST` kèm `?token=` **sai** | 401 | **401** `{"message":"Sai tham số bí mật"}` |
| `POST` **không** có token | 401 | **401** |
| `POST` từ Pancake, `?token=vtp_…` hiện tại | (đang) 401 | **401** — 13 lần chỉ trong 24 phút |

Nhật ký Caddy cho thấy nguyên văn: `POST /api/webhooks/viettelpost?token=vtp_••••` từ IP
`203.171.22.6`, `User-Agent: mint/1.9.3`, `status: 401`, lặp lại liên tục.

⇒ **Token `vtp_ccb…` trong Pancake là token CŨ, đã hết hiệu lực từ 06/09 11:39.** Nó là secret gốc
sinh lúc cài đặt, bị thay bởi ops run #4 ngày 04/09 nhưng chỉ thực sự mất tác dụng khi container
được tạo lại.

### URL phải dán vào Pancake

```
https://erp.vnxcommerce.com/api/webhooks/viettelpost?token=<TOKEN HIỆN HÀNH>
```

Lấy `<TOKEN HIỆN HÀNH>` tại: **ERP → Kết nối dữ liệu → thẻ Viettel Post → dòng “Tham số bí mật
webhook (Secret parameter)” → bấm nút Copy** (`app/(dashboard)/integrations/page.tsx:157-167`).
Giá trị bắt đầu bằng `vtp_` + 32 ký tự hex. **Không xoay lại secret** — chỉ dán giá trị đang có.

Đó cũng chính là giá trị chủ shop đã điền đúng ở Viettel Post Partner, nên sau khi sửa Pancake thì
**cả hai kênh dùng chung một token**.

Sau khi dán, kiểm chứng bằng đúng ba dấu hiệu (không cần chờ lâu — Pancake gửi vài phút một gói):

1. Nhật ký Caddy: `POST /api/webhooks/viettelpost?token=…` chuyển từ **401 → 200**.
2. `select max(received_at) from webhook_events where source='VIETTELPOST'` — mốc mới trong vài phút.
3. Trang **Kết nối dữ liệu** thoát trạng thái *DEGRADED*, events/hour > 0.

Sai một ký tự thì vẫn 401 — chỉ nên Copy, không gõ tay.
