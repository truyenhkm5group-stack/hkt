#!/usr/bin/env bash
# ───────────── DỰNG BẢN CHẠY THỬ NHÂN SỰ AI ─────────────
#
#   bash scripts/staging-up.sh
#
# Chạy kiểm tra an toàn TRƯỚC, và TỪ CHỐI dựng nếu có va chạm. Không có cờ nào bỏ qua bước đó —
# một cờ `--force` ở đây sẽ được dùng đúng vào lúc không nên dùng.
#
# Script chỉ đụng tới: thư mục $STAGING_DIR, compose project vnx-ai-staging, volume riêng của nó.
# Nó KHÔNG chạy `docker compose` nào khác, KHÔNG restart gì, KHÔNG sửa Caddy.
set -euo pipefail

DIR="${STAGING_DIR:-/opt/vnx-ai-staging}"
PORT="${STAGING_PORT:-3100}"
BRANCH="${STAGING_BRANCH:-claude/ai-workforce-sales-v1}"
REPO="${STAGING_REPO:-https://github.com/truyenhkm5group-stack/hkt.git}"
COMPOSE="docker compose -f docker-compose.staging.yml --env-file .env.staging"
# Cờ DUY NHẤT của script, và nó chỉ NỚI một việc: dựng ảnh tại chỗ. Không có cờ nào bỏ qua kiểm
# tra an toàn — một cờ như thế sẽ được dùng đúng vào lúc không nên dùng.
BUILD_HERE=0
for a in "$@"; do [ "$a" = "--build-here" ] && BUILD_HERE=1; done
export STAGING_IMAGE="${STAGING_IMAGE:-}"

say() { printf '%s\n' "$*"; }

say "═════════ BƯỚC 1/5 · KIỂM TRA AN TOÀN ═════════"
#
# Tìm preflight ở ba chỗ, và KHÔNG có nhánh thứ tư nào "không thấy thì thôi": kiểm tra an toàn là
# thứ duy nhất đứng giữa lượt dựng này và production. Không chạy được nó thì DỪNG.
PREFLIGHT=""
for p in "$DIR/scripts/staging-preflight.sh" "$(dirname "$0")/staging-preflight.sh"; do
  [ -f "$p" ] && { PREFLIGHT="$p"; break; }
done
if [ -z "$PREFLIGHT" ]; then
  say "Không thấy staging-preflight.sh tại chỗ — tải từ nhánh $BRANCH."
  PREFLIGHT="$(mktemp)"
  curl -fsSL -H "Accept: application/vnd.github.raw" \
    "https://api.github.com/repos/truyenhkm5group-stack/hkt/contents/scripts/staging-preflight.sh?ref=${BRANCH}" > "$PREFLIGHT" \
    || { say "✗ Không tải được kiểm tra an toàn. DỪNG — không dựng khi chưa kiểm được va chạm."; exit 1; }
fi
STAGING_DIR="$DIR" STAGING_PORT="$PORT" bash "$PREFLIGHT"
say "Kiểm tra an toàn ĐẠT."

say ""
say "═════════ BƯỚC 2/5 · LẤY MÃ NGUỒN ═════════"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$DIR" checkout -B "$BRANCH" "origin/$BRANCH"
  say "Đã cập nhật $DIR sang $BRANCH ($(git -C "$DIR" rev-parse --short HEAD))"
else
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 --single-branch --branch "$BRANCH" "$REPO" "$DIR"
  say "Đã tải $BRANCH về $DIR"
fi
cd "$DIR"

say ""
say "═════════ BƯỚC 3/5 · TỆP MÔI TRƯỜNG ═════════"
if [ -f .env.staging ]; then
  say "Đã có .env.staging — giữ nguyên, không ghi đè."
else
  # Bí mật sinh NGAY TRÊN MÁY. Không bao giờ đi qua kho mã, nhật ký hay tin nhắn.
  cp .env.staging.example .env.staging
  for key in STAGING_POSTGRES_PASSWORD AUTH_SECRET CRON_SECRET; do
    value="$(openssl rand -hex 32)"
    # dùng | làm dấu phân tách để không vỡ khi giá trị có ký tự /
    sed -i "s|^${key}=.*|${key}=\"${value}\"|" .env.staging
  done
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=\"$(openssl rand -base64 18)\"|" .env.staging
  chmod 600 .env.staging
  say "Đã tạo .env.staging với bí mật sinh ngẫu nhiên tại chỗ (quyền 600)."
  say "CÒN PHẢI ĐIỀN BẰNG TAY: PANCAKE_PAGE_ID · PANCAKE_PAGE_ACCESS_TOKEN · AI_API_KEY (nếu muốn gọi mô hình)"
fi

say ""
say "═════════ BƯỚC 4/5 · LẤY ẢNH VÀ KHỞI ĐỘNG ═════════"
#
# MẶC ĐỊNH KHÔNG DỰNG TRÊN MÁY NÀY. VPS có 1.963 MB RAM / 949 MB khả dụng / SWAP 0 (đo 14/09/2026);
# `next build` ở đó nhiều khả năng làm nhân OOM giết container production. Ảnh dựng sẵn ở workflow
# "Dựng ảnh bản chạy thử nhân sự AI" rồi kéo về — thao tác cần vài trăm MB thay vì vài GB.
if [ "$BUILD_HERE" = "1" ]; then
  say "⚠ --build-here: DỰNG ẢNH NGAY TRÊN MÁY NÀY. Chỉ làm khi kiểm tra an toàn ở bước 1 báo đủ RAM."
  $COMPOSE build
