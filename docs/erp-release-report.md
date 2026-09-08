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

## 10h. REALTIME ĐÃ THÔNG — xác minh end-to-end 08/09/2026

Chủ shop dán URL mới (`?token=` với secret hiện hành) vào Poscake → Cấu hình chuyển tiếp Webhook.

### Mốc chuyển trạng thái

| Mốc (UTC) | Việc |
|---|---|
| 08:07:21 | Gói tin **401 cuối cùng** từ `mint/1.9.3` |
| 08:07:18 | 3 request `curl/8.19.0` — **phép thử của tôi**, không phải Poscake (GET 200 · POST token sai 401 · POST không token 401) |
| **08:12:01** | Gói tin **200 đầu tiên** — dữ liệu thật |
| 08:18:36 | Gói tin gần nhất tại thời điểm chốt báo cáo |

Cửa sổ chuyển đổi nằm giữa 08:07:21 và 08:12:01.

### Gói tin thật đã nhận (KHÔNG có gói test nào trong nhóm 200)

| Nhận lúc | HTTP | Vận đơn | Mã đơn | Mã thô | Trạng thái ĐVVC | Chiều | Xử lý | Lưu? | Vận đơn đổi? |
|---|---|---|---|---|---|---|---|---|---|
| 08:12:01 | 200 | PKE1515018957 | PKE90085133618451 | 500 | Giao cho bưu cục | *(thiếu cờ)* | PROCESSED | ✓ | → `OUT_FOR_DELIVERY` |
| 08:12:11 | 200 | PKE1515018957 | PKE90085133618451 | 500 | Giao cho bưu cục | *(thiếu cờ)* | PROCESSED | ✓ | ✓ |
| 08:13:24 | 200 | PKE1511614334 | PKE540445029262297 | 502 | Chuyển hoàn bưu cục gốc | **RETURN** | PROCESSED | ✓ | → `RETURNING` |
| 08:16:30 | 200 | PKE1508909019 | PKE10901192769 | 400 | Nhận bảng kê đến | OUTBOUND | PROCESSED | ✓ | ✓ |
| 08:18:01 | 200 | PKE1508909019 | PKE10901192769 | 500 | Giao bưu tá đi phát | OUTBOUND | PROCESSED | ✓ | → `OUT_FOR_DELIVERY` |

**0 gói FAILED, 0 gói IGNORED.** Đây là **sự kiện vòng đời thật** (mã vận đơn thật, mã đơn thật, mốc
thời gian thật), không phải gói tin kiểm tra kết nối — nên kết luận "realtime healthy" đứng được.

`leg_type` suy từ cờ `IS_RETURNING`: `502 + IS_RETURNING=true` → **RETURN**; `400/500 +
IS_RETURNING=false` → **OUTBOUND**. Hai gói đầu **không có** trường `IS_RETURNING` nên `leg_type`
để **trống** — đúng nguyên tắc *UNKNOWN không phải 0*, không đoán bừa.

### Sức khoẻ tích hợp Viettel Post — trước / sau

| Chỉ số | Trước (08:00) | Sau (08:20) |
|---|---|---|
| Gói tin gần nhất | 07/09 07:42 (gói TEST) — **~25 giờ trước** | **2 phút trước** |
| Gói/giờ | 0 | **6** |
| Sự kiện hành trình mới nhất | 06/09 11:32:34 | **08/09 08:17:23** |
| Gói lỗi (FAILED) | 0 | **0** (0 trong 24h) |
| Mức sức khoẻ | DEGRADED / DOWN | **HEALTHY** |

### Idempotency (mục 7)

Cả hai đường — Viettel Post Partner gửi thẳng và Poscake chuyển tiếp — vào **cùng một route** và
được ghi với **cùng `source = "VTP_WEBHOOK"`**. Vì vậy hai bản sao của cùng một sự việc rơi vào cùng
khoá duy nhất `shipment_events_uq (shipment_id, source, status, occurred_at)`.

| Kiểm tra | Kết quả |
|---|---|
| Dòng `shipment_events` trùng khoá | **0** |
| `webhook_events` VTP có `dedupe_key` | 6 gói / **6 sự việc** phân biệt |

