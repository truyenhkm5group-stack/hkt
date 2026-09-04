# Triển khai lên VPS với tên miền erp.vnxcommerce.com (Docker + HTTPS tự động)

Bộ triển khai gồm `docker-compose.prod.yml` (PostgreSQL, ERP, scheduler, Caddy) và `scripts/install-vps.sh` (cài mọi thứ bằng một lệnh). Caddy tự xin và tự gia hạn chứng chỉ Let's Encrypt.

## 0. Cần chuẩn bị

| Thứ cần | Ghi chú |
|---|---|
| VPS | Đang dùng Vietnix `mr.truyen-vpscode`, IP `14.225.198.146`, 2 vCPU · 2 GB RAM · 40 GB. Cần mật khẩu root (email Vietnix gửi khi tạo VPS) hoặc dùng Console trên trang Vietnix. |
| Tên miền `vnxcommerce.com` (name.com) | Sẽ dùng tên miền con `erp.vnxcommerce.com`. |
| API key Pancake, token bí mật Viettel Post | Và tài khoản đối tác Viettel Post (SĐT + mật khẩu) để dự phòng. |

## 1. Trỏ DNS trên name.com (làm trước, DNS cần vài phút để lan)

1. Đăng nhập https://www.name.com → **My Domains** → `vnxcommerce.com` → **DNS Records**.
2. **Add Record**: Type `A` · Host `erp` · Answer `14.225.198.146` · TTL `300` → Add Record.
3. Kiểm tra: trên máy bất kỳ chạy `nslookup erp.vnxcommerce.com` phải ra `14.225.198.146` (hoặc mở https://dnschecker.org, gõ `erp.vnxcommerce.com`).

Nếu name.com đang bật "Name.com Nameservers" mặc định thì làm như trên là đủ. Nếu tên miền đang dùng nameserver khác (Cloudflare…), thêm bản ghi A ở nơi đó.

## 2. Cài đặt bằng một lệnh

Mở **Console** của VPS trên trang Vietnix (hoặc SSH `ssh root@14.225.198.146`), rồi dán:

```bash
curl -fsSL https://raw.githubusercontent.com/truyenhkm5group-stack/hkt/claude/fashion-erp-poscake-viettelpost-u97pgx/scripts/bootstrap.sh | bash
```

Lệnh này tải mã nguồn về `/root/erp` rồi chạy `scripts/install-vps.sh`. Chạy lại cùng lệnh sau này = cập nhật phiên bản mới.

Script sẽ:

1. Cài Docker + Compose nếu chưa có, mở cổng 80/443 trên ufw.
2. Hỏi tên miền, API key Pancake, Shop ID, token và tài khoản Viettel Post, email/mật khẩu quản trị → ghi `.env` với các khoá bí mật ngẫu nhiên (`AUTH_SECRET`, `CRON_SECRET`, `POSTGRES_PASSWORD`, secret webhook).
3. So IP máy chủ với DNS của tên miền và nhắc nếu chưa trỏ đúng.
4. Build và chạy 4 container, chờ ERP sẵn sàng, chạy `check:integrations` để xác nhận API key.
5. In ra địa chỉ ERP, tài khoản đăng nhập và **2 URL webhook** để dán vào Pancake / Viettel Post.

Muốn chạy không cần nhập tay:

```bash
export ERP_DOMAIN=erp.vnxcommerce.com PANCAKE_API_KEY=... PANCAKE_SHOP_ID=408063069 \
  VIETTELPOST_API_KEY=... VIETTELPOST_USERNAME=0886833448 VIETTELPOST_PASSWORD='...' \
  ADMIN_EMAIL=admin@vnxcommerce.com ADMIN_PASSWORD='...'
curl -fsSL https://raw.githubusercontent.com/truyenhkm5group-stack/hkt/claude/fashion-erp-poscake-viettelpost-u97pgx/scripts/bootstrap.sh | bash
```

## 2b. Cách khác: triển khai bằng GitHub Actions (không cần mở console VPS)

Workflow `.github/workflows/deploy-vps.yml` để máy chạy của GitHub SSH vào VPS và chạy `bootstrap.sh`. Thiết lập một lần tại GitHub → repo `hkt` → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Giá trị |
|---|---|
| `VPS_HOST` | `14.225.198.146` |
| `VPS_PASSWORD` | mật khẩu root của VPS (Vietnix gửi qua email; hoặc đặt lại trong trang quản lý VPS) — hoặc dùng `VPS_SSH_KEY` |
| `PANCAKE_API_KEY` | API key Pancake |
| `VIETTELPOST_API_KEY` | token bí mật Viettel Post |
| `VIETTELPOST_USERNAME` / `VIETTELPOST_PASSWORD` | tài khoản đối tác Viettel Post |
| `ADMIN_PASSWORD` | mật khẩu đăng nhập ERP ban đầu |

Tuỳ chọn ở tab **Variables**: `ERP_DOMAIN` (mặc định `erp.vnxcommerce.com`), `ADMIN_EMAIL` (mặc định `admin@vnxcommerce.com`), `VPS_USER`, `VPS_PORT`.

Chạy: tab **Actions → Deploy ERP to VPS → Run workflow**. Chạy lại bất cứ lúc nào để cập nhật phiên bản; tick `reset_env` nếu muốn tạo lại `.env` từ Secrets.

## 3. Sau khi lên

1. Mở https://erp.vnxcommerce.com → đăng nhập → *Người dùng* đổi mật khẩu, tạo tài khoản nhân viên theo vai trò.
2. *Kết nối dữ liệu* → *Kiểm tra kết nối* (cả hai) → *Đồng bộ toàn bộ Pancake (lịch sử)* → sau đó *Trạng thái vận đơn Viettel Post* và *Nhập vận đơn từ Viettel Post*.
3. Bật webhook Pancake và Viettel Post theo `docs/CHECKLIST-DONG-BO-REALTIME.md` (mục 3, 4).
4. Sao lưu hằng ngày (thêm vào `crontab -e`):
   ```
   0 3 * * * cd /root/erp && docker compose -f docker-compose.prod.yml exec -T db pg_dump -U erp erp | gzip > /root/backup-$(date +\%F).sql.gz
   ```

## 4. Vận hành

```bash
cd ~/erp
docker compose -f docker-compose.prod.yml logs -f app        # log ERP
docker compose -f docker-compose.prod.yml logs -f caddy      # log HTTPS/chứng chỉ
docker compose -f docker-compose.prod.yml ps                 # trạng thái container
git pull && docker compose -f docker-compose.prod.yml up -d --build   # cập nhật phiên bản
```

Migration cơ sở dữ liệu tự chạy khi container `app` khởi động.

## 5. Sự cố thường gặp

| Hiện tượng | Xử lý |
|---|---|
| Trình duyệt báo "không an toàn" / Caddy log "obtaining certificate" lặp | DNS chưa trỏ đúng IP hoặc cổng 80/443 bị chặn ở tường lửa của nhà cung cấp VPS (Security Group). Sửa xong Caddy tự thử lại. |
| `check:integrations` ✗ Pancake 403 | API key sai hoặc không có quyền với shop 408063069 → tạo key mới, sửa `.env`, `docker compose -f docker-compose.prod.yml up -d`. |
| ✗ Viettel Post không lấy được token | Tạo token mới trên viettelpost.vn hoặc kiểm tra tài khoản đối tác; xem log để biết cách nào thất bại. |
| Webhook Viettel Post không về | Chưa được Viettel Post duyệt; trong lúc chờ, job `vtp-tracking` cập nhật mỗi 10 phút. |

## 6. Tuỳ chọn: Vercel + Neon/Supabase

Ứng dụng là Next.js chuẩn nên có thể deploy lên Vercel: đặt `DATABASE_URL` trỏ tới Postgres (Neon/Supabase), chạy `npx drizzle-kit migrate` một lần, dùng Vercel Cron gọi `GET https://<domain>/api/sync/pancake-orders?secret=<CRON_SECRET>` (và các job khác) thay cho service `scheduler`. Lưu ý giới hạn thời gian chạy mỗi request; đồng bộ lịch sử lớn nên chạy bằng `npm run sync` từ máy khác trỏ cùng `DATABASE_URL`.
