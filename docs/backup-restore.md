# Sao lưu & khôi phục ERP — runbook

Một tệp làm mọi việc: `scripts/erp-backup.sh`. Cron, ops `backup` / `backup-status` / `restore-drill`
và `install-vps.sh` đều gọi nó — không nơi nào tự viết một `pg_dump`.

## 1. Tóm tắt

| Việc | Ở đâu | Ghi chú |
|---|---|---|
| Lịch | `/etc/cron.d/erp-backup` — cron gọi **phút 17 mỗi giờ** | script tự chỉ chạy trong khung **02:00–05:59 giờ VN**, mỗi ngày đúng một bản; lượt hỏng lúc 02 giờ được thử lại lúc 03, 04, 05 giờ |
| Cài lịch | `install-vps.sh` gọi `erp-backup.sh install-cron` ở **mọi lần deploy** (idempotent) | không cần `crontab -e` tay nữa |
| CSDL | `pg_dump -Fc` (nén sẵn, khôi phục chọn lọc được) → `erp-YYYYmmdd-HHMM.dump` | kiểm toàn vẹn: kích thước > 0 **và** `pg_restore --list` đọc được, mục lục phải có dữ liệu `orders` + `shipments` — hỏng thì xoá bản hỏng |
| Bot chat | volume `chatbot_data` (tên thật `<dự án>_chatbot_data`, hỏi container `erp-chatbot` xem gắn gì ở `/data`) → `chatbot-YYYYmmdd-HHMM.tar.gz` | gắn CHỈ-ĐỌC vào container dùng một lần, không mạng |
| Nơi lưu trên máy | `/root/backups/daily/` (cron) · `/root/backups/weekly/` (Chủ nhật, liên kết cứng) · `/root/backups/manual/` (ops `backup`) | thư mục 700 — trong đó có dữ liệu khách hàng và **khoá của bot** |
| Xoay vòng | **7 bản ngày + 4 bản tuần + 3 bản tay** | khai MỘT chỗ ở đầu `scripts/erp-backup.sh` (`GIU_BAN_*`) |
| Ổ đĩa | kiểm **TRƯỚC** khi dump: cần ≥ ước lượng (2 × bản gần nhất) + **3.000 MB dự trữ** | dự trữ = đúng cổng ổ đĩa của deploy; thiếu thì KHÔNG dump và báo lỗi |
| Chạy chồng | `flock` — FD 7 `erp-backup.lock` (không chờ) → FD 8 `erp-readonly-db.lock` (độc quyền) → FD 9 `erp-lifecycle.lock` (chia sẻ) | cùng ổ khoá với `ops-vps.yml` và deploy: sao lưu không chạy giữa lúc deploy dựng lại container |
| Ngoài máy | Google Drive, **mã hoá phía VPS** (`rclone crypt`) — `rclone copyto gcrypt:<daily\|weekly\|manual>/…`, đọc lại kích thước ở đầu kia, dọn theo tuổi | cấu hình đi qua GitHub Secrets/Variables + deploy, **không SSH** (mục 5) · **chưa khai ⇒ trạng thái ghi rõ `CHƯA CÓ BẢN SAO NGOÀI MÁY`** · khôi phục: mục 6 |
| Cấu hình ngoài máy | `/root/.config/erp-backup/offsite.env` (thư mục 700, tệp 600) — `erp-backup.sh configure-offsite` dựng lại ở mỗi lần deploy | **không** nằm trong `/root/erp/.env`: compose nạp `.env` vào container app/scheduler, còn token Drive và mật khẩu giải mã không có việc gì ở đó |
| Trạng thái | `/root/backups/status/last-run.json` · `last-success.json` · `last-drill.json` | ERP mount thư mục này CHỈ-ĐỌC (`/erp-backup-status`) và hiện ở **Kết nối dữ liệu → Sao lưu dữ liệu** và **Phòng Tech** |
| Log | `/var/log/erp-backup.log` (logrotate hằng tuần) | |

### ERP chấm thế nào (`lib/constants/backup.ts::evaluateBackupHealth`)