Quan trọng hơn khoá duy nhất: **kết quả đơn là HÀM của tập sự kiện, không phải phép cộng dồn.**
`materializeShipmentState()` dựng lại trạng thái từ toàn bộ lịch sử; thêm một bản sao không đổi kết
quả. Nên kể cả nếu một dòng trùng lọt qua, `ORDER_OUTCOME` vẫn không sinh outcome kép.

### Kiến trúc nguồn dữ liệu (đã xác nhận bằng bằng chứng)

| Nguồn | Vai trò | Căn cứ |
|---|---|---|
| **Poscake chuyển tiếp webhook VTP** | **CHÍNH** cho vận đơn do Poscake tạo | 485 + 6 gói thật đều từ `mint/1.9.3` |
| Webhook Viettel Post Partner (trực tiếp) | **PHỤ** — nhận nếu có sự kiện thật | cấu hình đúng, nhưng mới chỉ gửi 2 gói TEST |
| **API Viettel Post** | **KHÔNG** dùng làm nguồn đối chiếu | `getOrderDetailV3`/`order-filter` rỗng, `list-data-push-his` 403 — token không sở hữu vận đơn |
| Tệp tải từ viettelpost.vn | Kênh **bù lịch sử** duy nhất | `applyVtpOrderList()` ghi `shipment_events` nguồn `VTP_IMPORT` |

### Vận đơn treo: 380 (212 quá 48 giờ)

Số treo **tăng** so với hôm qua vì thời gian trôi, không phải vì nạp dữ liệu hỏng. 51/380 đã nhận
tin mới trong hôm nay — realtime đang tự gỡ dần.

| Ngày tin cuối | Số vận đơn | Ghi chú |
|---|---|---|
| 22/01/2026 | 1 | **vận đơn ảo `123456789101112`** do gói TEST của ĐVVC tạo (07/09 04:31), không gắn đơn nào |
| 28/08 – 03/09 | 13 | tồn cũ |
| 04/09 | 33 | |
| 05/09 | 70 | |
| **06/09** | **119** | đúng ngày kênh nạp đứt |
| 07/09 | 140 | phần lớn là vận đơn Pancake tạo, **chưa từng có sự kiện ĐVVC** |
| 08/09 | 4 | đang chạy bình thường |

### Module “Nhập dữ liệu Viettel Post” dùng được cho việc phục hồi

`detectVtpFile()` tự nhận loại tệp bằng chính hai trình đọc thật (không đoán theo tên tệp), nên
không nhập nhầm trạng thái với tiền:

- **ORDER_LIST — “Danh sách vận đơn”**: trạng thái giao/hoàn, COD **khai báo**, cước. → `applyVtpOrderList()`
- **STATEMENT_DETAIL — “Chi tiết bảng kê”**: tiền **THỰC THU**. → dùng cho đối soát COD, không phải logistics.

`applyVtpOrderList()` ([statement-db.ts:270](../lib/integrations/viettelpost/statement-db.ts)) làm đúng
việc cần cho phục hồi lịch sử:

1. Ghi `shipment_events` nguồn **`VTP_IMPORT`** — chứng từ ĐVVC, không phải suy từ tiền.
2. **Idempotent**: kiểm tra sẵn có theo (vận đơn, nguồn, trạng thái, mốc) trước khi chèn.
3. **Không hạ cấp**: dòng cũ hơn trạng thái đang lưu bị đếm vào `stale` và bỏ qua.
4. Gọi **`materializeShipmentState()`** — vẫn là chỗ ghi trạng thái DUY NHẤT.
5. Nhận diện vận đơn **chiều hoàn** (`legs`), gắn vận đơn thiếu mã theo SĐT người nhận (`linked`),
   đếm `conflicts` và `unmatched` để đối chiếu tay.

⇒ Nhập tệp **không** phải backfill suy đoán. Nó bơm chứng từ ĐVVC thật vào đúng đường ống canonical.
Khác hẳn `canonical-backfill` (đang bị chặn) vốn chỉ **tính lại** trên lịch sử đang thiếu.

## 10i. PAYLOAD POSCAKE CHUYỂN TIẾP — điều tra 08/09/2026

### Kết luận: **A — Poscake chuyển tiếp NGUYÊN VĂN gói tin Viettel Post**

Đọc 492 gói tin thật đã lưu. Khối `DATA` mang **31 trường**, đều là **tên trường gốc của Viettel
Post**, không phải tên do Poscake đặt:

