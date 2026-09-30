#!/bin/sh
# ═══════════════ LƯU MỘT ĐOẠN WAL — `archive_command` CỦA erp-db (PITR) ═══════════════
#
# Postgres gọi:  /bin/sh /erp-pitr-bin/luu-wal.sh %p %f   (docker-compose.prod.yml, dịch vụ `db`)
#   %p = đường tới đoạn WAL trong pg_wal (tương đối với thư mục dữ liệu), %f = tên tệp.
# Tệp này chạy BÊN TRONG container postgres:16-alpine: chỉ có busybox `sh`, KHÔNG có bash ⇒ POSIX sh thuần.
# `tests/pitr.test.ts` chạy nó bằng `sh` thật (dash trên CI Linux) với tệp WAL giả.
#
# LUẬT — mỗi mã thoát là một lời hứa với Postgres:
#   thoát 0  = "đoạn này đã nằm an toàn ở kho" ⇒ Postgres được phép tái dùng / xoá nó trong pg_wal.
#   thoát ≠0 = "chưa" ⇒ Postgres GIỮ đoạn trong pg_wal, thử lại sau ~1 phút, `pg_stat_archiver.failed_count` tăng.
#
#  1. IDEMPOTENT: đích đã có và giải nén ra CÙNG nội dung ⇒ 0 (lượt thử lại sau sự cố). Đích có mà KHÁC nội dung ⇒ ≠0
#     và KHÔNG BAO GIỜ ghi đè — hai cụm cùng ghi một kho, hay timeline lệch, phải lộ ra chứ không được xoá bằng chứng.
#     Ghi bằng tệp tạm + `ln` (không ghi đè nếu đích xuất hiện giữa chừng), fsync trước khi trả 0.
#  2. PHANH TAY: có tệp `.tam-dung` trong kho (ops `pitr-pause`) ⇒ BỎ đoạn, ghi một dòng vào `.lo-hong.log`, thoát 0.
#     Không cần khởi động lại Postgres, không cần ALTER SYSTEM. Chuỗi PITR ĐỨT từ đây tới bản nền kế tiếp.
#  3. SÀN Ổ TRỐNG (SAN_O_TRONG_MB): ổ còn dưới sàn ⇒ BỎ đoạn + ghi lỗ hổng + thoát 0. Đây là lựa chọn CÓ CHỦ Ý giữa hai
#     cái xấu: thoát ≠0 thì Postgres giữ đoạn trong pg_wal — CÙNG ổ đĩa, lại chưa nén — nên ổ vẫn đầy, chỉ chậm hơn,
#     và tới 0 byte thì Postgres PANIC: production sập. Mất độ phủ PITR rẻ hơn mất production. Không im lặng: dòng
#     lỗ hổng + stderr vào log Postgres + ops `pitr-status` đỏ "chuỗi WAL đứt".
#  4. TRẦN KHO (TRAN_KHO_WAL_MB): kho WAL vượt trần ⇒ thoát ≠0 (lỗi NHÌN THẤY ĐƯỢC ở pg_stat_archiver) trong lúc ổ còn
#     chỗ — đó là cảnh báo SỚM, trước khi phải chạm tới sàn ở điều 3. Dọn kho = bản nền mới (xoay vòng xoá WAL cũ).
#  5. Không bao giờ in dữ liệu: chỉ tên đoạn WAL (hex) và con số.
set -u

KHO_WAL="${ERP_PITR_WAL_DIR:-/pitr/wal}"
TRAN_KHO_WAL_MB=8192      # ƯỚC LƯỢNG ban đầu — WAL/ngày của production CHƯA ĐO; đo 24 giờ sau khi bật rồi chỉnh (docs §9.4)
SAN_O_TRONG_MB=1536       # dưới mức này thì bỏ đoạn thay vì để pg_wal làm đầy ổ (thấp hơn hẳn ngưỡng 3000 MB của deploy/sao lưu)
CO_TAM_DUNG=".tam-dung"
SO_LO_HONG=".lo-hong.log"

bao_loi() { printf 'erp-pitr luu-wal: %s\n' "$*" >&2; }
ghi_lo_hong() { # $1=tên đoạn $2=lý do
  printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >> "$KHO_WAL/$SO_LO_HONG" 2>/dev/null || true
}

if [ "$#" -ne 2 ]; then
  bao_loi "cần đúng hai tham số (%p %f), nhận $#"
  exit 2
fi
NGUON="$1"
TEN="$2"

# Tên phải là một tệp WAL thật: đoạn (24 hex), .partial, .history, .backup. Tên lạ không bao giờ đi vào một đường dẫn.
case "$TEN" in
  '' | *[!0-9A-Za-z.]*) bao_loi "tên tệp WAL lạ — từ chối"; exit 2 ;;
