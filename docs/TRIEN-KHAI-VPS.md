# Triển khai lên VPS (Docker + HTTPS)

Cấu hình tối thiểu: VPS Ubuntu 22.04/24.04, 2 vCPU, 2 GB RAM, 20 GB ổ cứng; một tên miền (ví dụ `erp.tenshop.vn`) trỏ bản ghi A về IP VPS.

## 1. Cài Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker
```

## 2. Tải mã nguồn & cấu hình

```bash
mkdir -p ~/erp && cd ~/erp
# giải nén shop-control-erp.zip vào đây (hoặc git clone)
cp .env.example .env
nano .env
```

Trong `.env` đặt: `APP_URL=https://erp.tenshop.vn`, `AUTH_SECRET`, `CRON_SECRET`, các API key, secret webhook. Không cần sửa `DATABASE_URL` (Compose tự đặt).

## 3. Reverse proxy HTTPS bằng Caddy

Tạo file `docker-compose.override.yml`:

```yaml
services:
  app:
    ports: []            # không mở 3000 ra ngoài
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
    depends_on: [app]
volumes:
  caddy_data:
```

và file `Caddyfile`:

```
erp.tenshop.vn {
  reverse_proxy app:3000
}
```

Caddy tự xin chứng chỉ Let's Encrypt. Khởi chạy:

```bash
docker compose up -d --build
docker compose logs -f app      # xem log khởi động, migration, tạo tài khoản
```

## 4. Sau khi lên

1. Đăng nhập https://erp.tenshop.vn, đổi mật khẩu quản trị, tạo tài khoản cho nhân viên (Người dùng).
2. *Kết nối dữ liệu* → Kiểm tra kết nối → *Đồng bộ toàn bộ Pancake (lịch sử)*.
3. Cấu hình webhook Pancake và Viettel Post theo URL hiển thị trên trang Kết nối dữ liệu; gửi yêu cầu duyệt webhook cho Viettel Post.
4. Sao lưu hằng ngày:
   ```bash
   docker compose exec -T db pg_dump -U erp erp | gzip > backup-$(date +%F).sql.gz
   ```

## 5. Cập nhật phiên bản

```bash
docker compose build app scheduler && docker compose up -d
```

Migration được áp dụng tự động khi container `app` khởi động (`drizzle-kit migrate`).

## 6. Tuỳ chọn: Vercel + Neon/Supabase

Ứng dụng là Next.js chuẩn nên có thể deploy lên Vercel: đặt `DATABASE_URL` trỏ tới Postgres (Neon/Supabase), chạy `npx drizzle-kit migrate` một lần, dùng Vercel Cron gọi `GET https://<domain>/api/sync/pancake-orders?secret=<CRON_SECRET>` (và các job khác) thay cho service `scheduler`. Lưu ý giới hạn thời gian chạy của mỗi request (đặt `maxDuration` phù hợp gói Vercel); đồng bộ lịch sử lớn nên chạy bằng `npm run sync` từ máy khác trỏ cùng DATABASE_URL.