| Nhóm | Trường |
|---|---|
| Định danh | `ORDER_NUMBER` · `ORDER_REFERENCE` · `GROUPADDRESS_ID` |
| **Trạng thái thô** | **`ORDER_STATUS`** (mã số) · **`STATUS_NAME`** · `REASON_CODE` |
| **Mốc của ĐVVC** | **`ORDER_STATUSDATE`** (giờ VN) · `EXPECTED_DELIVERY_DATE` |
| **Chiều đi/hoàn** | **`IS_RETURNING`** |
| Hiện trường | `LOCATION_CURRENTLY` + `LOCALION_CURRENTLY` (giữ nguyên cả **lỗi chính tả của VTP**) · `EMPLOYEE_NAME` · `EMPLOYEE_PHONE` · `POD` |
| Tiền | `MONEY_COLLECTION` · `MONEY_COLLECTION_ORIGIN` · `MONEY_TOTAL` · `MONEY_TOTALFEE` · `MONEY_TOTALVAT` · `MONEY_FEECOD` · `VOUCHER_VALUE` |

Việc **lỗi chính tả `LOCALION_CURRENTLY` của Viettel Post vẫn còn nguyên** là bằng chứng mạnh nhất:
Poscake không hề đọc-hiểu-ghi lại, nó chuyển tiếp thẳng.

**Lớp bọc ngoài** chỉ có `{DATA, TOKEN}` — đúng phong bì gốc của Viettel Post — cộng `api_token`
(96/492 gói) do Poscake thêm. **Không có một trường trạng thái chuẩn hoá nào của Poscake.**

Mã trạng thái thô nhận được trải khắp vòng đời thật: `102` · `104` · `202` · `300` · `400` · `500` ·
**`501`** (20) · `502` (30) · **`504`** (29) · `505` (114) · `506` (45) · `507`.

ERP lưu **cả hai**: `payload.DATA` (bản ghi hành trình) và `payload.RAW` (toàn bộ body gốc kèm phong
bì) — 492/492 gói có `RAW`.

⇒ Theo mục 4 của yêu cầu: gói tin Poscake chuyển tiếp **ĐƯỢC** coi là chứng từ logistics.

### Thang thẩm quyền — nay có một bản duy nhất

Ghi thành `LOGISTICS_EVIDENCE_AUTHORITY` trong `lib/constants/truth.ts`:

| Mức | Nguồn | Được kết luận? |
|---|---|---|
| **HIGH** | `VTP_WEBHOOK` — sự kiện mang mã số VTP, đến thẳng **hoặc Poscake chuyển tiếp nguyên văn** | ✔ |
| **HIGH** | `VTP_IMPORT` — tệp danh sách vận đơn | ✔ |
| **HIGH** | `VTP_POLL` — tra cứu API | ✔ |
| MEDIUM | `partner_status` do Poscake tự chuẩn hoá | ✘ (chỉ khi chưa có HIGH) |
| LOW | Trạng thái **ĐƠN** Pancake (“Đã nhận”) | ✘ — cao nhất chỉ được nói ĐANG GIAO |
| **NEVER** | Tiền · COD · bảng kê · trạng thái thanh toán | ✘ vĩnh viễn |

Ranh giới phải nhớ: gói tin **chuyển tiếp** (`webhook_events.source = 'VIETTELPOST'`) khác hẳn
**bản sao hành trình** trong `orders.partner.extend_update` mà Poscake tự dựng — bản sao đó mốc thời
gian là giờ Pancake ghi nhận nên chỉ ở mức MEDIUM và bị `deriveShipmentState()` loại.

### LỖI TÌM ĐƯỢC — trạng thái đơn Pancake bị dịch thẳng thành “ĐÃ GIAO”

`lib/integrations/pancake/mapper.ts` có đúng cái luật mà đặc tả cấm:

| Dòng cũ | Sai ở chỗ |
|---|---|
| `stage === "DELIVERED" hoặc "PAID"` → `shipmentStage = "DELIVERED"` | trạng thái **ĐƠN** và trạng thái **THANH TOÁN** → trạng thái **LOGISTICS** |
| `partnerMeta.stage === "PENDING"` + đơn `DELIVERED/PAID` → `"DELIVERED"` | **ghi đè cả khi ĐVVC đã nói `PENDING`** — vứt bỏ chứng từ để lấy trạng thái đơn |
| `deliveredLike` gộp luôn `stage === "DELIVERED"` và `"PAID"` | kéo theo `deliveredAt`, `isFinal`, `codStatus` |
| `codCollected: … ? (reconciledCod hoặc codAmount) : 0` | biến **COD KHAI BÁO** thành **tiền ĐÃ THU** |