elif [ -n "${STAGING_IMAGE:-}" ]; then
  # Token chỉ sống trong lượt chạy này. Đăng xuất NGAY sau khi kéo xong để không bỏ lại một chứng
  # thư trong /root/.docker/config.json — kho mã PUBLIC, gói GHCR riêng tư, và một token nằm lại
  # trên máy chủ là một token sẽ bị quên.
  if [ -n "${GHCR_TOKEN:-}" ]; then
    say "Đăng nhập ghcr.io (token dùng một lần)…"
    printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-x}" --password-stdin >/dev/null
  fi
  say "Kéo ảnh $STAGING_IMAGE …"
  docker pull "$STAGING_IMAGE" || { [ -n "${GHCR_TOKEN:-}" ] && docker logout ghcr.io >/dev/null 2>&1; exit 1; }
  [ -n "${GHCR_TOKEN:-}" ] && { docker logout ghcr.io >/dev/null 2>&1; say "Đã đăng xuất ghcr.io."; }
elif docker image inspect vnx-ai-staging-app:local >/dev/null 2>&1; then
  say "Dùng ảnh vnx-ai-staging-app:local đã có sẵn trên máy."
else
  say "✗ CHƯA CÓ ẢNH để chạy, và script này KHÔNG tự dựng trên máy chủ."
  say ""
  say "  Cách đúng (dựng ở nơi có RAM, VPS chỉ kéo về):"
  say "    1. GitHub → Actions → \"Dựng ảnh bản chạy thử nhân sự AI\" → Run workflow"
  say "    2. STAGING_IMAGE=ghcr.io/truyenhkm5group-stack/hkt-ai-staging:latest bash $0"
  say ""
  say "  Nếu CHẮC CHẮN máy này đủ RAM (kiểm tra an toàn ở bước 1 đã nói), dựng tại chỗ bằng:"
  say "    bash $0 --build-here"
  exit 1
fi
$COMPOSE up -d
say "Đợi CSDL và ứng dụng sẵn sàng…"
for i in $(seq 1 60); do
  if curl -fsS -m 5 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null | grep -q '"ok":true'; then
    say "Ứng dụng đã sẵn sàng sau ${i}0 giây."
    break
  fi
  sleep 10
done

say ""
say "═════════ BƯỚC 5/5 · KIỂM CHỨNG ═════════"
say "── Bản chạy thử ──"
$COMPOSE ps
curl -fsS -m 10 "http://127.0.0.1:${PORT}/api/health" && echo || say "  ✗ /api/health CHƯA trả lời — xem log: $COMPOSE logs --tail=80 app"

say ""
say "── RAM / swap sau khi bản chạy thử lên ──"
free -h || true
swapon --show 2>/dev/null || say "  (chưa có swap — chạy scripts/vps-add-swap.sh)"
docker stats --no-stream --format '  {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' 2>/dev/null || true

say ""
say "── Migration trên CSDL RIÊNG của bản chạy thử ──"
# `/api/health` chỉ chứng minh tiến trình sống và CSDL nối được. Migration xong hay chưa phải ĐẾM.
docker exec vnx-ai-staging-db psql -U erp -d erp -P pager=off -t \
  -c "select '  đã áp: ' || count(*) || ' migration' from drizzle.__drizzle_migrations;" \
  -c "select '  bảng nhân sự AI: ' || count(*) || '/14' from information_schema.tables where table_schema='public' and (table_name like 'ai\\_%' or table_name like 'sales\\_%');" \
  -c "select '  tin đã gửi cho khách: ' || count(*) || ' (phải là 0)' from sales_suggestions where sent;" 2>&1 || say "  (chưa đọc được CSDL bản chạy thử)"

say ""
say "── Production PHẢI không đổi ──"
docker ps --format '  {{.Names}}\t{{.Status}}' | grep '^  erp-' || say "  (không thấy container erp-*)"
if docker exec erp-app wget -qO- --timeout=10 http://127.0.0.1:3000/api/health 2>/dev/null | grep -q '"ok":true'; then
  say "  ✓ production vẫn khoẻ"
else
  say "  ⚠ production KHÔNG trả ok:true — kiểm tra ngay"
fi

say ""
say "Xong. Mở bằng SSH tunnel từ máy của bạn:"
say "    ssh -L ${PORT}:127.0.0.1:${PORT} <user>@<vps>   rồi vào http://localhost:${PORT}/ai/review"
say ""
say "CÒN THIẾU ĐỂ NẠP HỘI THOẠI — điền vào $DIR/.env.staging rồi `$COMPOSE up -d app`:"
if grep -qE '^PANCAKE_PAGE_ID="?.+"?$' .env.staging 2>/dev/null && ! grep -qE '^PANCAKE_PAGE_ID=""$' .env.staging; then
  say "    ✓ PANCAKE_PAGE_ID đã có"
else
  say "    ✗ PANCAKE_PAGE_ID          — pancake.vn → Cấu hình → Page → ID của page cần đọc"
fi
if grep -qE '^PANCAKE_PAGE_ACCESS_TOKEN="?.+"?$' .env.staging 2>/dev/null && ! grep -qE '^PANCAKE_PAGE_ACCESS_TOKEN=""$' .env.staging; then
  say "    ✓ PANCAKE_PAGE_ACCESS_TOKEN đã có"
else
  say "    ✗ PANCAKE_PAGE_ACCESS_TOKEN — pancake.vn → Cấu hình → Page → Access token của CHÍNH page đó"
fi
say ""
say "Rồi nạp thử lượt đầu (một page, cửa sổ hẹp, KHÔNG ghi gì):"
say "    cd $DIR && $COMPOSE exec -T app npm run ai:ingest -- --page=<PAGE_ID> --hours=24 --max=20 --dry-run"