**Đang chạy tốt** chỉ khi đủ năm vế: bản CSDL thành công trong **36 giờ** · lượt gần nhất không hỏng ·
có bản **ngoài máy** · dữ liệu bot được sao lưu · **diễn tập khôi phục** đạt trong **35 ngày**.

| Tình huống | Mức |
|---|---|
| Máy không mount thư mục trạng thái (dev, bản chạy thử) | Chưa đủ căn cứ |
| Chưa có bản nào · bản mới nhất cũ hơn 36 giờ · diễn tập gần nhất THẤT BẠI | Không nhận được dữ liệu (đỏ) |
| Chưa có bản ngoài máy · lượt gần nhất hỏng · bot chưa sao lưu · chưa từng / quá 35 ngày chưa diễn tập | Chạy nhưng có lỗi (vàng) |

Không vế nào tự "nâng" được lên xanh khi thiếu bằng chứng: một bản sao lưu nằm trên chính cái máy nó
bảo vệ, hay chưa từng khôi phục thử, là một lời hứa chứ chưa phải một bản sao lưu.

## 2. Thao tác hằng ngày (Actions → "Vận hành ERP trên VPS")

| Thao tác | Làm gì | Làn khoá |
|---|---|---|
| `backup-status` | in lịch cron, ba tệp trạng thái, danh sách bản trên máy, ổ đĩa, tình trạng ngoài máy (thư mục Drive, có token / có mã hoá hay không, danh sách bản trên Drive theo tên đã giải mã) — **không in dữ liệu, không in khoá** | đọc nhẹ |
| `backup` | sao lưu NGAY vào `manual/` (cùng luật với cron) | đọc nặng |
| `restore-drill` | diễn tập khôi phục (mục 4) | đọc nặng |

## 3. Khôi phục toàn phần — từng bước

> Làm trên VPS (SSH). Mỗi bước đọc kết quả rồi mới sang bước sau. Khôi phục GHI ĐÈ CSDL production —
> AGENTS.md mục 7: cần chủ shop đồng ý trước.

1. **Chọn bản.** `bash /root/erp/scripts/erp-backup.sh status` → lấy bản mới nhất còn tốt trong
   `/root/backups/{daily,weekly,manual}/`. Bản trên máy mất / hỏng thì lấy từ Google Drive theo
   **mục 6** (`rclone copy gcrypt:daily/erp-YYYYmmdd-HHMM.dump /root/restore/`, và `chatbot-…tar.gz` cùng mốc).
2. **Diễn tập trước trên chính bản đó** nếu còn thời gian: đặt tệp vào `/root/backups/manual/` rồi chạy
   ops `restore-drill` (nó lấy bản có mốc mới nhất) — số đếm bảng phải hợp lý.
3. **Dừng mọi thứ ghi vào CSDL**, giữ lại `db`:
   `cd /root/erp && docker compose -f docker-compose.prod.yml stop app scheduler chatbot`
4. **Sao lưu trạng thái hiện tại** (dù hỏng) để có đường lui: `bash scripts/erp-backup.sh run`.
   Nếu CSDL chết hẳn thì bỏ qua bước này.
5. **Khôi phục CSDL** (xoá sạch rồi nạp lại, trong một phiên):
   ```bash
   docker exec -i erp-db psql -U erp -d postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='erp' and pid<>pg_backend_pid();"
   docker exec -i erp-db dropdb -U erp erp
   docker exec -i erp-db createdb -U erp -O erp erp
   docker exec -i erp-db pg_restore -U erp -d erp --no-owner --no-privileges < /root/backups/daily/erp-YYYYmmdd-HHMM.dump
   ```
   `pg_restore` báo lỗi thì DỪNG, đọc lỗi — không khởi động app trên một CSDL nạp dở.
   Máy mới hoàn toàn: chạy `bootstrap.sh`/deploy trước để có container `erp-db`, rồi làm bước 5.
6. **Khôi phục dữ liệu bot chat:**
   ```bash
   VOL=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' erp-chatbot)
   docker run --rm --network none -v "$VOL:/data" -v /root/backups/daily:/in:ro postgres:16-alpine \
     sh -c 'rm -rf /data/* && tar xzf /in/chatbot-YYYYmmdd-HHMM.tar.gz -C /data'
   ```
