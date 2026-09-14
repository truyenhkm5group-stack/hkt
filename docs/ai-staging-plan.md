# Kế hoạch chạy thử nhánh nhân sự AI tách khỏi production — ĐỀ XUẤT, chưa thực hiện

> **Chưa triển khai gì cả.** Tài liệu này là bản đề xuất để chủ shop duyệt trước.
>
> **Đã có bản hiện thực hoá:** `docs/ai-staging-runbook.md` — sổ tay vận hành của bộ dựng
> thật trong kho mã (`docker-compose.staging.yml`, `scripts/staging-preflight.sh`,
> `scripts/staging-up.sh`). Danh tính chốt lại khác đề xuất ở ba chỗ: thư mục
> `/opt/vnx-ai-staging` (không phải `/root/erp-ai-staging`), project `vnx-ai-staging`
> (không phải `erp-ai`), và **chạy trên localhost trước**, chỉ thêm Caddy sau khi mọi thứ
> đã xanh. Đọc sổ tay để thi hành; đọc tệp này để biết vì sao lại chọn như vậy.

## 1. Hiện trạng triển khai

| Thành phần | Hiện tại |
|---|---|
| Quy trình | GitHub Actions **Deploy ERP to VPS**, chạy tay (`workflow_dispatch`) |
| Nhánh triển khai | `ERP_BRANCH: github.ref_name` — **deploy đúng nhánh đang bấm** |
| Thư mục trên VPS | `/root/erp` (`ERP_DIR`) |
| Compose | `docker-compose.prod.yml`, tên container **cố định**: `erp-app` · `erp-db` · `erp-scheduler` · `erp-caddy` |
| Cổng | Caddy giữ 80/443, tự xin chứng chỉ cho `ERP_DOMAIN` |
| CSDL | Volume `erp_pgdata`, một CSDL `erp` duy nhất |

### Vì sao KHÔNG được bấm workflow hiện tại trên nhánh này

`ERP_BRANCH` lấy từ nhánh đang bấm, thư mục và tên container thì cố định. Bấm **Deploy ERP to VPS**
trên `claude/ai-workforce-sales-v1` sẽ **kéo nhánh này vào chính `/root/erp` và dựng lại đúng các
container đang chạy thật** — tức là thay production bằng nhánh chưa duyệt. Đây là lý do phiên này
không chạy deploy.

## 2. Đề xuất: một ngăn xếp thứ hai, tách hoàn toàn

Ý tưởng: cùng một VPS, một **compose project** riêng, tên container riêng, CSDL riêng, tên miền
riêng. Không sửa gì trong ngăn xếp đang chạy.

```
/root/erp            ← production, KHÔNG ĐỤNG
/root/erp-ai-staging ← bản chạy thử, nhánh claude/ai-workforce-sales-v1
```

| Thành phần | Production | Chạy thử |
|---|---|---|
| Compose project | mặc định | `-p erp-ai` |
| Container | `erp-app`, `erp-db`, … | `erp-ai-app`, `erp-ai-db`, `erp-ai-scheduler` |
| Tên miền | `erp.vnxcommerce.com` | `ai-staging.vnxcommerce.com` |
| CSDL | volume `erp_pgdata` | volume `erp_ai_pgdata` **riêng** |
| Cổng ra ngoài | Caddy 80/443 | **không mở cổng nào** — dùng chung Caddy của production |
| Scheduler | đang chạy | **TẮT** |

### 2.1 Vì sao dùng chung Caddy chứ không dựng Caddy thứ hai

Cổng 80/443 chỉ có một bộ. Một Caddy thứ hai sẽ không khởi động được, hoặc tệ hơn, tranh cổng với
Caddy đang phục vụ khách. Thêm một khối vào Caddyfile là thay đổi **cộng thêm**, và quay lui bằng
cách xoá đúng khối đó.

```caddyfile
# Thêm vào cuối deploy/Caddyfile — KHÔNG sửa khối {$ERP_DOMAIN} đang có
ai-staging.vnxcommerce.com {
	encode gzip zstd
	reverse_proxy erp-ai-app:3000 {
		flush_interval -1
		transport http { read_timeout 0 }
	}
	# Bản chạy thử: chặn mọi công cụ dò tìm, và nói rõ đây không phải production
	header {
		X-Robots-Tag "noindex, nofollow"
		X-Environment "ai-staging"
	}
	basic_auth {
		# sinh bằng: docker run --rm caddy caddy hash-password --plaintext '<mật khẩu>'
		staging <chuỗi băm>
	}
}
```

Caddy và app staging phải cùng mạng Docker — khai `networks` chung trong compose staging.

### 2.2 CSDL: nên tách hẳn

Hai lựa chọn, khuyến nghị lựa chọn A:

**A. CSDL trắng (khuyến nghị).** Container `erp-ai-db` riêng, volume riêng. Sạch sẽ, không cách nào
chạm dữ liệu thật, xoá là xong.
*Đánh đổi:* không có sản phẩm / tồn / đơn thật, nên `product.search`, `pricing.get`,
`inventory.check` trả rỗng — chưa đo được chất lượng nhận diện sản phẩm.

