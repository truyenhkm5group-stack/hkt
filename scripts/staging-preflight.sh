#!/usr/bin/env bash
# ───────────── KIỂM TRA AN TOÀN TRƯỚC KHI DỰNG BẢN CHẠY THỬ — CHỈ ĐỌC ─────────────
#
#   bash scripts/staging-preflight.sh
#
# Script này KHÔNG tạo, KHÔNG sửa, KHÔNG dừng, KHÔNG khởi động lại bất cứ thứ gì. Nó chỉ đọc và
# trả lời đúng một câu hỏi: **dựng bản chạy thử có đụng vào thứ đang phục vụ khách không?**
#
# Thoát 0 = không va chạm, dựng được.  Thoát 1 = CÓ va chạm, DỪNG LẠI.
#
# Vì sao phải là một script chứ không phải một danh sách việc cần nhớ: danh sách thì người mệt sẽ
# bỏ qua một dòng, còn script thì thoát khác 0 và `staging-up.sh` từ chối chạy tiếp.
set -uo pipefail

PROJECT="${STAGING_PROJECT:-vnx-ai-staging}"
DIR="${STAGING_DIR:-/opt/vnx-ai-staging}"
PORT="${STAGING_PORT:-3100}"
VOLUME="${STAGING_VOLUME:-vnx-ai-staging_vnx_ai_staging_pgdata}"
CONTAINERS=("vnx-ai-staging-app" "vnx-ai-staging-db")