7. **Khởi động lại:** `docker compose -f docker-compose.prod.yml up -d` → chờ `/api/health` → chạy
   ops `verify`. Migration mới hơn bản sao lưu tự áp khi app khởi động.
8. **Kéo lại phần hụt** từ lúc sao lưu tới lúc sự cố: Kết nối dữ liệu → đồng bộ Pancake / Viettel Post
   (các luồng nạp là idempotent). Ghi lại mốc bản đã dùng và khoảng dữ liệu phải kéo lại.

Khôi phục **chọn lọc** một bảng (vd lỡ tay xoá chi phí): `pg_restore --list` lấy mục của bảng, rồi
`pg_restore -d <CSDL tạm> -t expenses` vào một CSDL tạm để đối chiếu — không nạp thẳng đè production.

## 4. Diễn tập khôi phục (`ops restore-drill`) — mỗi tháng một lần

1. Lấy bản `erp-*.dump` có mốc mới nhất trong ba thư mục.
2. Kiểm tài nguyên TRƯỚC khi dựng gì: RAM dùng được ≥ 700 MB, ổ đĩa ≥ dung lượng CSDL + 3.000 MB.
   Thiếu thì **từ chối** và ghi `SKIPPED` kèm lý do (không phải lỗi của bản sao lưu).
3. Dựng container Postgres **tạm**: cùng ảnh với `erp-db`, `--network none` (không mạng, không cổng),
   `--memory 512m`, `--cpus 1`, bản dump gắn chỉ-đọc.
4. `pg_restore` vào container tạm; lỗi ⇒ `FAILED` (ERP chuyển đỏ).
5. Đếm dòng 14 bảng then chốt (orders, order_items, shipments, shipment_events, expenses, users,
   customers, products, product_variants, cod_statement_lines, bank_transactions, stock_receipts,
   payroll_periods, sync_runs) ở bản khôi phục **và** CSDL sống, in SỐ ĐẾM. `CHÊNH` dương nhỏ là bình
   thường (dữ liệu sinh sau lúc dump); bảng thiếu hoặc rỗng trong khi CSDL sống có dòng ⇒ `FAILED`.
6. Xoá container tạm (kể cả khi thất bại giữa chừng). CSDL sống chỉ bị đọc `count(*)`.

Nên chạy vào giờ thấp điểm: máy 2 nhân / ~1,9 GB đang phục vụ người dùng thật.

## 5. HUMAN GATE — bật bản sao ngoài máy trên Google Drive

Chủ shop đã chọn **Google Drive** làm nơi lưu ngoài máy. Cấu hình đi hoàn toàn qua GitHub (Secrets /
Variables) + một lượt deploy — **không ai phải SSH vào VPS**. Bản sao lưu được **mã hoá trên VPS trước
khi rời máy** (`rclone crypt`): Google chỉ thấy byte vô nghĩa và tên tệp vô nghĩa.

Đường đi: GitHub Secrets/Variables → `deploy-vps.yml` (bước SSH) → `install-vps.sh` →
`erp-backup.sh configure-offsite` → `/root/.config/erp-backup/offsite.env` (600) → cron / ops `backup`.

**Bước 1 — lấy token Google Drive** (trên máy Windows có trình duyệt, KHÔNG trên VPS):

1. Mở PowerShell, chạy:
   ```powershell
   C:\Users\Admin\erp-ship\rclone.exe authorize "drive"
   ```
2. Trình duyệt mở trang đăng nhập Google → đăng nhập **đúng tài khoản sở hữu thư mục** sao lưu → bấm
   *Cho phép* (Allow). Trình duyệt báo "Success".
3. Quay lại PowerShell: rclone in ra một khối giữa hai dòng
   `Paste the following into your remote machine --->` và `<---End paste`. Chép **dòng ở giữa** — một
   dòng JSON dạng `{"access_token":"…","token_type":"Bearer","refresh_token":"…","expiry":"…"}`.
   (Lỡ chép thừa hai dòng mũi tên, hoặc bản rclone in dạng base64, deploy vẫn tự nhận ra — nhưng
   **không** được thiếu `refresh_token`.) Đây là chìa khoá vào Google Drive: không dán vào chat, email,
   hay bất cứ đâu ngoài ô Secret.

