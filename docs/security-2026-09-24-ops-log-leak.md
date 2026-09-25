# Sự cố 24/09/2026 — log công khai của workflow vận hành chứa dữ liệu khách hàng và secret

**Mức độ: CAO.** Kho `truyenhkm5group-stack/hkt` là PUBLIC; log GitHub Actions của mọi lượt chạy
ai cũng đọc được (không cần đăng nhập), và giữ mặc định **90 ngày**.

Tài liệu này suy ra **từ mã nguồn**: phiên sửa KHÔNG tải log cũ về, nên mọi dòng "có thể đã vào
log" dưới đây là KHẢ NĂNG theo mã, không phải xác nhận đã xảy ra. Người vận hành xác nhận bằng cách
đọc lại lịch sử lượt chạy (HUMAN GATE mục 4) trước khi xoá.

## 1. Bốn đường rò

| # | Đường | Từ khi | Phạm vi |
|---|---|---|---|
| A | GitHub in khối `env:` của mỗi bước ở đầu log bước đó — bước SSH khai `ARG: ${{ inputs.arg }}`, nên **nguyên văn ô "arg"** hiện ở mọi lượt chạy. | từ khi `ops-vps.yml` có ô `arg` (04/09/2026) | MỌI thao tác |
| B | Dòng `echo "[khoá] phân loại: action=$ACTION arg=\"$ARG\" ⇒ $LOP"` in lại nguyên văn ô "arg". | 19/09/2026 (`026c4042`) | MỌI thao tác |
| C | Thao tác in **kết quả** có dữ liệu khách hàng thẳng ra log (bảng psql, phản hồi thô API). | 04/09/2026 (`14b5d2ed` — `db-query`) | xem mục 2 |
| D | `logs` / `verify` chỉ che `pk_…`/`vtp_…`; log ứng dụng còn email, IP, SĐT. | từ khi có hai thao tác ấy | `logs`, `verify` |

Và ba lỗi khiến hàng rào "chỉ đọc" / "tham số" không có thật:

- **`db-query` chưa bao giờ chỉ đọc.** Lệnh là
  `printf … | PGOPTIONS='-c default_transaction_read_only=on …' docker compose exec -T db psql -U erp …`.
  `PGOPTIONS` đặt ở shell MÁY CHỦ; `docker compose exec` không chuyển biến môi trường của máy chủ
  vào container (phải có `-e`), nên nó không tới psql. Và `erp` là **SUPERUSER** của CSDL — kể cả
  khi cờ tới được, một câu `SET default_transaction_read_only = off;` ở đầu ô arg là tắt được.
  Tài liệu `docs/payroll-production-runbook.md` (mục 1.2 cách A) đã khẳng định điều ngược lại.
- **psql nhận lệnh meta từ ô arg**: `\! <lệnh>` chạy shell trong container `db`.
- **Chèn lệnh**: ô arg được ghép vào `sh -c "…"` ở `set-setting`, `run-job`, `sepay-reconcile`,
  `cs-stale`, `reason-coverage`, `returns-parity`, `session-revoke-e2e` — một dấu nháy / `$(…)` là
  một lệnh thứ hai trong container `erp-app`. `agent-run.yml` nội suy `${{ inputs.* }}` thẳng vào
  thân `run:`. (Người dispatch được workflow vốn đã có quyền cao — nhưng "nhầm một dấu nháy" không
  được phép thành "chạy một lệnh".)

## 2. Dữ liệu có thể đã vào log — theo thao tác

