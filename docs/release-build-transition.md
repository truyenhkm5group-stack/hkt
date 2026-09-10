# Đưa việc dựng image ra khỏi máy chủ production

Trạng thái: **kế hoạch, chưa thực hiện.** Bước tạm thời đã làm nằm ở mục 3.

---

## 1. Vì sao

Deploy #208 chết giữa chừng:

```
#13 215.7 Next.js build worker exited with code: null and signal: SIGKILL
target scheduler: failed to solve: process "/bin/sh -c npm run build" ... exit code: 1
```

`SIGKILL` khi `next build` là **hết RAM**. Đo trên máy chủ ngay sau đó:

```
              total   used   free   shared  buff/cache   available
Mem:           1963    542    308      145        1111        1106
Swap:             0      0      0
```

- **Swap = 0.** Không có vùng đệm nào: chạm trần là nhân hệ điều hành giết tiến trình, không có
  bước "chậm dần" nào để kịp nhận ra.
- Bốn container thường trực đã dùng ~500 MB (Postgres 253 · ứng dụng 202 · Caddy 26 · lập lịch 20).
- `docker-compose.prod.yml` khai `build: .` cho **cả `app` lẫn `scheduler`** ⇒ máy chủ dựng hai
  image từ cùng một Dockerfile.

Cùng SHA đó chạy lại ở #209 thì thành công. Nghĩa là **đang ở sát mép** — lần này may.

**"Chạy lại thấy được" không phải giải pháp.** Nó biến một lỗi hạ tầng xác định thành xác suất, và
xác suất đó rơi vào đúng lúc cần phát hành gấp.

## 2. Hướng đúng: máy chủ chỉ KÉO artifact, không biên dịch

```
GitHub Actions                                  VPS
─────────────────────────────────────────────   ─────────────────────────
typecheck · lint · test · build                 (không làm gì)
        ↓
dựng image, gắn nhãn = ĐÚNG SHA đã kiểm
        ↓
đẩy lên registry (ghcr.io)
        ↓                                       docker compose pull <SHA>
                                                chạy migration
                                                khởi động lại
                                                kiểm sức khoẻ
```

Bất biến phải giữ, và nó mạnh hơn hiện tại:

```
SHA đã kiểm  =  SHA của image đã dựng  =  SHA đang chạy
```

Hiện tại bất biến này được giữ bằng cách ghim `git checkout <SHA>` rồi **dựng lại trên máy chủ** —
tức là vẫn phải tin rằng hai lần dựng ở hai nơi cho ra cùng một kết quả. Kéo artifact thì không cần
tin điều đó nữa: **chính xác cùng một image** đã được kiểm.

Lợi thêm: quay lui trở thành `docker compose pull <SHA cũ>` — vài giây, không phải dựng lại.

### Việc phải làm

1. Thêm bước `docker/build-push-action` vào `deploy-vps.yml`, gắn nhãn `ghcr.io/<repo>:<sha>`.
2. `docker-compose.prod.yml`: đổi `build: .` thành `image: ghcr.io/<repo>:${ERP_DEPLOY_SHA}`.
3. `install-vps.sh`: `docker compose pull` thay cho `up -d --build`.
4. Giữ nguyên bước ghim SHA và bước đối chiếu — nay đối chiếu cả nhãn image.

### Điều PHẢI kiểm trước khi làm

- **Kho mã là PUBLIC.** Image trên GHCR sẽ công khai theo. `.dockerignore` hiện đã loại `.env`,
  `.env.local`, `data`, `.git` — **phải xác minh lại từng dòng trước khi đẩy image lên**, vì một
  tệp bí mật lọt vào layer là lộ vĩnh viễn kể cả sau khi xoá.
- Dung lượng đĩa máy chủ cho image cũ, và chính sách dọn.
- Đường mạng VPS ↔ ghcr.io (kéo ~300–500 MB mỗi lần phát hành).

**Chưa làm trong đợt này**: nó thay đổi đường phát hành — thứ mà hỏng thì không phát hành được gì
nữa, kể cả bản sửa cho chính nó. Cần một đợt riêng, làm lúc không có việc gấp.

## 3. Bước tạm thời — ĐÃ LÀM

`scripts/install-vps.sh` trước khi dựng:

1. **Dọn rác an toàn**: `docker image prune -f` và `docker builder prune -f --keep-storage 2GB`.
   Cố ý KHÔNG dùng `-a`: chỉ xoá thứ không container nào đang dùng, nên bản đang chạy không bị đụng.
2. **Chặn sớm nếu không đủ**: dưới 700 MB dùng được **và** dưới 512 MB swap thì dừng với một dòng
   nói rõ còn bao nhiêu — thay vì để bị `SIGKILL` rồi phải đọc log Docker mới hiểu. Bản đang chạy
   không bị đụng tới.
3. **Cảnh báo khi không có swap**, vì đó là điểm yếu cấu trúc thật.

`Dockerfile`: `RUN NODE_OPTIONS=--max-old-space-size=1024 npm run build` — đặt trên chính dòng `RUN`,
**không** dùng `ENV`: `ENV` sẽ theo image sang lúc chạy và bóp luôn vùng nhớ của ứng dụng đang phục
vụ người dùng.

**Không dừng ứng dụng để lấy RAM.** Mất dịch vụ mà chưa chắc dựng nổi thì tệ hơn nhiều, và không có
đường quay lui an toàn nếu bản dựng mới hỏng.

## 4. Việc của chủ shop

**Bật swap trên VPS** — đây là thứ rẻ nhất và có tác dụng ngay:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Không tự làm vì đây là thay đổi cấu hình máy chủ (AGENTS.md mục 7). Có 2 GB swap thì lần dựng tới
chậm hơn một chút thay vì bị giết, và cảnh báo ở mục 3 sẽ tắt.