**Bước 2 — khai trên GitHub** (kho → *Settings* → *Secrets and variables* → *Actions*):

| Tab | Nút | Tên | Giá trị |
|---|---|---|---|
| Secrets | *New repository secret* | `RCLONE_GDRIVE_TOKEN` | dòng JSON ở bước 1 |
| Secrets | *New repository secret* | `RCLONE_CRYPT_PASSWORD` | chuỗi trong tệp `C:\Users\Admin\.erp-ops\backup-crypt.txt` (đã `rclone obscure` sẵn) |
| Secrets | *New repository secret* | `RCLONE_CRYPT_PASSWORD2` | **tuỳ chọn** — salt, cũng phải là chuỗi đã `rclone obscure`; không dùng thì bỏ qua |
| Variables | *New repository variable* | `BACKUP_GDRIVE_FOLDER_ID` | `1v-8padz4pNRsIz36-JngPE4Fi4iutXku` (phần sau `/folders/` trong đường dẫn thư mục Drive) |

ID thư mục đi bằng **Variable**, không ghi vào mã: đổi thư mục chỉ là sửa Variable rồi deploy lại.

> **MẬT KHẨU CRYPT LÀ THỨ DUY NHẤT KHÔNG LẤY LẠI ĐƯỢC.** GitHub không cho đọc lại một Secret đã lưu.
> Mất chuỗi trong `backup-crypt.txt` (và salt, nếu dùng) là **mất mọi bản trên Drive** — chúng chỉ còn
> là byte ngẫu nhiên, không ai (kể cả Google) giải được. Chép chuỗi đó vào trình quản lý mật khẩu
> hoặc in ra giấy cất riêng, TÁCH khỏi VPS. Chuỗi "obscure" KHÔNG phải mã hoá — `rclone reveal` đảo
> ngược được — nên giữ bí mật nó y như mật khẩu gốc. Token (bước 1) thì mất vẫn làm lại được.

**Bước 3 — deploy:** *Actions* → **Deploy ERP to VPS** → *Run workflow* trên `main`. Trong log:

- bước *Kiểm tra Secrets bắt buộc* in `Sao lưu Google Drive: RCLONE_GDRIVE_TOKEN có · RCLONE_CRYPT_PASSWORD có · BACKUP_GDRIVE_FOLDER_ID có`;
- bước SSH in `Google Drive: đã ghi /root/.config/erp-backup/offsite.env (600) — thư mục …, remote gcrypt: (crypt) → gdrive:erp-backup · token N ký tự · mật khẩu crypt M ký tự (không in giá trị)`,
  rồi `đã khai BACKUP_OFFSITE_REMOTE — cài rclone` (chỉ lần đầu).

Thiếu một trong ba thứ bắt buộc thì deploy vẫn xanh nhưng in `::warning:: … Google Drive: THIẾU <tên>
— KHÔNG ghi cấu hình mới` — nó **không** dựng một cấu hình dở, và cấu hình cũ (nếu có) giữ nguyên.
Giá trị sai dạng (token không có `refresh_token`, ID là cả đường dẫn, mật khẩu chưa obscure) cũng bị
từ chối kèm cảnh báo. Log không bao giờ in giá trị, chỉ in độ dài.

**Bước 4 — chạy thử:** *Actions* → **Vận hành ERP trên VPS** → `backup`. Log phải có
`ngoài máy: đã đẩy erp-…dump (… byte) → gcrypt:…/manual/` và `KẾT QUẢ: OK · … · ngoài máy OK`. Rồi
chạy `backup-status`: mục *Ngoài máy* liệt kê bản trên Drive (tên đã giải mã, kèm kích thước). Trang
**Kết nối dữ liệu → Sao lưu dữ liệu** hết cảnh báo `CHƯA CÓ BẢN SAO NGOÀI MÁY` ngay sau lượt thành
công đầu tiên (nó đọc `offsite.state` của bản thành công gần nhất). Trên Google Drive sẽ thấy thư mục
`erp-backup` trong thư mục đã chọn, bên trong là các thư mục/tệp tên ngẫu nhiên — đó là đúng.

