# Đọc kết quả thao tác vận hành có dữ liệu khách hàng

Áp dụng cho workflow **Vận hành ERP trên VPS** (`.github/workflows/ops-vps.yml`), các thao tác
trong biến `OPS_THAO_TAC_MA_HOA` — danh sách đầy đủ và lý do từng cái ở
`docs/security-2026-09-24-ops-log-leak.md` mục 6. Ngày 24/09/2026 gồm: `db-query`, `vtp-debug`,
`phone-probe`, `vtp-probe`, `vtp-statement-peek`, `payroll-reconcile`, `seed-employees`,
`marketing-explain`, `cs-stale`, `check-integrations`, `run-job`, `vtp-replay-explain`,
`vtp-manual-verify`, `returns-hmt`, `care-false-reopen`, `care-outcome-before-open`,
`fanpage-evidence-backfill`. Ngày 25/09/2026 thêm `cod-statement-audit` và `stock-wait-summary` (chỉ in số tổng hợp qua
kênh tóm tắt — đọc được ngay trên log, không cần giải mã).

Kho mã này **PUBLIC**: log của mọi lượt chạy ai cũng đọc được. Kết quả của các thao tác trên có
SĐT, tên, địa chỉ khách, hoặc tên / lương / note của nhân viên, nên nó **không bao giờ in ra log**.
Máy chủ mã hoá kết quả bằng chứng chỉ
công khai trong kho (`deploy/ops-result-recipient.crt`), máy Actions lấy **bản mã** về thành hiện
vật `ket-qua-ma-hoa-<RUN_ID>` giữ **1 ngày**, và chỉ người giữ **khoá riêng** mở được.

Log chỉ còn: mã thoát, số dòng văn bản, số khối và tổng số dòng kết quả của psql, kích thước +
sha256 của bản mã, dòng lỗi đầu tiên **đã che** (mọi thứ trong nháy, mọi dãy ≥ 4 chữ số, mọi
email), và **khối tóm tắt** (mục 7) nếu script có khai. Muốn biết lỗi đầy đủ thì giải mã — lỗi gốc
nằm trong bản mã.

> **Chưa có chứng chỉ ⇒ các thao tác trên TỪ CHỐI chạy** (bước "Kiểm chứng chỉ người nhận" đỏ).
> Không có đường lùi về in bản rõ. Làm mục 1 một lần là mở lại được.

`db-query` chạy bằng role **`erp_ro`** (không có quyền ghi bảng nào — `scripts/ops-erp-ro-role.sql`,
tự dựng lại mỗi lượt, idempotent). Câu SQL **không được chứa dấu `\`** (psql coi `\!`, `\o`, `\copy`
là lệnh của chính nó); cần ký tự ấy trong chuỗi thì dùng `chr(92)`.

---

## 1. Sinh cặp khoá (người vận hành, MỘT lần)

Làm trên máy của người sẽ đọc kết quả. Trên Windows dùng **Git Bash** (có sẵn `openssl`).

```bash
mkdir -p ~/.erp-ops && cd ~/.erp-ops          # = %USERPROFILE%\.erp-ops — NGOÀI kho mã
unset OPENSSL_CONF                            # Windows: biến này hay trỏ vào tệp đã gỡ
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:4096 -sha256 -days 730 \
  -subj "/CN=VNX ERP ops ket qua" \
  -keyout ops-ket-qua.key -out ops-result-recipient.crt
