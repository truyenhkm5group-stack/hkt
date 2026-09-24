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
| `seed-employees` | JSON nhân sự: tên, bí danh, tài khoản QC, **% lợi nhuận** | dòng tóm tắt từng người (tên, %) — **vẫn in**, xem mục 6 |
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
| C | `ma_hoa_ket_qua`: chạy lệnh, gom kết quả trong RAM (`/dev/shm`), **mã hoá** bằng `openssl cms` cho chứng chỉ `deploy/ops-result-recipient.crt`, xoá bản rõ; log chỉ còn trạng thái + số dòng + lỗi đã che. Bản mã về máy Actions bằng một lượt `ssh` riêng (không qua log) và thành hiện vật giữ 1 ngày. **Chưa có chứng chỉ ⇒ thao tác TỪ CHỐI chạy**, không lùi về in trần. Áp cho `db-query`, `vtp-debug`, `phone-probe`, `vtp-probe`, `vtp-statement-peek`. Cách đọc: `docs/ops-doc-ket-qua.md`. |
| D | `che_log` che thêm email, IPv4/IPv6, SĐT Việt Nam, `token=` / `key=` / `secret=` / `password=` trong URL. |
| db-query | Role **`erp_ro`** (`scripts/ops-erp-ro-role.sql`, dựng lại idempotent mỗi lượt): chỉ `SELECT` trên từng schema ứng dụng, không `pg_read_all_data` (đo trên PGlite: role đó đọc được `pg_authid.rolpassword`), không `pg_execute_server_program`, `PASSWORD NULL` (không vào được qua TCP), mặc định chỉ đọc + `statement_timeout 60s`. `SET default_transaction_read_only = off; INSERT …` ⇒ *permission denied*. Câu SQL có `\` bị từ chối. psql chạy với `-X`. |
| Chèn lệnh | Không còn `sh -c "…$ARG…"`: cờ đi thẳng vào argv qua `chay_voi_arg` SAU danh sách ký tự cho phép; biến đi qua `docker exec -e`; `set-setting` tách `<khoá> <json> [--test-lark]` bằng mở rộng tham số (không đánh giá gì) và vẫn nhận JSON trong nháy đơn như cũ. `agent-run.yml`: mọi `inputs.*` và `github.actor` đi qua `env:`. |
| Chuỗi cung ứng | `appleboy/ssh-action` ghim SHA `0ff4204d59e8e51228ff73bce53f80d53301dee2` (= thẻ `v1` = `v1.2.5`) ở `ops-vps.yml` (2 chỗ) và `deploy-vps.yml`. |
| Quyền token | `ops-vps.yml` khai `permissions: contents: read`. |

Bài kiểm: `tests/ops-log-leak.test.ts` (đăng ký trong `tests/sync-fixtures.test.ts`) — khoá ở mức mã
nguồn VÀ chạy thật: tệp role trên Postgres (PGlite), hàm mã hoá + hàm tách arg + `che_log` dưới
bash/openssl.

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
xong, `db-query`, `vtp-debug`, `phone-probe`, `vtp-probe`, `vtp-statement-peek` **từ chối chạy**.

**(iv) Tuỳ chọn:** khai biến kho `VPS_KNOWN_HOSTS` (một dòng `ssh-keyscan -p <cổng> <máy chủ>` đã
đối chiếu tay) để bước lấy bản mã kiểm khoá máy chủ chặt thay vì nhận theo lần đầu.

## 5. Hành vi đổi sau khi gộp

- `db-query`, `vtp-debug`, `phone-probe`, `vtp-probe`, `vtp-statement-peek`: **không còn in kết quả**;
  cần chứng chỉ (fail-closed) và khoá riêng để đọc. Phiên agent / người trực nào quen "đọc số trong
  log" phải chuyển sang giải mã hiện vật.
- `db-query`: câu ghi nay **thất bại thật** (trước đây chạy được); câu có `\` bị từ chối; lượt đầu
  tiên dựng role `erp_ro` (ghi danh mục hệ thống Postgres, không đụng dữ liệu nghiệp vụ).
- Mọi thao tác nhận cờ tách theo khoảng trắng: ô arg có ký tự ngoài `chữ số khoảng-trắng = : . _ , / @ + -`
  bị từ chối (exit 64). Tên tệp tiếng Việt có dấu cho `vtp-statement-peek` / `vtp-replay-files --like=`
  cần gõ phần không dấu.
- `run-job`: arg không còn qua shell — chuỗi có nháy / `$` bị từ chối.
- `set-setting`: vẫn nhận `<khoá> '<json>' [--test-lark]`; nay nhận cả JSON KHÔNG bọc nháy.
- `logs` / `verify`: email, IP, SĐT hiện `•`.

## 6. CHƯA phủ — rủi ro còn lại

Các thao tác sau vẫn in ra log thứ có thể là dữ liệu cá nhân và cần rà từng script trước khi quyết
đưa vào `OPS_THAO_TAC_MA_HOA`: `payroll-reconcile` (lương từng người), `seed-employees` (tên + %
lợi nhuận), `marketing-calibrate --explain` (liệt kê từng đơn), `outcome-explain`,
`cs-stale` / `cs-rule-update` (in "mẫu thật"), `returns-hmt`, `vtp-import-preview`,
`care-*` (liệt kê ca). Thêm vào danh sách = thêm tên vào `OPS_THAO_TAC_MA_HOA` VÀ bọc lệnh chạy
bằng `ma_hoa_ket_qua` (bài kiểm đòi khớp hai chiều).

Ô "arg" còn có thể hiện ở siêu dữ liệu lượt chạy mà GitHub hiển thị cho người xem kho — chưa kiểm
chứng. **Không dán secret vào ô arg**; secret đi qua Secrets của kho như `apply-*-env` đã làm.