**Cần biết về Google Drive:**

- **Dung lượng:** ~11 bản đang giữ (7 ngày + 4 tuần; bản tay giữ ≤ 8 ngày) × ~70 MB ≈ 0,8 GB. Tệp bị
  dọn đi vào **thùng rác** của Drive và Drive tự xoá hẳn sau 30 ngày, nên thực tế chiếm thêm tới
  ~30 bản ngày trong thùng rác (≈ 2–3 GB). Vẫn nằm trong 15 GB miễn phí; thùng rác là lưới an toàn khi
  một lệnh xoá sai.
- **Giới hạn tốc độ:** token lấy bằng client ID mặc định của rclone — dùng chung với mọi người dùng
  rclone trên thế giới, nên thỉnh thoảng Google trả `rateLimitExceeded`. rclone tự thử lại; lượt nào
  vẫn hỏng thì ghi `ngoài máy FAILED` (ERP báo vàng) và đêm sau thử lại. Hỏng thường xuyên thì tạo
  client ID riêng trên Google Cloud Console rồi `rclone authorize "drive" <client_id> <client_secret>`
  (việc này cần thêm hai Secret — hỏi phiên kỹ sư).
- **Token hết hiệu lực** khi đổi mật khẩu Google, gỡ quyền của rclone trong tài khoản Google, hoặc
  không dùng 6 tháng. Dấu hiệu: `backup` báo `rclone copyto lỗi … invalid_grant`. Sửa: làm lại bước 1,
  cập nhật Secret `RCLONE_GDRIVE_TOKEN`, deploy lại. Mật khẩu crypt KHÔNG đổi — đổi nó là mất khả năng
  đọc các bản cũ.

Script chỉ `rclone copyto` (không bao giờ `rclone sync` — sync sẽ xoá bản ngoài máy khi bản trên máy
mất, đúng thứ bản ngoài máy sinh ra để giữ), đọc lại kích thước ở đầu kia, rồi dọn bản cũ theo tuổi
suy từ `GIU_BAN_*` — và chỉ dọn sau một lượt đẩy thành công.

Cấu hình tay kiểu cũ (`BACKUP_OFFSITE_REMOTE` + `RCLONE_CONFIG_*` trong `/root/erp/.env`, hoặc
`rclone config` trên VPS) vẫn được đọc, nhưng tệp do deploy dựng **thắng** nó.

**Các quyết định khác cần chủ shop:** xoá các bản tay kiểu cũ `/root/backups/erp-*.sql.gz` (script
không tự xoá, `backup-status` in số lượng và dung lượng) · đổi khung giờ / số bản giữ (sửa hằng số ở
đầu `scripts/erp-backup.sh`).

## 6. Khôi phục từ Google Drive

**Cần có** (thiếu thứ nào thì dừng ở đó):

1. **Mật khẩu crypt GỐC** — chuỗi obscure trong `backup-crypt.txt` (+ salt nếu đã khai
   `RCLONE_CRYPT_PASSWORD2`). **Mất là mất bản sao** — không có đường vòng nào.
2. **Quyền vào Google Drive**: hoặc VPS còn sống (token nằm sẵn trong `offsite.env`), hoặc đăng nhập
   lại Google trên máy có trình duyệt (tài khoản sở hữu thư mục).
3. **ID thư mục**: Variable `BACKUP_GDRIVE_FOLDER_ID` (đọc lại được trên GitHub).

**A. VPS còn sống** (bản trên máy mất/hỏng, cấu hình ngoài máy còn): cấu hình dựng từ
`/root/.config/erp-backup/offsite.env` — đúng thứ cron dùng, nạp qua chính hàm của script (nó giải
mã token base64; `source` thẳng tệp thì KHÔNG được):

