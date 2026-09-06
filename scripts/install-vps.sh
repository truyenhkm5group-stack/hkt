#!/usr/bin/env bash
# Cài đặt ERP trên VPS Ubuntu/Debian bằng MỘT lệnh:
#   sudo bash scripts/install-vps.sh
# Có thể truyền sẵn giá trị qua biến môi trường để không phải nhập:
#   ERP_DOMAIN=erp.vnxcommerce.com PANCAKE_API_KEY=... VIETTELPOST_API_KEY=... sudo -E bash scripts/install-vps.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
COMPOSE="docker compose -f docker-compose.prod.yml"

say()  { printf '\033[1;32m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
ask()  { # ask VAR "Câu hỏi" "mặc định" — đọc từ /dev/tty để dùng được cả khi chạy qua curl | bash
  local var="$1" prompt="$2" def="${3:-}" val
  if [ -n "${!var:-}" ]; then return; fi
  if [ "${ERP_NONINTERACTIVE:-0}" = "1" ] || ! { : </dev/tty; } 2>/dev/null; then printf -v "$var" '%s' "$def"; return; fi
  if [ -n "$def" ]; then read -r -p "$prompt [$def]: " val </dev/tty; val="${val:-$def}"; else read -r -p "$prompt: " val </dev/tty; fi
  printf -v "$var" '%s' "$val"
}
rand() { openssl rand -hex "${1:-24}"; }

# ───────── 1. Docker ─────────
if ! command -v docker >/dev/null 2>&1; then
  say "Cài Docker"
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  say "Cài Docker Compose plugin"
  if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq docker-compose-plugin; else (dnf install -y -q docker-compose-plugin || yum install -y -q docker-compose-plugin); fi
fi
command -v openssl >/dev/null 2>&1 || { (apt-get update -qq && apt-get install -y -qq openssl) || dnf install -y -q openssl || yum install -y -q openssl; }
systemctl enable --now docker >/dev/null 2>&1 || true

# ───────── 2. Tường lửa ─────────
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  say "Mở cổng 80/443 trên ufw"
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  say "Mở cổng 80/443 trên firewalld"
  firewall-cmd --permanent --add-service=http >/dev/null; firewall-cmd --permanent --add-service=https >/dev/null; firewall-cmd --reload >/dev/null
fi

# ───────── 3. File .env ─────────
if [ -f .env ]; then
  say "Đã có .env, giữ nguyên (xoá file này nếu muốn tạo lại)"
  # Bổ sung / cập nhật các biến mới nếu được truyền qua môi trường (không đụng các giá trị khác)
  upsert_env() { # upsert_env TÊN GIÁ_TRỊ
    [ -n "$2" ] || return 0
    if grep -qE "^$1=" .env; then sed -i -E "s|^$1=.*|$1=\"$2\"|" .env; else printf '%s="%s"\n' "$1" "$2" >> .env; fi
  }
  upsert_env FACEBOOK_ACCESS_TOKEN "${FACEBOOK_ACCESS_TOKEN:-}"
  upsert_env FACEBOOK_BUSINESS_ID "${FACEBOOK_BUSINESS_ID:-}"
  upsert_env PANCAKE_ACCESS_TOKEN "${PANCAKE_ACCESS_TOKEN:-}"
  upsert_env VIETTELPOST_API_KEY "${VIETTELPOST_API_KEY:-}"
  upsert_env VIETTELPOST_USERNAME "${VIETTELPOST_USERNAME:-}"
  upsert_env VIETTELPOST_PASSWORD "${VIETTELPOST_PASSWORD:-}"
  upsert_env PANCAKE_API_KEY "${PANCAKE_API_KEY:-}"
  grep -qE "^SYNC_ADS_EVERY_MINUTES=" .env || printf 'SYNC_ADS_EVERY_MINUTES="60"\n' >> .env
else
  say "Tạo .env — nhập thông tin (Enter để dùng mặc định)"
  ask ERP_DOMAIN          "Tên miền ERP"                       "erp.vnxcommerce.com"
  ask PANCAKE_API_KEY     "API key Pancake POS"
  ask PANCAKE_SHOP_ID     "Shop ID Pancake"                    "408063069"
  ask VIETTELPOST_API_KEY "Token bí mật Viettel Post (Enter nếu không có)" ""
  ask VIETTELPOST_USERNAME "Tài khoản đối tác Viettel Post (SĐT, Enter nếu không dùng)" ""
  if [ -n "${VIETTELPOST_USERNAME:-}" ] && [ -z "${VIETTELPOST_PASSWORD:-}" ] && [ "${ERP_NONINTERACTIVE:-0}" != "1" ] && { : </dev/tty; } 2>/dev/null; then
    read -r -s -p "Mật khẩu đối tác Viettel Post: " VIETTELPOST_PASSWORD </dev/tty; echo
  fi
  if [ -z "${PANCAKE_API_KEY:-}" ]; then warn "Chưa có PANCAKE_API_KEY — ERP vẫn chạy nhưng không đồng bộ được Pancake, sửa .env sau."; fi
  ask FACEBOOK_ACCESS_TOKEN "Token Facebook Ads (System User, Enter nếu chưa có)" ""
  ask FACEBOOK_BUSINESS_ID "ID Business Manager Facebook"      "336423739082347"
  ask ADMIN_EMAIL         "Email quản trị ERP"                 "admin@vnxcommerce.com"
  ask ADMIN_PASSWORD      "Mật khẩu quản trị ERP"              "$(rand 6)"
  ask PANCAKE_BACKFILL_DAYS "Số ngày lịch sử đơn cần kéo lần đầu" "365"

  cat > .env <<ENV
# Sinh bởi scripts/install-vps.sh — $(date -Is)
ERP_DOMAIN="${ERP_DOMAIN}"
APP_URL="https://${ERP_DOMAIN}"
POSTGRES_PASSWORD="$(rand 16)"
DATABASE_URL="postgresql://erp:CHANGED_BY_COMPOSE@db:5432/erp?schema=public"

AUTH_SECRET="$(rand 32)"
ADMIN_EMAIL="${ADMIN_EMAIL}"
ADMIN_PASSWORD="${ADMIN_PASSWORD}"
ADMIN_NAME="Quản trị viên"
CRON_SECRET="$(rand 24)"

PANCAKE_API_KEY="${PANCAKE_API_KEY}"
PANCAKE_SHOP_ID="${PANCAKE_SHOP_ID}"
PANCAKE_BASE_URL="https://pos.pages.fm/api/v1"
PANCAKE_WEBHOOK_SECRET="pk_$(rand 16)"
PANCAKE_BACKFILL_DAYS="${PANCAKE_BACKFILL_DAYS}"

VIETTELPOST_API_KEY="${VIETTELPOST_API_KEY:-}"
VIETTELPOST_USERNAME="${VIETTELPOST_USERNAME:-}"
VIETTELPOST_PASSWORD="${VIETTELPOST_PASSWORD:-}"
VIETTELPOST_BASE_URL="https://partner.viettelpost.vn/v2"
VIETTELPOST_WEBHOOK_SECRET="vtp_$(rand 16)"

FACEBOOK_ACCESS_TOKEN="${FACEBOOK_ACCESS_TOKEN:-}"
FACEBOOK_BUSINESS_ID="${FACEBOOK_BUSINESS_ID:-336423739082347}"
FACEBOOK_API_VERSION="v21.0"
FACEBOOK_USD_VND="25500"

# Pancake Pages (chat): access token người dùng để đọc hội thoại → case CSKH
PANCAKE_ACCESS_TOKEN="${PANCAKE_ACCESS_TOKEN:-}"
PANCAKE_PAGES_BASE_URL="https://pages.fm/api/v1"

ERP_INTERNAL_URL="http://app:3000"
SYNC_ORDERS_EVERY_MINUTES="3"
SYNC_VTP_EVERY_MINUTES="10"
SYNC_PRODUCTS_EVERY_MINUTES="30"
SYNC_CUSTOMERS_EVERY_MINUTES="60"
SYNC_INVENTORY_EVERY_MINUTES="60"
SYNC_RETURNS_EVERY_MINUTES="30"
SYNC_ADS_EVERY_MINUTES="60"
ENV
  chmod 600 .env
  say "Đã ghi .env (chmod 600)"
fi

# đọc lại các giá trị cần dùng bên dưới
ERP_DOMAIN="$(grep -E '^ERP_DOMAIN=' .env | cut -d= -f2- | tr -d '"')"
PANCAKE_WEBHOOK_SECRET="$(grep -E '^PANCAKE_WEBHOOK_SECRET=' .env | cut -d= -f2- | tr -d '"')"
VIETTELPOST_WEBHOOK_SECRET="$(grep -E '^VIETTELPOST_WEBHOOK_SECRET=' .env | cut -d= -f2- | tr -d '"')"
ADMIN_EMAIL="$(grep -E '^ADMIN_EMAIL=' .env | cut -d= -f2- | tr -d '"')"

# ───────── 4. Kiểm tra DNS ─────────
PUBLIC_IP="$(curl -fsS -m 10 https://api.ipify.org || curl -fsS -m 10 https://ifconfig.me || true)"
DNS_IP="$(getent ahostsv4 "$ERP_DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
if [ -n "$PUBLIC_IP" ] && [ "$DNS_IP" != "$PUBLIC_IP" ]; then
  warn "DNS của $ERP_DOMAIN đang trỏ về '${DNS_IP:-chưa có}' nhưng IP máy này là $PUBLIC_IP."
  warn "Vào name.com → My Domains → vnxcommerce.com → DNS Records → thêm bản ghi A: Host = erp, Answer = $PUBLIC_IP, TTL 300."
  warn "Caddy sẽ tự xin chứng chỉ HTTPS ngay khi DNS trỏ đúng (không cần chạy lại lệnh này)."
else
  say "DNS $ERP_DOMAIN → $DNS_IP (khớp IP máy chủ)"
fi

# ───────── 5. Khởi chạy ─────────
# Ghi commit đang chạy vào .env để /api/health nói được Production đang chạy đúng bản nào.
# Không có mốc này thì "deploy xanh" vẫn không chứng minh được máy chủ khớp Git.
ERP_COMMIT_SHA="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
ERP_COMMIT_REF="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
if grep -qE "^ERP_COMMIT=" .env; then sed -i -E "s|^ERP_COMMIT=.*|ERP_COMMIT=\"$ERP_COMMIT_SHA\"|" .env; else printf 'ERP_COMMIT="%s"
' "$ERP_COMMIT_SHA" >> .env; fi
if grep -qE "^ERP_BRANCH_NAME=" .env; then sed -i -E "s|^ERP_BRANCH_NAME=.*|ERP_BRANCH_NAME=\"$ERP_COMMIT_REF\"|" .env; else printf 'ERP_BRANCH_NAME="%s"
' "$ERP_COMMIT_REF" >> .env; fi
say "Phiên bản triển khai: $ERP_COMMIT_REF @ $ERP_COMMIT_SHA"

say "Build và khởi chạy (lần đầu mất 3–6 phút)"

# CSDL lên trước, rồi ĐỒNG BỘ mật khẩu role với .env.
# Vì sao bắt buộc: POSTGRES_PASSWORD chỉ có tác dụng lúc initdb — lần đầu tạo volume erp_pgdata.
# Về sau .env có thể được tạo lại với mật khẩu ngẫu nhiên mới, nhưng volume vẫn giữ mật khẩu cũ,
# nên app báo "password authentication failed for user erp" và crash-loop vĩnh viễn
# (pg_isready vẫn xanh vì không cần đăng nhập, nên nhìn bên ngoài tưởng CSDL vẫn tốt).
# ALTER USER ở đây không đụng dữ liệu, chạy lại nhiều lần vẫn đúng, và chạy được qua socket
# nội bộ của container (pg_hba mặc định của image postgres cho phép "local all all trust").
$COMPOSE up -d --build db
for _ in $(seq 1 60); do
  $COMPOSE exec -T db pg_isready -U erp -d erp >/dev/null 2>&1 && break
  sleep 2
done
DB_PASSWORD="$(grep -E '^POSTGRES_PASSWORD=' .env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
if [ -n "${DB_PASSWORD:-}" ]; then
  DB_PASSWORD_SQL="$(printf '%s' "$DB_PASSWORD" | sed "s/'/''/g")"
  if $COMPOSE exec -T db psql -U erp -d erp -v ON_ERROR_STOP=1 -q -c "ALTER USER erp WITH PASSWORD '$DB_PASSWORD_SQL';" >/dev/null 2>&1; then
    say "Đã đồng bộ mật khẩu CSDL với .env"
  else
    warn "KHÔNG đồng bộ được mật khẩu CSDL — app sẽ không kết nối được. Kiểm tra container erp-db."
  fi
else
  warn "Không đọc được POSTGRES_PASSWORD trong .env — bỏ qua bước đồng bộ mật khẩu CSDL."
fi

$COMPOSE up -d --build

say "Chờ ERP sẵn sàng"
for i in $(seq 1 60); do
  if docker exec erp-app wget -qO- http://127.0.0.1:3000/api/health 2>/dev/null | grep -q '"ok":true'; then break; fi
  sleep 3
done
docker exec erp-app wget -qO- http://127.0.0.1:3000/api/health 2>/dev/null | grep -q '"ok":true' && say "ERP đã chạy" || warn "ERP chưa phản hồi, xem log: $COMPOSE logs -f app"

say "Smoke test các màn hình chính (đăng nhập thật, không chỉ /api/health)"
# /api/health chỉ chứng minh tiến trình sống + CSDL kết nối được; nó KHÔNG bắt được
# trang lỗi runtime (truy vấn hỏng, thiếu cột). Smoke test mở thật từng màn hình.
if ! docker exec erp-app npx tsx --tsconfig tsconfig.json scripts/smoke.ts; then
  warn "SMOKE TEST THẤT BẠI — có màn hình không mở được. Xem danh sách ở trên."
  SMOKE_FAILED=1
fi

say "Kiểm tra API key Pancake / Viettel Post"
docker exec erp-app npm run --silent check:integrations || warn "Có mục ✗ ở trên — sửa .env rồi chạy: $COMPOSE up -d"

# Khi chạy không tương tác (log GitHub Actions có thể công khai) thì che các secret webhook
if [ "${ERP_NONINTERACTIVE:-0}" = "1" ]; then
  PANCAKE_WEBHOOK_SECRET_SHOWN="${PANCAKE_WEBHOOK_SECRET:0:6}••••••••"
  VIETTELPOST_WEBHOOK_SECRET_SHOWN="${VIETTELPOST_WEBHOOK_SECRET:0:6}••••••••"
else
  PANCAKE_WEBHOOK_SECRET_SHOWN="$PANCAKE_WEBHOOK_SECRET"
  VIETTELPOST_WEBHOOK_SECRET_SHOWN="$VIETTELPOST_WEBHOOK_SECRET"
fi

cat <<INFO

════════════════════════════════════════════════════════════════
 ERP:                 https://${ERP_DOMAIN}
 Đăng nhập:           ${ADMIN_EMAIL}  (mật khẩu trong .env → ADMIN_PASSWORD)
 Webhook Pancake:     https://${ERP_DOMAIN}/api/webhooks/pancake/${PANCAKE_WEBHOOK_SECRET_SHOWN}
 Webhook Viettel Post: https://${ERP_DOMAIN}/api/webhooks/viettelpost
   Tham số bí mật:    ${VIETTELPOST_WEBHOOK_SECRET_SHOWN}
   (giá trị đầy đủ: đăng nhập ERP → Kết nối dữ liệu, hoặc xem file .env trên VPS)

 Bước tiếp theo:
  1. Đăng nhập → Kết nối dữ liệu → "Đồng bộ toàn bộ Pancake (lịch sử)".
  2. Pancake POS → Cấu hình → Nâng cao → Kết nối bên thứ 3 → Webhook URL: dán URL Pancake ở trên,
     tick Đơn hàng / Khách hàng / Tồn kho.
  3. partner.viettelpost.vn → Cấu hình tài khoản → Thông tin nhận hành trình: dán URL + tham số bí mật,
     rồi liên hệ b2b@viettelpost.com.vn · 0862 235 888 để duyệt webhook.

 Lệnh hữu ích:
   $COMPOSE logs -f app          # log ERP
   $COMPOSE up -d --build        # cập nhật phiên bản
   $COMPOSE exec -T db pg_dump -U erp erp | gzip > backup-\$(date +%F).sql.gz
════════════════════════════════════════════════════════════════
INFO

# Smoke test hỏng => deploy phải BÁO ĐỎ. Trước đây workflow chỉ cảnh báo nên một lần
# deploy làm ERP crash-loop vẫn được ghi là thành công và không ai biết production đang sập.
if [ "${SMOKE_FAILED:-0}" = "1" ]; then
  warn "Deploy KHÔNG đạt: smoke test có màn hình lỗi."
  exit 1
fi
