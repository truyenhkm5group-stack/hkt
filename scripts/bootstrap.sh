#!/usr/bin/env bash
# Khởi tạo ERP trên VPS mới bằng MỘT lệnh (chạy với quyền root):
#   curl -fsSL https://raw.githubusercontent.com/truyenhkm5group-stack/hkt/claude/fashion-erp-poscake-viettelpost-u97pgx/scripts/bootstrap.sh | bash
# Truyền sẵn cấu hình qua biến môi trường (xem scripts/install-vps.sh), ví dụ:
#   PANCAKE_API_KEY=... VIETTELPOST_API_KEY=... bash -c "$(curl -fsSL <url-bootstrap>)"
set -euo pipefail
REPO_URL="${ERP_REPO_URL:-https://github.com/truyenhkm5group-stack/hkt.git}"
BRANCH="${ERP_BRANCH:-claude/fashion-erp-poscake-viettelpost-u97pgx}"
DIR="${ERP_DIR:-/root/erp}"

if [ "$(id -u)" -ne 0 ]; then echo "Hãy chạy với quyền root (sudo -i rồi chạy lại)." >&2; exit 1; fi

install_pkg() {
  if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@";
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q "$@";
  elif command -v yum >/dev/null 2>&1; then yum install -y -q "$@";
  else echo "Không nhận ra trình quản lý gói, hãy cài thủ công: $*" >&2; exit 1; fi
}
command -v git >/dev/null 2>&1 || install_pkg git
command -v curl >/dev/null 2>&1 || install_pkg curl
command -v openssl >/dev/null 2>&1 || install_pkg openssl

if [ -d "$DIR/.git" ]; then
  echo "▶ Cập nhật mã nguồn tại $DIR"
  # Đặt thẳng về đúng commit của nhánh trên remote. Dùng "checkout -B" thay cho checkout+pull
  # để ĐỔI NHÁNH được (ví dụ từ nhánh phát triển sang main) kể cả khi máy chủ chưa có nhánh đó,
  # và để trạng thái máy chủ luôn khớp Git thay vì phụ thuộc trạng thái cũ trên máy.
  git -C "$DIR" fetch --quiet --prune origin
  git -C "$DIR" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
else
  echo "▶ Tải mã nguồn về $DIR"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$DIR"
fi

cd "$DIR"
exec bash scripts/install-vps.sh
