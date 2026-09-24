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
| Ngoài máy | `rclone copyto` tới `BACKUP_OFFSITE_REMOTE`, đọc lại kích thước ở đầu kia, dọn theo tuổi | **chưa khai ⇒ trạng thái ghi rõ `CHƯA CÓ BẢN SAO NGOÀI MÁY`** — xem mục 5 |
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
| `backup-status` | in lịch cron, ba tệp trạng thái, danh sách bản trên máy, ổ đĩa, tình trạng ngoài máy — **không in dữ liệu** | đọc nhẹ |
| `backup` | sao lưu NGAY vào `manual/` (cùng luật với cron) | đọc nặng |
| `restore-drill` | diễn tập khôi phục (mục 4) | đọc nặng |

## 3. Khôi phục toàn phần — từng bước

> Làm trên VPS (SSH). Mỗi bước đọc kết quả rồi mới sang bước sau. Khôi phục GHI ĐÈ CSDL production —
> AGENTS.md mục 7: cần chủ shop đồng ý trước.

1. **Chọn bản.** `bash /root/erp/scripts/erp-backup.sh status` → lấy bản mới nhất còn tốt trong
   `/root/backups/{daily,weekly,manual}/`. Máy mất hẳn thì lấy từ ngoài máy:
   `rclone copy <remote>/daily/erp-YYYYmmdd-HHMM.dump /root/restore/` (và `chatbot-…tar.gz` cùng mốc).
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

## 5. HUMAN GATE — chủ shop quyết

**Chọn dịch vụ lưu trữ ngoài máy** (AGENTS.md mục 7: thêm dịch vụ bên ngoài mới). Kho mã không chọn giùm.
Tiêu chí gợi ý: ở ngoài nhà cung cấp VPS, có khoá truy cập giới hạn quyền, chi phí theo dung lượng
(bản CSDL nén hiện cỡ vài chục – vài trăm MB × 11 bản). Các lựa chọn rclone hỗ trợ: Backblaze B2,
Google Drive, Amazon S3 / S3-tương thích, Cloudflare R2, OneDrive…

**Sau khi chọn, khai trên VPS** (cấu hình rclone nằm trên máy, KHÔNG vào kho — kho này PUBLIC):

1. SSH vào VPS, `apt-get install -y rclone`, rồi `rclone config` tạo một remote (ví dụ tên `ngoai`).
   **Nên bọc thêm một remote `crypt`** (ví dụ `ngoaima`) trỏ vào `ngoai:erp-backup`: bản sao lưu chứa
   dữ liệu khách hàng và khoá của bot; mã hoá ở phía máy chủ nghĩa là nhà cung cấp lưu trữ chỉ thấy
   byte vô nghĩa. Mật khẩu `crypt` cất ở chỗ chủ shop giữ được — mất nó là mất mọi bản ngoài máy.
   Cách khác (kém hơn): khai remote bằng các dòng `RCLONE_CONFIG_<TÊN>_…` trong `/root/erp/.env` —
   script chỉ nạp đúng họ biến này và `BACKUP_OFFSITE_REMOTE`, nhưng `.env` còn được compose nạp vào
   môi trường của container `app`/`scheduler` (`env_file`), tức khoá lưu trữ đi vào nơi không cần nó.
   Ưu tiên `rclone config` (tệp `/root/.config/rclone/rclone.conf`, chỉ root đọc).
2. Thêm vào `/root/erp/.env`: `BACKUP_OFFSITE_REMOTE="ngoaima:"` (hoặc `ngoai:ten-bucket/erp`).
3. Chạy ops `backup` → đọc dòng `ngoài máy: đã đẩy …`, rồi ops `backup-status`. ERP hết cảnh báo
   `CHƯA CÓ BẢN SAO NGOÀI MÁY` sau lượt thành công đầu tiên.

Script chỉ `rclone copyto` (không bao giờ `rclone sync` — sync sẽ xoá bản ngoài máy khi bản trên máy
mất, đúng thứ bản ngoài máy sinh ra để giữ), đọc lại kích thước ở đầu kia, rồi dọn bản cũ theo tuổi
suy từ `GIU_BAN_*` — và chỉ dọn sau một lượt đẩy thành công.

**Các quyết định khác cần chủ shop:** xoá các bản tay kiểu cũ `/root/backups/erp-*.sql.gz` (script
không tự xoá, `backup-status` in số lượng và dung lượng) · đổi khung giờ / số bản giữ (sửa hằng số ở
đầu `scripts/erp-backup.sh`).
