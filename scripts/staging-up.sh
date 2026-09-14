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

say() { printf '%s\n' "$*"; }

say "═════════ BƯỚC 1/5 · KIỂM TRA AN TOÀN ═════════"
if [ -f "$DIR/scripts/staging-preflight.sh" ]; then
  STAGING_DIR="$DIR" STAGING_PORT="$PORT" bash "$DIR/scripts/staging-preflight.sh"
else
  STAGING_DIR="$DIR" STAGING_PORT="$PORT" bash "$(dirname "$0")/staging-preflight.sh"
fi
say "Kiểm tra an toàn ĐẠT."

say ""
say "═════════ BƯỚC 2/5 · LẤY MÃ NGUỒN ═════════"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch origin "$BRANCH"
  git -C "$DIR" checkout -B "$BRANCH" "origin/$BRANCH"
  say "Đã cập nhật $DIR sang $BRANCH ($(git -C "$DIR" rev-parse --short HEAD))"
else
  mkdir -p "$(dirname "$DIR")"
  git clone --branch "$BRANCH" "$REPO" "$DIR"
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
say "═════════ BƯỚC 4/5 · DỰNG VÀ KHỞI ĐỘNG ═════════"
$COMPOSE up -d --build
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
say "Nạp thử hội thoại đầu tiên (một page, cửa sổ hẹp):"
say "    cd $DIR && $COMPOSE exec -T app npm run ai:ingest -- --page=<PAGE_ID> --hours=24 --max=20 --dry-run"