```bash
cd /root/erp
bash -c 'source scripts/erp-backup.sh; nap_cau_hinh; rclone lsf --format sp --separator " " gcrypt:daily/'
mkdir -p /root/restore
bash -c 'source scripts/erp-backup.sh; nap_cau_hinh; rclone copy gcrypt:daily/erp-YYYYmmdd-HHMM.dump /root/restore/ && rclone copy gcrypt:daily/chatbot-YYYYmmdd-HHMM.tar.gz /root/restore/'
```

(`weekly/` và `manual/` cũng nằm dưới `gcrypt:`.) Rồi làm tiếp **mục 3 từ bước 2**, thay
`/root/backups/daily/…` bằng `/root/restore/…`.

**B. Máy mới hoàn toàn / VPS mất hẳn** — dựng cấu hình rclone tay.

*B1. Trên máy Windows có trình duyệt* (`C:\Users\Admin\erp-ship\rclone.exe`, PowerShell):

```powershell
$r = "C:\Users\Admin\erp-ship\rclone.exe"
& $r config create gdrive drive scope=drive root_folder_id=<BACKUP_GDRIVE_FOLDER_ID>
#   ↑ mở trình duyệt đăng nhập Google (tài khoản sở hữu thư mục).
& $r config create gcrypt crypt remote=gdrive:erp-backup filename_encryption=standard password=<chuỗi obscure trong backup-crypt.txt> --no-obscure
#   ↑ đã khai salt thì thêm password2=<salt obscure>. `--no-obscure` BẮT BUỘC: chuỗi đã obscure sẵn,
#     obscure thêm lần nữa là sai mật khẩu.
& $r lsf gcrypt:daily/
& $r copy gcrypt:daily/erp-YYYYmmdd-HHMM.dump .\restore\
```

*B2. Trên VPS mới (không có trình duyệt)* — lấy token bằng `rclone authorize "drive"` trên máy Windows
(như mục 5, bước 1), rồi khai bằng biến môi trường, đúng cơ chế cron dùng (`apt-get install -y rclone`
trước):

```bash
export RCLONE_CONFIG_GDRIVE_TYPE=drive RCLONE_CONFIG_GDRIVE_SCOPE=drive
export RCLONE_CONFIG_GDRIVE_ROOT_FOLDER_ID='<BACKUP_GDRIVE_FOLDER_ID>'
export RCLONE_CONFIG_GDRIVE_TOKEN='<dòng JSON token>'          # nháy ĐƠN: JSON có dấu "
export RCLONE_CONFIG_GCRYPT_TYPE=crypt RCLONE_CONFIG_GCRYPT_REMOTE=gdrive:erp-backup
export RCLONE_CONFIG_GCRYPT_FILENAME_ENCRYPTION=standard
export RCLONE_CONFIG_GCRYPT_PASSWORD='<chuỗi obscure>'         # (+ RCLONE_CONFIG_GCRYPT_PASSWORD2 nếu có salt)
rclone lsf gcrypt:daily/
mkdir -p /root/restore && rclone copy gcrypt:daily/erp-YYYYmmdd-HHMM.dump /root/restore/
```

Hoặc gọn hơn: khai lại đủ Secrets/Variable trên GitHub như mục 5 và deploy lên VPS mới — deploy tự
dựng `offsite.env`, rồi làm theo **A**.

Tên tệp liệt kê ra đọc được (`erp-20260925-0217.dump`) ⇒ mật khẩu đúng. Mật khẩu sai thì `lsf` trả
rỗng hoặc báo lỗi giải mã — KHÔNG phải "Drive trống". Có tệp `.dump` rồi thì: dựng ERP trên máy mới
(deploy), rồi **mục 3 từ bước 5** (nạp CSDL) và bước 6 (bot chat). Nếu còn thời gian, diễn tập trước
(mục 4) bằng cách đặt tệp vào `/root/backups/manual/`.

Đã đo trên rclone v1.75 (crypt bọc một thư mục cục bộ thay cho Drive, 25/09/2026): đẩy bằng đúng
`day_ngoai_may` → đọc lại kích thước qua crypt khớp → quy trình B (`config create … --no-obscure`)
giải ra tệp **khớp từng byte** với bản gốc.
