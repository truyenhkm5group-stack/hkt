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

# Mạng từ VPS ra github.com chập chờn: 2 trong 3 lần deploy gần đây hỏng vì "Failed to connect
# to github.com port 443 after 130s". Không phải lỗi mã nguồn, nhưng làm deploy trượt và người
# vận hành phải tự bấm lại. Thử lại vài lần với thời gian chờ tăng dần, và đặt timeout để không
# treo hơn hai phút mỗi lần.
git_retry() {
  attempt=1
  while [ "$attempt" -le 4 ]; do
    if timeout 120 git "$@"; then return 0; fi
    echo "  ⚠ git $1 hỏng (lần $attempt/4) — thử lại sau $((attempt * 10))s"
    sleep $((attempt * 10))
    attempt=$((attempt + 1))
  done
  # HẾT ĐĨA TRÔNG HỆT MẤT MẠNG Ở ĐÂY — và #243 đã báo nhầm đúng như vậy: `git` chết với
    # "No space left on device" nhưng thông báo lại bảo đi kiểm tra mạng. Người trực mất thời gian
    # soi một đường mạng hoàn toàn bình thường. Nói đúng nguyên nhân thì rẻ hơn nhiều.
    DISK_FREE_MB="$(df -Pm /root 2>/dev/null | awk 'NR==2 {print $4}')"
    if [ "${DISK_FREE_MB:-9999}" -lt 500 ]; then
      echo "::error::HẾT Ổ ĐĨA (còn ${DISK_FREE_MB} MB) — git không ghi nổi, KHÔNG phải lỗi mạng."
      echo "         Chạy Actions → 'Vận hành ERP trên VPS' → docker-prune để giải phóng, rồi deploy lại."
      exit 1
    fi
    echo "::error::Không kết nối được github.com sau 4 lần thử. Kiểm tra mạng của VPS rồi chạy lại."
  return 1
}

if [ -d "$DIR/.git" ]; then
  echo "▶ Cập nhật mã nguồn tại $DIR"
  # Đặt thẳng về đúng commit của nhánh trên remote. Dùng "checkout -B" thay cho checkout+pull
  # để ĐỔI NHÁNH được (ví dụ từ nhánh phát triển sang main) kể cả khi máy chủ chưa có nhánh đó,
  # và để trạng thái máy chủ luôn khớp Git thay vì phụ thuộc trạng thái cũ trên máy.
  git_retry -C "$DIR" fetch --quiet --prune origin
  git -C "$DIR" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
else
  echo "▶ Tải mã nguồn về $DIR"
  git_retry clone --quiet --branch "$BRANCH" "$REPO_URL" "$DIR"
fi

cd "$DIR"

# ═════════════ BẢN ĐƯỢC KIỂM PHẢI LÀ BẢN ĐƯỢC TRIỂN KHAI ═════════════
#
# SỰ CỐ THẬT 09/09/2026: workflow chạy `tsc`/`npm test` trên commit lúc bấm chạy, nhưng đoạn
# trên đây lấy ĐỈNH NHÁNH LÚC KÉO. Khi hai phiên làm việc cùng đẩy lên `main`, phiên kia đẩy
# thêm 3 commit trong lúc deploy đang chạy — máy chủ nhận một bản mã KHÔNG commit nào kiểm qua.
# Deploy vẫn báo xanh vì không có bước nào đối chiếu hai con số đó.
#
# `ERP_DEPLOY_SHA` do workflow truyền vào, bằng đúng SHA mà bước kiểm thử đã chạy. Có nó thì
# đặt cây làm việc về ĐÚNG commit bất biến ấy; không có thì giữ hành vi cũ (cài tay trên VPS).
#
# Tên biến CỐ Ý khác `ERP_COMMIT` — `scripts/install-vps.sh` ghi `ERP_COMMIT` vào `.env` cho
# `/api/health`, trùng tên sẽ khiến hai vai trò khác nhau đè lên nhau.
if [ -n "${ERP_DEPLOY_SHA:-}" ]; then
  echo "▶ Ghim mã nguồn về đúng commit đã kiểm: $ERP_DEPLOY_SHA"
  # Commit có thể chưa nằm trong nhánh đã fetch (nhánh bị đẩy tiếp sau đó), nên lấy thẳng SHA.
  git_retry -C "$DIR" fetch --quiet origin "$ERP_DEPLOY_SHA"
  git -C "$DIR" checkout --quiet -B "$BRANCH" "$ERP_DEPLOY_SHA"

  ACTUAL="$(git -C "$DIR" rev-parse HEAD)"
  if [ "$ACTUAL" != "$ERP_DEPLOY_SHA" ]; then
    echo "::error::Ghim commit thất bại — yêu cầu $ERP_DEPLOY_SHA nhưng cây làm việc đang ở $ACTUAL."
    exit 1
  fi
  echo "  ✓ HEAD = $ACTUAL"
fi

exec bash scripts/install-vps.sh