esac
if ! printf '%s\n' "$TEN" | grep -Eq '^([0-9A-F]{24}(\.partial)?|[0-9A-F]{8}\.history|[0-9A-F]{24}\.[0-9A-F]{8}\.backup)$'; then
  bao_loi "tên tệp WAL lạ ($TEN) — từ chối"
  exit 2
fi
if [ ! -f "$NGUON" ]; then
  bao_loi "không thấy tệp nguồn của $TEN"
  exit 1
fi
if [ ! -d "$KHO_WAL" ]; then
  bao_loi "không thấy kho WAL $KHO_WAL (bind mount /root/backups/pitr hỏng?) — CHƯA lưu $TEN"
  exit 1
fi
DICH="$KHO_WAL/$TEN.gz"

# Nội dung giải nén của đích có TRÙNG tệp nguồn không. Không có pipefail trong sh: gzip hỏng giữa chừng ⇒ cmp thấy
# ngắn hơn ⇒ khác ⇒ trả 1. Đúng chiều an toàn.
trung_noi_dung() { gzip -dc "$1" 2>/dev/null | cmp -s - "$2"; }

# 1 · ĐÃ CÓ
if [ -e "$DICH" ]; then
  if trung_noi_dung "$DICH" "$NGUON"; then
    exit 0
  fi
  bao_loi "$TEN.gz ĐÃ CÓ trong kho với nội dung KHÁC — KHÔNG ghi đè. Kiểm: hai cụm cùng ghi một kho? timeline lệch?"
  exit 1
fi

# 2 · PHANH TAY
if [ -e "$KHO_WAL/$CO_TAM_DUNG" ]; then
  ghi_lo_hong "$TEN" TAM_DUNG
  bao_loi "đang TẠM DỪNG lưu WAL ($CO_TAM_DUNG) — bỏ $TEN; chuỗi PITR ĐỨT tại đây"
  exit 0
fi

# 3 · SÀN Ổ TRỐNG — không đọc được ⇒ CHƯA BIẾT ⇒ không lưu, Postgres thử lại (không phải "còn chỗ")
TRONG_KB="$(df -Pk "$KHO_WAL" 2>/dev/null | awk 'NR==2 {print $4}')"
case "$TRONG_KB" in
  '' | *[!0-9]*) bao_loi "không đọc được dung lượng trống của $KHO_WAL — CHƯA lưu $TEN"; exit 1 ;;
esac
if [ "$TRONG_KB" -lt $((SAN_O_TRONG_MB * 1024)) ]; then
  ghi_lo_hong "$TEN" O_DAY
  bao_loi "ổ còn $((TRONG_KB / 1024)) MB < sàn $SAN_O_TRONG_MB MB — BỎ $TEN để Postgres tái dùng pg_wal thay vì làm đầy ổ; chuỗi PITR ĐỨT tại đây"
  exit 0
fi

# 4 · TRẦN KHO
DUNG_KB="$(du -sk "$KHO_WAL" 2>/dev/null | awk '{print $1}')"
case "$DUNG_KB" in
  '' | *[!0-9]*) bao_loi "không đọc được dung lượng kho WAL — CHƯA lưu $TEN"; exit 1 ;;
esac
if [ "$DUNG_KB" -gt $((TRAN_KHO_WAL_MB * 1024)) ]; then
  bao_loi "kho WAL đã $((DUNG_KB / 1024)) MB > trần $TRAN_KHO_WAL_MB MB — CHƯA lưu $TEN (Postgres giữ đoạn trong pg_wal và thử lại). Dọn bằng bản nền mới (ops pitr-basebackup) hoặc kéo phanh (ops pitr-pause)."
  exit 1
fi

# 5 · GHI: tệp tạm → fsync → `ln` (KHÔNG ghi đè) → fsync thư mục
TAM="$KHO_WAL/.$TEN.gz.dang-ghi.$$"
if ! gzip -c < "$NGUON" > "$TAM"; then
  rm -f "$TAM"
  bao_loi "gzip $TEN lỗi — CHƯA lưu"
  exit 1
fi
sync "$TAM" 2>/dev/null || sync
if ! ln "$TAM" "$DICH" 2>/dev/null; then
  # Đích xuất hiện giữa lúc ta ghi: chỉ nhận khi nó TRÙNG nội dung.
  rm -f "$TAM"
  if [ -e "$DICH" ] && trung_noi_dung "$DICH" "$NGUON"; then
    exit 0
  fi
  bao_loi "không đặt được $TEN.gz vào kho (đích xuất hiện với nội dung khác, hoặc lỗi ghi) — CHƯA lưu"
  exit 1
fi
rm -f "$TAM"
sync "$KHO_WAL" 2>/dev/null || sync
exit 0
