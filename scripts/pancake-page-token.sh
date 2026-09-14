#!/usr/bin/env bash
# ───────── SINH page_access_token CHO MỘT PAGE RỒI GHI VÀO .env.staging ─────────
#
#   PANCAKE_ACCESS_TOKEN=<token người dùng> PANCAKE_PAGE_ID=<id> bash scripts/pancake-page-token.sh
#
# VÌ SAO PHẢI CÓ SCRIPT RIÊNG THAY VÌ MỘT DÒNG curl:
#
# Token người dùng mở được MỌI page của tài khoản. Nó chỉ được phép tồn tại trong bộ nhớ của tiến
# trình này, trong vài giây, rồi biến mất — KHÔNG ghi vào đĩa, KHÔNG vào `.env.staging`, KHÔNG vào
# nhật ký. Thứ ở lại trên máy chủ là `page_access_token`: chỉ mở đúng một page, thu hồi riêng được.
#
# BA CHỖ TOKEN CÓ THỂ RÒ, và cách bịt từng chỗ:
#   1. Dòng lệnh — `curl` nhận URL qua BIẾN, không nội suy vào một dòng lệnh có thể bị `set -x` in ra.
#   2. Thông báo lỗi của curl — dùng `-s` (không `-S`), tự đọc mã HTTP, tự viết thông báo lỗi.
#   3. Phản hồi — ghi thẳng ra tệp tạm quyền 600, đọc bằng python, rồi xoá. Không `cat`, không `echo`.
#
# Script in ra: mã page, ĐỘ DÀI token, và bốn ký tự cuối. Không bao giờ in chính token.
set -euo pipefail

DIR="${STAGING_DIR:-/opt/vnx-ai-staging}"
ENV_FILE="$DIR/.env.staging"
BASE="${PANCAKE_PAGES_BASE_URL:-https://pages.fm/api/v1}"
say() { printf '%s\n' "$*"; }

if [ -z "${PANCAKE_ACCESS_TOKEN:-}" ]; then
  say "✗ Không có PANCAKE_ACCESS_TOKEN trong môi trường."
  say "  Đặt nó ở GitHub → Settings → Secrets and variables → Actions → PANCAKE_ACCESS_TOKEN."
  say "  KHÔNG truyền token qua ô \"arg\" của workflow: kho mã này PUBLIC và ô ấy vào thẳng nhật ký."
  exit 1
fi
if [ -z "${PANCAKE_PAGE_ID:-}" ]; then
  say "✗ Không có PANCAKE_PAGE_ID. Truyền qua ô \"arg\" — mã page KHÔNG phải bí mật."
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  say "✗ Chưa có $ENV_FILE — dựng bản chạy thử trước (thao tác ai-staging-up)."
  exit 1
fi

say "Page: $PANCAKE_PAGE_ID"
say "Token người dùng: có (độ dài ${#PANCAKE_ACCESS_TOKEN})"

RESP="$(mktemp)"; chmod 600 "$RESP"
# Xoá phản hồi ở MỌI đường thoát, kể cả khi script chết giữa chừng: nó chứa page token.
trap 'rm -f "$RESP"' EXIT INT TERM

URL="${BASE}/pages/${PANCAKE_PAGE_ID}/generate_page_access_token?access_token=${PANCAKE_ACCESS_TOKEN}"
CODE="$(curl -s -o "$RESP" -w '%{http_code}' -X POST --max-time 30 "$URL" || echo "000")"
unset URL   # không để URL kèm token nằm lại trong môi trường của các lệnh sau

if [ "$CODE" = "000" ]; then
  say "✗ Không gọi được Pancake (mạng/tên miền). KHÔNG in URL vì nó chứa token."
  exit 1
fi

TOKEN="$(python3 - "$RESP" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print(""); raise SystemExit(0)
if not isinstance(d, dict):
    print(""); raise SystemExit(0)
data = d.get("data") if isinstance(d.get("data"), dict) else {}
print(d.get("page_access_token") or data.get("page_access_token") or "")
PY
)"

if [ -z "$TOKEN" ]; then
  say "✗ Pancake trả HTTP $CODE nhưng KHÔNG có page_access_token."
  # In lý do mà Pancake khai, và CHỈ lý do — không in cả phản hồi, vì phản hồi có thể chứa token.
  python3 - "$RESP" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("  (phản hồi không phải JSON)"); raise SystemExit(0)
if isinstance(d, dict):
    for k in ("message", "error", "reason", "error_code", "success"):
        if k in d:
            print(f"  {k}: {d[k]}")
PY
  say "  Thường gặp: token người dùng hết hạn, hoặc tài khoản không có quyền trên page này."
  exit 1
fi

say "Đã sinh page_access_token: độ dài ${#TOKEN}, bốn ký tự cuối …${TOKEN: -4}"

# ── GHI VÀO .env.staging — chỉ page id và page token, KHÔNG ghi token người dùng ──
upsert() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    # python thay dòng: `sed` sẽ vỡ nếu token chứa ký tự phân tách, và token là chuỗi tuỳ ý.
    KEY="$key" VALUE="$value" FILE="$ENV_FILE" python3 - <<'PY'
import os
key, value, path = os.environ["KEY"], os.environ["VALUE"], os.environ["FILE"]
lines = open(path, encoding="utf-8").read().splitlines(True)
out = [f'{key}="{value}"\n' if l.startswith(f"{key}=") else l for l in lines]
open(path, "w", encoding="utf-8").write("".join(out))
PY
  else
    printf '%s="%s"\n' "$key" "$value" >> "$ENV_FILE"
  fi
}
upsert PANCAKE_PAGE_ID "$PANCAKE_PAGE_ID"
upsert PANCAKE_PAGE_ACCESS_TOKEN "$TOKEN"
chmod 600 "$ENV_FILE"

say "Đã ghi PANCAKE_PAGE_ID và PANCAKE_PAGE_ACCESS_TOKEN vào $ENV_FILE (quyền 600)."
say ""
say "── Kiểm chứng: KHÔNG có token người dùng nằm lại trên đĩa ──"
if grep -qE '^PANCAKE_ACCESS_TOKEN="?.+"?$' "$ENV_FILE" && ! grep -qE '^PANCAKE_ACCESS_TOKEN=""$' "$ENV_FILE"; then
  say "  ⚠ .env.staging CÓ PANCAKE_ACCESS_TOKEN — token người dùng mở mọi page, nên xoá đi."
else
  say "  ✓ .env.staging KHÔNG chứa token người dùng"
fi
say "  ✓ hai khoá đã ghi:"
grep -cE '^PANCAKE_PAGE_(ID|ACCESS_TOKEN)=' "$ENV_FILE" | sed 's/^/    /'