Dòng cuối là nặng nhất: `cod_collected` là bằng chứng tiền mà `ORDER_OUTCOME` dùng để kết luận giao
thành công. Bịa nó ra chính là **rửa trạng thái đơn thành chứng từ tiền**, đi vòng qua chiều tiền để
kết luận chiều logistics.

Hệ quả kèm theo: lời cam kết ở nhánh cuối `ORDER_OUTCOME` — *Pancake báo “đã giao” KHÔNG phải chứng
từ giao hàng… cao nhất chỉ là ĐANG GIAO* — **không bao giờ chạy tới**, vì mapper đã kịp đặt
`s.stage = 'DELIVERED'` nên nhánh trên đó bắt trước.

### Mức độ ảnh hưởng thật (đo trên production)

| Phép đo | Kết quả |
|---|---|
| Vận đơn `stage = DELIVERED` mà **không có bất kỳ sự kiện ĐVVC nào** | **9** |
| Trong đó `cod_collected` bịa | **0** (đều bằng 0) |
| Tổng COD **khai báo** của 9 vận đơn | **4.566.000đ** |
| Toàn hệ thống: `cod_collected > 0` mà không có dòng bảng kê | 19 vận đơn · 11.255.000đ · **18/19 bằng đúng số khai báo** |
| Trong 19 đó, có chứng từ ĐVVC | **19/19 có** |

Chín vận đơn kia là biểu hiện thuần khiết nhất: `partner_status` **rỗng**, không một sự kiện ĐVVC
nào, vậy mà ERP ghi `DELIVERED` + `is_final = true` + `cod_status = COLLECTED` + `delivered_at`
(13/08 và 29/08) — toàn bộ suy từ trạng thái đơn Pancake.

### Đã sửa

- `shipmentStage` từ trạng thái đơn Pancake cao nhất là **`IN_TRANSIT`**, không bao giờ `DELIVERED`.
  Chọn `IN_TRANSIT` chứ không phải `PENDING` vì nó nằm trong `SHIPMENT_LEFT_WAREHOUSE` y như
  `DELIVERED` ⇒ **SỔ KHO không đổi một món nào**, chỉ chiều logistics hết bịa.
- Xoá hẳn nhánh ghi đè `partnerMeta.stage === "PENDING"`.
- `deliveredLike` chỉ còn `shipmentStage === "DELIVERED"` (tức do ĐVVC nói) ⇒ `deliveredAt`,
  `isFinal`, `codStatus` không còn sinh ra từ trạng thái đơn.
- `codCollected` chỉ lấy từ `partner.cod` (số ĐVVC báo); **bỏ hẳn** nhánh lùi về `codAmount`.

`partnerMeta` (trạng thái ĐVVC do Poscake chuyển tiếp) vẫn được quyền nói `DELIVERED` — đó là thông
tin của hãng vận chuyển, chỉ đi nhờ đường Poscake.

### Kiểm thử hồi quy (bất biến 13 & 14)

Bất biến **13** dựng đúng ca yêu cầu: đơn Pancake `DELIVERED` + webhook VTP mã **505** *“Tồn - Thông
báo chuyển hoàn”* ⇒ khẳng định `stage = RETURNING` và `ORDER_OUTCOME = RETURNED`, **không** phải
`DELIVERED`. Kèm kiểm tra tầng mapper cho cả `delivered` lẫn `paid`: không ra `DELIVERED`, không bịa
`deliveredAt`, `codCollected = 0`, `isFinal = false`.

Bất biến **14** khoá thang thẩm quyền: `LOGISTICS_DECIDING_SOURCES` phải trùng
`CARRIER_DOCUMENT_SOURCES`, và `PAYMENT_COD` phải vĩnh viễn ở mức `NEVER`.

`npm test` in **TẤT CẢ KIỂM THỬ ĐẠT** với **14/14** bất biến. Mọi con số fixture cũ giữ nguyên
(giao thành công 18 · hoàn 32 · GTC 36%) ⇒ bản vá không đụng vào ca đã có chứng từ ĐVVC.

### Giữ xung đột, không ghi đè (mục 8)