```

- Lệnh sẽ hỏi **mật khẩu cho khoá riêng** hai lần. Đặt mật khẩu mạnh, lưu trong trình quản lý mật
  khẩu. (Không dùng `-nodes` / `-noenc`: khoá riêng không mật khẩu nằm trên đĩa là khoá ai chép
  được tệp cũng dùng được.)
- `MSYS_NO_PATHCONV=1` là để Git Bash không biến `/CN=…` thành một đường dẫn Windows.
- Khoá dùng 2 năm (`-days 730`). Hết hạn thì bước kiểm trên Actions tự đỏ và nói phải thay.

Khoá chặt quyền đọc tệp khoá riêng:

```bash
chmod 600 ~/.erp-ops/ops-ket-qua.key                       # Git Bash / Linux / macOS
icacls "%USERPROFILE%\.erp-ops\ops-ket-qua.key" /inheritance:r /grant:r "%USERNAME%:R"   # cmd.exe
```

**Khoá riêng (`ops-ket-qua.key`) KHÔNG BAO GIỜ vào kho mã, vào Secret của GitHub, vào chat hay
vào ô "arg".** Chỉ tệp `.crt` được commit.

## 2. Đặt chứng chỉ công khai vào kho

```bash
cp ~/.erp-ops/ops-result-recipient.crt <kho>/deploy/ops-result-recipient.crt
grep -c "PRIVATE KEY" <kho>/deploy/ops-result-recipient.crt     # PHẢI in 0
openssl x509 -in <kho>/deploy/ops-result-recipient.crt -noout -subject -enddate -fingerprint -sha256
```

Ghi lại dòng `sha256 Fingerprint=…` — mỗi lượt chạy in lại đúng dòng này, để đối chiếu rằng bản mã
làm cho đúng khoá của mình. Commit tệp `.crt` theo quy trình PR thường. Bài kiểm
`tests/ops-log-leak.test.ts` đỏ nếu tệp ấy (hay bất kỳ tệp nào trong `deploy/`) chứa khoá riêng;
bước "Kiểm chứng chỉ người nhận" trên Actions cũng dừng trong trường hợp đó.

Workflow đọc chứng chỉ **từ chính commit đang chạy**, nên chứng chỉ mới có hiệu lực ngay ở lượt
dispatch đầu tiên sau khi gộp vào `main` — không cần deploy.

## 3. Chạy thao tác và lấy bản mã

1. Actions → **Vận hành ERP trên VPS** → Run workflow → chọn thao tác, dán SQL/tham số vào `arg`.
2. Đợi xong. Trong log bước SSH có khối `── Kết quả ĐÃ MÃ HOÁ ──` với số dòng và
   `sha256 xxxxxxxxxxxxxxxx…` của bản mã, rồi (nếu script có khai) khối
   `── Tóm tắt do script tự khai ──` — đủ để biết lượt chạy thử / lượt ghi ra bao nhiêu mà chưa cần
   giải mã (mục 7).
3. Trang tóm tắt của lượt chạy → mục **Artifacts** → tải `ket-qua-ma-hoa-<RUN_ID>` (cần đăng nhập
   GitHub; hiện vật tự xoá sau 1 ngày). Hoặc, nếu máy có `gh`:

   ```bash
   gh run download <RUN_ID> -R truyenhkm5group-stack/hkt -n ket-qua-ma-hoa-<RUN_ID>
   ```

Hiện vật của kho PUBLIC tải được bởi **mọi tài khoản GitHub đã đăng nhập** — vì thế nó là bản mã,
không phải bản rõ.

## 4. Giải mã

```bash
cd ~/Downloads
unzip -o ket-qua-ma-hoa-<RUN_ID>.zip          # ra ket-qua.p7m (bước tải bằng gh đã tự giải nén)
sha256sum ket-qua.p7m | cut -c1-16            # phải khớp dòng in trong log
unset OPENSSL_CONF
openssl cms -decrypt -binary -inform DER -in ket-qua.p7m \
  -inkey ~/.erp-ops/ops-ket-qua.key -out ket-qua-<RUN_ID>.txt
```

Dòng đầu tệp giải mã là `# run=<RUN_ID> action=<thao tác> lúc <giờ UTC>`; phần sau là đúng thứ
thao tác in ra (kết quả psql dạng bảng, kể cả dòng lỗi gốc).

Đọc xong thì **xoá bản rõ** (`rm ket-qua-<RUN_ID>.txt ket-qua.p7m`). Không dán SĐT / tên / địa chỉ
khách vào commit, tài liệu, PR hay tin nhắn — kể cả khi "chỉ để làm ví dụ". Con số tổng hợp (đếm,
tổng tiền) thì dùng thoải mái.

## 5. Thay chứng chỉ (xoay khoá)

Làm khi: khoá sắp hết hạn, đổi người vận hành, hoặc **nghi khoá riêng bị lộ**.

1. Sinh cặp mới theo mục 1 (đặt tên tệp khác, ví dụ `ops-ket-qua-2028.key`).
2. Thay `deploy/ops-result-recipient.crt` bằng chứng chỉ mới, commit, gộp vào `main`.
3. Giữ khoá riêng CŨ thêm **1 ngày** (hạn giữ hiện vật) để mở các bản mã còn treo, rồi xoá hẳn.