| Thao tác | Qua ô arg (đường A, B) | Qua kết quả (đường C/D) |
|---|---|---|
| `db-query` | Câu SQL — thường có SĐT / mã đơn / tên khách trong `WHERE` | **Mọi thứ đã từng được SELECT**: SĐT, tên, địa chỉ khách; email người dùng; nếu từng chạy `select * from settings` thì cả cấu hình có token (xem mục 3); nếu từng đọc `users` / `pg_authid` thì cả băm mật khẩu |
| `set-setting` | **JSON cấu hình**: URL webhook Lark, khoá ký Lark, token bot Telegram (`alerts.config`, `marketing.alerts`) | (script chỉ in số trường) |
| `seed-employees` | JSON nhân sự: tên, bí danh, tài khoản QC, **% lợi nhuận** | dòng tóm tắt từng người (tên, bí danh, tài khoản QC, %) — nay mã hoá, xem mục 6 |
| `payroll-reconcile` | kỳ (`--from/--to`) — rủi ro thấp | **lương, hoa hồng, cơ sở lợi nhuận của từng người kèm tên** — nay mã hoá |
| `check-integrations` | — | tên khách của 5 đơn mẫu và 2 hội thoại mẫu; tên + SĐT chủ tài khoản Viettel Post — nay mã hoá |
| `cs-stale` | cờ | 20 "mẫu thật" = tiêu đề case (tên khách, có loại kèm SĐT) — nay mã hoá |
| `run-job` | tên job + cờ | `landing-sheet preview=1`: dòng mẫu của sheet (tên, địa chỉ khách); `marketing-digest`: tên marketer — nay mã hoá |
| `marketing-calibrate --explain`, `vtp-replay-files --explain` | ngày / phần tên tệp | từng đơn kèm tên người chốt; từng dòng tệp kèm SĐT người nhận — nay là thao tác riêng có mã hoá |
| `returns-hmt`, `vtp-manual-verify`, `care-false-reopen`, `care-outcome-before-open`, `fanpage-evidence-backfill` | cờ | tên / email người tải tệp; SĐT khách đối chiếu; note tự do của nhân viên; tên nhân viên được quy kết quả cứu đơn; tên marketer theo fanpage — nay mã hoá |
| `import-bank-ledger` | **Sao kê MB Bank**: số tài khoản, đối tác, nội dung chuyển khoản, số tiền | tổng hợp |
| `import-vtp-statements` | Bảng kê COD: mã vận đơn, tiền, có thể có người nhận | tổng hợp |
| `vtp-debug` | mã vận đơn | **phản hồi thô getOrderDetail**: tên, SĐT, địa chỉ người nhận; 12 ký tự đầu token VTP |
| `phone-probe` | **SĐT khách** | lịch sử mua hàng theo SĐT từ Pancake |
| `vtp-probe` | mã vận đơn | danh sách vận đơn kèm người nhận |
| `vtp-statement-peek` | tên tệp / mã | dòng bảng kê COD |
| `session-revoke-e2e` | email tài khoản QA | — |
| `logs`, `verify` | — | email, IP, SĐT trong log app / caddy |
| các thao tác còn lại | cờ (`--apply`, ngày, mã) — rủi ro thấp | xem mục 6 |

## 3. Đã chặn thế nào (nhánh `claude/ops-chan-lo-log`)