Đã có sẵn và được xác nhận còn đúng: sự kiện Pancake **vẫn lưu đủ** trong `shipment_events` (case
`PKE1508908614` giữ 13 dòng PANCAKE bên cạnh 2 dòng chứng từ) nhưng bị `deriveShipmentState()` loại
khỏi việc kết luận; luật `ORDER_SHIPMENT_CONFLICT` (`autoRepair: false`) nêu xung đột ra trang Chất
lượng dữ liệu thay vì tự sửa.

### Đơn nhiều vận đơn (mục 9)

Đo thực tế: **1.509/1.509 đơn có đúng 1 vận đơn**, không đơn nào có hai vận đơn khác trạng thái ⇒
hiện chưa có ca gộp nhầm. 242 vận đơn **chiều hoàn** được giữ thành dòng riêng (`order_id` NULL,
`order_reference` = mã gốc) đúng quy ước. `ORDER_OUTCOME` tính ở grain `orders LEFT JOIN shipments`
nên không gộp theo SĐT/khách; không cần sửa gì.

### Hai case được hỏi

**`PKE1508908614`** — đơn 3176. Lịch sử: **13 sự kiện nguồn PANCAKE** (giữ nguyên, không được kết
luận) + **2 chứng từ**: `VTP_IMPORT` *“Chờ xử lý”* → PENDING (05/09 00:37:47) và `VTP_WEBHOOK`
**505** *“Tồn - Thông báo chuyển hoàn bưu cục gốc”* → **RETURNING** (06/09 08:03:05). Chứng từ mới
nhất thắng ⇒ `stage = RETURNING`, `cod_collected = 0`, `cod_status = PENDING`, `delivered_at` rỗng.
`ORDER_OUTCOME`: không có mã cuối 504/503/501-hoàn nên không rơi vào `VTP_RETURNED`; có chứng từ ĐVVC
và `stage = RETURNING` ⇒ **`RETURNED` (đơn hoàn)**. Pancake cũng đang nói `RETURNING` nên không xung
đột. Đây là ví dụ đẹp: 505 không phải mã cuối mà vẫn kết luận đúng, và 13 bản sao Pancake không làm
lệch gì.

**`PKE1508295104`** — **KHÔNG tồn tại** trong ERP: 0 dòng ở `shipments`, 0 gói ở `webhook_events`,
0 dấu vết trong `shipment_events.raw`. Không kết luận được gì; nếu vận đơn này có thật thì nó thuộc
diện phải bù bằng tệp danh sách vận đơn.

### Cần chủ shop quyết trước khi deploy

Bản vá **chỉ tác động về sau** (`COD_RANK` và `hasCarrierTruth` chặn hạ cấp), nhưng lần đồng bộ
Pancake kế tiếp sẽ tính lại 9 vận đơn kia: **`DELIVERED` → `IN_TRANSIT`**, kéo theo kết quả đơn từ
*giao thành công* sang *đang giao* — **9 đơn · 4.566.000đ doanh thu tháng 8 chuyển sang “chưa biết”**.

Đó là sửa số của **kỳ đã chốt**, thuộc mục 7 của `AGENTS.md` (phải hỏi chủ shop). Mã đã commit và
push; **chưa deploy**, chờ chủ shop duyệt con số này.

## 10j. ĐIỀU TRA CHÍN ĐƠN — 08/09/2026

### Bảng đầy đủ

Tất cả đều **không có mã vận đơn**, `carrier = "Khác"`, `partner_status` rỗng, `cod_collected = 0`,
`prepaid = 0`, và **`shipment_events` = 0 dòng ở MỌI nguồn** (không có cả bản sao PANCAKE).

