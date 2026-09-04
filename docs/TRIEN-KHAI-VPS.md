# Triển khai lên VPS với tên miền erp.vnxcommerce.com (Docker + HTTPS tự động)

Bộ triển khai gồm `docker-compose.prod.yml` (PostgreSQL, ERP, scheduler, Caddy) và `scripts/install-vps.sh` (cài mọi thứ bằng một lệnh). Caddy tự xin và tự gia hạn chứng chỉ Let's Encrypt.

## 0. Cần chuẩn bị

| Thứ cần | Ghi chú |
|---|---|
| VPS Ubuntu 22.04/24.04 | 2 vCPU · 2 GB RAM · 20 GB SSD là đủ. Gợi ý: Vultr/DigitalOcean (Singapore) hoặc Viettel IDC, VNPT, AZDIGI, Vietnix. Khi tạo chọn "Ubuntu 22.04", lấy **IP public** và mật khẩu root/SSH. |
| Tên miền `vnxcommerce.com` (name.com) | Sẽ dùng tên miền con `erp.vnxcommerce.com`. |
| API key Pancake, token bí mật Viettel Post | Và tài khoản đối tác Viettel Post (SĐT + mật khẩu) để dự phòng. |

## 1. Trỏ DNS trên name.com (làm trước, DNS cần vài phút để lan)

1. Đăng nhập https://www.name.com → **My Domains** → `vnxcommerce.com` → **DNS Records**.
2. **Add Record**: Type `A` · Host `erp` · Answer `<IP public của VPS>` · TTL `300` → Add Record.
3. Kiểm tra: trên máy bất kỳ chạy `nslookup erp.vnxcommerce.com` phải ra IP VPS.

Nếu name.com đang bật "Name.com Nameservers" mặc định thì làm như trên là đủ. Nếu tên miền đang dùng nameserver khác (Cloudflare…), thêm bản ghi A ở nơi đó.

## 2. Cài đặt bằng một lệnh

SSH vào VPS (`ssh root@<IP>`), rồi:

```bash
apt-get update && apt-get install -y git
git clone https://github.com/truyenhkm5group-stack/hkt.git erp && cd erp
sudo bash scripts/install-vps.sh
```

(Repo riêng tư: dùng `git clone https://<token-github>@github.com/truyenhkm5group-stack/hkt.git erp`, hoặc tải zip mã nguồn và giải nén vào `~/erp`.)

Script sẽ:

1. Cài Docker + Compose nếu chưa có, mở cổng 80/443 trên ufw.
2. Hỏi tên miền, API key Pancake, Shop ID, token và tài khoản Viettel Post, email/mật khẩu quản trị → ghi `.env` với các khoá bí mật ngẫu nhiên (`AUTH_SECRET`, `CRON_SECRET`, `POSTGRES_PASSWORD`, secret webhook).
3. So IP máy chủ với DNS của tên miền và nhắc nếu chưa trỏ đúng.
4. Build và chạy 4 container, chờ ERP sẵn sàng, chạy `check:integrations` để xác nhận API key.
5. In ra địa chỉ ERP, tài khoản đăng nhập và **2 URL webhook** để dán vào Pancake / Viettel Post.

Muốn chạy không cần nhập tay:

```bash
ERP_DOMAIN=erp.vnxcommerce.com \
PANCAKE_API_KEY=... PANCAKE_SHOP_ID=408063069 \
VIETTELPOST_API_KEY=... VIETTELPOST_USERNAME=0886833448 VIETTELPOST_PASSWORD='...' \
ADMIN_EMAIL=admin@vnxcommerce.com ADMIN_PASSWORD='...' \
sudo -E bash scripts/install-vps.sh
```

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
