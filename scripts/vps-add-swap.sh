#!/usr/bin/env bash
# ───────────── THÊM SWAP CHO VPS — IDEMPOTENT, KHÔNG ĐỤNG CONTAINER NÀO ─────────────
#
#   bash scripts/vps-add-swap.sh [dung-lượng-GB]     (mặc định 2)
#
# VÌ SAO. Đo 14/09/2026: VPS 1.963 MB RAM, 949 MB khả dụng, **SWAP = 0**. Không swap nghĩa là nhân
# không có đệm: hết RAM là nó gọi OOM killer NGAY, và OOM killer chọn tiến trình lớn nhất — đang là
# ERP phục vụ khách. Một tệp swap 2 GB không làm máy nhanh hơn; nó làm cho lúc thiếu RAM máy CHẬM
# lại thay vì có một tiến trình bị giết.
#
# BA ĐIỀU SCRIPT NÀY KHÔNG LÀM: không dừng/khởi động lại container nào, không khởi động lại máy,
# không chạm CSDL. Bật swap là một lời gọi `swapon` — nhân nhận ngay, không cần khởi động lại gì.
#
# CHẠY LẠI ĐƯỢC. Đã có swap thì báo và thoát 0, không tạo tệp thứ hai.
set -euo pipefail

GB="${1:-2}"
FILE="${SWAP_FILE:-/swapfile}"
say() { printf '%s\n' "$*"; }

say "═════════ TRƯỚC KHI ĐỔI ═════════"
free -h
say ""
say "── swap đang có ──"
swapon --show || say "  (chưa có swap nào)"
say ""
say "── đĩa ──"
df -h /

# ── 1. ĐÃ CÓ SWAP THÌ DỪNG. Hai tệp swap không tốt hơn một, và chồng lên nhau là một cách hỏng. ──
if [ -n "$(swapon --show --noheadings 2>/dev/null || true)" ]; then
  say ""
  say "✓ Máy ĐÃ CÓ swap — không tạo thêm. Không làm gì cả."
  swapon --show
  exit 0
fi
if [ -e "$FILE" ]; then
  say ""
  say "✗ $FILE đã tồn tại nhưng KHÔNG được bật làm swap. Dừng để người kiểm — ghi đè một tệp lạ"
  say "  có thể là ghi đè dữ liệu của ai đó."
  ls -lh "$FILE"
  exit 1
fi

# ── 2. ĐỦ ĐĨA CHƯA. Tạo swap mà hết đĩa là đổi một sự cố lấy một sự cố khác (sự cố #242). ──
CAN_MB=$(( GB * 1024 + 1024 ))            # dung lượng swap + 1 GB dự phòng
CON_MB=$(df -BM --output=avail / | tail -1 | tr -dc '0-9')
if [ "$CON_MB" -lt "$CAN_MB" ]; then
  say ""
  say "✗ Chỉ còn ${CON_MB} MB đĩa, cần ít nhất ${CAN_MB} MB. DỪNG."
  exit 1
fi

say ""
say "═════════ TẠO SWAP ${GB} GB TẠI $FILE ═════════"
# `fallocate` tức thì; máy nào không hỗ trợ (một số hệ tệp) thì lùi về `dd` — chậm hơn nhưng chắc.
if ! fallocate -l "${GB}G" "$FILE" 2>/dev/null; then
  say "  fallocate không dùng được, lùi về dd (chậm hơn, vài chục giây)…"
  dd if=/dev/zero of="$FILE" bs=1M count=$(( GB * 1024 )) status=none
fi
# 600 TRƯỚC khi mkswap: tệp swap chứa ảnh bộ nhớ của mọi tiến trình. Quyền rộng là đọc trộm được.
chmod 600 "$FILE"
mkswap "$FILE" >/dev/null
swapon "$FILE"
say "  đã bật."

# ── 3. SỐNG QUA KHỞI ĐỘNG LẠI ──
if grep -qE "^[^#]*[[:space:]]$FILE[[:space:]]" /etc/fstab 2>/dev/null || grep -qE "^$FILE[[:space:]]" /etc/fstab 2>/dev/null; then
  say "  /etc/fstab đã có dòng cho $FILE — không thêm trùng."
else
  cp /etc/fstab "/etc/fstab.bak-$(date +%s)"
  printf '%s none swap sw 0 0\n' "$FILE" >> /etc/fstab
  say "  đã ghi vào /etc/fstab (bản cũ lưu ở /etc/fstab.bak-*)."
fi

# ── 4. SWAPPINESS THẤP. Có swap rồi mà để mặc định 60 thì nhân sẽ đẩy CẢ trang của ERP ra đĩa khi
#      rảnh, và trang đầu tiên khách chạm vào sẽ chậm. 10 = "chỉ dùng swap khi thật sự cần". ──
CUR_SW=$(cat /proc/sys/vm/swappiness 2>/dev/null || echo "?")
if [ "$CUR_SW" != "10" ]; then
  sysctl -w vm.swappiness=10 >/dev/null
  if [ -d /etc/sysctl.d ]; then
    printf 'vm.swappiness=10\n' > /etc/sysctl.d/99-vnx-swappiness.conf
    say "  vm.swappiness: $CUR_SW → 10 (ghi /etc/sysctl.d/99-vnx-swappiness.conf để sống qua khởi động lại)."
  fi
fi

say ""
say "═════════ SAU KHI ĐỔI ═════════"
free -h
say ""
swapon --show
say ""
say "── dòng trong /etc/fstab ──"
grep -E "swap" /etc/fstab || say "  (không thấy — kiểm lại!)"
say ""
say "── đĩa còn lại ──"
df -h /