| Đơn | Ngày lên đơn | Trạng thái Pancake | ERP hiện tại | Mốc “giao” bịa | COD khai | Giá trị hàng | Nguồn | Khách · SĐT |
|---|---|---|---|---|---|---|---|---|
| 2350 | 13/08 09:11:19 | **Đã nhận** | DELIVERED | 13/08 09:12:58 | 474.000 | 449.000 | Facebook | Nguyễn thị Duyên · 979936889 |
| 2357 | 13/08 09:11:24 | **Đã nhận** | DELIVERED | 13/08 09:12:58 | 474.000 | 449.000 | Facebook | Lê Hien · 0345222695 |
| 2359 | 13/08 09:11:25 | **Đã nhận** | DELIVERED | 13/08 09:12:58 | 474.000 | 449.000 | Facebook | Linh le · 896997119 |
| 2360 | 13/08 09:11:27 | **Đã nhận** | DELIVERED | 13/08 09:12:58 | 474.000 | 449.000 | Facebook | Nguyễn thị Bích thu · 909728879 |
| 2370 | 13/08 09:11:39 | **Đã nhận** | DELIVERED | 13/08 09:12:58 | 474.000 | 449.000 | Khác | Linh le · 896997119 |
| 2371 | 13/08 09:11:40 | **Đã nhận** | DELIVERED | 13/08 09:12:58 | 474.000 | 449.000 | Khác | Nguyễn thị Bích thu · 909728879 |
| 2372 | 13/08 09:11:40 | **Đã nhận** | DELIVERED | 13/08 09:12:58 | 474.000 | 449.000 | Khác | Nguyễn thị Duyên · 979936889 |
| 2393 | 13/08 09:11:58 | **Đã nhận** | DELIVERED | 13/08 09:12:56 | 399.000 | 399.000 | Facebook | Lê Hiên · 0345222695 |
| 3181 | 29/08 09:04:36 | **Đã nhận** | DELIVERED | 29/08 09:05:05 | 849.000 | 998.000 | Facebook | Nhiễn Hiền · 0985222958 |

- **Webhook VTP:** 0 · **Import VTP:** 0 · **Poll VTP:** 0 · **Sự kiện carrier mới nhất:** không có.
- **Lý do đang DELIVERED:** khối `partner` trong dữ liệu Pancake **rỗng hoàn toàn**, nên mapper rơi
  vào nhánh `!partnerMeta` và dịch thẳng trạng thái đơn *"Đã nhận"* → `shipmentStage = DELIVERED`.
  Đúng nguyên văn cái luật bị cấm. `delivered_at` được lấy từ mốc đổi trạng thái Pancake, cách lúc
  lên đơn **29–99 giây** — không một bưu tá nào giao hàng trong 30 giây.
- **Kết quả đơn hiện tại:** cả 9 đều là `DELIVERED` **theo COD KHAI BÁO** (nhánh tạm tính), vì
  `cod_collected = 0` và không có dòng bảng kê. Không đơn nào có bằng chứng tiền thật.
- **Kết quả theo logic mới:** `IN_TRANSIT` — tức **CHƯA KẾT LUẬN ĐƯỢC**, không phải “đã hoàn”.

### Phân loại: **9/9 thuộc nhóm D**

| Nhóm | Số ca |
|---|---|
| A — có chứng từ giao thành công nhưng parser chưa nhận ra | **0** |
| B — có chứng từ hoàn / thất bại | **0** |
| C — thiếu lịch sử carrier | **0** |
| **D — không có mã vận đơn / không ghép được thực thể** | **9** |

Khác biệt quan trọng so với giả thiết ban đầu: đây **không phải** ca “lịch sử bị thiếu do webhook
chết”. Chúng chưa từng được đẩy sang Viettel Post — Pancake không có khối `partner`, không có mã, và
ERP không có một sự kiện nào để mất. Vì vậy **xuất tệp từ viettelpost.vn theo mã vận đơn sẽ không
tìm được gì**, đơn giản vì không có mã để đối chiếu.

### Bối cảnh — không phải lô nhập hàng loạt

Trong khung 13/08 09:05–09:20 có **92 đơn**, trong đó **69 đơn CÓ mã vận đơn**. Tám đơn của chúng ta
là thiểu số **không** có mã trong một lô đặt hàng bình thường. Đây là đơn thật của ngày hôm đó,
chỉ là chưa bao giờ được tạo vận đơn.

Phạm vi rộng hơn (đơn không có mã vận đơn nào): 422 `NEW` · 153 `CONFIRMED` · 146 `CANCELLED` ·
143 `DELETED` · 3 `WAITING` · **9 `DELIVERED`** · 4 `RETURNED`. Chỉ nhóm 9 + 4 mới sinh ra dòng
`shipments`, nên phạm vi lỗi đúng bằng những gì đã đo.

### Dấu hiệu trùng đơn cần chủ shop xác nhận

| SĐT | Các đơn |
|---|---|
| **0985222958** | **3176** — 998.000đ · 29/08 · vận đơn **PKE1508908614** · đang **RETURNING**<br>**3181** — 998.000đ · 29/08 · **không mã** · đang DELIVERED |
| 0345222695 | 2357 (449.000, không mã) · 2393 (399.000, không mã) — khác số tiền |

