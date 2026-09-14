#!/usr/bin/env bash
# ───────── GHI CHỨNG THƯ PANCAKE VÀO .env.staging — KHÔNG IN, KHÔNG COMMIT ─────────
#
#   PANCAKE_ACCESS_TOKEN=<token> PANCAKE_PAGE_ID=<id> bash scripts/pancake-staging-credentials.sh
#
# Ghi đúng hai khoá mà connector đang đọc (`lib/env.ts`):
#   PANCAKE_ACCESS_TOKEN   — token người dùng, biến mà `env.pancake.pagesAccessToken` đọc
#   PANCAKE_PAGE_ID        — mã page, KHÔNG phải bí mật
#
# GHI CHÚ VỀ PHẠM VI, để người đọc sau biết mình đang đánh đổi cái gì: token người dùng mở được
# MỌI page của tài khoản. Hẹp hơn là `PANCAKE_PAGE_ACCESS_TOKEN` (chỉ một page), sinh bằng
# `scripts/pancake-page-token.sh`. Ở giai đoạn này chủ shop chọn dùng token hiện có thay vì sinh
# thêm chứng thư mới — và lượt nạp luôn truyền `--page=<id>` nên chỉ một page bị chạm tới.
#
# Script KHÔNG in token. Nó in độ dài, và bốn ký tự cuối để đối chiếu khi cần.
set -euo pipefail

DIR="${STAGING_DIR:-/opt/vnx-ai-staging}"
ENV_FILE="$DIR/.env.staging"
say() { printf '%s\n' "$*"; }

[ -n "${PANCAKE_ACCESS_TOKEN:-}" ] || { say "✗ Không có PANCAKE_ACCESS_TOKEN trong môi trường (đặt ở GitHub Actions Secrets)."; exit 1; }
[ -n "${PANCAKE_PAGE_ID:-}" ]      || { say "✗ Không có PANCAKE_PAGE_ID (truyền qua ô \"arg\" — mã page không phải bí mật)."; exit 1; }
[ -f "$ENV_FILE" ]                 || { say "✗ Chưa có $ENV_FILE — chạy thao tác ai-staging-up trước."; exit 1; }

upsert() {
  KEY="$1" VALUE="$2" FILE="$ENV_FILE" python3 - <<'PY'
import os
key, value, path = os.environ["KEY"], os.environ["VALUE"], os.environ["FILE"]
# Dùng python chứ không `sed`: giá trị là chuỗi tuỳ ý và có thể chứa ký tự phân tách của sed.
lines = open(path, encoding="utf-8").read().splitlines(True)
hit = False
out = []
for line in lines:
    if line.startswith(f"{key}="):
        out.append(f'{key}="{value}"\n'); hit = True
    else:
        out.append(line)
if not hit:
    out.append(f'{key}="{value}"\n')
open(path, "w", encoding="utf-8").write("".join(out))
PY
}

upsert PANCAKE_ACCESS_TOKEN "$PANCAKE_ACCESS_TOKEN"
upsert PANCAKE_PAGE_ID "$PANCAKE_PAGE_ID"

# KHOÁ POS — CHỈ để đồng bộ DANH MỤC SẢN PHẨM vào CSDL riêng của bản chạy thử.
#
# Vì sao cần: nhân sự AI khớp sản phẩm qua cổng công cụ `product.search`, và CSDL bản chạy thử là
# CSDL TRẮNG. Không có danh mục thì mọi hội thoại đều rơi về "không nhận ra sản phẩm" và lượt chạy
# thử không nói lên điều gì về chất lượng nhận diện — nó chỉ chứng minh bảng sản phẩm đang rỗng.
#
# Job `pancake-products` CHỈ ĐỌC từ Pancake POS và CHỈ GHI vào CSDL bản chạy thử. Không đụng CSDL
# production, không gọi một endpoint ghi nào của Pancake.
if [ -n "${PANCAKE_API_KEY:-}" ]; then
  upsert PANCAKE_API_KEY "$PANCAKE_API_KEY"
  say "  PANCAKE_API_KEY      = (${#PANCAKE_API_KEY} ký tự) — để đồng bộ danh mục sản phẩm"
fi
[ -n "${PANCAKE_SHOP_ID:-}" ] && upsert PANCAKE_SHOP_ID "$PANCAKE_SHOP_ID"

chmod 600 "$ENV_FILE"

say "Đã ghi vào $ENV_FILE (quyền $(stat -c '%a' "$ENV_FILE"), chủ sở hữu $(stat -c '%U' "$ENV_FILE")):"
say "  PANCAKE_PAGE_ID      = $PANCAKE_PAGE_ID"
say "  PANCAKE_ACCESS_TOKEN = (${#PANCAKE_ACCESS_TOKEN} ký tự, bốn ký tự cuối …${PANCAKE_ACCESS_TOKEN: -4})"
say ""
say "── Kiểm chứng trên đĩa ──"
say "  số dòng khai hai khoá: $(grep -cE '^PANCAKE_(ACCESS_TOKEN|PAGE_ID)=' "$ENV_FILE")  (mong đợi 2)"
say "  tệp có nằm trong kho mã không: $(cd "$DIR" && git check-ignore -q .env.staging && echo 'KHÔNG — .gitignore đã loại' || echo '!!! CÓ — PHẢI SỬA NGAY')"
say "  git status có thấy tệp không: $(cd "$DIR" && git status --porcelain --ignored=no -- .env.staging | wc -l) dòng (mong đợi 0)"