**B. Bản sao production.** `pg_dump` từ production, nạp vào CSDL staging.
*Đánh đổi:* có dữ liệu thật để đo, nhưng bản sao mang theo SĐT và địa chỉ khách — phải xử lý như dữ
liệu thật, và bản sao cũ dần.
**Tuyệt đối không** trỏ staging vào CSDL production: nhân sự AI GHI vào `sales_*` và `ai_*`, và dù
các bảng đó là bảng mới, một sai sót cấu hình ở staging sẽ ghi vào cùng CSDL đang phục vụ khách.

### 2.3 Biến môi trường của bản chạy thử

```
# Bắt buộc khác production
DATABASE_URL=postgresql://erp:<mật khẩu riêng>@erp-ai-db:5432/erp?schema=public
APP_URL=https://ai-staging.vnxcommerce.com
AUTH_SECRET=<chuỗi ngẫu nhiên RIÊNG>   # dùng chung = phiên đăng nhập dùng chéo được
CRON_SECRET=<chuỗi ngẫu nhiên RIÊNG>

# Nhân sự AI — nấc an toàn
AI_DEFAULT_MODE=SHADOW
AI_MODEL_CALLS_ENABLED=false           # bật sau, khi đã có khoá và bảng giá
PANCAKE_CHAT_WEBHOOK_SECRET=<bí mật RIÊNG, khác production>

# PHẢI để trống / không khai trên bản chạy thử
VIETTELPOST_API_KEY=
VIETTELPOST_WEBHOOK_SECRET=
FACEBOOK_ACCESS_TOKEN=
PANCAKE_WEBHOOK_SECRET=                # webhook ĐƠN HÀNG: không cho staging nhận
```

Ba dòng cuối quan trọng: staging **không** được nhận webhook đơn hàng và **không** được gọi Viettel
Post. Nó chỉ cần đọc hội thoại.

`PANCAKE_API_KEY` và `PANCAKE_ACCESS_TOKEN` là **chỉ đọc** trong luồng này, dùng chung được. Nhưng
nếu Pancake cấp được token thứ hai thì nên tách, để thu hồi một cái không ảnh hưởng cái kia.

### 2.4 Scheduler: TẮT

Compose staging **không** dựng service `scheduler`. Hai bộ lập lịch cùng gọi Pancake sẽ tăng gấp
đôi lưu lượng và làm rối chẩn đoán. Chạy job ở staging bằng tay trên trang Kết nối dữ liệu.

## 3. Các bước triển khai (chờ chủ shop duyệt)

1. Trỏ DNS `ai-staging.vnxcommerce.com` → cùng IP VPS.
2. `git clone -b claude/ai-workforce-sales-v1 <repo> /root/erp-ai-staging`.
3. Viết `/root/erp-ai-staging/.env` theo mục 2.3.
4. Thêm `docker-compose.staging.yml` (app + db, **không** scheduler, **không** caddy, cùng mạng với Caddy production).
5. `docker compose -p erp-ai -f docker-compose.staging.yml up -d --build`.
6. Thêm khối Caddy ở mục 2.1 rồi `docker exec erp-caddy caddy reload --config /etc/caddy/Caddyfile`.
7. Kiểm chứng: `https://ai-staging.vnxcommerce.com/api/health` trả `{"ok":true}`; production vẫn khoẻ.
8. Chạy `npm run db:seed` trên staging để có tài khoản quản trị riêng.

**Thời điểm:** làm ngoài giờ bán hàng cao điểm. Bước 6 là bước duy nhất chạm vào thứ đang phục vụ
khách (reload Caddy — không dừng kết nối, nhưng vẫn nên tránh giờ cao điểm).

## 4. Quay lui

| Việc | Lệnh | Ảnh hưởng production |
|---|---|---|
| Dừng staging | `docker compose -p erp-ai down` | Không |
| Xoá hẳn kèm dữ liệu | `docker compose -p erp-ai down -v` | Không |
| Gỡ tên miền | Xoá khối Caddy vừa thêm, reload | Không |
| Xoá mã nguồn | `rm -rf /root/erp-ai-staging` | Không |

Không bước quay lui nào chạm vào `/root/erp`, container `erp-*`, hay volume `erp_pgdata`.

## 5. Phương án nhẹ hơn nếu chưa muốn thêm tên miền

Chạy staging **không mở ra Internet**: bỏ bước Caddy, chỉ ánh xạ cổng về localhost
(`127.0.0.1:3100:3000`) và vào qua SSH tunnel:

```bash
ssh -L 3100:127.0.0.1:3100 root@<vps>
# rồi mở http://localhost:3100
```

Đánh đổi: webhook hội thoại của Pancake **không gọi vào được** (không có URL công khai), nên chỉ
kiểm chứng được đường đọc bù. Với giai đoạn chạy ngầm thì như vậy là đủ, và đây là phương án có ít
bề mặt rủi ro nhất.

## 6. Điều kiện đủ để coi bản chạy thử là thành công

- `/api/health` xanh trên tên miền staging.
- Production không đổi: `https://erp.vnxcommerce.com/api/health` vẫn xanh, container `erp-*` không bị dựng lại.
- Nạp được hội thoại thật và sinh gợi ý.
- **`select count(*) from sales_suggestions where sent` = 0.**
- Số việc trong hàng đợi nhân sự AI của production vẫn bằng 0 (staging không ghi sang production).