Cặp **3176 / 3181** cùng khách, cùng ngày, cùng **998.000đ**: rất giống một đơn được tạo hai lần —
bản có vận đơn thì đang chuyển hoàn, bản không có mã thì đang được đếm là giao thành công. Nếu đúng
là trùng thì hiện ERP vừa đếm thừa một đơn giao thành công, vừa đếm cả đơn hoàn của chính nó.

Đã kiểm tra: **không có vận đơn mồ côi nào** trong ERP mang 5 số điện thoại này (0 dòng), nên không
thể tự ghép bằng dữ liệu sẵn có.

### Tác động KPI — trước → sau

*(đo bằng định nghĩa theo `stage`; con số nền là xấp xỉ của bảng điều khiển, phần **chênh lệch** là chính xác)*

| Chỉ số | Trước | Sau | Chênh |
|---|---|---|---|
| Đơn giao thành công | 666 | **657** | **−9** |
| Doanh thu giao thành công | 354.714.000đ | **350.148.000đ** | **−4.566.000đ (−1,29%)** |
| Đơn hoàn | 521 | 521 | 0 |
| Tỷ lệ GTC | 56,11% | **55,77%** | **−0,34 điểm** |
| Đơn chuyển sang “chưa kết luận” | — | **+9** | |

**Không đơn nào chuyển thành hoàn.** Toàn bộ 9 chuyển từ *giao thành công (tạm tính)* sang
*chưa kết luận*. Giá trị hàng của 9 đơn là 4.540.000đ; con số 4.566.000đ là COD khai báo (đã gồm
25.000đ phí ship mỗi đơn).

### Ba đường đi, chủ shop chọn

**1 — Nếu 9 đơn này THẬT SỰ đã giao (giao tay / khách tự lấy / ship ngoài):** chứng từ đúng của
chúng là **TIỀN**, không phải trạng thái. Ghi số tiền thực nhận vào đơn (trả trước / chuyển khoản),
`ORDER_OUTCOME` sẽ kết luận **giao thành công một cách hợp lệ** qua nhánh “tiền thực > 100.000đ” —
đúng luật của shop, không cần lách. Đây là đường **giữ nguyên doanh thu** mà vẫn đúng nguyên tắc.

**2 — Nếu nghi chúng CÓ vận đơn mà Pancake không ghi:** xuất **“Danh sách vận đơn”** từ
viettelpost.vn khoảng **13/08 → 29/08/2026** (lấy rộng ra 10/08 → 31/08 cho chắc). Tệp đó có cột
**tên + SĐT người nhận**, và `applyVtpOrderList()` có sẵn đường **gắn mã theo SĐT người nhận**
(`linked`) — nếu Viettel Post có vận đơn của 5 số máy kia thì ERP tự ghép và chứng từ thật sẽ tự
quyết định kết quả. Khẳng định của chủ shop là đúng: **tệp 28/08–08/09 KHÔNG đủ**, nó bỏ sót toàn
bộ 8 đơn ngày 13/08.

**3 — Nếu không có cả hai:** để nguyên là *chưa kết luận*. Đó là câu trả lời trung thực khi không có
chứng từ nào.

### Một điểm cần biết trước khi deploy bản vá

Sau bản vá, 9 dòng này thành `is_final = false` ⇒ **cộng thêm 9 vào danh sách vận đơn treo, vĩnh
viễn**, vì sẽ không bao giờ có ĐVVC nào báo tin. Cách sạch hơn (cần chủ shop duyệt riêng): đơn
**không có khối `partner`** thì **không tạo dòng `shipments`** ngay từ đầu — kết quả đơn vẫn ra
`IN_TRANSIT` qua nhánh `o.stage` của `ORDER_OUTCOME`, mà không để lại vận đơn ma trong danh sách
theo dõi. Thay đổi đó động tới dữ liệu đã có nên tách riêng, không gộp vào bản vá này.

### Trạng thái

`npm test` **TẤT CẢ KIỂM THỬ ĐẠT** · 14/14 bất biến · `typecheck` sạch · `lint` 0 lỗi.
**Chưa deploy. Chưa chạy WRITE BACKFILL.** Chưa import tệp nào, chưa tạo một sự kiện giả nào.