fail=0
say()  { printf '%s\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
bad()  { printf '  ✗ %s\n' "$*"; fail=1; }
warn() { printf '  ⚠ %s\n' "$*"; }

say ""
say "═════════ HIỆN TRẠNG PRODUCTION (chỉ đọc) ═════════"

if ! command -v docker >/dev/null 2>&1; then
  say "  ✗ Không có docker trên máy này — không kiểm được gì. DỪNG."
  exit 1
fi

say ""
say "── Container đang chạy ──"
docker ps --format '  {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || warn "không đọc được danh sách container"

say ""
say "── Compose project đang có ──"
docker ps -a --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | grep -v '^$' | sort -u | sed 's/^/  /' || warn "không đọc được"

say ""
say "── Volume ──"
docker volume ls --format '  {{.Name}}' 2>/dev/null || warn "không đọc được"

say ""
say "── Cổng đang nghe ──"
(ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | awk 'NR==1 || /LISTEN/' | sed 's/^/  /' | head -25

say ""
say "── Thư mục triển khai ──"
for d in /root/erp /opt /srv; do
  [ -d "$d" ] && say "  $d: $(ls -1 "$d" 2>/dev/null | head -5 | tr '\n' ' ')"
done

say ""
say "── Caddy ──"
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^erp-caddy$'; then
  say "  container erp-caddy đang chạy; các tên miền đã khai:"
  docker exec erp-caddy cat /etc/caddy/Caddyfile 2>/dev/null | grep -E '^[a-z0-9.*-]+\s*\{' | sed 's/^/    /' || warn "không đọc được Caddyfile"
else
  warn "không thấy container erp-caddy — kiểm tra lại tên"
fi

say ""
say "═════════ KIỂM TRA VA CHẠM VỚI BẢN CHẠY THỬ ═════════"
say "  (project=$PROJECT · thư mục=$DIR · cổng=$PORT)"
say ""

# 1. Tên compose project
if docker ps -a --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | grep -qx "$PROJECT"; then
  bad "compose project \"$PROJECT\" ĐÃ TỒN TẠI — đổi tên hoặc gỡ bản chạy thử cũ trước"
else
  ok "compose project \"$PROJECT\" chưa được dùng"
fi

# 2. Tên container
for c in "${CONTAINERS[@]}"; do
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
    bad "container \"$c\" ĐÃ TỒN TẠI"
  else
    ok "tên container \"$c\" còn trống"
  fi
done

# 3. Không được trùng tên container production
for c in erp-app erp-db erp-scheduler erp-caddy; do
  for s in "${CONTAINERS[@]}"; do
    [ "$c" = "$s" ] && bad "tên bản chạy thử \"$s\" TRÙNG container production \"$c\""
  done
done
ok "không tên nào trùng container production (erp-app · erp-db · erp-scheduler · erp-caddy)"

# 4. Cổng
if (ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep -qE "[:.]$PORT[[:space:]]"; then
  bad "cổng $PORT ĐANG CÓ TIẾN TRÌNH NGHE — chọn cổng khác qua STAGING_PORT"
else
  ok "cổng $PORT còn trống"
fi
for p in 80 443 5432 3000; do
  [ "$PORT" = "$p" ] && bad "cổng $PORT là cổng production/hệ thống — tuyệt đối không dùng"
done

# 4b. Tên image — production dùng `erp-app:local`. Một lần trùng tên là một lần `up --build` của
#     bên này ghi đè image mà container bên kia đang chạy, và lần khởi động lại sau mới lộ ra.
IMAGE="${STAGING_IMAGE:-vnx-ai-staging-app:local}"
if [ "$IMAGE" = "erp-app:local" ]; then
  bad "tên image \"$IMAGE\" TRÙNG image production"
else
  ok "tên image \"$IMAGE\" không đụng image production (erp-app:local)"
fi

# 5. Volume
if docker volume ls --format '{{.Name}}' 2>/dev/null | grep -qx "$VOLUME"; then
  warn "volume \"$VOLUME\" đã tồn tại — dữ liệu cũ sẽ được dùng lại (không phải lỗi, nhưng phải biết)"
else
  ok "volume \"$VOLUME\" chưa tồn tại, sẽ tạo mới"
fi
if [ "$VOLUME" = "erp_pgdata" ] || echo "$VOLUME" | grep -q '^erp_'; then
  bad "volume \"$VOLUME\" thuộc không gian tên của production"
else
  ok "volume không đụng không gian tên production (erp_*)"
fi

# 6. Thư mục
if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  warn "thư mục $DIR đã có nội dung — kiểm tra trước khi ghi đè"
else
  ok "thư mục $DIR trống hoặc chưa tồn tại"
fi
case "$DIR" in /root/erp|/root/erp/*) bad "thư mục $DIR NẰM TRONG thư mục production";; *) ok "thư mục nằm ngoài /root/erp";; esac

# 6b. TÀI NGUYÊN MÁY — lớp chặn quan trọng nhất, và là lớp duy nhất bảo vệ production khỏi chính
#     lượt dựng này. Bản chạy thử phải chạy `next build`, và trên VPS nhỏ thì một lượt build thứ hai
#     song song với ứng dụng đang phục vụ khách là đúng cách bị nhân OOM giết (deploy #208, #227 đã
#     chết vì hai `next build` chạy cùng lúc). Hết đĩa cũng đã giết một lượt deploy (sự cố #242).
#
#     Ngưỡng: 1200 MB khả dụng (RAM trống + đệm thu hồi được) và 8 GB đĩa trống. Dưới ngưỡng thì
#     DỪNG — chờ lúc vắng khách, hoặc dọn `docker system prune` trước.
MEM_MIN_MB="${STAGING_MIN_MEM_MB:-1200}"
DISK_MIN_GB="${STAGING_MIN_DISK_GB:-8}"

say ""
say "── Tài nguyên máy ──"
if command -v free >/dev/null 2>&1; then
  free -m | sed 's/^/  /'
  KHA_DUNG="$(free -m | awk '/^Mem:/ {print ($7 != "" ? $7 : $4)}')"
  if [ -n "$KHA_DUNG" ] && [ "$KHA_DUNG" -lt "$MEM_MIN_MB" ] 2>/dev/null; then
    bad "chỉ còn ${KHA_DUNG} MB RAM khả dụng (cần ≥ ${MEM_MIN_MB} MB) — dựng bây giờ có thể làm OOM giết container production"
  else
    ok "RAM khả dụng ${KHA_DUNG:-?} MB ≥ ${MEM_MIN_MB} MB"
  fi
else
  warn "không có lệnh free — không đo được RAM, tự kiểm bằng tay trước khi dựng"
fi

TRONG_GB="$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9')"
if [ -n "$TRONG_GB" ] && [ "$TRONG_GB" -lt "$DISK_MIN_GB" ] 2>/dev/null; then
  bad "chỉ còn ${TRONG_GB} GB đĩa trống (cần ≥ ${DISK_MIN_GB} GB cho ảnh + đệm build + CSDL riêng)"
else
  ok "đĩa trống ${TRONG_GB:-?} GB ≥ ${DISK_MIN_GB} GB"
fi

# 7. Production còn khoẻ không — để so sánh lại sau khi dựng
say ""
say "── Sức khoẻ production TRƯỚC khi dựng bản chạy thử ──"
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^erp-app$'; then
  if docker exec erp-app wget -qO- --timeout=10 http://127.0.0.1:3000/api/health 2>/dev/null | grep -q '"ok":true'; then
    ok "erp-app trả /api/health ok:true"
  else
    warn "erp-app KHÔNG trả ok:true — production đang có vấn đề TỪ TRƯỚC; sửa xong hãy dựng bản chạy thử"
  fi
  say "  Số container production đang chạy: $(docker ps --format '{{.Names}}' | grep -c '^erp-') (mong đợi 4)"
else
  warn "không thấy container erp-app đang chạy"
fi

say ""
if [ "$fail" -eq 0 ]; then
  say "═════════ KẾT LUẬN: KHÔNG VA CHẠM — dựng được ═════════"
else
  say "═════════ KẾT LUẬN: CÓ VA CHẠM — DỪNG, KHÔNG DỰNG ═════════"
fi
say ""
exit "$fail"