| Đường | Sửa |
|---|---|
| A | Bước ĐẦU TIÊN của job `ops` đọc ô arg từ `$GITHUB_EVENT_PATH` (không nội suy, không qua `env:`) và đăng ký `::add-mask::` cho từng dòng — mọi bước sau in `***` ở chỗ nó, kể cả khối `env:`. Ô arg chỉ gồm cờ vô hại (chữ, số, `= : . _ , / + -`, ≤ 80 ký tự, không dãy ≥ 7 chữ số, không `@`) thì không che, để log còn đọc được. |
| B | Dòng phân loại chỉ in **độ dài** ô arg. Không in cả băm ngắn: băm của một SĐT 10 chữ số dò ngược trong vài giây. Mọi thông báo lỗi khác liên quan ô arg cũng chỉ in độ dài. |
| C | `ma_hoa_ket_qua`: chạy lệnh, gom kết quả trong RAM (`/dev/shm`), **mã hoá** bằng `openssl cms` cho chứng chỉ `deploy/ops-result-recipient.crt`, xoá bản rõ; log chỉ còn trạng thái + số dòng + lỗi đã che. Bản mã về máy Actions bằng một lượt `ssh` riêng (không qua log) và thành hiện vật giữ 1 ngày. **Chưa có chứng chỉ ⇒ thao tác TỪ CHỐI chạy**, không lùi về in trần. Áp cho mọi thao tác trong `OPS_THAO_TAC_MA_HOA` (danh sách ở mục 6). Dòng script tự đánh dấu `[ops:tom-tat] ` (chỉ con số đếm / kết luận) được in ra log sau khi đã mã hoá, qua `che_log`, tối đa 60 dòng. Cách đọc: `docs/ops-doc-ket-qua.md`. |
| D | `che_log` che thêm email, IPv4/IPv6, SĐT Việt Nam, `token=` / `key=` / `secret=` / `password=` trong URL. |
| db-query | Role **`erp_ro`** (`scripts/ops-erp-ro-role.sql`, dựng lại idempotent mỗi lượt): chỉ `SELECT` trên từng schema ứng dụng, không `pg_read_all_data` (đo trên PGlite: role đó đọc được `pg_authid.rolpassword`), không `pg_execute_server_program`, `PASSWORD NULL` (không vào được qua TCP), mặc định chỉ đọc + `statement_timeout 60s`. `SET default_transaction_read_only = off; INSERT …` ⇒ *permission denied*. Câu SQL có `\` bị từ chối. psql chạy với `-X`. |
| Chèn lệnh | Không còn `sh -c "…$ARG…"`: cờ đi thẳng vào argv qua `chay_voi_arg` SAU danh sách ký tự cho phép; biến đi qua `docker exec -e`; `set-setting` tách `<khoá> <json> [--test-lark]` bằng mở rộng tham số (không đánh giá gì) và vẫn nhận JSON trong nháy đơn như cũ. `agent-run.yml`: mọi `inputs.*` và `github.actor` đi qua `env:`. |
| Chuỗi cung ứng | `appleboy/ssh-action` ghim SHA `0ff4204d59e8e51228ff73bce53f80d53301dee2` (= thẻ `v1` = `v1.2.5`) ở `ops-vps.yml` (2 chỗ) và `deploy-vps.yml`. |
| Quyền token | `ops-vps.yml` khai `permissions: contents: read`. |

Bài kiểm: `tests/ops-log-leak.test.ts` (đăng ký trong `tests/sync-fixtures.test.ts`) — khoá ở mức mã
nguồn VÀ chạy thật: tệp role trên Postgres (PGlite), hàm mã hoá + kênh tóm tắt + hàm tách arg +
`che_log` dưới bash/openssl. Mọi thao tác trong `options:` phải hoặc nằm trong `OPS_THAO_TAC_MA_HOA`,
hoặc có một dòng "đã rà — vì sao" ở `KHONG_MA_HOA_DA_RA`; thiếu cả hai là đỏ.

## 4. HUMAN GATE — việc CHỈ người vận hành làm được

Phiên sửa mã không có quyền và không được phép làm các việc dưới đây.

**(i) Xoá log các lượt ops cũ.** Actions → *Vận hành ERP trên VPS* → từng lượt chạy trước khi bản
sửa này vào `main` → ⋯ → **Delete all logs** (hoặc xoá cả lượt chạy). Làm cho TẤT CẢ lượt từ
04/09/2026; ưu tiên `db-query`, `set-setting`, `import-bank-ledger`, `seed-employees`,
`phone-probe`, `vtp-debug`, `logs`. **Trước khi xoá**, lướt danh sách lượt `db-query` / `set-setting`
để biết mục (ii) cần xoay những gì. Xoá log KHÔNG thu hồi được thứ đã bị ai đó chép — nó chỉ chặn
người đọc SAU. Cân nhắc hạ *Settings → Actions → General → Artifact and log retention* xuống
mức tối thiểu cần dùng.

**(ii) Xoay các secret có thể đã in ra:**

| Secret | Vì sao | Cách xoay |
|---|---|---|
| URL webhook Lark + khoá ký Lark trong `settings["alerts.config"]` (`larkWebhookUrl`) và `settings["marketing.alerts"]` (`larkWebhookUrl`, `larkSecret`, `managerWebhookUrl`, `managerSecret`) | đi qua ô arg của `set-setting` (đường A, B); hoặc `select * from settings` qua `db-query` | Lark: xoá bot cũ, tạo webhook mới, ghi lại qua màn hình Cảnh báo marketing / `set-setting` (nay đã che) |
| Token bot Telegram (`alerts.config.telegramBotToken`) | như trên | BotFather → `/revoke` → ghi token mới |
| Mọi giá trị bí mật khác trong bảng `settings` | nếu từng `select * from settings` | sau khi có chứng chỉ: `db-query` `select key from settings where value::text ~* '(token\|secret\|password\|webhook\|apikey)'` rồi xoay từng khoá |
| Mật khẩu người dùng ERP | nếu từng `select … from users` có cột băm mật khẩu | buộc đặt lại mật khẩu |
| `POSTGRES_PASSWORD` | nếu từng đọc `pg_authid` / `pg_shadow` qua `db-query` (khi đó chạy bằng superuser) | đổi trong `.env` rồi deploy (install-vps.sh tự `ALTER USER erp`) |
| Secret webhook Pancake / Viettel Post | chỉ khi log app in chúng ở dạng KHÁC `pk_…`/`vtp_…` (bản cũ chỉ che hai dạng ấy) | thao tác `rotate-webhook-secrets` rồi khai lại URL ở Pancake / VTP |

Token API Viettel Post: `vtp-debug` in 12 ký tự đầu của token phiên — không đủ dùng lại, và token
phiên tự hết hạn; không cần xoay trừ khi (i) cho thấy in nhiều hơn.

**(iii) Sinh cặp khoá + đặt chứng chỉ** theo `docs/ops-doc-ket-qua.md` mục 1–2. Cho tới khi làm
xong, **17 thao tác** trong `OPS_THAO_TAC_MA_HOA` (bảng mục 6) **từ chối chạy** — trong đó có những
thao tác dùng hằng ngày: `run-job`, `check-integrations`, `cs-stale`, `returns-hmt`,
`payroll-reconcile`.

**(v) Số điện thoại khách nằm trong MÃ NGUỒN công khai.** `scripts/vtp-manual-verify.ts` (bảng
`RECORDS`, có từ commit `e754aaed`) ghi cứng **18 SĐT khách** để đối chiếu tay. Việc mã hoá
kết quả thao tác không gỡ được chúng khỏi kho và lịch sử git. Chủ shop quyết: bỏ cột `phone` khỏi
tệp (lô đã chạy xong thì không cần nữa) và cân nhắc có viết lại lịch sử hay không — phiên sửa mã
này KHÔNG tự làm.

**(iv) Tuỳ chọn:** khai biến kho `VPS_KNOWN_HOSTS` (một dòng `ssh-keyscan -p <cổng> <máy chủ>` đã
đối chiếu tay) để bước lấy bản mã kiểm khoá máy chủ chặt thay vì nhận theo lần đầu.

## 5. Hành vi đổi sau khi gộp

- 17 thao tác trong `OPS_THAO_TAC_MA_HOA` (mục 6): **không còn in kết quả**; cần chứng chỉ
  (fail-closed) và khoá riêng để đọc. Phiên agent / người trực nào quen "đọc số trong log" phải
  chuyển sang giải mã hiện vật. Log chỉ còn khối `── Kết quả ĐÃ MÃ HOÁ ──` và, nếu script có khai,
  khối `── Tóm tắt do script tự khai ──` (con số đếm, kết luận ✓ / ✗).
- `marketing-calibrate --explain` và `vtp-replay-files --explain` bị **từ chối** (exit 64); dùng
  `marketing-explain` (arg giữ nguyên `--explain=YYYY-MM-DD …`) và `vtp-replay-explain`
  (arg `--like=<phần tên tệp>`).
- `check-integrations` nay lấy `scripts/check-integrations.ts` từ `main` (như `apply-ai-env`) thay vì
  bản trong ảnh.
- `run-job`, `seed-employees`: dòng tóm tắt đến từ `scripts/sync.ts` / `scripts/seed-employees.ts`
  **trong ảnh** — chỉ hiện sau lần deploy kế tiếp; trước đó log chỉ có khối "ĐÃ MÃ HOÁ".
- `db-query`: câu ghi nay **thất bại thật** (trước đây chạy được); câu có `\` bị từ chối; lượt đầu
  tiên dựng role `erp_ro` (ghi danh mục hệ thống Postgres, không đụng dữ liệu nghiệp vụ).
- Mọi thao tác nhận cờ tách theo khoảng trắng: ô arg có ký tự ngoài `chữ số khoảng-trắng = : . _ , / @ + -`
  bị từ chối (exit 64). Tên tệp tiếng Việt có dấu cho `vtp-statement-peek` / `vtp-replay-files --like=`
  cần gõ phần không dấu.
- `run-job`: arg không còn qua shell — chuỗi có nháy / `$` bị từ chối.
- `set-setting`: vẫn nhận `<khoá> '<json>' [--test-lark]`; nay nhận cả JSON KHÔNG bọc nháy.
- `logs` / `verify`: email, IP, SĐT hiện `•`.

## 6. Rà từng thao tác — in gì, xử lý thế nào (24/09/2026)

Rà bằng cách đọc script mà mỗi nhánh chạy, và mọi hàm `lib/` nó gọi có tự `console.*`. **Dữ liệu
cá nhân** = thứ định danh một NGƯỜI THẬT: tên (khách hoặc nhân viên), SĐT, địa chỉ, email, lương /
hoa hồng / % của một người, số tài khoản, nội dung chat, note tự do. **Mã vận đơn / mã đơn / tiền
theo dòng** là định danh GIÁN TIẾP (tra ngược cần quyền vào ERP hoặc tài khoản Viettel Post, không
mang tên / SĐT / địa chỉ) — ghi ở cột "in gì", không mã hoá.

Nơi khai DUY NHẤT của danh sách mã hoá là `OPS_THAO_TAC_MA_HOA` (ops-vps.yml). Phần bù — thao tác
đã rà và để in trần — nằm ở `KHONG_MA_HOA_DA_RA` trong `tests/ops-log-leak.test.ts`, mỗi thao tác
một câu lý do; thao tác nằm ngoài cả hai làm bài kiểm đỏ.

### 6a. MÃ HOÁ (18) — kết quả chỉ đi dạng bản mã; log còn khối đếm + kênh tóm tắt

| Thao tác | In gì (bản rõ, nay chỉ trong bản mã) | Log công khai còn |
|---|---|---|
| `db-query` | mọi thứ SELECT được | số khối / số dòng psql, lỗi đã che |
| `vtp-debug` | phản hồi thô getOrderDetail: tên, SĐT, địa chỉ người nhận | số dòng |
| `phone-probe` | lịch sử mua hàng theo SĐT | số dòng |
| `vtp-probe` | danh sách vận đơn kèm người nhận | số dòng |
| `vtp-statement-peek` | dòng bảng kê COD kèm người nhận | số dòng |
| `payroll-reconcile` | lương, hoa hồng, cơ sở lợi nhuận TỪNG NGƯỜI kèm tên | tóm tắt: kỳ, hoạt động nguồn, bảng đếm trạng thái, chứng minh không ghi, kết luận cổng |
| `seed-employees` | tên, bí danh, tài khoản QC, % lợi nhuận từng người | tóm tắt: số người thêm / cập nhật, số chiến dịch ghép lại *(sau deploy — script chạy từ ảnh)* |
| `marketing-explain` (tách từ `marketing-calibrate --explain`) | từng đơn: mã đơn, doanh thu, TÊN người chốt | tóm tắt: số đơn, phép cộng của ngày, KHỚP / KHÔNG KHỚP |
| `cs-stale` | 20 mẫu = tiêu đề case (tên khách, loại phiếu trả hàng kèm SĐT) | tóm tắt: mọi bảng đếm (kết luận, theo loại, "chưa tạo đơn", đã áp dụng) |
| `check-integrations` | 5 đơn mẫu (tên khách), 2 hội thoại mẫu (tên khách), chủ tài khoản VTP (tên + SĐT) | tóm tắt: tiêu đề mục + ✓ / ✗ từng kết nối + hướng dẫn cố định |
| `run-job` | job bất kỳ; `landing-sheet preview=1` in dòng mẫu sheet (tên, địa chỉ); `marketing-digest` trả tên marketer | tóm tắt: tên job, trạng thái, 4 con số đếm *(sau deploy — `scripts/sync.ts` chạy từ ảnh)* |
| `vtp-replay-explain` (tách từ `vtp-replay-files --explain`) | từng dòng chưa ghép kèm SĐT người nhận | tóm tắt: mỗi tệp — số dòng, số dòng chưa ghép |
| `vtp-manual-verify` | JSON có SĐT khách đối chiếu + ghi chú chủ shop | tóm tắt: số yêu cầu / đã có / tạo mới / chứng cứ |
| `returns-hmt` | tên / email người tải tệp, ví dụ từng dòng sổ viết tay | tóm tắt: băm tệp, bảng TỔNG HỢP, số đã ghi |
| `care-false-reopen` | từng đợt kèm note tự do nhân viên viết | tóm tắt: số ứng viên / đóng được / phải hỏi, số đã đóng |
| `care-outcome-before-open` | từng đợt kèm TÊN nhân viên được quy kết quả cứu đơn | tóm tắt: số đợt, số đã sửa |
| `fanpage-evidence-backfill` | bảng page → TÊN marketer | tóm tắt: số page theo kết luận, số phân công tạo / bỏ qua |
| `cod-statement-audit` *(thêm 25/09/2026)* | không in dữ liệu cá nhân — mọi dòng đều qua kênh tóm tắt; bọc mã hoá để phần in thêm (nếu có) không ra log | tóm tắt: số theo tab /cod, quá hạn theo ngày giao, đợt tiền VTP (ngày · số tiền · số bảng kê) so với tệp đã nhận, các lần nhập tệp (loại tệp · số dòng · lỗi đã che), sổ chứng từ, nhịp tim script Gmail |
| `stock-wait-summary` *(thêm 25/09/2026)* | không in dữ liệu cá nhân — danh sách đơn đang chờ (tên khách) chỉ được ĐẾM theo nhóm, không in dòng nào; bọc mã hoá để phần in thêm (nếu có) không ra log | tóm tắt: GTC theo khoảng ngày chờ / miền / vùng / 8 tỉnh nhiều đơn nhất, bảng chéo chờ × miền, điểm gãy, số đơn đang chờ theo khoảng · miền, 14 ngày gần nhất, tiêu đề đề xuất |

Hai thao tác gốc giữ nguyên chế độ tổng hợp và **từ chối** cờ in dữ liệu cá nhân (exit 64):
`marketing-calibrate --explain`, `vtp-replay-files --explain`.

### 6b. ĐÃ RÀ — chỉ in số tổng hợp hoặc định danh gián tiếp, để in trần

| Thao tác | In gì |
|---|---|
| `status`, `perf`, `disk`, `docker-prune`, `restart`, `backup` | trạng thái container, health, CPU/RAM, tên bảng + số dòng, ổ đĩa, tên tệp dump |
| `logs`, `verify`, `smoke` | log ứng dụng qua `che_log` (email, IP, SĐT, token bị che); smoke: đường dẫn + thời gian |
| `sync-pancake-all`, `sync-pancake-orders`, `sync-vtp-tracking`, `sync-vtp-import`, `sync-facebook-ads` | JSON kết quả job: số đếm; lỗi từng đơn vào `sync_runs`, không in; mã trạng thái VTP chưa dịch |
| `import-bank-ledger`, `bank-ledger-prune` | số dòng / tổng tiền theo trạng thái và nhóm chi phí — **nội dung chuyển khoản không in** (ô arg đã che) |
| `import-vtp-statements`, `vtp-statements-autolink`, `cod-status-repair` | số bảng kê, tổng tiền; mã bảng kê + ngày + tổng COD |
| `vtp-rebuild-state`, `cod-rebuild`, `vtp-return-status-repair`, `vtp-retry-webhooks`, `outcome-explain`, `vtp-import-preview`, `outcome-parity`, `cogs-drift` | số đếm + tối đa 10–20 **mã vận đơn / mã đơn** kèm chặng, trạng thái VTP, COD hoặc giá vốn từng dòng (gián tiếp) |
| `vtp-replay-files` | tên tệp + số đếm (`--explain` bị từ chối) |
| `marketing-calibrate` | bảng theo NGÀY toàn shop (`--explain` bị từ chối) |
| `kpi-snapshot`, `profit-verify`, `explain-stock`, `perf-probe`, `perf-audit` | tổng toàn shop; kế hoạch truy vấn; marketer ẩn danh `MKT#n` |
| `returns-parity`, `reason-backfill`, `reason-coverage` | mã hàng + số đếm |
| `care-waiting-reconcile`, `cs-cleanup`, `cs-rule-update` | mã vận đơn + trạng thái care + giờ xem lại (note KHÔNG in); số đếm; ≤ 3 lỗi quét (id hội thoại, tên fanpage) |
| `set-setting` | khoá + số trường (JSON không in) |
| `meta-id-probe`, `ads-level-probe`, `pages-debug`, `vtp-web-probe` | mã Meta, tên chiến dịch / tài khoản QC / fanpage (đối tượng kinh doanh), chi tiêu; HTML công khai của viettelpost.vn |
| `vtp-capability`, `session-verify`, `session-revoke-e2e` | danh tính tài khoản VTP / email quản trị / email QA **đã che**; mã HTTP |
| `sepay-verify`, `sepay-reconcile`, `sepay-schedule` | mã giao dịch / mã tham chiếu ngân hàng + số tiền, tổng sổ — không nội dung chuyển khoản; số phút |
| `rotate-webhook-secrets`, `apply-ai-env`, `apply-sepay-env`, `apply-tech-github-env`, `apply-agent-env` | độ dài secret; `check-integrations --ai / --github / --agent-identity` chỉ in meta và danh tính đã che |
| `agent-run-reattach`, `ai-check` | mã lượt chạy agent, nhánh, mã việc; meta của lượt AI (độ dài câu trả lời, id vận đơn thử) |