Nếu khoá riêng **bị lộ**: làm bước 2 NGAY. Mọi bản mã tạo bằng chứng chỉ cũ mà ai đó đã tải trong
thời gian hiện vật còn sống thì coi như đã lộ — ghi vào sổ sự cố.

## 6. Gỡ rối

| Triệu chứng | Nguyên nhân · cách sửa |
|---|---|
| Bước "Kiểm chứng chỉ người nhận" đỏ: *Chưa có chứng chỉ* | Chưa làm mục 1–2. |
| … *chứa KHOÁ RIÊNG* | Đã commit nhầm tệp khoá. Coi như lộ: làm mục 5 NGAY, gỡ tệp khỏi kho. |
| … *không phải chứng chỉ X.509 hợp lệ hoặc đã hết hạn* | Mục 5. |
| `BIO_new_file … openssl.cnf` khi chạy openssl trên Windows | `unset OPENSSL_CONF` rồi chạy lại. |
| `Error decrypting CMS … no recipient matches` | Giải mã bằng khoá không khớp chứng chỉ của lượt đó — so dấu vân tay trong log. |
| Không có hiện vật, log ghi *Máy chủ không có bản mã* | Thao tác dừng trước khi chạy (lỗi khoá, SQL có `\`, ô arg rỗng) — đọc log bước SSH. |
| `permission denied for table …` trong kết quả `db-query` | `erp_ro` chỉ ĐỌC được; câu có ghi bị chặn là đúng thiết kế. Ghi dữ liệu production chỉ qua job / action của ứng dụng (AGENTS.md mục 4). |
| `marketing-calibrate` / `vtp-replay-files` đỏ: *--explain … dùng thao tác …* | Chế độ `--explain` in dữ liệu cá nhân nên đã tách thành `marketing-explain` / `vtp-replay-explain` (có mã hoá). Chạy thao tác ấy, arg giữ nguyên. |
| `run-job` / `seed-employees` không có khối tóm tắt | Hai thao tác này chạy script từ ẢNH đang phục vụ; dòng tóm tắt có từ lần deploy sau 24/09/2026. Trước đó giải mã để đọc. |

## 7. Kênh tóm tắt — thứ duy nhất của bản rõ được ra log

Một thao tác trong danh sách mã hoá vẫn có thể cần cho người vận hành thấy NGAY một con số —
"đã đóng 12 case", "kết luận cổng: RECONCILIATION_PASS", "✓ Pancake POS". Script in dòng ấy với
tiền tố **`[ops:tom-tat] `** ở ĐẦU dòng (kể cả dấu cách):

```ts
const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);
tomTat(`Đã đóng ${kq.closed}/${kq.planned} case`);
```

Sau khi mã hoá xong, `ma_hoa_ket_qua` lấy đúng các dòng ấy (bỏ tiền tố), cho qua `che_log` (SĐT,
email, IP, token bị che), tách `::` để chúng không thành lệnh workflow, cắt 300 ký tự / 60 dòng,
và in dưới khối `── Tóm tắt do script tự khai ──`. Dòng không đánh dấu thì KHÔNG ra log — mặc
định là kín. Bản mã vẫn giữ nguyên mọi dòng, kể cả dòng tóm tắt.

Luật cho người viết script:

- **Chỉ con số đếm, tổng, nhãn trạng thái, kết luận.** Không bao giờ tên, SĐT, email, địa chỉ,
  tiêu đề case, note, lương / % của một người. `tests/ops-log-leak.test.ts` đỏ khi một dòng tóm
  tắt nhắc tới các trường như `name`, `phone`, `title`, `note`, `employeeName`… — nhưng đó chỉ là
  lưới thô, không thay người review.
- Viết tiền tố **tại chỗ** trong script, không import từ `lib/`: ops lấy script từ `main` còn
  `lib/` từ ảnh đang chạy, nên một tệp `lib/` mới làm script chết `MODULE_NOT_FOUND` cho tới lần
  deploy sau.
- Thao tác MỚI in dữ liệu cá nhân: thêm tên vào `OPS_THAO_TAC_MA_HOA`, bọc lệnh chạy bằng
  `ma_hoa_ket_qua` (soát ô arg bằng `kiem_arg` TRƯỚC), rồi cập nhật bảng mục 6 của tài liệu sự cố.
  Thao tác mới chỉ in số tổng hợp: khai một dòng lý do ở `KHONG_MA_HOA_DA_RA` trong bài kiểm.
  Thiếu cả hai thì bài kiểm đỏ.