### 6c. Rủi ro còn lại

- **Định danh gián tiếp** (mã vận đơn, mã đơn, tiền từng dòng) vẫn in trần ở nhóm 6b.
- **Chữ lỗi của bên thứ ba** in thô ở vài thao tác 6b (`vtp-retry-webhooks`, `vtp-capability`,
  `pages-debug`, `sync-*`): không thấy dữ liệu cá nhân trong các thông điệp ERP tự dựng, nhưng thân
  lỗi của Pancake / Viettel Post / Meta không được bảo đảm sạch.
- **Tên tài khoản QC / chiến dịch** (`ads-level-probe`, `meta-id-probe`) có thể mang tên marketer
  nếu đặt tên theo người.
- **Kênh tóm tắt** chỉ chặn được lỗi dễ mắc (`tests/ops-log-leak.test.ts` cấm các trường như
  `name`, `phone`, `title`, `note` trên dòng tóm tắt, và dòng vẫn qua `che_log`); nó không thay
  người review — `ok()` / `bad()` của `check-integrations` in tên shop / fanpage / tài khoản QC qua
  kênh này.
- **SĐT khách trong mã nguồn** `scripts/vtp-manual-verify.ts` — HUMAN GATE mục 4 (v).
- Ô "arg" còn có thể hiện ở siêu dữ liệu lượt chạy mà GitHub hiển thị cho người xem kho — chưa
  kiểm chứng. **Không dán secret vào ô arg**; secret đi qua Secrets của kho như `apply-*-env` đã làm.
