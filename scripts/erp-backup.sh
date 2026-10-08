#!/usr/bin/env bash
# ═══════════════════════ SAO LƯU ERP — MỘT TỆP, MỘT LUẬT ═══════════════════════
#
# HIỆN TRẠNG TRƯỚC TỆP NÀY (đo 24/09/2026): KHÔNG có sao lưu tự động. Chỉ có ops `backup` bấm tay
# ghi `pg_dump | gzip` ngay trên CHÍNH VPS — không bản ngoài máy, không xoay vòng, chưa từng thử
# khôi phục, và volume dữ liệu bot chat không được sao lưu. Ổ đĩa từng đầy 100% (sự cố #242).
# Một máy chủ hỏng ổ là mất TẤT CẢ: đơn, vận đơn, sổ tiền, lương.
#
# Tệp này là chỗ DUY NHẤT biết sao lưu làm thế nào. Cron, ops `backup`, ops `backup-status`,
# ops `restore-drill` và `install-vps.sh` đều gọi nó — không nơi nào viết lại một `pg_dump`.
#
#   erp-backup.sh run [--trigger=ops|manual]  sao lưu NGAY (ops `backup`) — vào thư mục manual/
#   erp-backup.sh cron                         cron gọi MỖI GIỜ; chỉ chạy trong khung thấp điểm,
#                                              mỗi ngày (giờ VN) đúng một bản vào daily/
#   erp-backup.sh status                       in trạng thái — KHÔNG in một dòng dữ liệu nào
#   erp-backup.sh restore-drill                khôi phục bản mới nhất vào container TẠM rồi đếm dòng
# >>> TỔ CHỨC KHÁC NHÀ
#   erp-backup.sh restore-drill-org [mã]       ops `restore-drill-org` (và lượt tuần bên dưới): khôi phục bản mới nhất của
#                                              MỘT CSDL erp_org_* vào CSDL TẠM `tam_khoiphuc_<mã>` trong container TẠM, đếm
#                                              bảng lõi, xoá container. Không mã ⇒ luân phiên (tổ chức diễn tập lâu nhất).
#   erp-backup.sh hourly-org                   cron gọi MỖI GIỜ (phút PHUT_CRON_GIO): dump -Fc MỌI CSDL erp_org_* vào
#                                              orgs/<csdl>/hourly/, giữ GIU_BAN_GIO bản — RPO ≤ 1 giờ cho tổ chức khách.
#                                              KHÔNG BAO GIỜ dump CSDL nhà (nhà giữ lịch đêm). Không có erp_org_* ⇒ thoát 0.
#   erp-backup.sh drill-org-weekly             cron gọi MỖI GIỜ (phút PHUT_CRON_DIEN_TAP); chỉ chạy Chủ nhật, khung
#                                              GIO_DIEN_TAP_* giờ VN, mỗi tuần một lượt `restore-drill-org` luân phiên.
# <<< TỔ CHỨC KHÁC NHÀ
#   erp-backup.sh install-cron                 cài /etc/cron.d/erp-backup (install-vps.sh gọi mỗi lần deploy)
#   erp-backup.sh configure-offsite            dựng cấu hình Google Drive + crypt từ Secrets/Variables mà
#                                              deploy truyền xuống (install-vps.sh gọi mỗi lần deploy)
#
# Trạng thái máy đọc được nằm ở $BACKUP_DIR/status/*.json. ERP mount thư mục đó CHỈ-ĐỌC và hiện
# lên trang Kết nối dữ liệu + Phòng Tech (lib/queries/backup-status.ts) — thất bại phải lộ ra chỗ
# người nhìn, không chỉ nằm trong một tệp log không ai mở.
set -euo pipefail

# ═══════════════ HẰNG SỐ — KHAI Ở ĐÚNG MỘT CHỖ NÀY ═══════════════
#
# `tests/backup.test.ts` đòi: phép xoay vòng chỉ được đọc các hằng số này, không gõ lại con số.
GIU_BAN_NGAY=7            # daily/: giữ 7 bản gần nhất (một bản mỗi ngày)
GIU_BAN_TUAN=4            # weekly/: giữ 4 bản Chủ nhật gần nhất
GIU_BAN_TAY=3             # manual/: giữ 3 bản bấm tay gần nhất (ops `backup`)
THU_BAN_TUAN=7            # thứ trong tuần theo giờ VN (`date +%u`): 7 = Chủ nhật ⇒ chép sang weekly/
GIO_BAT_DAU=2             # khung thấp điểm theo giờ VN: 02:00 …
GIO_KET_THUC=5            # … tới 05:59. Lượt hỏng lúc 02 giờ được thử lại lúc 03, 04, 05 giờ.
PHUT_CRON=17              # cron gọi phút 17 mỗi giờ (lệch khỏi phút 0, nơi mọi job khác dồn vào)
LECH_GIO_VN=25200         # UTC+7, Việt Nam không có giờ mùa hè. Tính tay để không phụ thuộc tzdata.
DU_TRU_O_DIA_MB=3000      # phải CÒN LẠI sau khi sao lưu — đúng ngưỡng cổng ổ đĩa của install-vps.sh
TOI_THIEU_UOC_TINH_MB=512 # lần đầu chưa có bản trước để ước lượng thì giả định chừng này
HE_SO_UOC_TINH=2          # bản mới ước = 2 × bản gần nhất (CSDL chỉ lớn dần)
TRAN_CHO_KHOA_GIAY=1800   # cùng trần với thao tác GHI của ops — deploy dài nhất vẫn nằm gọn trong đó
TRAN_LENH_GIAY=3600       # pg_dump / tar / rclone treo quá 1 giờ thì dừng hẳn, không treo cả đêm
TRAN_DO_DRIVE_GIAY=300    # một phép ĐO Google Drive (rclone about / size) — quá thì nói CHƯA ĐO ĐƯỢC, không treo lượt
TRAN_DON_THUNG_RAC_GIAY=900 # lệnh dọn thùng rác của thư mục sao lưu (cùng trần các lệnh dọn theo tuổi) — quá thì dọn dở, lượt sau dọn tiếp
# Xoay vòng phía Drive xoá HẲN, không qua thùng rác: rclone với Google Drive mặc định `--drive-use-trash=true`, và thùng
# rác VẪN tính vào hạn mức tới khi Google tự xoá (≤ 30 ngày) — sự cố 403 storageQuotaExceeded 08/10/2026, xem khối
# THÙNG RÁC GOOGLE DRIVE. Khai ĐÚNG MỘT chỗ; mọi `rclone delete` phía ngoài máy đọc nó. Remote không phải Drive bỏ qua cờ.
CO_KHONG_THUNG_RAC="--drive-use-trash=false"
RAM_TOI_THIEU_DIEN_TAP_MB=700
BO_NHO_DIEN_TAP=512m      # container diễn tập: VPS chỉ ~1,9 GB và đang phục vụ người dùng thật
BANG_DIEN_TAP="orders order_items shipments shipment_events expenses users customers products product_variants cod_statement_lines bank_transactions stock_receipts payroll_periods sync_runs"
LICH_MO_TA="hằng ngày, khung 02:00–05:59 giờ Việt Nam (cron phút ${PHUT_CRON} mỗi giờ; ngày nào xong thì thôi)"

DB_CONTAINER="erp-db"
BOT_CONTAINER="erp-chatbot"
BOT_VOLUME_KEY="chatbot_data"   # tên volume trong docker-compose.prod.yml (compose tự thêm tiền tố dự án)

ERP_DIR="${ERP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BACKUP_DIR="${ERP_BACKUP_DIR:-/root/backups}"
STATUS_DIR="$BACKUP_DIR/status"
LOCK_DIR="${ERP_LOCK_DIR:-/var/lock}"
TEP_CRON="${ERP_CRON_FILE:-/etc/cron.d/erp-backup}"
TEP_LOGROTATE="${ERP_LOGROTATE_FILE:-/etc/logrotate.d/erp-backup}"
TEP_LOG="${ERP_BACKUP_LOG:-/var/log/erp-backup.log}"
# Cấu hình nơi lưu ngoài máy (token Google Drive, mật khẩu crypt) — tệp RIÊNG, KHÔNG phải .env của ERP:
# compose nạp .env vào môi trường container app/scheduler (`env_file`), tức khoá Drive và mật khẩu
# giải mã mọi bản sao lưu sẽ nằm trong một tiến trình web không bao giờ cần tới chúng. Tệp này nằm
# NGOÀI cây mã (/root/erp) để không lệnh git nào chạm tới, thư mục 700, tệp 600.
TEP_NGOAI_MAY="${ERP_BACKUP_OFFSITE_ENV:-/root/.config/erp-backup/offsite.env}"
# Tên hai remote rclone dựng từ Secrets: `gdrive` (Google Drive, gốc = thư mục chủ shop chọn) và
# `gcrypt` (crypt bọc `gdrive:erp-backup`). Mọi bản đẩy đi qua `gcrypt:` — Drive chỉ thấy byte mã hoá.
REMOTE_DRIVE="gdrive"
REMOTE_CRYPT="gcrypt"
THU_MUC_TREN_DRIVE="erp-backup"

# Ổ khoá: DÙNG CHUNG với ops-vps.yml (xem khối "HÀNG ĐỢI NẰM TRÊN MÁY CHỦ" ở đầu tệp đó).
#   FD 7  erp-backup.lock           chống chạy chồng giữa các lượt sao lưu — KHÔNG CHỜ (-n)
#   FD 8  erp-readonly-db.lock      một lượt đọc nặng tại một thời điểm — ĐỘC QUYỀN
#   FD 9  erp-lifecycle.lock        container phải đứng yên (deploy chờ ta, ta chờ deploy) — CHIA SẺ
# Thứ tự LUÔN là 7 → 8 → 9, đúng thứ tự 8 → 9 của ops. FD 7 không bao giờ chờ nên không tạo được
# chu trình chờ với bất kỳ ai — đó là cả phần chứng minh không bế tắc.
KHOA_SAO_LUU="$LOCK_DIR/erp-backup.lock"
KHOA_DOC_DB="$LOCK_DIR/erp-readonly-db.lock"
KHOA_VONG_DOI="$LOCK_DIR/erp-lifecycle.lock"

# ═══════════════ TIỆN ÍCH ═══════════════

bao() { printf '[sao-lưu %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
loi() { printf '::error::[sao-lưu] %s\n' "$*"; }
gio_vn() { date -u -d "@$(( $(date +%s) + LECH_GIO_VN ))" "$@"; }
bay_gio_utc() { date -u +%FT%TZ; }

# Chuỗi JSON. Rỗng ⇒ null. Ký tự điều khiển bị bỏ, xuống dòng thành dấu cách.
js() {
  if [ -z "${1:-}" ]; then printf 'null'; return 0; fi
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="$(printf '%s' "$s" | tr '\n\r\t' '   ' | tr -d '\000-\037')"
  printf '"%s"' "$s"
}
# Số nguyên JSON. Không phải số ⇒ null (CHƯA BIẾT, không phải 0 — AGENTS.md mục 42).
jn() { case "${1:-}" in '' | *[!0-9]*) printf 'null' ;; *) printf '%s' "$1" ;; esac; }

# Ghi NGUYÊN TỬ: ERP đọc tệp này bất cứ lúc nào, không được thấy một tệp viết dở.
ghi_json() { # $1=tệp $2=nội dung
  local tam="$1.tam.$$"
  printf '%s\n' "$2" > "$tam"
  chmod 644 "$tam"
  mv -f "$tam" "$1"
}

o_trong_mb() { df -Pm "$1" 2>/dev/null | awk 'NR==2 {print $4}'; }
kich_thuoc() { stat -c %s "$1" 2>/dev/null || wc -c < "$1"; }
mb_cua() { echo $(( ($1 + 1048575) / 1048576 )); }

chuan_bi_thu_muc() {
  mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly" "$BACKUP_DIR/manual" "$STATUS_DIR"
  # Bản sao lưu chứa dữ liệu khách hàng và khoá của bot: chỉ root đọc được. Thư mục trạng thái thì
  # mở đọc — ERP mount nó chỉ-đọc, và trong đó KHÔNG có dữ liệu.
  chmod 700 "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly" "$BACKUP_DIR/manual"
  chmod 755 "$STATUS_DIR"
}

# Đọc cấu hình ngoài máy — CHỈ các khoá trong danh sách trắng, không `source` cả tệp (.env chứa mọi
# secret của ERP; nạp hết vào môi trường của pg_dump/rclone là mở rộng bán kính vô cớ).
# Thứ tự thắng: biến đã có sẵn trong môi trường → tệp ngoài máy do deploy dựng → .env (khai tay kiểu cũ).
#
# Khoá mang đuôi `_B64` được GIẢI MÃ base64 rồi nạp dưới tên bỏ đuôi, và bản thân khoá `_B64` không
# bao giờ được export. Lý do: token OAuth là JSON (`"`, `{`, `/`, `+`, `=` …) — ghi thô vào một dòng
# KEY=VALUE thì mỗi trình đọc (sed, dotenv, vòng đọc này) có một luật trích dẫn riêng, và một luật
# lệch là một token hỏng im lặng. Base64 chỉ có [A-Za-z0-9+/=]: không ai phải trích dẫn gì.
nap_tu_tep() { # $1=tệp
  local tep="$1" dong khoa gia_tri
  [ -f "$tep" ] || return 0
  while IFS= read -r dong || [ -n "$dong" ]; do
    dong="${dong%$'\r'}"
    case "$dong" in
      BACKUP_OFFSITE_REMOTE=* | RCLONE_CONFIG_*=*) ;;
      *) continue ;;
    esac
    khoa="${dong%%=*}"
    [[ "$khoa" =~ ^[A-Z0-9_]+$ ]] || continue
    gia_tri="${dong#*=}"
    gia_tri="${gia_tri#\"}"
    gia_tri="${gia_tri%\"}"
    case "$khoa" in
      *_B64)
        khoa="${khoa%_B64}"
        [ -z "${!khoa:-}" ] || continue
        if ! gia_tri="$(printf '%s' "$gia_tri" | base64 -d 2>/dev/null)" || [ -z "$gia_tri" ]; then
          loi "không giải mã được ${khoa}_B64 trong $tep — bỏ qua khoá này (không in giá trị)."
          continue
        fi
        ;;
      *) [ -z "${!khoa:-}" ] || continue ;;
    esac
    export "$khoa=$gia_tri"
  done < "$tep"
}

nap_cau_hinh() {
  nap_tu_tep "$TEP_NGOAI_MAY"
  nap_tu_tep "$ERP_DIR/.env"
}

# Nối remote với đường con: `gcrypt:` + `daily` ⇒ `gcrypt:daily` (KHÔNG phải `gcrypt:/daily` — với
# remote không kèm thư mục, dấu `/` đầu biến đường tương đối thành đường tuyệt đối ở vài backend).
noi_duong() { # $1=remote $2=đường con
  case "$1" in
    *:) printf '%s%s' "$1" "$2" ;;
    *) printf '%s/%s' "${1%/}" "$2" ;;
  esac
}

# ═══════════════ KHOÁ ═══════════════
#
# Ops `backup` / `restore-drill` đã CẦM FD 8 + 9 trước khi gọi tệp này (làn DOC_NANG). Tiến trình
# con thừa kế đúng hai file descriptor đó; mở lại tệp khoá thành một FD mới thì chính ta sẽ chờ
# khoá của cha mình tới hết giờ. Nên: FD đã trỏ đúng tệp khoá ⇒ dùng lại, KHÔNG xin lần hai (và
# không gọi `flock` lên nó — đổi chế độ trên FD thừa kế là hạ khoá của cha).
# `readlink -f` hai vế: trên Ubuntu /var/lock là liên kết tới /run/lock.
giu_khoa() { # $1=fd $2=tệp $3=-x|-s $4=trần giây
  local fd="$1" tep="$2" kieu="$3" tran="$4" t0
  if [ -e "/proc/$$/fd/$fd" ] && [ "$(readlink -f "/proc/$$/fd/$fd")" = "$(readlink -f "$tep")" ]; then
    bao "khoá $tep: tiến trình gọi đang cầm trên FD $fd — dùng lại"
    return 0
  fi
  mkdir -p "$(dirname "$tep")"
  eval "exec $fd>\"\$tep\""
  t0=$(date +%s)
  bao "khoá $tep: xin $kieu, trần ${tran}s"
  if flock "$kieu" -w "$tran" "$fd"; then
    bao "khoá $tep: ĐÃ LẤY sau $(( $(date +%s) - t0 ))s"
    return 0
  fi
  return 1
}

# Chống chạy chồng. KHÔNG CHỜ: lượt thứ hai tới lúc lượt đầu còn chạy/chờ thì nói ra và thoát.
khoa_chong_chong() {
  mkdir -p "$LOCK_DIR"
  exec 7>"$KHOA_SAO_LUU"
  flock -n 7
}

# ═══════════════ XOAY VÒNG ═══════════════
#
# Tên tệp mang mốc YYYYmmdd-HHMM giờ VN ⇒ thứ tự TÊN = thứ tự THỜI GIAN. Không tin mtime (chép,
# rsync, khôi phục đều làm đổi mtime). Không có gì để xoá là trạng thái BÌNH THƯỜNG — `|| true` ở
# phép lọc là bắt buộc dưới `set -euo pipefail` (đúng bài học deploy #244 của install-vps.sh).
xoay_vong() { # $1=thư mục $2=tiền tố (erp|chatbot) $3=số bản giữ
  local d="$1" tien_to="$2" giu="$3" ds f
  if ! [ "$giu" -ge 1 ] 2>/dev/null; then
    loi "xoay vòng $d: số bản giữ '$giu' không hợp lệ — KHÔNG xoá gì"
    return 1
  fi
  [ -d "$d" ] || return 0
  ds="$(ls -1 "$d" 2>/dev/null | grep -E "^${tien_to}-[0-9]{8}-[0-9]{4}\." || true)"
  [ -n "$ds" ] || return 0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    rm -f -- "${d:?}/$f"
    bao "xoay vòng: xoá $d/$f"
  done < <(printf '%s\n' "$ds" | sort -r | tail -n +"$((giu + 1))")
}

xoay_vong_tat_ca() {
  local tt
  for tt in erp chatbot; do
    xoay_vong "$BACKUP_DIR/daily" "$tt" "$GIU_BAN_NGAY"
    xoay_vong "$BACKUP_DIR/weekly" "$tt" "$GIU_BAN_TUAN"
    xoay_vong "$BACKUP_DIR/manual" "$tt" "$GIU_BAN_TAY"
  done
}

# Bản CSDL mới nhất trên đĩa, xét cả ba thư mục, theo MỐC TRONG TÊN.
ban_moi_nhat() {
  local d f tot="" ten_tot=""
  for d in daily weekly manual; do
    [ -d "$BACKUP_DIR/$d" ] || continue
    for f in "$BACKUP_DIR/$d"/erp-*.dump; do
      [ -f "$f" ] || continue
      if [ -z "$ten_tot" ] || [[ "$(basename "$f")" > "$ten_tot" ]]; then tot="$f"; ten_tot="$(basename "$f")"; fi
    done
  done
  printf '%s' "$tot"
}

# ═══════════════ KIỂM Ổ ĐĨA TRƯỚC KHI DUMP ═══════════════
#
# Cần = ước lượng bản mới + DỰ TRỮ cho deploy. Dự trữ không phải phòng xa: sao lưu làm đầy ổ thì
# lần deploy kế tiếp chết ở cổng ổ đĩa (install-vps.sh, 3000 MB) và bản sửa không lên được máy.
# In ra ĐỦ ba con số để người đọc log biết thiếu bao nhiêu, không phải chỉ "không đủ".
uoc_tinh_mb() {
  local ban bytes mb bot_mb=0 f
  ban="$(ban_moi_nhat)"
  if [ -n "$ban" ]; then
    bytes="$(kich_thuoc "$ban")"
    mb=$(( $(mb_cua "$bytes") * HE_SO_UOC_TINH ))
  else
    mb=$TOI_THIEU_UOC_TINH_MB
  fi
  for f in "$BACKUP_DIR"/daily/chatbot-*.tar.gz "$BACKUP_DIR"/manual/chatbot-*.tar.gz; do
    [ -f "$f" ] || continue
    bot_mb=$(mb_cua "$(kich_thuoc "$f")")
  done
  mb=$(( mb + bot_mb * HE_SO_UOC_TINH ))
  [ "$mb" -ge "$TOI_THIEU_UOC_TINH_MB" ] || mb=$TOI_THIEU_UOC_TINH_MB
  echo "$mb"
}

kiem_o_dia() { # đặt TU_DO_MB, CAN_MB; trả 1 khi không đủ
  TU_DO_MB="$(o_trong_mb "$BACKUP_DIR")"
  CAN_MB=$(( $(uoc_tinh_mb) + DU_TRU_O_DIA_MB ))
  if [ -z "$TU_DO_MB" ]; then
    LY_DO="Không đọc được dung lượng trống của $BACKUP_DIR (df lỗi) — KHÔNG dump khi không biết còn chỗ hay không."
    return 1
  fi
  if [ "$TU_DO_MB" -lt "$CAN_MB" ]; then
    LY_DO="Ổ đĩa còn ${TU_DO_MB} MB, cần ≥ ${CAN_MB} MB (ước bản mới $((CAN_MB - DU_TRU_O_DIA_MB)) MB + dự trữ ${DU_TRU_O_DIA_MB} MB để deploy còn chạy được) — KHÔNG dump để không làm đầy ổ. Chạy ops disk / docker-prune."
    return 1
  fi
  return 0
}

# ═══════════════ GHI TRẠNG THÁI ═══════════════

TRIGGER="manual"; BAT_DAU=""; KET_QUA=""; LY_DO=""; TU_DO_MB=""; CAN_MB=""
DB_FILE=""; DB_BYTES=""; DB_TABLES=""
BOT_STATE="NOT_RUN"; BOT_FILE=""; BOT_BYTES=""; BOT_REASON=""
OFFSITE_STATE="NOT_CONFIGURED"; OFFSITE_REMOTE=""; OFFSITE_REASON=""

noi_dung_trang_thai() {
  printf '{"schema":1,"kind":"backup","result":%s,"trigger":%s,"startedAt":%s,"finishedAt":%s,"reason":%s,' \
    "$(js "$KET_QUA")" "$(js "$TRIGGER")" "$(js "$BAT_DAU")" "$(js "$(bay_gio_utc)")" "$(js "$LY_DO")"
  printf '"freeMbBefore":%s,"needMb":%s,' "$(jn "$TU_DO_MB")" "$(jn "$CAN_MB")"
  printf '"db":{"file":%s,"bytes":%s,"tableData":%s},' "$(js "$DB_FILE")" "$(jn "$DB_BYTES")" "$(jn "$DB_TABLES")"
  printf '"chatbot":{"state":%s,"file":%s,"bytes":%s,"reason":%s},' "$(js "$BOT_STATE")" "$(js "$BOT_FILE")" "$(jn "$BOT_BYTES")" "$(js "$BOT_REASON")"
  printf '"offsite":{"state":%s,"remote":%s,"reason":%s},' "$(js "$OFFSITE_STATE")" "$(js "$OFFSITE_REMOTE")" "$(js "$OFFSITE_REASON")"
  printf '"retention":{"daily":%s,"weekly":%s,"manual":%s},"schedule":%s,"host":%s}' \
    "$GIU_BAN_NGAY" "$GIU_BAN_TUAN" "$GIU_BAN_TAY" "$(js "$LICH_MO_TA")" "$(js "$(hostname 2>/dev/null || true)")"
}

that_bai() { # lượt sao lưu THẤT BẠI: ghi trạng thái, nói to, thoát 1
  LY_DO="$1"
  KET_QUA="FAILED"
  loi "$LY_DO"
  mkdir -p "$STATUS_DIR"
  ghi_json "$STATUS_DIR/last-run.json" "$(noi_dung_trang_thai)"
  exit 1
}

# ═══════════════ BẢN NGOÀI MÁY ═══════════════
#
# Chọn DỊCH VỤ lưu trữ là quyết định của chủ shop (AGENTS.md mục 7) — tệp này không chọn giùm.
# Chưa khai ⇒ KHÔNG GIẢ VỜ: trạng thái ghi rõ CHƯA CÓ BẢN SAO NGOÀI MÁY, và ERP hiện nó thành cảnh báo.
#
# Không bao giờ `rclone sync`: sync làm bản ngoài máy GIỐNG bản trên máy, kể cả khi bản trên máy vừa
# bị xoá sạch — tức nó xoá đúng thứ bản ngoài máy sinh ra để giữ. Chỉ `copyto` rồi dọn theo TUỔI,
# và chỉ dọn SAU một lượt đẩy thành công (có bản mới thì bản cũ mới được đi).
day_ngoai_may() { # $1=thư mục con $2...=tệp cục bộ
  local sub="$1" f dich kt_xa kt_goc
  shift
  local remote="${BACKUP_OFFSITE_REMOTE:-}"
  if [ -z "$remote" ]; then
    OFFSITE_STATE="NOT_CONFIGURED"
    OFFSITE_REASON="CHƯA CÓ BẢN SAO NGOÀI MÁY — chưa khai BACKUP_OFFSITE_REMOTE; mọi bản sao lưu đang nằm trên chính VPS."
    bao "$OFFSITE_REASON"
    return 0
  fi
  OFFSITE_REMOTE="${remote%%:*}:"
  if ! command -v rclone >/dev/null 2>&1; then
    OFFSITE_STATE="FAILED"
    OFFSITE_REASON="Đã khai BACKUP_OFFSITE_REMOTE nhưng máy chưa cài rclone (deploy kế tiếp tự cài)."
    loi "$OFFSITE_REASON"
    return 0
  fi
  for f in "$@"; do
    [ -f "$f" ] || continue
    dich="$(noi_duong "$remote" "$sub/$(basename "$f")")"
    if ! timeout "$TRAN_LENH_GIAY" rclone copyto --retries 3 "$f" "$dich" 2>"$STATUS_DIR/.rclone.err"; then
      OFFSITE_STATE="FAILED"
      OFFSITE_REASON="rclone copyto lỗi cho $(basename "$f"): $(tail -n 1 "$STATUS_DIR/.rclone.err" 2>/dev/null || true)"
      loi "$OFFSITE_REASON"
      rm -f "$STATUS_DIR/.rclone.err"
      return 0
    fi
    # Đẩy xong phải ĐỌC LẠI kích thước ở đầu kia: "lệnh thoát 0" chưa phải "tệp nằm ở đó".
    kt_xa="$(timeout 300 rclone lsf --format s "$dich" 2>/dev/null | head -n 1 || true)"
    kt_goc="$(kich_thuoc "$f")"
    if [ "$kt_xa" != "$kt_goc" ]; then
      OFFSITE_STATE="FAILED"
      OFFSITE_REASON="Đầu kia báo $(basename "$f") nặng '${kt_xa:-không thấy}' byte, bản gốc $kt_goc byte."
      loi "$OFFSITE_REASON"
      return 0
    fi
    bao "ngoài máy: đã đẩy $(basename "$f") ($kt_goc byte) → $OFFSITE_REMOTE…/$sub/"
  done
  rm -f "$STATUS_DIR/.rclone.err"
  OFFSITE_STATE="OK"
  OFFSITE_REASON=""
  # Dọn theo TUỔI, suy từ đúng hằng số giữ lại ở trên (+1 ngày đệm). Chỉ tới được đây khi MỌI tệp của lượt đã lên đầu
  # kia và đọc lại đúng kích thước — mọi nhánh hỏng ở trên `return 0` trước: đẩy hỏng thì bản cũ ngoài máy KHÔNG bị đụng.
  # Xoá HẲN ("$CO_KHONG_THUNG_RAC"): thùng rác Google Drive vẫn tính dung lượng tới 30 ngày và đã làm đầy Drive
  # (08/10/2026, khối THÙNG RÁC GOOGLE DRIVE). Tệp bị chọn không đổi — vẫn đúng --min-age dưới đây.
  timeout 900 rclone delete "$(noi_duong "$remote" daily)" --min-age "$((GIU_BAN_NGAY + 1))d" "$CO_KHONG_THUNG_RAC" 2>/dev/null || true
  timeout 900 rclone delete "$(noi_duong "$remote" weekly)" --min-age "$((GIU_BAN_TUAN * 7 + 1))d" "$CO_KHONG_THUNG_RAC" 2>/dev/null || true
  timeout 900 rclone delete "$(noi_duong "$remote" manual)" --min-age "$((GIU_BAN_NGAY + 1))d" "$CO_KHONG_THUNG_RAC" 2>/dev/null || true
}

# ═══════════════ THÙNG RÁC GOOGLE DRIVE — ĐO DUNG LƯỢNG · DỌN THÙNG RÁC CỦA THƯ MỤC SAO LƯU ═══════════════
#
# SỰ CỐ 08/10/2026: ops `backup` dump + kiểm toàn vẹn ĐẠT trên VPS, nhưng `rclone copyto` lên Drive lỗi «Error 403: The
# user's Drive storage quota has been exceeded» — bản ngoài máy mới không lên được. Chính phép xoay vòng gây ra: rclone
# với Google Drive mặc định `--drive-use-trash=true`, nên mỗi `rclone delete` theo tuổi chỉ đưa tệp vào THÙNG RÁC, và
# thùng rác VẪN tính vào hạn mức tới khi Google tự xoá (≤ 30 ngày). Bản giờ của từng CSDL khác nhà, bản nền + WAL của
# PITR (scripts/erp-pitr.sh) rơi vào đó mỗi giờ / mỗi 15 phút.
#
# LUẬT CỦA KHỐI:
#  · Xoay vòng xoá HẲN: mọi `rclone delete` phía ngoài máy mang "$CO_KHONG_THUNG_RAC" (khai một chỗ ở đầu tệp). Tệp bị
#    chọn KHÔNG đổi — vẫn đúng `--min-age` suy từ hằng số giữ; chỉ đổi «vào thùng rác» thành «xoá hẳn».
#  · Thùng rác CŨ (xoay vòng trước bản vá để lại) được dọn ở mỗi lượt `run`, TRƯỚC bước đẩy — giải phóng chỗ cho bản
#    mới — và CHỈ dưới đúng thư mục mà crypt bọc ($REMOTE_DRIVE:$THU_MUC_TREN_DRIVE). Tệp đã-xoá ở đó đều do xoay vòng
#    xoá, tức đã quá hạn giữ; Google cũng sẽ tự xoá chúng. Lệnh dọn chỉ THẤY tệp trong thùng rác (`--drive-trashed-only`):
#    bản đang sống không bao giờ bị chạm, nên lượt đẩy sau đó có hỏng thì bản cũ ngoài máy vẫn còn nguyên.
#  · KHÔNG BAO GIỜ `rclone cleanup` / `rclone purge`: đây là Drive CÁ NHÂN của chủ shop — thùng rác chung có thể chứa tệp
#    riêng của họ (tests/backup.test.ts quét mã nguồn).
#  · LÁ CHẮN: đường đích chỉ được dựng khi cấu hình ĐÚNG là thứ configure-offsite dựng (BACKUP_OFFSITE_REMOTE là crypt,
#    crypt bọc đúng $REMOTE_DRIVE:$THU_MUC_TREN_DRIVE, remote kiểu drive, có thư mục gốc). Tên rỗng / lạ / lệch ⇒ KHÔNG
#    một lời gọi Drive nào, và nói rõ vì sao — một đường rỗng là GỐC Drive.
#  · Mọi phép đo có trần (TRAN_DO_DRIVE_GIAY); hỏng ⇒ in CHƯA ĐO ĐƯỢC kèm lý do, không làm đổ lượt sao lưu hay phần còn
#    lại của `status`. Dòng lỗi rclone in ra đã che ID thư mục gốc (log ops của kho PUBLIC). Phần của `status` CHỈ ĐỌC.
DRIVE_SAO_LUU=""; DRIVE_LY_DO=""; DO_RA=""; DO_LOI=""

# Đường thư mục sao lưu trên Drive — ĐÚNG thứ crypt bọc. Đặt DRIVE_SAO_LUU khi mọi điều kiện đúng; không thì đặt
# DRIVE_LY_DO và trả 1. Chuỗi rỗng / ký tự lạ kiểm TRƯỚC mọi thứ khác (và trước mọi phép thế gián tiếp `${!…}`).
xac_dinh_drive_sao_luu() {
  local goc bien_kieu bien_boc bien_goc
  DRIVE_SAO_LUU=""; DRIVE_LY_DO=""
  if [ -z "$REMOTE_DRIVE" ] || [ -z "$REMOTE_CRYPT" ] || [ -z "$THU_MUC_TREN_DRIVE" ]; then
    DRIVE_LY_DO="tên remote hoặc thư mục sao lưu trên Drive RỖNG — đường đích sẽ là GỐC Drive; không gọi Drive."
    return 1
  fi
  if ! [[ "$REMOTE_DRIVE" =~ ^[a-z][a-z0-9_]*$ ]] || ! [[ "$REMOTE_CRYPT" =~ ^[a-z][a-z0-9_]*$ ]] \
    || ! [[ "$THU_MUC_TREN_DRIVE" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]]; then
    DRIVE_LY_DO="tên remote / thư mục sao lưu trên Drive có ký tự lạ (chỉ nhận chữ, số, - và _; không /, không ..) — không gọi Drive."
    return 1
  fi
  goc="$REMOTE_DRIVE:$THU_MUC_TREN_DRIVE"
  bien_kieu="RCLONE_CONFIG_${REMOTE_DRIVE^^}_TYPE"
  bien_boc="RCLONE_CONFIG_${REMOTE_CRYPT^^}_REMOTE"
  bien_goc="RCLONE_CONFIG_${REMOTE_DRIVE^^}_ROOT_FOLDER_ID"
  if [ -z "${BACKUP_OFFSITE_REMOTE:-}" ]; then
    DRIVE_LY_DO="chưa khai BACKUP_OFFSITE_REMOTE — chưa có nơi lưu ngoài máy."
  elif [ "$BACKUP_OFFSITE_REMOTE" != "$REMOTE_CRYPT:" ]; then
    DRIVE_LY_DO="nơi lưu ngoài máy không phải $REMOTE_CRYPT: (Google Drive + crypt do deploy dựng) — không biết thùng rác nào là của sao lưu."
  elif [ "${!bien_kieu:-}" != "drive" ]; then
    DRIVE_LY_DO="remote $REMOTE_DRIVE: không phải Google Drive ($bien_kieu khác drive)."
  elif [ "${!bien_boc:-}" != "$goc" ]; then
    DRIVE_LY_DO="crypt $REMOTE_CRYPT: không bọc đúng $goc ($bien_boc lệch) — không chắc thư mục sao lưu nằm đâu."
  elif [ -z "${!bien_goc:-}" ]; then
    DRIVE_LY_DO="chưa khai thư mục gốc Drive ($bien_goc) — $REMOTE_DRIVE: sẽ là gốc My Drive."
  elif ! command -v rclone >/dev/null 2>&1; then
    DRIVE_LY_DO="máy chưa cài rclone."
  else
    DRIVE_SAO_LUU="$goc"
    return 0
  fi
  return 1
}

# Dòng lỗi CUỐI của rclone, đã che ID thư mục gốc Drive — lỗi 404 của Google in nguyên ID, và log ops của kho PUBLIC.
dong_loi_rclone() { # $1=tệp lỗi
  local d id="" bien=""
  d="$(tail -n 1 "$1" 2>/dev/null || true)"
  if [[ "$REMOTE_DRIVE" =~ ^[a-z][a-z0-9_]*$ ]]; then bien="RCLONE_CONFIG_${REMOTE_DRIVE^^}_ROOT_FOLDER_ID"; id="${!bien:-}"; fi
  [ -z "$id" ] || d="${d//"$id"/<thư mục gốc>}"
  printf '%s' "${d:-rclone không in lý do}"
}

# MỘT phép đo rclone, có trần thời gian. Đặt DO_RA (stdout) khi thành công; hỏng ⇒ DO_LOI nói vì sao (quá giờ, hoặc dòng
# lỗi cuối đã che ID) và trả 1. Gọi TRỰC TIẾP, không trong `$(…)` — tiến trình con không trả được hai biến về.
do_luong_drive() { # $@ = tham số rclone
  local tep_loi="" ma=0
  DO_RA=""; DO_LOI=""
  if ! tep_loi="$(mktemp 2>/dev/null)"; then DO_LOI="không tạo được tệp tạm"; return 1; fi
  DO_RA="$(timeout "$TRAN_DO_DRIVE_GIAY" rclone "$@" 2>"$tep_loi")" || ma=$?
  if [ "$ma" -eq 124 ]; then
    DO_LOI="quá ${TRAN_DO_DRIVE_GIAY} giây — CHƯA ĐO ĐƯỢC"
  elif [ "$ma" -ne 0 ]; then
    DO_LOI="$(dong_loi_rclone "$tep_loi")"
  fi
  rm -f "$tep_loi"
  if [ "$ma" -ne 0 ]; then DO_RA=""; return 1; fi
  return 0
}

# Số nguyên của MỘT khoá trong JSON phẳng rclone in ra (`about --json`, `size --json`), có thể âm (Free của Drive vượt hạn
# mức). Thiếu khoá ⇒ RỖNG = CHƯA BIẾT (AGENTS.md mục 42): Drive không giới hạn thì rclone bỏ hẳn total / free.
so_trong_json() { # $1=JSON $2=khoá
  local m
  m="$(printf '%s' "$1" | tr -d ' \t\r\n' | grep -o "\"$2\":-\{0,1\}[0-9]\{1,\}" | head -n 1 || true)"
  printf '%s' "${m#*:}"
}

# Byte ⇒ chữ đọc được: dưới 1 GB in MB (làm tròn LÊN như mb_cua — 1 KB không in thành 0), từ 1 GB in GB hai chữ số lẻ,
# dấu phẩy thập phân. Có thể âm. Không phải số ⇒ «—» (CHƯA BIẾT, không in thành 0 — AGENTS.md mục 42).
doc_byte() { # $1=byte
  local b="${1:-}" dau="" x
  case "$b" in -*) dau="-"; b="${b#-}" ;; esac
  case "$b" in '' | *[!0-9]*) printf '—'; return 0 ;; esac
  b=$((10#$b))
  [ "$b" -gt 0 ] || dau=""
  if [ "$b" -lt 1073741824 ]; then
    printf '%s%s MB' "$dau" "$(mb_cua "$b")"
  else
    x=$(( (b * 100 + 536870912) / 1073741824 ))
    printf '%s%s,%02d GB' "$dau" "$((x / 100))" "$((x % 100))"
  fi
}

# JSON của `rclone size --json` ⇒ "N tệp · X".
tep_va_byte() { # $1=JSON
  local n b
  n="$(so_trong_json "$1" count)"
  b="$(so_trong_json "$1" bytes)"
  printf '%s tệp · %s' "${n:-—}" "$(doc_byte "$b")"
}

# Chuỗi định danh (ID thư mục Drive…) ⇒ dạng ĐÃ CHE cho log công khai: 4 ký tự cuối + độ dài — đủ để đối chiếu với
# Variable, không đủ để dùng lại.
che_dinh_danh() { # $1
  local s="${1:-}"
  if [ -z "$s" ]; then printf 'chưa khai'; return 0; fi
  if [ "${#s}" -le 8 ]; then printf '(%s ký tự)' "${#s}"; return 0; fi
  printf '…%s (%s ký tự)' "${s: -4}" "${#s}"
}

# Lượt `run`: dọn thùng rác CỦA THƯ MỤC SAO LƯU trước khi đẩy. Không bao giờ làm đổ lượt sao lưu: mọi bước tự kiểm, hỏng
# thì nói ra rồi để bước đẩy chạy như cũ (Drive còn đầy thì lượt đẩy vẫn ghi ngoài máy FAILED như trước).
don_thung_rac_drive() {
  local n_truoc="" b_truoc="" n_sau="" b_sau="" tep_loi="" loi_xoa="" ma_xoa=0 truoc_chu="chưa đo được" sau_chu="chưa đo được" so='^[0-9]+$'
  if ! xac_dinh_drive_sao_luu; then
    bao "thùng rác Drive: KHÔNG dọn — $DRIVE_LY_DO"
    return 0
  fi
  # Hàng rào thứ hai, ngay chỗ dùng: đích phải là ĐÚNG MỘT thư mục dưới remote Drive — không gốc, không đường con.
  case "$DRIVE_SAO_LUU" in
    */* | "$REMOTE_DRIVE:") bao "thùng rác Drive: KHÔNG dọn — đích không phải đúng một thư mục dưới $REMOTE_DRIVE:"; return 0 ;;
    "$REMOTE_DRIVE:"?*) ;;
    *) bao "thùng rác Drive: KHÔNG dọn — đích không nằm dưới $REMOTE_DRIVE:"; return 0 ;;
  esac
  if do_luong_drive size --json --drive-trashed-only "$DRIVE_SAO_LUU"; then
    n_truoc="$(so_trong_json "$DO_RA" count)"
    b_truoc="$(so_trong_json "$DO_RA" bytes)"
  elif [[ "$DO_LOI" == *"directory not found"* ]]; then
    bao "thùng rác Drive: $DRIVE_SAO_LUU chưa có trên Drive (tạo ở lượt đẩy đầu tiên) — không có gì để dọn"
    return 0
  else
    bao "thùng rác Drive: chưa đo được thùng rác của $DRIVE_SAO_LUU trước khi dọn ($DO_LOI) — vẫn dọn"
  fi
  if [ "$n_truoc" = "0" ]; then
    bao "thùng rác Drive: $DRIVE_SAO_LUU không có tệp nào trong thùng rác — không có gì để dọn"
    return 0
  fi
  [[ "$n_truoc" =~ $so && "$b_truoc" =~ $so ]] && truoc_chu="$n_truoc tệp · $(doc_byte "$b_truoc")"
  bao "thùng rác Drive: xoá HẲN tệp trong thùng rác của $DRIVE_SAO_LUU ($truoc_chu) — chỉ thư mục sao lưu, không đụng thùng rác chung của Drive"
  tep_loi="$(mktemp 2>/dev/null || true)"
  [ -n "$tep_loi" ] || tep_loi="$STATUS_DIR/.rclone-thung-rac.err"
  timeout "$TRAN_DON_THUNG_RAC_GIAY" rclone delete "$DRIVE_SAO_LUU" --drive-trashed-only "$CO_KHONG_THUNG_RAC" 2>"$tep_loi" || ma_xoa=$?
  if [ "$ma_xoa" -eq 124 ]; then
    loi_xoa="quá ${TRAN_DON_THUNG_RAC_GIAY} giây — dọn dở, lượt sau dọn tiếp"
  elif [ "$ma_xoa" -ne 0 ]; then
    loi_xoa="$(dong_loi_rclone "$tep_loi")"
  fi
  rm -f "$tep_loi"
  if do_luong_drive size --json --drive-trashed-only "$DRIVE_SAO_LUU"; then
    n_sau="$(so_trong_json "$DO_RA" count)"
    b_sau="$(so_trong_json "$DO_RA" bytes)"
    [[ "$n_sau" =~ $so && "$b_sau" =~ $so ]] && sau_chu="$n_sau tệp · $(doc_byte "$b_sau")"
  fi
  if [[ "$n_truoc" =~ $so && "$b_truoc" =~ $so && "$n_sau" =~ $so && "$b_sau" =~ $so ]]; then
    bao "thùng rác Drive: đã xoá hẳn $((n_truoc - n_sau)) tệp · $(doc_byte "$((b_truoc - b_sau))") khỏi thùng rác của $DRIVE_SAO_LUU (còn lại $sau_chu)"
  else
    bao "thùng rác Drive: đã chạy lệnh dọn $DRIVE_SAO_LUU — trước: $truoc_chu · sau: $sau_chu"
  fi
  [ -z "$loi_xoa" ] || printf '::warning::[sao-lưu] thùng rác Drive: lệnh dọn báo lỗi — %s (bước đẩy vẫn chạy).\n' "$loi_xoa"
  return 0
}

# `status`: dung lượng Google Drive cả tài khoản + thư mục sao lưu (đang sống / trong thùng rác). Chỉ SỐ — không tên tệp,
# không ID thư mục, không một dòng dữ liệu. CHỈ ĐỌC (không một lệnh xoá). Không bao giờ làm đổ phần còn lại của `status`.
trang_thai_dung_luong_drive() {
  local tong="" dung="" rac="" khac="" trong=""
  echo
  echo "── Dung lượng Google Drive (đo lúc chạy, trần ${TRAN_DO_DRIVE_GIAY} giây mỗi phép) ──"
  if ! xac_dinh_drive_sao_luu; then
    echo "Không đo: $DRIVE_LY_DO"
    return 0
  fi
  if do_luong_drive about --json "$REMOTE_DRIVE:"; then
    tong="$(so_trong_json "$DO_RA" total)"
    dung="$(so_trong_json "$DO_RA" used)"
    rac="$(so_trong_json "$DO_RA" trashed)"
    khac="$(so_trong_json "$DO_RA" other)"
    trong="$(so_trong_json "$DO_RA" free)"
    echo "Cả tài khoản Google (rclone about $REMOTE_DRIVE:): Total $(doc_byte "$tong") · Used $(doc_byte "$dung") · Trashed $(doc_byte "$rac") · Other $(doc_byte "$khac") · Free $(doc_byte "$trong")"
    echo "  Trashed = thùng rác: Google VẪN tính vào hạn mức tới khi bị xoá hẳn (tự xoá sau 30 ngày) · Other = Gmail / Google Photos · «—» = Google không trả số (tài khoản không giới hạn)."
    case "$trong" in
      -* | 0) echo "⚠ Drive HẾT CHỖ (Free ≤ 0): mọi lượt đẩy lỗi 403 storageQuotaExceeded tới khi có chỗ — lượt backup kế tiếp dọn thùng rác của thư mục sao lưu TRƯỚC khi đẩy." ;;
    esac
  else
    echo "Cả tài khoản Google (rclone about $REMOTE_DRIVE:): KHÔNG ĐỌC ĐƯỢC — $DO_LOI"
  fi
  if do_luong_drive size --json "$DRIVE_SAO_LUU"; then
    echo "Thư mục sao lưu $DRIVE_SAO_LUU (tên đã mã hoá) · đang sống: $(tep_va_byte "$DO_RA")"
  else
    echo "Thư mục sao lưu $DRIVE_SAO_LUU · đang sống: KHÔNG ĐỌC ĐƯỢC — $DO_LOI"
  fi
  if do_luong_drive size --json --drive-trashed-only "$DRIVE_SAO_LUU"; then
    if [ "$(so_trong_json "$DO_RA" count)" = "0" ]; then
      echo "Thư mục sao lưu $DRIVE_SAO_LUU · trong thùng rác: $(tep_va_byte "$DO_RA")"
    else
      echo "Thư mục sao lưu $DRIVE_SAO_LUU · trong thùng rác: $(tep_va_byte "$DO_RA") — lượt backup / bản đêm kế tiếp xoá hẳn (CHỈ thùng rác của thư mục này)."
    fi
  else
    echo "Thư mục sao lưu $DRIVE_SAO_LUU · trong thùng rác: KHÔNG ĐỌC ĐƯỢC — $DO_LOI"
  fi
  return 0
}

# ═══════════════ DỮ LIỆU BOT CHAT ═══════════════
#
# Volume `chatbot_data` (cài đặt page, trạng thái tin, khoá của bot) — compose đặt tên thật là
# `<dự án>_chatbot_data`. HỎI container đang chạy xem volume nào gắn ở /data thay vì đoán tiền tố.
tim_volume_bot() {
  local v=""
  v="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$BOT_CONTAINER" 2>/dev/null || true)"
  if [ -z "$v" ]; then
    v="$(docker volume ls -q --filter "label=com.docker.compose.volume=$BOT_VOLUME_KEY" 2>/dev/null | head -n 1 || true)"
  fi
  printf '%s' "$v"
}

sao_luu_bot() { # $1=thư mục đích $2=mốc
  local dich="$1" moc="$2" vol anh tam
  vol="$(tim_volume_bot)"
  if [ -z "$vol" ]; then
    BOT_STATE="NOT_FOUND"
    BOT_REASON="Không tìm thấy volume $BOT_VOLUME_KEY (container $BOT_CONTAINER không chạy và không volume nào mang nhãn đó) — dữ liệu bot CHƯA được sao lưu."
    loi "$BOT_REASON"
    return 0
  fi
  anh="$(docker inspect -f '{{.Config.Image}}' "$DB_CONTAINER" 2>/dev/null || echo postgres:16-alpine)"
  BOT_FILE="chatbot-$moc.tar.gz"
  tam="$dich/.$BOT_FILE.dang-ghi"
  # Gắn volume CHỈ-ĐỌC vào một container dùng một lần, không mạng. Dùng lại ảnh của CSDL (đã có
  # sẵn trên máy, có busybox tar) — không kéo ảnh mới về một máy từng đầy ổ.
  if timeout "$TRAN_LENH_GIAY" docker run --rm --network none -v "$vol:/data:ro" "$anh" tar czf - -C /data . > "$tam" 2>"$STATUS_DIR/.bot.err" \
    && [ -s "$tam" ] && tar tzf "$tam" >/dev/null 2>&1; then
    chmod 600 "$tam"
    mv -f "$tam" "$dich/$BOT_FILE"
    BOT_BYTES="$(kich_thuoc "$dich/$BOT_FILE")"
    BOT_STATE="OK"
    bao "bot chat: $BOT_FILE ($BOT_BYTES byte) từ volume $vol"
  else
    rm -f "$tam"
    BOT_STATE="FAILED"
    BOT_REASON="tar volume $vol lỗi: $(tail -n 1 "$STATUS_DIR/.bot.err" 2>/dev/null || true)"
    BOT_FILE=""
    loi "$BOT_REASON"
  fi
  rm -f "$STATUS_DIR/.bot.err"
}

# >>> TỔ CHỨC KHÁC NHÀ ─────────────────────────────────────────────────────────────────────────
# ═══════════════ CSDL CỦA TỔ CHỨC KHÁC NHÀ (erp_org_*) — Phase 11 ═══════════════
#
# Nền tảng đa tổ chức SILO: tổ chức nhà ở CSDL `erp`, mỗi tổ chức khác một CSDL `erp_org_<mã, - thành _>`
# trên CÙNG container erp-db (`organizationDatabaseName`, db/index.ts). Trước khối này script chỉ dump
# `-d erp`: CSDL của tổ chức khác KHÔNG có bản sao nào, mất ổ là mất hẳn (docs/platform/backup-recovery.md).
#
# LUẬT CỦA KHỐI:
#  · Mọi thứ về tổ chức khác nằm giữa các cặp dấu `>>> TỔ CHỨC KHÁC NHÀ` / `<<< TỔ CHỨC KHÁC NHÀ`.
#    Phần của nhà KHÔNG đổi một byte — gỡ các khối có dấu ra là được nguyên văn bản trước Phase 11
#    (`tests/backup.test.ts` chạy lượt có / không có tổ chức và so tệp + trạng thái của nhà).
#  · Chạy SAU khi bản của nhà đã kiểm toàn vẹn, xoay vòng, đẩy ngoài máy và GHI TRẠNG THÁI xong: lỗi
#    của một tổ chức không chạm được bản của nhà.
#  · Được gọi trong ngữ cảnh `|| true` ⇒ bash TẮT `set -e` cho cả cây hàm bên dưới. Nên KHÔNG bước
#    nào dựa vào `set -e`: mọi bước có thể hỏng đều kiểm TƯỜNG MINH rồi `return 1`, và không một dòng
#    nào `exit` — một tổ chức hỏng thì ghi lỗi của nó rồi sang tổ chức kế tiếp.
#  · Danh sách lấy từ CHÍNH Postgres (`pg_database`), không từ cấu hình. Tên phải khớp
#    MAU_CSDL_TO_CHUC — tên lạ bị BỎ và nói ra, không bao giờ vào một đường dẫn hay một lệnh.
#  · Kiểm toàn vẹn THEO LOẠI: tổ chức dịch vụ không có đơn, nên không đòi orders/shipments — đòi các
#    bảng lõi mọi CSDL tổ chức đều có (BANG_LOI_TO_CHUC).
#  · Tệp, thư mục, trạng thái, đường Drive đều TÁCH theo tổ chức:
#      $BACKUP_DIR/orgs/<csdl>/{daily,weekly,manual}/<csdl>-YYYYmmdd-HHMM.dump
#      $STATUS_DIR/orgs/<csdl>/{last-run,last-success}.json  ·  $STATUS_DIR/orgs-last-run.json (tổng hợp)
#      <remote>orgs/<csdl>/{daily,weekly,manual}/
#    Tên tệp bắt đầu bằng `erp_org_` (gạch DƯỚI): glob `erp-*.dump` của `ban_moi_nhat` và mẫu xoay
#    vòng `^erp-[0-9]{8}` của nhà không bao giờ khớp, kể cả khi ai đó chép nhầm thư mục. Xoay vòng
#    đếm RIÊNG theo tiền tố từng CSDL — gộp chung thì bản của năm tổ chức đẩy bản của nhà ra khỏi 7 bản giữ.
#  · Không có CSDL `erp_org_*` nào (production 28/09/2026) ⇒ không ghi tệp nào, không đổi mã thoát.
MAU_CSDL_TO_CHUC='^erp_org_[a-z0-9_]+$'
BANG_LOI_TO_CHUC="public.users public.settings drizzle.__drizzle_migrations"
THU_MUC_TO_CHUC="$BACKUP_DIR/orgs"
STATUS_TO_CHUC="$STATUS_DIR/orgs"
TO_CHUC_HONG=""

# ─── LƯỢT GIỜ + DIỄN TẬP TUẦN (quyết định C4/C6/C7 của chủ nền tảng, 29/09/2026) ───
#
# «full backup hằng đêm; incremental/PITR mỗi giờ nếu hạ tầng DB hỗ trợ; target RPO <= 1 giờ; target RTO <= 4 giờ;
#  tự động restore drill mỗi tuần trên môi trường test, không restore đè production.»
#
# erp-db (postgres:16-alpine, docker-compose.prod.yml) chạy mặc định: wal_level=replica, archive_mode=off. Bật PITR
# thật cần đổi archive_mode = KHỞI ĐỘNG LẠI erp-db = gián đoạn production ⇒ đề xuất riêng cần cửa sổ bảo trì
# (docs/platform/backup-recovery.md §9). Trong lúc chờ: CSDL tổ chức khách NHỎ, nên một bản LOGIC (`pg_dump -Fc`)
# mỗi giờ đủ giữ RPO ≤ 1 giờ cho chúng mà không đụng cấu hình Postgres. CSDL NHÀ giữ nguyên lịch đêm — RPO của nhà
# vẫn ≤ 1 ngày cho tới khi có PITR (lượt giờ này KHÔNG BAO GIỜ dump `-d erp`; tests/backup.test.ts khoá).
GIU_BAN_GIO=48            # orgs/<csdl>/hourly/: giữ 48 bản giờ gần nhất (2 ngày), đếm riêng từng CSDL
PHUT_CRON_GIO=47          # lượt giờ: phút 47 — cách lượt đêm (phút 17) nửa giờ, lệch khỏi phút 0
TRAN_CHO_KHOA_GIO_GIAY=600 # lượt giờ chờ khoá đọc nặng / vòng đời tối đa 10 phút — quá thì bỏ lượt, giờ sau làm lại
PHUT_CRON_DIEN_TAP=37     # diễn tập tuần: cron gọi phút 37 mỗi giờ, script tự lọc Chủ nhật + khung dưới
GIO_DIEN_TAP_BAT_DAU=6    # Chủ nhật 06:00 … (SAU khung bản đêm 02:00–05:59 — diễn tập bản đêm vừa xong)
GIO_DIEN_TAP_KET_THUC=7   # … 07:59 giờ VN. Lượt bị bỏ vì thiếu RAM / khoá bận lúc 06 giờ được thử lại lúc 07.
LICH_GIO_MO_TA="mỗi giờ (phút ${PHUT_CRON_GIO}) cho CSDL tổ chức, cộng bản đêm 02:00–05:59 giờ Việt Nam"

ten_csdl_to_chuc_hop_le() { [[ "${1:-}" =~ $MAU_CSDL_TO_CHUC ]]; }
ten_tep_to_chuc() { printf '%s-%s.dump' "$1" "$2"; } # $1=csdl $2=mốc

# In các bảng lõi THIẾU dữ liệu trong mục lục `pg_restore --list` (rỗng = đủ). Here-string, không
# đường ống — cùng lý do SIGPIPE/pipefail với phép kiểm của nhà.
bang_loi_thieu() { # $1=mục lục
  local b thieu=""
  for b in $BANG_LOI_TO_CHUC; do
    grep -qF " TABLE DATA ${b%%.*} ${b#*.} " <<< "$1" || thieu="${thieu:+$thieu }$b"
  done
  printf '%s' "$thieu"
}

# Mỗi dòng một tên HỢP LỆ. Trả 1 khi không hỏi được Postgres — CHƯA BIẾT, không phải "không có tổ chức".
# Lời cảnh báo đi ra stderr: stdout của hàm LÀ danh sách.
liet_ke_csdl_to_chuc() {
  local ds ten
  ds="$(docker exec "$DB_CONTAINER" psql -U erp -d erp -Atc "select datname from pg_database where datname like 'erp\_org\_%' and not datistemplate order by 1" 2>/dev/null)" || return 1
  while IFS= read -r ten; do
    ten="${ten%$'\r'}"
    [ -n "$ten" ] || continue
    if ten_csdl_to_chuc_hop_le "$ten"; then
      printf '%s\n' "$ten"
    else
      loi "bỏ qua CSDL tên lạ $(printf '%q' "$ten") — không khớp $MAU_CSDL_TO_CHUC, KHÔNG sao lưu." >&2
    fi
  done <<< "$ds"
}

# Ước lượng như `uoc_tinh_mb` của nhà nhưng trên bản của CHÍNH tổ chức này (2 × bản gần nhất).
uoc_tinh_mb_to_chuc() { # $1=csdl
  local d f tot="" mb=$TOI_THIEU_UOC_TINH_MB
  for d in daily weekly manual hourly; do
    for f in "$THU_MUC_TO_CHUC/$1/$d/$1"-*.dump; do
      [ -f "$f" ] || continue
      if [ -z "$tot" ] || [[ "$(basename "$f")" > "$(basename "$tot")" ]]; then tot="$f"; fi
    done
  done
  [ -z "$tot" ] || mb=$(( $(mb_cua "$(kich_thuoc "$tot")") * HE_SO_UOC_TINH ))
  [ "$mb" -ge "$TOI_THIEU_UOC_TINH_MB" ] 2>/dev/null || mb=$TOI_THIEU_UOC_TINH_MB
  echo "$mb"
}

# Như `day_ngoai_may` nhưng đích là `orgs/<csdl>/…` và trạng thái ghi vào ORG_OFFSITE_* — KHÔNG đụng
# OFFSITE_* của nhà (trạng thái của nhà đã ghi xong trước khi khối này chạy).
day_ngoai_may_to_chuc() { # $1=csdl $2=thư mục con $3...=tệp cục bộ
  local csdl="$1" sub="$2" f dich kt_xa kt_goc remote="${BACKUP_OFFSITE_REMOTE:-}" tep_loi="$STATUS_DIR/.rclone-to-chuc.err"
  shift 2
  if [ -z "$remote" ]; then
    ORG_OFFSITE_STATE="NOT_CONFIGURED"
    ORG_OFFSITE_REASON="CHƯA CÓ BẢN SAO NGOÀI MÁY — chưa khai BACKUP_OFFSITE_REMOTE; bản của $csdl đang nằm trên chính VPS."
    return 0
  fi
  ORG_OFFSITE_REMOTE="${remote%%:*}:"
  if ! command -v rclone >/dev/null 2>&1; then
    ORG_OFFSITE_STATE="FAILED"
    ORG_OFFSITE_REASON="Đã khai BACKUP_OFFSITE_REMOTE nhưng máy chưa cài rclone (deploy kế tiếp tự cài)."
    return 0
  fi
  for f in "$@"; do
    [ -f "$f" ] || continue
    dich="$(noi_duong "$remote" "orgs/$csdl/$sub/$(basename "$f")")"
    if ! timeout "$TRAN_LENH_GIAY" rclone copyto --retries 3 "$f" "$dich" 2>"$tep_loi"; then
      ORG_OFFSITE_STATE="FAILED"
      ORG_OFFSITE_REASON="rclone copyto lỗi cho $(basename "$f"): $(tail -n 1 "$tep_loi" 2>/dev/null || true)"
      rm -f "$tep_loi"
      return 0
    fi
    kt_xa="$(timeout 300 rclone lsf --format s "$dich" 2>/dev/null | head -n 1 || true)"
    kt_goc="$(kich_thuoc "$f")"
    if [ "$kt_xa" != "$kt_goc" ]; then
      ORG_OFFSITE_STATE="FAILED"
      ORG_OFFSITE_REASON="Đầu kia báo $(basename "$f") nặng '${kt_xa:-không thấy}' byte, bản gốc $kt_goc byte."
      rm -f "$tep_loi"
      return 0
    fi
    bao "ngoài máy: đã đẩy $(basename "$f") ($kt_goc byte) → $ORG_OFFSITE_REMOTE…/orgs/$csdl/$sub/"
  done
  rm -f "$tep_loi"
  ORG_OFFSITE_STATE="OK"
  ORG_OFFSITE_REASON=""
  # Lượt giờ chỉ dọn thư mục hourly/ của chính nó — ba lệnh dọn bên dưới mỗi giờ là 72 lượt gọi Drive vô ích mỗi ngày.
  # Như của nhà: chỉ tới đây khi mọi tệp đã lên đầu kia, và xoá HẲN ("$CO_KHONG_THUNG_RAC") — bản giờ của mỗi CSDL rơi
  # vào thùng rác Drive mỗi giờ chính là thứ đã làm đầy Drive 08/10/2026.
  if [ "$sub" = "hourly" ]; then
    timeout 900 rclone delete "$(noi_duong "$remote" "orgs/$csdl/hourly")" --min-age "$((GIU_BAN_GIO + 1))h" "$CO_KHONG_THUNG_RAC" 2>/dev/null || true
    return 0
  fi
  timeout 900 rclone delete "$(noi_duong "$remote" "orgs/$csdl/daily")" --min-age "$((GIU_BAN_NGAY + 1))d" "$CO_KHONG_THUNG_RAC" 2>/dev/null || true
  timeout 900 rclone delete "$(noi_duong "$remote" "orgs/$csdl/weekly")" --min-age "$((GIU_BAN_TUAN * 7 + 1))d" "$CO_KHONG_THUNG_RAC" 2>/dev/null || true
  timeout 900 rclone delete "$(noi_duong "$remote" "orgs/$csdl/manual")" --min-age "$((GIU_BAN_NGAY + 1))d" "$CO_KHONG_THUNG_RAC" 2>/dev/null || true
}

# MỘT tổ chức: ổ đĩa → dump → kiểm toàn vẹn → (bản tuần) → xoay vòng → ngoài máy. Đặt ORG_*; trả 1
# khi KHÔNG có bản dùng được (ORG_LY_DO nói vì sao). Bản hỏng / dở bị xoá như luật của nhà.
sao_luu_mot_to_chuc() { # $1=csdl $2=mốc $3=thư mục con (daily|manual|hourly)
  local csdl="$1" moc="$2" sub="$3" goc thu_muc tam danh_sach thieu dong_loi tep_loi="$STATUS_DIR/.dump-to-chuc.err" tep_tuan=""
  ORG_FILE=""; ORG_BYTES=""; ORG_TABLES=""; ORG_LY_DO=""; ORG_TU_DO_MB=""; ORG_CAN_MB=""
  ORG_OFFSITE_STATE="NOT_RUN"; ORG_OFFSITE_REMOTE=""; ORG_OFFSITE_REASON=""
  ten_csdl_to_chuc_hop_le "$csdl" || { ORG_LY_DO="Tên CSDL không hợp lệ — không sao lưu."; return 1; }
  case "$sub" in daily | manual | hourly) ;; *) ORG_LY_DO="Thư mục con '$sub' không hợp lệ — không sao lưu."; return 1 ;; esac
  goc="$THU_MUC_TO_CHUC/$csdl"
  thu_muc="$goc/$sub"
  if ! mkdir -p "$goc/daily" "$goc/weekly" "$goc/manual" "$goc/hourly"; then
    ORG_LY_DO="Không tạo được thư mục $goc."; return 1
  fi
  chmod 700 "$THU_MUC_TO_CHUC" "$goc" "$goc/daily" "$goc/weekly" "$goc/manual" "$goc/hourly" 2>/dev/null || true

  ORG_TU_DO_MB="$(o_trong_mb "$BACKUP_DIR")"
  ORG_CAN_MB=$(( $(uoc_tinh_mb_to_chuc "$csdl") + DU_TRU_O_DIA_MB ))
  if [ -z "$ORG_TU_DO_MB" ]; then
    ORG_LY_DO="Không đọc được dung lượng trống của $BACKUP_DIR (df lỗi) — KHÔNG dump khi không biết còn chỗ hay không."; return 1
  fi
  if [ "$ORG_TU_DO_MB" -lt "$ORG_CAN_MB" ]; then
    ORG_LY_DO="Ổ đĩa còn ${ORG_TU_DO_MB} MB, cần ≥ ${ORG_CAN_MB} MB (ước bản mới $((ORG_CAN_MB - DU_TRU_O_DIA_MB)) MB + dự trữ ${DU_TRU_O_DIA_MB} MB) — KHÔNG dump $csdl."; return 1
  fi

  ORG_FILE="$(ten_tep_to_chuc "$csdl" "$moc")"
  tam="$thu_muc/.$ORG_FILE.dang-ghi"
  bao "pg_dump -Fc $csdl → $thu_muc/$ORG_FILE"
  if ! timeout "$TRAN_LENH_GIAY" docker exec "$DB_CONTAINER" pg_dump -U erp -d "$csdl" -Fc > "$tam" 2>"$tep_loi"; then
    dong_loi="$(tail -n 1 "$tep_loi" 2>/dev/null || true)"
    rm -f "$tam" "$tep_loi"; ORG_FILE=""
    ORG_LY_DO="pg_dump $csdl lỗi: ${dong_loi:-không có thông báo}"; return 1
  fi
  rm -f "$tep_loi"

  ORG_BYTES="$(kich_thuoc "$tam")"
  if ! [ "${ORG_BYTES:-0}" -gt 0 ] 2>/dev/null; then
    rm -f "$tam"; ORG_FILE=""
    ORG_LY_DO="Bản dump $csdl rỗng (0 byte) — đã xoá, KHÔNG tính là một bản sao lưu."; return 1
  fi
  if ! danh_sach="$(docker exec -i "$DB_CONTAINER" pg_restore --list < "$tam" 2>/dev/null)"; then
    rm -f "$tam"; ORG_FILE=""
    ORG_LY_DO="pg_restore --list không đọc được bản dump $csdl vừa tạo — bản hỏng đã xoá."; return 1
  fi
  ORG_TABLES="$(grep -c ' TABLE DATA ' <<< "$danh_sach" || true)"
  thieu="$(bang_loi_thieu "$danh_sach")"
  if [ -n "$thieu" ]; then
    rm -f "$tam"; ORG_FILE=""
    ORG_LY_DO="Mục lục bản dump $csdl thiếu dữ liệu bảng lõi: $thieu ($ORG_TABLES bảng có dữ liệu) — không phải một bản sao lưu dùng được."; return 1
  fi
  chmod 600 "$tam" 2>/dev/null || true
  if ! mv -f "$tam" "$thu_muc/$ORG_FILE"; then
    rm -f "$tam"; ORG_FILE=""
    ORG_LY_DO="Không đổi tên được bản dump $csdl vào $thu_muc."; return 1
  fi
  bao "CSDL tổ chức: $ORG_FILE — $ORG_BYTES byte, $ORG_TABLES bảng có dữ liệu, pg_restore đọc lại được"

  if [ "$TRIGGER" = "cron" ] && [ "$(gio_vn +%u)" = "$THU_BAN_TUAN" ]; then
    tep_tuan="$goc/weekly/$ORG_FILE"
    ln -f "$thu_muc/$ORG_FILE" "$tep_tuan" 2>/dev/null || cp -p "$thu_muc/$ORG_FILE" "$tep_tuan" 2>/dev/null || tep_tuan=""
  fi

  xoay_vong "$goc/daily" "$csdl" "$GIU_BAN_NGAY" || true
  xoay_vong "$goc/weekly" "$csdl" "$GIU_BAN_TUAN" || true
  xoay_vong "$goc/manual" "$csdl" "$GIU_BAN_TAY" || true
  xoay_vong "$goc/hourly" "$csdl" "$GIU_BAN_GIO" || true

  day_ngoai_may_to_chuc "$csdl" "$sub" "$thu_muc/$ORG_FILE"
  if [ -n "$tep_tuan" ] && [ "$ORG_OFFSITE_STATE" = "OK" ]; then
    day_ngoai_may_to_chuc "$csdl" weekly "$tep_tuan"
  fi
  return 0
}

noi_dung_trang_thai_to_chuc() { # $1=csdl $2=kết quả $3=lý do $4=bắt đầu
  printf '{"schema":1,"kind":"org-backup","database":%s,"result":%s,"trigger":%s,"startedAt":%s,"finishedAt":%s,"reason":%s,' \
    "$(js "$1")" "$(js "$2")" "$(js "$TRIGGER")" "$(js "$4")" "$(js "$(bay_gio_utc)")" "$(js "$3")"
  printf '"freeMbBefore":%s,"needMb":%s,' "$(jn "$ORG_TU_DO_MB")" "$(jn "$ORG_CAN_MB")"
  printf '"db":{"file":%s,"bytes":%s,"tableData":%s},' "$(js "$ORG_FILE")" "$(jn "$ORG_BYTES")" "$(jn "$ORG_TABLES")"
  printf '"offsite":{"state":%s,"remote":%s,"reason":%s},' "$(js "$ORG_OFFSITE_STATE")" "$(js "$ORG_OFFSITE_REMOTE")" "$(js "$ORG_OFFSITE_REASON")"
  printf '"retention":{"daily":%s,"weekly":%s,"manual":%s,"hourly":%s},"schedule":%s,"host":%s}' \
    "$GIU_BAN_NGAY" "$GIU_BAN_TUAN" "$GIU_BAN_TAY" "$GIU_BAN_GIO" "$(js "$LICH_GIO_MO_TA")" "$(js "$(hostname 2>/dev/null || true)")"
}

# Mọi tổ chức. Đặt TO_CHUC_HONG (rỗng = không tổ chức nào hỏng); trả 1 khi có. Gọi SAU khi trạng thái
# của nhà đã ghi, trong ngữ cảnh `|| true` — xem luật đầu khối.
sao_luu_cac_to_chuc() { # $1=mốc $2=thư mục con (daily|manual)
  local moc="$1" sub="$2" ds="" csdl ket ly_do bat_dau dang_ky ma ten json_ds="" thieu_json="" loi_liet_ke="" noi_dung n=0
  TO_CHUC_HONG=""
  if ! ds="$(liet_ke_csdl_to_chuc)"; then
    ds=""
    loi_liet_ke="Không liệt kê được CSDL erp_org_* (psql lỗi) — CHƯA BIẾT có tổ chức nào chưa được sao lưu."
    loi "$loi_liet_ke"
    TO_CHUC_HONG=" (không liệt kê được CSDL tổ chức)"
  fi
  # Đối chiếu sổ tổ chức: tổ chức đang ACTIVE/SUSPENDED mà KHÔNG có CSDL trên erp-db (CSDL ở máy khác
  # qua ORG_DATABASE_URL__<MÃ>, hoặc cấp dở) thì script này KHÔNG sao lưu được nó — nói ra, không im lặng.
  # Sổ không đọc được (CSDL nhà cũ chưa có bảng) thì bỏ qua phép đối chiếu, không coi là lỗi sao lưu.
  if [ -z "$loi_liet_ke" ] && dang_ky="$(docker exec "$DB_CONTAINER" psql -U erp -d erp -Atc "select code from platform_organizations where not is_home and status in ('ACTIVE','SUSPENDED') order by 1" 2>/dev/null)"; then
    while IFS= read -r ma; do
      ma="${ma%$'\r'}"
      [ -n "$ma" ] || continue
      ten="erp_org_${ma//-/_}"
      if ten_csdl_to_chuc_hop_le "$ten" && grep -qxF "$ten" <<< "$ds"; then continue; fi
      printf '::warning::[sao-lưu] tổ chức %s có trong sổ nhưng KHÔNG có CSDL %s trên %s — script này KHÔNG sao lưu được nó (CSDL ở máy khác cần lịch sao lưu riêng).\n' "$(printf '%q' "$ma")" "$(printf '%q' "$ten")" "$DB_CONTAINER"
      thieu_json="${thieu_json:+$thieu_json,}$(js "$ten")"
    done <<< "$dang_ky"
  fi
  if [ -z "$ds" ] && [ -z "$loi_liet_ke" ] && [ -z "$thieu_json" ]; then
    bao "tổ chức khác: không có CSDL erp_org_* nào — không làm gì thêm"
    return 0
  fi

  mkdir -p "$STATUS_TO_CHUC" 2>/dev/null && chmod 755 "$STATUS_TO_CHUC" 2>/dev/null || true
  while IFS= read -r csdl; do
    [ -n "$csdl" ] || continue
    n=$((n + 1))
    bat_dau="$(bay_gio_utc)"
    if sao_luu_mot_to_chuc "$csdl" "$moc" "$sub"; then
      if [ "$ORG_OFFSITE_STATE" = "FAILED" ]; then
        ket="PARTIAL"; ly_do="CSDL $csdl đã sao lưu và kiểm toàn vẹn; phần hỏng: bản ngoài máy."
        TO_CHUC_HONG="$TO_CHUC_HONG $csdl(ngoài máy)"
      else
        ket="OK"; ly_do=""
      fi
    else
      ket="FAILED"; ly_do="$ORG_LY_DO"
      TO_CHUC_HONG="$TO_CHUC_HONG $csdl"
      loi "$ly_do"
    fi
    noi_dung="$(noi_dung_trang_thai_to_chuc "$csdl" "$ket" "$ly_do" "$bat_dau")"
    if mkdir -p "$STATUS_TO_CHUC/$csdl" 2>/dev/null; then
      chmod 755 "$STATUS_TO_CHUC/$csdl" 2>/dev/null || true
      ghi_json "$STATUS_TO_CHUC/$csdl/last-run.json" "$noi_dung" || loi "không ghi được trạng thái của $csdl"
      [ "$ket" = "FAILED" ] || ghi_json "$STATUS_TO_CHUC/$csdl/last-success.json" "$noi_dung" || loi "không ghi được trạng thái của $csdl"
    else
      loi "không tạo được thư mục trạng thái của $csdl"
    fi
    json_ds="${json_ds:+$json_ds,}{\"database\":$(js "$csdl"),\"result\":$(js "$ket"),\"file\":$(js "$ORG_FILE"),\"bytes\":$(jn "$ORG_BYTES"),\"offsite\":$(js "$ORG_OFFSITE_STATE"),\"reason\":$(js "$ly_do")}"
    bao "tổ chức $csdl: $ket${ly_do:+ — $ly_do}"
  done <<< "$ds"

  ghi_json "$STATUS_DIR/orgs-last-run.json" "$(printf '{"schema":1,"kind":"org-backup-summary","trigger":%s,"finishedAt":%s,"listError":%s,"organizations":[%s],"missingDatabases":[%s]}' \
    "$(js "$TRIGGER")" "$(js "$(bay_gio_utc)")" "$(js "$loi_liet_ke")" "$json_ds" "$thieu_json")" || loi "không ghi được $STATUS_DIR/orgs-last-run.json"
  bao "TỔ CHỨC KHÁC: $n CSDL · hỏng:${TO_CHUC_HONG:- không}"
  [ -z "$TO_CHUC_HONG" ]
}

# `status`: phần tổ chức khác — trạng thái và bản trên máy, KHÔNG in một dòng dữ liệu nào.
trang_thai_to_chuc() {
  local d csdl tep sub
  echo
  echo "── CSDL tổ chức khác nhà (erp_org_*) ──"
  if [ -f "$STATUS_DIR/orgs-last-run.json" ]; then echo "orgs-last-run.json:"; cat "$STATUS_DIR/orgs-last-run.json"; else echo "orgs-last-run.json: (chưa có — chưa lượt sao lưu nào gặp CSDL erp_org_*)"; fi
  if [ -f "$STATUS_DIR/orgs-last-hourly.json" ]; then echo "orgs-last-hourly.json:"; cat "$STATUS_DIR/orgs-last-hourly.json"; else echo "orgs-last-hourly.json: (chưa có — chưa lượt giờ nào gặp CSDL erp_org_*)"; fi
  echo "Lượt giờ: $LICH_GIO_MO_TA · giữ $GIU_BAN_GIO bản giờ / CSDL · diễn tập tuần: Chủ nhật ${GIO_DIEN_TAP_BAT_DAU}:00–${GIO_DIEN_TAP_KET_THUC}:59 giờ VN, lượt gần nhất: $(cat "$STATUS_DIR/drill-org-week-done" 2>/dev/null || echo 'chưa có')"
  [ -d "$THU_MUC_TO_CHUC" ] || return 0
  for d in "$THU_MUC_TO_CHUC"/*/; do
    csdl="$(basename "$d")"
    ten_csdl_to_chuc_hop_le "$csdl" || continue
    echo "$csdl:"
    for tep in last-run.json last-hourly.json last-success.json last-drill.json; do
      if [ -f "$STATUS_TO_CHUC/$csdl/$tep" ]; then echo "  $tep: $(cat "$STATUS_TO_CHUC/$csdl/$tep")"; else echo "  $tep: (chưa có)"; fi
    done
    for sub in daily weekly manual hourly; do
      echo "  $sub/:"
      ls -lh "$d$sub" 2>/dev/null | sed '1d' | sed 's/^/    /' || true
    done
  done
  return 0
}

# ═══════════════ LỆNH: restore-drill-org — DIỄN TẬP KHÔI PHỤC MỘT CSDL TỔ CHỨC (CHẠY TAY) ═══════════════
#
# Cùng khuôn với `cmd_restore_drill` của nhà (container Postgres TẠM cùng ảnh, không mạng, không cổng, trần RAM; CSDL
# sống chỉ bị đọc `count(*)`), cho MỘT CSDL `erp_org_*`. Lý do có lệnh riêng thay vì nới lệnh của nhà: diễn tập của nhà
# không đổi một byte (xem BAM_PHAN_NHA), và thẻ của tổ chức chỉ tin diễn tập mang ĐÚNG tên CSDL của nó.
#
# LUẬT:
#  · Chạy tay (ops `restore-drill-org`) VÀ tự động mỗi tuần qua `drill-org-weekly` (quyết định C7 của chủ nền tảng,
#    29/09/2026): Chủ nhật sau bản đêm, luân phiên một CSDL. Không đường nào khác gọi nó (cmd_run / cmd_cron / lượt giờ).
#  · Đích khôi phục là CSDL TẠM `tam_khoiphuc_<mã>` BÊN TRONG container tạm — KHÔNG BAO GIỜ trên erp-db. Khối này không
#    có một lệnh `createdb` / `dropdb` / `pg_restore` / `alter database` nào nhắm vào $DB_CONTAINER.
#  · Tên tạm KHÔNG bắt đầu bằng `erp_org_`: lượt sao lưu đêm liệt kê `erp_org_%` và sẽ dump một CSDL tạm như một tổ chức
#    thật nếu nó lọt vào erp-db. Hai hàng rào độc lập: mẫu MAU_CSDL_TAM, và tên không được khớp MAU_CSDL_TO_CHUC.
#  · Dọn bằng trap EXIT — container (kèm volume) bị xoá cả khi diễn tập hỏng giữa chừng. Xoá container = xoá CSDL tạm.
#  · Không `exit`: mọi bước tự kiểm rồi `return` (luật khối). Trạng thái ghi vào status/orgs/<csdl>/last-drill.json
#    (kind `restore-drill`, mang tên CSDL) — ERP đọc đúng tệp này cho thẻ Sao lưu của tổ chức đó.
BANG_DIEN_TAP_TO_CHUC="public.users public.settings public.access_roles public.meta_objects public.meta_custom_fields public.meta_forms public.meta_list_views public.meta_pages public.workflow_rules public.blueprint_installs public.custom_records drizzle.__drizzle_migrations"
TIEN_TO_CSDL_TAM="tam_khoiphuc_"
MAU_CSDL_TAM='^tam_khoiphuc_[a-z0-9_]+$'
NHAN_DIEN_TAP_TO_CHUC="erp.restore-drill-org=1"
DRILL_TEN_TO_CHUC=""

# Mã tổ chức (a-z0-9-) hoặc tên CSDL erp_org_* ⇒ tên CSDL. Trả 1 khi không hợp lệ — không bao giờ đoán.
csdl_tu_ma_to_chuc() { # $1
  local v="${1:-}"
  if ten_csdl_to_chuc_hop_le "$v"; then printf '%s' "$v"; return 0; fi
  [[ "$v" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || return 1
  v="erp_org_${v//-/_}"
  ten_csdl_to_chuc_hop_le "$v" || return 1
  printf '%s' "$v"
}

# erp_org_bp_a ⇒ tam_khoiphuc_bp_a. Trả 1 khi kết quả không qua hai hàng rào tên.
ten_csdl_tam() { # $1=csdl
  local t
  ten_csdl_to_chuc_hop_le "${1:-}" || return 1
  t="${TIEN_TO_CSDL_TAM}${1#erp_org_}"
  [[ "$t" =~ $MAU_CSDL_TAM ]] || return 1
  if ten_csdl_to_chuc_hop_le "$t" || [[ "$t" == erp_org_* ]]; then return 1; fi
  printf '%s' "$t"
}

# Bản dump mới nhất của MỘT CSDL tổ chức, theo MỐC TRONG TÊN (không tin mtime), cả ba thư mục.
ban_moi_nhat_to_chuc() { # $1=csdl
  local d f ten tot="" ten_tot=""
  for d in daily weekly manual hourly; do
    for f in "$THU_MUC_TO_CHUC/$1/$d/$1"-*.dump; do
      [ -f "$f" ] || continue
      ten="$(basename "$f")"
      [[ "$ten" =~ ^${1}-[0-9]{8}-[0-9]{4}\.dump$ ]] || continue
      if [ -z "$ten_tot" ] || [[ "$ten" > "$ten_tot" ]]; then tot="$f"; ten_tot="$ten"; fi
    done
  done
  printf '%s' "$tot"
}

# LUÂN PHIÊN: CSDL có bản sao mà lượt diễn tập gần nhất CŨ NHẤT (chưa từng ⇒ đứng đầu). Rỗng ⇒ không có gì để diễn tập.
chon_to_chuc_luan_phien() {
  local d csdl moc tot="" moc_tot="" co=""
  for d in "$THU_MUC_TO_CHUC"/*/; do
    csdl="$(basename "$d")"
    ten_csdl_to_chuc_hop_le "$csdl" || continue
    [ -n "$(ban_moi_nhat_to_chuc "$csdl")" ] || continue
    moc="$(sed -n 's/.*"finishedAt":"\([^"]*\)".*/\1/p' "$STATUS_TO_CHUC/$csdl/last-drill.json" 2>/dev/null | head -n 1 || true)"
    if [ -z "$co" ] || [[ "$moc" < "$moc_tot" ]]; then tot="$csdl"; moc_tot="$moc"; co=1; fi
  done
  printf '%s' "$tot"
}

don_dien_tap_to_chuc() {
  if [ -n "$DRILL_TEN_TO_CHUC" ]; then docker rm -f -v "$DRILL_TEN_TO_CHUC" >/dev/null 2>&1 || true; fi
}

ghi_dien_tap_to_chuc() { # $1=csdl $2=kết quả $3=lý do $4=bản $5=CSDL tạm $6=mảng bảng JSON $7=bắt đầu
  mkdir -p "$STATUS_TO_CHUC/$1" 2>/dev/null && chmod 755 "$STATUS_TO_CHUC" "$STATUS_TO_CHUC/$1" 2>/dev/null
  ghi_json "$STATUS_TO_CHUC/$1/last-drill.json" "$(printf '{"schema":1,"kind":"restore-drill","scope":"ORGANIZATION","database":%s,"result":%s,"startedAt":%s,"finishedAt":%s,"reason":%s,"dumpFile":%s,"tempDatabase":%s,"tables":%s}' \
    "$(js "$1")" "$(js "$2")" "$(js "$7")" "$(js "$(bay_gio_utc)")" "$(js "$3")" "$(js "$4")" "$(js "$5")" "${6:-[]}")" \
    || loi "không ghi được trạng thái diễn tập của $1"
}

cmd_restore_drill_to_chuc() { # $1 = mã tổ chức | tên CSDL erp_org_* | rỗng (luân phiên)
  local csdl tam ban ten_ban avail db_mb tu_do can anh i b phuc song hoi loi_bang="" bang_json="" so_loi bat_dau tep_loi
  bat_dau="$(bay_gio_utc)"
  if [ "$#" -gt 1 ]; then loi "restore-drill-org nhận TỐI ĐA một tham số (mã tổ chức)."; return 2; fi
  chuan_bi_thu_muc || { loi "Không chuẩn bị được thư mục sao lưu."; return 1; }
  if [ -n "${1:-}" ]; then
    csdl="$(csdl_tu_ma_to_chuc "$1")" || { loi "Mã tổ chức $(printf '%q' "$1") không hợp lệ (chữ thường, số, gạch ngang; hoặc tên CSDL erp_org_*)."; return 2; }
  else
    csdl="$(chon_to_chuc_luan_phien)"
    if [ -z "$csdl" ]; then bao "diễn tập tổ chức: không CSDL erp_org_* nào có bản sao lưu trên máy — không có gì để diễn tập."; return 0; fi
    bao "diễn tập tổ chức: luân phiên chọn $csdl (lượt diễn tập gần nhất cũ nhất / chưa từng)"
  fi
  tam="$(ten_csdl_tam "$csdl")" || { loi "Tên CSDL tạm cho $csdl không qua hàng rào tên — KHÔNG diễn tập."; return 2; }

  giu_khoa 8 "$KHOA_DOC_DB" -x "$TRAN_CHO_KHOA_GIAY" || { loi "Hết giờ chờ khoá đọc nặng — diễn tập KHÔNG chạy."; return 75; }
  giu_khoa 9 "$KHOA_VONG_DOI" -s "$TRAN_CHO_KHOA_GIAY" || { loi "Hết giờ chờ khoá vòng đời — diễn tập KHÔNG chạy."; return 75; }

  ban="$(ban_moi_nhat_to_chuc "$csdl")"
  if [ -z "$ban" ]; then
    ghi_dien_tap_to_chuc "$csdl" "SKIPPED" "Chưa có bản sao lưu nào của $csdl trên máy — chạy ops backup trước." "" "$tam" "[]" "$bat_dau"
    loi "Chưa có bản sao lưu nào của $csdl ($THU_MUC_TO_CHUC/$csdl/…) để diễn tập."; return 1
  fi
  ten_ban="$(basename "$ban")"

  # Tài nguyên TRƯỚC khi dựng gì — đúng ngưỡng của diễn tập nhà.
  avail="$(free -m 2>/dev/null | awk '/^Mem:/ {print $7}' || true)"
  if [ -z "$avail" ] || ! [ "$avail" -ge "$RAM_TOI_THIEU_DIEN_TAP_MB" ] 2>/dev/null; then
    ghi_dien_tap_to_chuc "$csdl" "SKIPPED" "RAM dùng được ${avail:-?} MB < ${RAM_TOI_THIEU_DIEN_TAP_MB} MB — không dựng container tạm lúc máy đang chật." "$ten_ban" "$tam" "[]" "$bat_dau"
    loi "RAM dùng được ${avail:-?} MB < ${RAM_TOI_THIEU_DIEN_TAP_MB} MB — diễn tập KHÔNG chạy (không phải lỗi của bản sao lưu)."; return 1
  fi
  # Tên CSDL đã qua MAU_CSDL_TO_CHUC ([a-z0-9_]) — nội suy vào câu đọc là an toàn.
  db_mb="$(docker exec "$DB_CONTAINER" psql -U erp -d erp -Atc "select (pg_database_size('$csdl') / 1048576)::bigint" 2>/dev/null || true)"
  tu_do="$(o_trong_mb /var/lib/docker)"; [ -n "$tu_do" ] || tu_do="$(o_trong_mb /)"
  can=$(( ${db_mb:-0} + DU_TRU_O_DIA_MB ))
  if ! [[ "${db_mb:-}" =~ ^[0-9]+$ ]] || [ -z "$tu_do" ] || [ "$tu_do" -lt "$can" ]; then
    ghi_dien_tap_to_chuc "$csdl" "SKIPPED" "Ổ đĩa còn ${tu_do:-?} MB, cần ≥ ${can} MB (CSDL ${db_mb:-?} MB + dự trữ ${DU_TRU_O_DIA_MB} MB)." "$ten_ban" "$tam" "[]" "$bat_dau"
    loi "Không đủ ổ đĩa (hoặc không đọc được cỡ $csdl) cho diễn tập: còn ${tu_do:-?} MB, cần ≥ ${can} MB — KHÔNG chạy."; return 1
  fi
  bao "diễn tập tổ chức: $csdl · bản $ten_ban → CSDL tạm $tam · RAM dùng được ${avail} MB · ổ còn ${tu_do} MB (cần ${can} MB)"

  # Container sót lại từ lượt trước bị cắt ngang — dọn trước (chỉ container mang nhãn diễn tập tổ chức).
  docker ps -aq --filter "label=$NHAN_DIEN_TAP_TO_CHUC" 2>/dev/null | xargs -r docker rm -f -v >/dev/null 2>&1 || true
  anh="$(docker inspect -f '{{.Config.Image}}' "$DB_CONTAINER" 2>/dev/null || true)"
  if [ -z "$anh" ]; then
    ghi_dien_tap_to_chuc "$csdl" "FAILED" "Không đọc được ảnh của container $DB_CONTAINER." "$ten_ban" "$tam" "[]" "$bat_dau"
    loi "Không đọc được ảnh của $DB_CONTAINER."; return 1
  fi
  DRILL_TEN_TO_CHUC="erp-restore-drill-org-$(date +%s)"
  trap don_dien_tap_to_chuc EXIT
  # --network none: không cổng, không mạng — `trust` vô hại vì không ai tới được nó. POSTGRES_DB dựng sẵn CSDL tạm.
  if ! docker run -d --name "$DRILL_TEN_TO_CHUC" --label "$NHAN_DIEN_TAP_TO_CHUC" --network none \
    --memory "$BO_NHO_DIEN_TAP" --memory-swap "$BO_NHO_DIEN_TAP" --cpus 1 --pids-limit 256 \
    -e POSTGRES_USER=erp -e POSTGRES_DB="$tam" -e POSTGRES_HOST_AUTH_METHOD=trust \
    -v "$ban:/drill/ban.dump:ro" "$anh" \
    postgres -c shared_buffers=32MB -c maintenance_work_mem=64MB -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c autovacuum=off >/dev/null; then
    ghi_dien_tap_to_chuc "$csdl" "FAILED" "Không dựng được container Postgres tạm." "$ten_ban" "$tam" "[]" "$bat_dau"
    loi "docker run container tạm lỗi — diễn tập thất bại."; return 1
  fi

  # Chờ "init process complete" rồi mới hỏi — pg_isready xanh trong lúc initdb là xanh giả (như diễn tập nhà).
  for i in $(seq 1 90); do
    if grep -q "PostgreSQL init process complete" <<< "$(docker logs "$DRILL_TEN_TO_CHUC" 2>&1)" \
      && docker exec "$DRILL_TEN_TO_CHUC" pg_isready -U erp -d "$tam" >/dev/null 2>&1; then break; fi
    sleep 2
  done
  if ! docker exec "$DRILL_TEN_TO_CHUC" pg_isready -U erp -d "$tam" >/dev/null 2>&1; then
    ghi_dien_tap_to_chuc "$csdl" "FAILED" "Container Postgres tạm không lên sau 180 giây." "$ten_ban" "$tam" "[]" "$bat_dau"
    loi "Container tạm không lên — diễn tập thất bại."; return 1
  fi

  bao "diễn tập tổ chức: pg_restore vào $tam trong container tạm $DRILL_TEN_TO_CHUC…"
  tep_loi="$STATUS_DIR/.drill-to-chuc.err"
  if ! timeout "$TRAN_LENH_GIAY" docker exec "$DRILL_TEN_TO_CHUC" pg_restore -U erp -d "$tam" --no-owner --no-privileges /drill/ban.dump 2>"$tep_loi"; then
    so_loi="$(grep -c 'error' "$tep_loi" 2>/dev/null || true)"
    echo "── 20 dòng đầu của lỗi pg_restore ──"; head -n 20 "$tep_loi" 2>/dev/null || true
    rm -f "$tep_loi"
    ghi_dien_tap_to_chuc "$csdl" "FAILED" "pg_restore báo lỗi (${so_loi:-?} dòng lỗi) — bản $ten_ban KHÔNG khôi phục sạch." "$ten_ban" "$tam" "[]" "$bat_dau"
    loi "pg_restore lỗi — bản sao lưu của $csdl CHƯA chứng minh được là dùng được."; return 1
  fi
  rm -f "$tep_loi"

  echo
  printf '%-32s %14s %14s %10s\n' "BẢNG ($csdl)" "BẢN SAO LƯU" "CSDL SỐNG" "CHÊNH"
  for b in $BANG_DIEN_TAP_TO_CHUC; do
    phuc="$(docker exec "$DRILL_TEN_TO_CHUC" psql -U erp -d "$tam" -Atc "select count(*) from $b" 2>/dev/null || true)"
    song="$(docker exec "$DB_CONTAINER" psql -U erp -d "$csdl" -Atc "select count(*) from $b" 2>/dev/null || true)"
    [[ "$phuc" =~ ^[0-9]+$ ]] || phuc=""
    [[ "$song" =~ ^[0-9]+$ ]] || song=""
    hoi=""
    if [ -n "$phuc" ] && [ -n "$song" ]; then hoi=$(( song - phuc )); fi
    printf '%-32s %14s %14s %10s\n' "$b" "${phuc:-THIẾU}" "${song:-—}" "${hoi:-—}"
    # Hỏng thật: bảng có ở CSDL sống mà bản khôi phục KHÔNG có, hoặc sống có dòng mà bản khôi phục rỗng.
    if [ -n "$song" ] && [ -z "$phuc" ]; then loi_bang="$loi_bang $b(thiếu bảng)"; fi
    if [ -n "$song" ] && [ -n "$phuc" ] && [ "$song" -gt 0 ] && [ "$phuc" -eq 0 ]; then loi_bang="$loi_bang $b(rỗng)"; fi
    bang_json="${bang_json:+$bang_json,}{\"name\":$(js "$b"),\"restored\":$(jn "$phuc"),\"live\":$(jn "$song")}"
  done
  echo "CHÊNH = CSDL sống − bản sao lưu: dương nhỏ là BÌNH THƯỜNG (dữ liệu mới sinh sau lúc dump)."
  echo

  if [ -n "$loi_bang" ]; then
    ghi_dien_tap_to_chuc "$csdl" "FAILED" "Khôi phục xong nhưng hỏng ở:$loi_bang" "$ten_ban" "$tam" "[$bang_json]" "$bat_dau"
    loi "Diễn tập $csdl THẤT BẠI — hỏng ở:$loi_bang"; return 1
  fi
  ghi_dien_tap_to_chuc "$csdl" "OK" "" "$ten_ban" "$tam" "[$bang_json]" "$bat_dau"
  bao "DIỄN TẬP TỔ CHỨC ĐẠT: $ten_ban khôi phục sạch vào CSDL tạm $tam (container tạm, sẽ bị xoá), $(echo "$BANG_DIEN_TAP_TO_CHUC" | wc -w) bảng lõi đối chiếu với $csdl."
  return 0
}

# ═══════════════ LỆNH: hourly-org — SAO LƯU MỖI GIỜ CÁC CSDL TỔ CHỨC (RPO ≤ 1 giờ, quyết định C6) ═══════════════
#
# LUẬT:
#  · CHỈ CSDL erp_org_* — danh sách từ `liet_ke_csdl_to_chuc` (pg_database + MAU_CSDL_TO_CHUC, cùng hàng rào tên với lượt
#    đêm), mỗi CSDL qua đúng `sao_luu_mot_to_chuc` của lượt đêm (kiểm ổ đĩa, dump -Fc, kiểm mục lục, xoay vòng, ngoài máy).
#    KHÔNG có lời gọi pg_dump nào mang `-d erp`, không bot chat, không ghi last-run.json / last-success.json / daily-done
#    của NHÀ (tests/backup.test.ts chạy thật với docker giả và so).
#  · Khung đêm (GIO_BAT_DAU–GIO_KET_THUC) mà bản đêm HÔM NAY chưa xong ⇒ bỏ lượt: bản đêm đang chạy / sắp chạy, và nó dump
#    cả CSDL tổ chức. Chạy chen vào chỉ tranh khoá với nó.
#  · Cùng ổ khoá với bản đêm, ops và deploy: FD 7 KHÔNG CHỜ (bận ⇒ bỏ lượt, thoát 0 — giờ sau làm lại), rồi FD 8 / FD 9 với
#    trần NGẮN (TRAN_CHO_KHOA_GIO_GIAY) — lượt giờ không được treo sang lượt giờ sau.
#  · Không có CSDL erp_org_* nào (production 29/09/2026) ⇒ thoát 0: không lấy khoá, không ghi tệp, không một dòng log.
#  · Không liệt kê được ⇒ CHƯA BIẾT: thoát 1 (log cron), không ghi tệp. Thẻ Sao lưu của từng tổ chức vẫn tự lộ ra khi bản
#    thành công gần nhất quá cũ (ORG_BACKUP_RPO_ALERT_HOURS, lib/constants/backup.ts).
#  · Trạng thái: status/orgs/<csdl>/last-hourly.json (mọi lượt) + last-success.json (khi có bản dùng được — đó là bản thành
#    công gần nhất thật) + status/orgs-last-hourly.json (tổng hợp). last-run.json của tổ chức vẫn là lời khai của bản ĐÊM.
#  · Lỗi đẩy ngoài máy KHÔNG xoá bản cục bộ: bản đã kiểm toàn vẹn nằm lại hourly/, trạng thái PARTIAL, thoát 1.
cmd_sao_luu_gio_to_chuc() {
  local gio hom_nay ds moc csdl ket ly_do bat_dau json_ds="" noi_dung n=0 hong=""
  if [ "$#" -gt 0 ]; then loi "hourly-org không nhận tham số."; return 2; fi
  TRIGGER="hourly"
  if ! ds="$(liet_ke_csdl_to_chuc)"; then
    loi "lượt giờ: không liệt kê được CSDL erp_org_* ($DB_CONTAINER không chạy hoặc psql lỗi) — CHƯA BIẾT có tổ chức nào lỡ lượt giờ này; giờ sau thử lại."
    return 1
  fi
  [ -n "$ds" ] || return 0

  gio=$((10#$(gio_vn +%H)))
  hom_nay="$(gio_vn +%F)"
  if [ "$gio" -ge "$GIO_BAT_DAU" ] && [ "$gio" -le "$GIO_KET_THUC" ] && [ "$(cat "$STATUS_DIR/daily-done" 2>/dev/null || true)" != "$hom_nay" ]; then
    bao "lượt giờ: khung bản đêm ${GIO_BAT_DAU}:00–${GIO_KET_THUC}:59 và bản đêm hôm nay chưa xong — bỏ lượt (bản đêm dump cả CSDL tổ chức)."
    return 0
  fi

  chuan_bi_thu_muc || { loi "lượt giờ: không chuẩn bị được thư mục sao lưu."; return 1; }
  nap_cau_hinh
  if ! khoa_chong_chong; then
    bao "lượt giờ: một lượt sao lưu / diễn tập khác đang giữ $KHOA_SAO_LUU — bỏ lượt giờ này, giờ sau làm lại."
    return 0
  fi
  giu_khoa 8 "$KHOA_DOC_DB" -x "$TRAN_CHO_KHOA_GIO_GIAY" || { loi "lượt giờ: hết ${TRAN_CHO_KHOA_GIO_GIAY}s chờ khoá đọc nặng — bỏ lượt."; return 75; }
  giu_khoa 9 "$KHOA_VONG_DOI" -s "$TRAN_CHO_KHOA_GIO_GIAY" || { loi "lượt giờ: hết ${TRAN_CHO_KHOA_GIO_GIAY}s chờ khoá vòng đời (deploy?) — bỏ lượt."; return 75; }

  moc="$(gio_vn +%Y%m%d-%H%M)"
  mkdir -p "$STATUS_TO_CHUC" 2>/dev/null && chmod 755 "$STATUS_TO_CHUC" 2>/dev/null || true
  while IFS= read -r csdl; do
    [ -n "$csdl" ] || continue
    n=$((n + 1))
    bat_dau="$(bay_gio_utc)"
    if sao_luu_mot_to_chuc "$csdl" "$moc" hourly; then
      if [ "$ORG_OFFSITE_STATE" = "FAILED" ]; then
        ket="PARTIAL"; ly_do="CSDL $csdl đã sao lưu giờ và kiểm toàn vẹn (bản cục bộ giữ nguyên); phần hỏng: bản ngoài máy."
        hong="$hong $csdl(ngoài máy)"
      else
        ket="OK"; ly_do=""
      fi
    else
      ket="FAILED"; ly_do="$ORG_LY_DO"
      hong="$hong $csdl"
      loi "$ly_do"
    fi
    noi_dung="$(noi_dung_trang_thai_to_chuc "$csdl" "$ket" "$ly_do" "$bat_dau")"
    if mkdir -p "$STATUS_TO_CHUC/$csdl" 2>/dev/null; then
      chmod 755 "$STATUS_TO_CHUC/$csdl" 2>/dev/null || true
      ghi_json "$STATUS_TO_CHUC/$csdl/last-hourly.json" "$noi_dung" || loi "không ghi được trạng thái giờ của $csdl"
      [ "$ket" = "FAILED" ] || ghi_json "$STATUS_TO_CHUC/$csdl/last-success.json" "$noi_dung" || loi "không ghi được trạng thái của $csdl"
    else
      loi "không tạo được thư mục trạng thái của $csdl"
    fi
    json_ds="${json_ds:+$json_ds,}{\"database\":$(js "$csdl"),\"result\":$(js "$ket"),\"file\":$(js "$ORG_FILE"),\"bytes\":$(jn "$ORG_BYTES"),\"offsite\":$(js "$ORG_OFFSITE_STATE"),\"reason\":$(js "$ly_do")}"
    bao "lượt giờ $csdl: $ket${ly_do:+ — $ly_do}"
  done <<< "$ds"

  ghi_json "$STATUS_DIR/orgs-last-hourly.json" "$(printf '{"schema":1,"kind":"org-backup-summary","trigger":"hourly","finishedAt":%s,"listError":null,"organizations":[%s],"missingDatabases":[]}' \
    "$(js "$(bay_gio_utc)")" "$json_ds")" || loi "không ghi được $STATUS_DIR/orgs-last-hourly.json"
  bao "LƯỢT GIỜ: $n CSDL tổ chức · hỏng:${hong:- không}"
  [ -z "$hong" ] || return 1
  return 0
}

# ═══════════════ LỆNH: drill-org-weekly — DIỄN TẬP TỔ CHỨC TỰ ĐỘNG MỖI TUẦN (quyết định C7) ═══════════════
#
# LUẬT:
#  · Chỉ Chủ nhật (THU_BAN_TUAN, giờ VN), khung GIO_DIEN_TAP_BAT_DAU–GIO_DIEN_TAP_KET_THUC — SAU khung bản đêm, nên nó diễn
#    tập bản mới nhất vừa sinh. Ngoài lúc đó thoát 0, im lặng.
#  · MỘT CSDL mỗi tuần, luân phiên (`chon_to_chuc_luan_phien`: chưa diễn tập / diễn tập lâu nhất đứng đầu). Không tổ chức
#    nào có bản trên máy ⇒ thoát 0, không ghi gì, không lấy khoá.
#  · Đường DUY NHẤT tới Postgres là `cmd_restore_drill_to_chuc`: container TẠM (không mạng, trần RAM), CSDL TẠM
#    `tam_khoiphuc_<mã>`, kiểm RAM/ổ trước khi dựng, erp-db chỉ bị ĐỌC. Không bao giờ khôi phục đè production.
#  · Cầm FD 7 (khoá sao lưu, KHÔNG CHỜ): không dựng Postgres thứ hai trong lúc một lượt dump đang ăn RAM/IO. Bận ⇒ giờ sau.
#  · Đánh dấu "tuần này xong" (status/drill-org-week-done = ngày VN) CHỈ khi lượt đi tới KẾT LUẬN (OK / FAILED) và kết
#    luận ấy là của CHÍNH lượt này (finishedAt ≥ lúc bắt đầu). SKIPPED (thiếu RAM / ổ) hay hết giờ chờ khoá ⇒ không đánh
#    dấu, giờ sau trong khung thử lại. FAILED không thử lại: cùng bản cho cùng kết luận — nó là tín hiệu, đỏ trên thẻ.
cmd_dien_tap_tuan_to_chuc() {
  local gio hom_nay csdl bat_dau ma=0 ket moc
  if [ "$#" -gt 0 ]; then loi "drill-org-weekly không nhận tham số (muốn chọn tổ chức: restore-drill-org <mã>)."; return 2; fi
  [ "$(gio_vn +%u)" = "$THU_BAN_TUAN" ] || return 0
  gio=$((10#$(gio_vn +%H)))
  if [ "$gio" -lt "$GIO_DIEN_TAP_BAT_DAU" ] || [ "$gio" -gt "$GIO_DIEN_TAP_KET_THUC" ]; then return 0; fi
  hom_nay="$(gio_vn +%F)"
  [ "$(cat "$STATUS_DIR/drill-org-week-done" 2>/dev/null || true)" != "$hom_nay" ] || return 0
  csdl="$(chon_to_chuc_luan_phien)"
  [ -n "$csdl" ] || return 0

  if ! khoa_chong_chong; then
    bao "diễn tập tuần: một lượt sao lưu khác đang giữ $KHOA_SAO_LUU — không dựng Postgres thứ hai lúc này; giờ sau thử lại."
    return 0
  fi
  bat_dau="$(bay_gio_utc)"
  bao "diễn tập tuần: Chủ nhật $hom_nay — luân phiên chọn $csdl"
  cmd_restore_drill_to_chuc "$csdl" || ma=$?
  ket="$(sed -n 's/.*"result":"\([A-Z]*\)".*/\1/p' "$STATUS_TO_CHUC/$csdl/last-drill.json" 2>/dev/null | head -n 1 || true)"
  moc="$(sed -n 's/.*"finishedAt":"\([^"]*\)".*/\1/p' "$STATUS_TO_CHUC/$csdl/last-drill.json" 2>/dev/null | head -n 1 || true)"
  if { [ "$ket" = "OK" ] || [ "$ket" = "FAILED" ]; } && [ -n "$moc" ] && [[ ! "$moc" < "$bat_dau" ]]; then
    printf '%s\n' "$hom_nay" > "$STATUS_DIR/drill-org-week-done" || loi "không ghi được $STATUS_DIR/drill-org-week-done"
    bao "diễn tập tuần: $csdl — $ket; tuần này xong."
  else
    bao "diễn tập tuần: $csdl chưa đi tới kết luận (${ket:-không có trạng thái}) — giờ sau trong khung thử lại."
  fi
  return "$ma"
}

# <<< TỔ CHỨC KHÁC NHÀ ─────────────────────────────────────────────────────────────────────────
# ═══════════════ LỆNH: run ═══════════════

cmd_run() {
  local thu_muc moc tam danh_sach tep_da_tao=()
  BAT_DAU="$(bay_gio_utc)"
  case "$TRIGGER" in cron) thu_muc="$BACKUP_DIR/daily" ;; *) thu_muc="$BACKUP_DIR/manual" ;; esac
  chuan_bi_thu_muc
  nap_cau_hinh

  if ! khoa_chong_chong; then
    # KHÔNG ghi trạng thái: lượt đang chạy sẽ tự ghi, và đè lên nó bằng "thất bại" là nói sai.
    loi "Một lượt sao lưu khác đang chạy hoặc đang chờ khoá ($KHOA_SAO_LUU) — lượt này KHÔNG chạy."
    exit 75
  fi
  giu_khoa 8 "$KHOA_DOC_DB" -x "$TRAN_CHO_KHOA_GIAY" \
    || that_bai "Hết giờ chờ khoá đọc nặng ($KHOA_DOC_DB) sau ${TRAN_CHO_KHOA_GIAY}s — một lượt đọc nặng khác đang giữ."
  giu_khoa 9 "$KHOA_VONG_DOI" -s "$TRAN_CHO_KHOA_GIAY" \
    || that_bai "Hết giờ chờ khoá vòng đời ($KHOA_VONG_DOI) sau ${TRAN_CHO_KHOA_GIAY}s — gần như chắc chắn có deploy dài đang chạy."

  [ "$(docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null || true)" = "true" ] \
    || that_bai "Container $DB_CONTAINER không chạy — không có gì để sao lưu."

  # ─── 1 · KIỂM Ổ ĐĨA TRƯỚC — thiếu thì KHÔNG dump ───
  kiem_o_dia || that_bai "$LY_DO"
  bao "ổ đĩa còn ${TU_DO_MB} MB, cần ≥ ${CAN_MB} MB — đủ"

  # ─── 2 · DUMP (-Fc: nén sẵn, khôi phục chọn lọc từng bảng được) ───
  moc="$(gio_vn +%Y%m%d-%H%M)"
  DB_FILE="erp-$moc.dump"
  tam="$thu_muc/.$DB_FILE.dang-ghi"
  bao "pg_dump -Fc → $thu_muc/$DB_FILE"
  if ! timeout "$TRAN_LENH_GIAY" docker exec "$DB_CONTAINER" pg_dump -U erp -d erp -Fc > "$tam" 2>"$STATUS_DIR/.dump.err"; then
    local dong_loi
    dong_loi="$(tail -n 1 "$STATUS_DIR/.dump.err" 2>/dev/null || true)"
    rm -f "$tam" "$STATUS_DIR/.dump.err"
    DB_FILE=""
    that_bai "pg_dump lỗi: ${dong_loi:-không có thông báo}"
  fi
  rm -f "$STATUS_DIR/.dump.err"

  # ─── 3 · KIỂM TOÀN VẸN: kích thước > 0 VÀ pg_restore đọc lại được mục lục ───
  DB_BYTES="$(kich_thuoc "$tam")"
  if ! [ "${DB_BYTES:-0}" -gt 0 ] 2>/dev/null; then
    rm -f "$tam"; DB_FILE=""
    that_bai "Bản dump rỗng (0 byte) — đã xoá, KHÔNG tính là một bản sao lưu."
  fi
  if ! danh_sach="$(docker exec -i "$DB_CONTAINER" pg_restore --list < "$tam" 2>/dev/null)"; then
    rm -f "$tam"; DB_FILE=""
    that_bai "pg_restore --list không đọc được bản dump vừa tạo — bản hỏng đã xoá."
  fi
  # Here-string, KHÔNG đường ống: `grep -q` thoát ở dòng khớp đầu tiên, bên ghi của ống ăn SIGPIPE,
  # và dưới `pipefail` cả phép thử thành "không khớp" — một bản dump TỐT bị xoá vì lớn hơn 64 KB.
  DB_TABLES="$(grep -c ' TABLE DATA ' <<< "$danh_sach" || true)"
  if ! grep -q ' TABLE DATA public orders ' <<< "$danh_sach" \
    || ! grep -q ' TABLE DATA public shipments ' <<< "$danh_sach"; then
    rm -f "$tam"; DB_FILE=""
    that_bai "Mục lục bản dump thiếu dữ liệu bảng orders/shipments ($DB_TABLES bảng có dữ liệu) — không phải một bản sao lưu dùng được."
  fi
  chmod 600 "$tam"
  mv -f "$tam" "$thu_muc/$DB_FILE"
  tep_da_tao+=("$thu_muc/$DB_FILE")
  bao "CSDL: $DB_FILE — $DB_BYTES byte, $DB_TABLES bảng có dữ liệu, pg_restore đọc lại được"

  # ─── 4 · DỮ LIỆU BOT CHAT ───
  sao_luu_bot "$thu_muc" "$moc"
  [ -z "$BOT_FILE" ] || tep_da_tao+=("$thu_muc/$BOT_FILE")

  # ─── 5 · BẢN TUẦN: Chủ nhật (giờ VN) chép lượt cron sang weekly/ — liên kết cứng, không tốn chỗ ───
  local tep_tuan=()
  if [ "$TRIGGER" = "cron" ] && [ "$(gio_vn +%u)" = "$THU_BAN_TUAN" ]; then
    local f
    for f in "${tep_da_tao[@]}"; do
      ln -f "$f" "$BACKUP_DIR/weekly/$(basename "$f")" 2>/dev/null || cp -p "$f" "$BACKUP_DIR/weekly/$(basename "$f")"
      tep_tuan+=("$BACKUP_DIR/weekly/$(basename "$f")")
    done
    bao "bản tuần: đã chép ${#tep_tuan[@]} tệp sang weekly/"
  fi

  # ─── 6 · XOAY VÒNG — chỉ SAU khi bản mới đã được kiểm ───
  xoay_vong_tat_ca

  # ─── 7 · BẢN NGOÀI MÁY — dọn thùng rác Drive CỦA THƯ MỤC SAO LƯU trước (giải phóng chỗ cho bản mới), rồi đẩy ───
  don_thung_rac_drive || true
  day_ngoai_may "$(basename "$thu_muc")" "${tep_da_tao[@]}"
  if [ "${#tep_tuan[@]}" -gt 0 ] && [ "$OFFSITE_STATE" = "OK" ]; then
    day_ngoai_may weekly "${tep_tuan[@]}"
  fi

  # ─── 8 · KẾT LUẬN ───
  if [ "$BOT_STATE" = "OK" ] && [ "$OFFSITE_STATE" != "FAILED" ]; then
    KET_QUA="OK"
  else
    KET_QUA="PARTIAL"
    LY_DO="CSDL đã sao lưu và kiểm toàn vẹn; phần hỏng:$( [ "$BOT_STATE" = "OK" ] || printf ' bot chat (%s)' "$BOT_STATE")$( [ "$OFFSITE_STATE" != "FAILED" ] || printf ' · bản ngoài máy')."
  fi
  local noi_dung
  noi_dung="$(noi_dung_trang_thai)"
  ghi_json "$STATUS_DIR/last-run.json" "$noi_dung"
  # Bản CSDL dùng được ⇒ đây là "bản thành công gần nhất", kể cả khi bot/ngoài máy hỏng.
  ghi_json "$STATUS_DIR/last-success.json" "$noi_dung"
  [ "$TRIGGER" != "cron" ] || printf '%s\n' "$(gio_vn +%F)" > "$STATUS_DIR/daily-done"

  bao "KẾT QUẢ: $KET_QUA · CSDL $DB_FILE ($DB_BYTES byte) · bot $BOT_STATE · ngoài máy $OFFSITE_STATE"
  [ "$OFFSITE_STATE" != "NOT_CONFIGURED" ] || bao "⚠ CHƯA CÓ BẢN SAO NGOÀI MÁY — xem docs/backup-restore.md mục HUMAN GATE."
  # >>> TỔ CHỨC KHÁC NHÀ — 9 · CSDL erp_org_*: SAU khi trạng thái của nhà đã ghi; `|| true` = lỗi của tổ chức không dừng script
  sao_luu_cac_to_chuc "$moc" "$(basename "$thu_muc")" || true
  # <<< TỔ CHỨC KHÁC NHÀ
  [ "$KET_QUA" = "OK" ] || { loi "$LY_DO"; exit 1; }
  # >>> TỔ CHỨC KHÁC NHÀ — nhà ĐẠT mà có tổ chức hỏng ⇒ thoát 1 để ops đỏ; trạng thái của nhà vẫn là ĐẠT
  [ -z "$TO_CHUC_HONG" ] || { loi "CSDL nhà đã sao lưu ĐẠT; CSDL tổ chức khác hỏng:$TO_CHUC_HONG — xem $STATUS_DIR/orgs-last-run.json."; exit 1; }
  # <<< TỔ CHỨC KHÁC NHÀ
}

# ═══════════════ LỆNH: cron ═══════════════
#
# Cron gọi MỖI GIỜ, không phải một lần lúc 02:17: lượt hỏng (hết giờ chờ khoá vì deploy dài, ổ
# thiếu chỗ tạm thời) được thử lại lúc 03, 04, 05 giờ thay vì đợi nguyên một ngày. Ngoài khung
# thấp điểm thì im lặng thoát — không một dòng log nào.
cmd_cron() {
  local gio hom_nay
  gio=$((10#$(gio_vn +%H)))
  if [ "$gio" -lt "$GIO_BAT_DAU" ] || [ "$gio" -gt "$GIO_KET_THUC" ]; then return 0; fi
  hom_nay="$(gio_vn +%F)"
  if [ "$(cat "$STATUS_DIR/daily-done" 2>/dev/null || true)" = "$hom_nay" ]; then return 0; fi
  TRIGGER="cron"
  cmd_run
}

# ═══════════════ LỆNH: status — KHÔNG in một dòng dữ liệu nào ═══════════════

cmd_status() {
  local tep d
  echo "── Lịch ──"
  if [ -f "$TEP_CRON" ]; then echo "$TEP_CRON:"; grep -v '^#' "$TEP_CRON" | sed '/^$/d'; else echo "CHƯA CÀI $TEP_CRON — lần deploy kế tiếp sẽ cài."; fi
  echo "Mô tả: $LICH_MO_TA · giữ $GIU_BAN_NGAY bản ngày + $GIU_BAN_TUAN bản tuần + $GIU_BAN_TAY bản tay"
  echo
  echo "── Trạng thái (máy đọc được: $STATUS_DIR) ──"
  for tep in last-run.json last-success.json last-drill.json daily-done; do
    if [ -f "$STATUS_DIR/$tep" ]; then echo "$tep:"; cat "$STATUS_DIR/$tep"; else echo "$tep: (chưa có)"; fi
  done
  echo
  echo "── Bản trên máy ──"
  for d in daily weekly manual; do
    echo "$BACKUP_DIR/$d/:"
    ls -lh "$BACKUP_DIR/$d" 2>/dev/null | sed '1d' || echo "  (chưa có)"
  done
  local cu
  cu="$(ls -1 "$BACKUP_DIR"/erp-*.sql.gz 2>/dev/null | wc -l || true)"
  if [ "${cu:-0}" -gt 0 ]; then
    echo "Bản tay KIỂU CŨ (pg_dump | gzip, trước tệp này): $cu tệp, $(du -ch "$BACKUP_DIR"/erp-*.sql.gz 2>/dev/null | tail -n 1 | cut -f1) — KHÔNG tự xoá; xoá tay khi chủ shop đồng ý."
  fi
  echo
  echo "── Ổ đĩa ──"
  df -h "$BACKUP_DIR" 2>/dev/null || true
  echo
  echo "── Ngoài máy ──"
  nap_cau_hinh
  if [ -z "${BACKUP_OFFSITE_REMOTE:-}" ]; then
    echo "CHƯA CÓ BẢN SAO NGOÀI MÁY — chưa khai BACKUP_OFFSITE_REMOTE (xem docs/backup-restore.md, HUMAN GATE)."
  else
    echo "Remote: ${BACKUP_OFFSITE_REMOTE%%:*}: · rclone: $(command -v rclone >/dev/null 2>&1 && rclone version 2>/dev/null | head -n 1 || echo 'CHƯA CÀI')"
    # Chỉ in thứ KHÔNG bí mật: có mã hoá hay không, có token hay không — không in giá trị. ID thư mục Drive in ở dạng ĐÃ
    # CHE (4 ký tự cuối + độ dài, đủ đối chiếu với Variable BACKUP_GDRIVE_FOLDER_ID): log ops của kho PUBLIC.
    if [ -n "${RCLONE_CONFIG_GDRIVE_ROOT_FOLDER_ID:-}" ]; then
      echo "Google Drive: thư mục gốc $(che_dinh_danh "$RCLONE_CONFIG_GDRIVE_ROOT_FOLDER_ID") · token: $([ -n "${RCLONE_CONFIG_GDRIVE_TOKEN:-}" ] && echo có || echo THIẾU) · mã hoá crypt: $([ -n "${RCLONE_CONFIG_GCRYPT_PASSWORD:-}" ] && echo có || echo KHÔNG) · cấu hình: $TEP_NGOAI_MAY"
    fi
    if command -v rclone >/dev/null 2>&1; then
      local sub ds tep_loi
      tep_loi="$(mktemp)"
      for sub in daily weekly manual; do
        # Tên tệp chỉ là mốc ngày giờ (crypt giải tên ở phía này) — không có dữ liệu nào trong đó.
        if ds="$(timeout 120 rclone lsf --format "sp" --separator " " "$(noi_duong "$BACKUP_OFFSITE_REMOTE" "$sub")" 2>"$tep_loi")"; then
          echo "ngoài máy $sub/: $(printf '%s' "$ds" | grep -c . || true) tệp (kích thước byte · tên)"
          [ -z "$ds" ] || printf '%s\n' "$ds" | sed 's/^/  /'
        elif grep -qi 'directory not found' "$tep_loi"; then
          echo "ngoài máy $sub/: chưa có (thư mục tạo ở lượt đẩy đầu tiên vào đó)"
        else
          echo "ngoài máy $sub/: KHÔNG ĐỌC ĐƯỢC — $(tail -n 1 "$tep_loi")"
        fi
      done
      rm -f "$tep_loi"
      # Total · Used · Trashed · Other · Free của Drive + thư mục sao lưu (sống / thùng rác) — CHỈ ĐỌC, có trần thời gian.
      trang_thai_dung_luong_drive || true
    fi
  fi
  # >>> TỔ CHỨC KHÁC NHÀ
  trang_thai_to_chuc
  # <<< TỔ CHỨC KHÁC NHÀ
}

# ═══════════════ LỆNH: restore-drill ═══════════════
#
# Một bản sao lưu CHƯA TỪNG khôi phục là một lời hứa, không phải một bản sao lưu. Diễn tập: dựng
# container Postgres TẠM (cùng ảnh với CSDL thật, không mạng, không cổng, trần bộ nhớ), khôi phục
# bản mới nhất vào đó, đếm dòng các bảng then chốt và so với CSDL sống, rồi xoá container.
# CSDL sống CHỈ bị đọc `count(*)`.
DRILL_TEN=""
don_dien_tap() {
  if [ -n "$DRILL_TEN" ]; then docker rm -f -v "$DRILL_TEN" >/dev/null 2>&1 || true; fi
}

ghi_dien_tap() { # $1=kết quả $2=lý do $3=bản $4=mảng bảng JSON
  ghi_json "$STATUS_DIR/last-drill.json" "$(printf '{"schema":1,"kind":"restore-drill","result":%s,"startedAt":%s,"finishedAt":%s,"reason":%s,"dumpFile":%s,"tables":%s}' \
    "$(js "$1")" "$(js "$BAT_DAU")" "$(js "$(bay_gio_utc)")" "$(js "$2")" "$(js "$3")" "${4:-[]}")"
}

cmd_restore_drill() {
  local ban ten_ban avail db_mb tu_do can anh i t song phuc hoi bang_json="" loi_bang="" dong_bang
  BAT_DAU="$(bay_gio_utc)"
  chuan_bi_thu_muc
  giu_khoa 8 "$KHOA_DOC_DB" -x "$TRAN_CHO_KHOA_GIAY" || { loi "Hết giờ chờ khoá đọc nặng — diễn tập KHÔNG chạy."; exit 75; }
  giu_khoa 9 "$KHOA_VONG_DOI" -s "$TRAN_CHO_KHOA_GIAY" || { loi "Hết giờ chờ khoá vòng đời — diễn tập KHÔNG chạy."; exit 75; }

  ban="$(ban_moi_nhat)"
  if [ -z "$ban" ]; then
    ghi_dien_tap "SKIPPED" "Chưa có bản sao lưu định dạng -Fc nào để diễn tập — chạy ops backup trước." ""
    loi "Chưa có bản sao lưu nào (erp-*.dump) để diễn tập."; exit 1
  fi
  ten_ban="$(basename "$ban")"

  # Tài nguyên TRƯỚC khi dựng gì: bị giết vì hết RAM giữa chừng là một kết luận sai về bản sao lưu.
  avail="$(free -m 2>/dev/null | awk '/^Mem:/ {print $7}')"
  if [ -z "$avail" ] || [ "$avail" -lt "$RAM_TOI_THIEU_DIEN_TAP_MB" ]; then
    ghi_dien_tap "SKIPPED" "RAM dùng được ${avail:-?} MB < ${RAM_TOI_THIEU_DIEN_TAP_MB} MB — không dựng container tạm lúc máy đang chật; chạy lại lúc thấp điểm." "$ten_ban"
    loi "RAM dùng được ${avail:-?} MB < ${RAM_TOI_THIEU_DIEN_TAP_MB} MB — diễn tập KHÔNG chạy (không phải lỗi của bản sao lưu)."; exit 1
  fi
  db_mb="$(docker exec "$DB_CONTAINER" psql -U erp -d erp -Atc "select (pg_database_size('erp') / 1048576)::bigint" 2>/dev/null || true)"
  tu_do="$(o_trong_mb /var/lib/docker)"; [ -n "$tu_do" ] || tu_do="$(o_trong_mb /)"
  can=$(( ${db_mb:-0} + DU_TRU_O_DIA_MB ))
  if [ -z "$db_mb" ] || [ -z "$tu_do" ] || [ "$tu_do" -lt "$can" ]; then
    ghi_dien_tap "SKIPPED" "Ổ đĩa còn ${tu_do:-?} MB, cần ≥ ${can} MB (CSDL ${db_mb:-?} MB + dự trữ ${DU_TRU_O_DIA_MB} MB)." "$ten_ban"
    loi "Không đủ ổ đĩa cho diễn tập: còn ${tu_do:-?} MB, cần ≥ ${can} MB — KHÔNG chạy."; exit 1
  fi
  bao "diễn tập: bản $ten_ban · RAM dùng được ${avail} MB · ổ còn ${tu_do} MB (cần ${can} MB)"

  # Container sót lại từ lượt trước bị cắt ngang — dọn trước.
  docker ps -aq --filter label=erp.restore-drill=1 2>/dev/null | xargs -r docker rm -f -v >/dev/null 2>&1 || true
  anh="$(docker inspect -f '{{.Config.Image}}' "$DB_CONTAINER")"
  DRILL_TEN="erp-restore-drill-$(date +%s)"
  trap don_dien_tap EXIT
  # --network none: không cổng, không mạng — xác thực `trust` vô hại vì không ai tới được nó.
  docker run -d --name "$DRILL_TEN" --label erp.restore-drill=1 --network none \
    --memory "$BO_NHO_DIEN_TAP" --memory-swap "$BO_NHO_DIEN_TAP" --cpus 1 --pids-limit 256 \
    -e POSTGRES_USER=erp -e POSTGRES_DB=erp -e POSTGRES_HOST_AUTH_METHOD=trust \
    -v "$ban:/drill/ban.dump:ro" "$anh" \
    postgres -c shared_buffers=32MB -c maintenance_work_mem=64MB -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c autovacuum=off >/dev/null

  # Ảnh postgres khởi động một máy chủ TẠM để initdb rồi mới dựng máy chủ thật — pg_isready xanh
  # trong lúc đó là xanh giả. Chờ dòng "init process complete" rồi mới hỏi.
  for i in $(seq 1 90); do
    if grep -q "PostgreSQL init process complete" <<< "$(docker logs "$DRILL_TEN" 2>&1)" \
      && docker exec "$DRILL_TEN" pg_isready -U erp -d erp >/dev/null 2>&1; then break; fi
    sleep 2
  done
  if ! docker exec "$DRILL_TEN" pg_isready -U erp -d erp >/dev/null 2>&1; then
    ghi_dien_tap "FAILED" "Container Postgres tạm không lên sau 180 giây." "$ten_ban"
    loi "Container tạm không lên — diễn tập thất bại."; exit 1
  fi

  bao "diễn tập: pg_restore vào container tạm $DRILL_TEN…"
  if ! timeout "$TRAN_LENH_GIAY" docker exec "$DRILL_TEN" pg_restore -U erp -d erp --no-owner --no-privileges /drill/ban.dump 2>"$STATUS_DIR/.drill.err"; then
    local so_loi
    so_loi="$(grep -c 'error' "$STATUS_DIR/.drill.err" 2>/dev/null || true)"
    echo "── 20 dòng đầu của lỗi pg_restore ──"; head -n 20 "$STATUS_DIR/.drill.err" || true
    ghi_dien_tap "FAILED" "pg_restore báo lỗi (${so_loi:-?} dòng lỗi) — bản $ten_ban KHÔNG khôi phục sạch." "$ten_ban"
    rm -f "$STATUS_DIR/.drill.err"
    loi "pg_restore lỗi — bản sao lưu CHƯA chứng minh được là dùng được."; exit 1
  fi
  rm -f "$STATUS_DIR/.drill.err"

  echo
  printf '%-22s %14s %14s %10s\n' "BẢNG" "BẢN SAO LƯU" "CSDL SỐNG" "CHÊNH"
  for t in $BANG_DIEN_TAP; do
    phuc="$(docker exec "$DRILL_TEN" psql -U erp -d erp -Atc "select count(*) from public.$t" 2>/dev/null || true)"
    song="$(docker exec "$DB_CONTAINER" psql -U erp -d erp -Atc "select count(*) from public.$t" 2>/dev/null || true)"
    hoi=""
    if [ -n "$phuc" ] && [ -n "$song" ]; then hoi=$(( song - phuc )); fi
    printf '%-22s %14s %14s %10s\n' "$t" "${phuc:-THIẾU}" "${song:-—}" "${hoi:-—}"
    # Hỏng thật: bảng có ở CSDL sống mà bản khôi phục KHÔNG có, hoặc có dòng ở sống mà bản khôi phục rỗng.
    if [ -n "$song" ] && [ -z "$phuc" ]; then loi_bang="$loi_bang $t(thiếu bảng)"; fi
    if [ -n "$song" ] && [ -n "$phuc" ] && [ "$song" -gt 0 ] && [ "$phuc" -eq 0 ]; then loi_bang="$loi_bang $t(rỗng)"; fi
    dong_bang="{\"name\":$(js "$t"),\"restored\":$(jn "$phuc"),\"live\":$(jn "$song")}"
    bang_json="${bang_json:+$bang_json,}$dong_bang"
  done
  echo "CHÊNH = CSDL sống − bản sao lưu: dương nhỏ là BÌNH THƯỜNG (dữ liệu mới sinh sau lúc dump)."
  echo

  if [ -n "$loi_bang" ]; then
    ghi_dien_tap "FAILED" "Khôi phục xong nhưng hỏng ở:$loi_bang" "$ten_ban" "[$bang_json]"
    loi "Diễn tập THẤT BẠI — hỏng ở:$loi_bang"; exit 1
  fi
  ghi_dien_tap "OK" "" "$ten_ban" "[$bang_json]"
  bao "DIỄN TẬP ĐẠT: $ten_ban khôi phục sạch vào container tạm, $(echo "$BANG_DIEN_TAP" | wc -w) bảng then chốt đều có dữ liệu. Container tạm sẽ bị xoá."
}

# ═══════════════ LỆNH: install-cron ═══════════════
#
# Idempotent: chạy ở MỌI lần deploy. Nội dung giống hệt thì không ghi lại.
cmd_install_cron() {
  local noi_dung cu
  chuan_bi_thu_muc
  if ! command -v cron >/dev/null 2>&1 && ! command -v crond >/dev/null 2>&1; then
    bao "cài cron"
    if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cron
    elif command -v dnf >/dev/null 2>&1; then dnf install -y -q cronie
    elif command -v yum >/dev/null 2>&1; then yum install -y -q cronie
    fi
  fi
  systemctl enable --now cron >/dev/null 2>&1 || systemctl enable --now crond >/dev/null 2>&1 || true

  noi_dung="# Sinh bởi scripts/erp-backup.sh install-cron ở mỗi lần deploy — ĐỪNG sửa tay, lần deploy sau ghi đè.
# Gọi mỗi giờ; script tự chỉ chạy trong khung $GIO_BAT_DAU:00–$GIO_KET_THUC:59 giờ VN, mỗi ngày một bản. Xem docs/backup-restore.md.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HOME=/root
$PHUT_CRON * * * * root ERP_DIR=$ERP_DIR ERP_BACKUP_DIR=$BACKUP_DIR /bin/bash $ERP_DIR/scripts/erp-backup.sh cron >> $TEP_LOG 2>&1"
  # >>> TỔ CHỨC KHÁC NHÀ — hai lịch MỚI (quyết định C4/C6/C7, 29/09/2026), NỐI SAU dòng của nhà: dòng của nhà giữ nguyên
  # từng byte. Cả hai gọi mỗi giờ và tự lọc giờ VN trong script (như dòng của nhà) — không phụ thuộc múi giờ của máy.
  noi_dung="$noi_dung
# CSDL tổ chức khác nhà (erp_org_*): sao lưu mỗi giờ (RPO ≤ 1 giờ) · diễn tập khôi phục vào CSDL TẠM mỗi Chủ nhật ${GIO_DIEN_TAP_BAT_DAU}:00–${GIO_DIEN_TAP_KET_THUC}:59 giờ VN.
$PHUT_CRON_GIO * * * * root ERP_DIR=$ERP_DIR ERP_BACKUP_DIR=$BACKUP_DIR /bin/bash $ERP_DIR/scripts/erp-backup.sh hourly-org >> $TEP_LOG 2>&1
$PHUT_CRON_DIEN_TAP * * * * root ERP_DIR=$ERP_DIR ERP_BACKUP_DIR=$BACKUP_DIR /bin/bash $ERP_DIR/scripts/erp-backup.sh drill-org-weekly >> $TEP_LOG 2>&1"
  # <<< TỔ CHỨC KHÁC NHÀ
  cu="$(cat "$TEP_CRON" 2>/dev/null || true)"
  if [ "$cu" != "$noi_dung" ]; then
    mkdir -p "$(dirname "$TEP_CRON")"
    printf '%s\n' "$noi_dung" > "$TEP_CRON.tam"
    chmod 644 "$TEP_CRON.tam"
    mv -f "$TEP_CRON.tam" "$TEP_CRON"
    bao "đã cài lịch sao lưu: $TEP_CRON"
  else
    bao "lịch sao lưu đã có sẵn, không đổi: $TEP_CRON"
  fi

  if [ -d "$(dirname "$TEP_LOGROTATE")" ]; then
    printf '%s {\n  weekly\n  rotate 8\n  compress\n  missingok\n  notifempty\n}\n' "$TEP_LOG" > "$TEP_LOGROTATE"
  fi

  # rclone chỉ cài khi chủ shop ĐÃ khai nơi lưu ngoài máy — không cài công cụ cho một quyết định chưa có.
  nap_cau_hinh
  if [ -n "${BACKUP_OFFSITE_REMOTE:-}" ] && ! command -v rclone >/dev/null 2>&1; then
    bao "đã khai BACKUP_OFFSITE_REMOTE — cài rclone"
    # Danh sách gói có thể cũ (máy chỉ `apt-get update` khi cài cron lần đầu): hỏng lần đầu thì cập
    # nhật danh sách rồi thử lại, thay vì báo FAILED tới lần deploy sau.
    if command -v apt-get >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq rclone \
        || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq rclone; } \
        || loi "cài rclone thất bại — bản ngoài máy sẽ báo FAILED"
    fi
  fi
}

# ═══════════════ LỆNH: configure-offsite — GOOGLE DRIVE + CRYPT TỪ SECRETS ═══════════════
#
# Deploy truyền xuống (deploy-vps.yml → install-vps.sh → đây), KHÔNG ai SSH vào gõ `rclone config`:
#   RCLONE_GDRIVE_TOKEN       Secret   — JSON token do `rclone authorize "drive"` in ra
#   RCLONE_CRYPT_PASSWORD     Secret   — mật khẩu crypt ĐÃ `rclone obscure`
#   RCLONE_CRYPT_PASSWORD2    Secret   — (tuỳ chọn) salt, cũng đã obscure
#   BACKUP_GDRIVE_FOLDER_ID   Variable — ID thư mục Drive chủ shop chọn (không bí mật, không ghi cứng
#                                        vào mã: đổi thư mục không phải deploy mã)
#
# ĐỦ BA thứ bắt buộc ⇒ ghi lại NGUYÊN tệp $TEP_NGOAI_MAY (tạm → mv, 600). THIẾU một ⇒ KHÔNG ghi gì
# mới, tệp cũ (nếu có) giữ nguyên, và nói rõ THIẾU CÁI GÌ. Đây là khoá lưu trữ, không phải công tắc
# chi tiền: xoá nhầm một Secret không được làm mất đường sao lưu đang chạy.
#
# KHÔNG BAO GIỜ in giá trị token / mật khẩu — log Actions của kho PUBLIC ai cũng đọc được. Chỉ in độ dài.
# Không bao giờ làm đổ deploy: cấu hình sai thì trang Kết nối dữ liệu vẫn báo đỏ/vàng ở mục Sao lưu.

# Chuẩn hoá thứ chủ shop dán vào Secret thành đúng MỘT dòng JSON token. Chấp nhận: JSON trần; JSON
# kèm hai dòng mũi tên "Paste the following… --->" / "<---End paste"; xuống dòng CRLF của Windows;
# hoặc một khối base64 của JSON (rclone vài bản in dạng này). JSON không chứa được xuống dòng thô
# trong chuỗi, nên bỏ CR/LF không bao giờ làm đổi nghĩa token. Trả 1 khi không thấy refresh_token.
chuan_hoa_token() { # $1=giá trị Secret → in JSON một dòng
  local s d
  s="$(printf '%s' "$1" | tr -d '\r\n')"
  if [[ "$s" != *"{"* ]]; then
    d="$(printf '%s' "$s" | tr -d ' \t' | tr '_-' '/+')"
    while [ $(( ${#d} % 4 )) -ne 0 ]; do d="$d="; done
    s="$(printf '%s' "$d" | base64 -d 2>/dev/null | tr -d '\r\n' || true)"
  fi
  [[ "$s" == *"{"*"}"* ]] || return 1
  s="{${s#*\{}"
  s="${s%\}*}}"
  [[ "$s" == *'"refresh_token"'* ]] || return 1
  printf '%s' "$s"
}

cmd_configure_offsite() {
  local token="${RCLONE_GDRIVE_TOKEN:-}" mk mk2 thu_muc thieu="" json b64 noi_dung cu tam thu_muc_tep
  mk="$(printf '%s' "${RCLONE_CRYPT_PASSWORD:-}" | tr -d '\r\n\t ')"
  mk2="$(printf '%s' "${RCLONE_CRYPT_PASSWORD2:-}" | tr -d '\r\n\t ')"
  thu_muc="$(printf '%s' "${BACKUP_GDRIVE_FOLDER_ID:-}" | tr -d '\r\n\t ')"
  [ -n "$token" ] || thieu="${thieu:+$thieu ·} RCLONE_GDRIVE_TOKEN (Secret)"
  [ -n "$mk" ] || thieu="${thieu:+$thieu ·} RCLONE_CRYPT_PASSWORD (Secret)"
  [ -n "$thu_muc" ] || thieu="${thieu:+$thieu ·} BACKUP_GDRIVE_FOLDER_ID (Variable)"

  if [ -n "$thieu" ]; then
    if [ -z "$token$mk$thu_muc" ]; then
      bao "Google Drive: chưa khai Secret/Variable nào — không đổi cấu hình ngoài máy$( [ -f "$TEP_NGOAI_MAY" ] && printf ' (tệp hiện có giữ nguyên)' )."
    else
      printf '::warning::[sao-lưu] Google Drive: THIẾU%s — KHÔNG ghi cấu hình mới%s. Khai đủ cả ba rồi deploy lại (docs/backup-restore.md mục 5).\n' \
        "$thieu" "$( [ -f "$TEP_NGOAI_MAY" ] && printf ', cấu hình cũ giữ nguyên' )"
    fi
    return 0
  fi
  if ! [[ "$thu_muc" =~ ^[A-Za-z0-9_-]{10,200}$ ]]; then
    printf '::warning::[sao-lưu] Google Drive: BACKUP_GDRIVE_FOLDER_ID không giống một ID thư mục Drive (chỉ gồm chữ, số, - và _; lấy phần sau /folders/ trong đường dẫn) — KHÔNG ghi cấu hình mới.\n'
    return 0
  fi
  if ! [[ "$mk" =~ ^[A-Za-z0-9_-]{22,}$ ]] || { [ -n "$mk2" ] && ! [[ "$mk2" =~ ^[A-Za-z0-9_-]{22,}$ ]]; }; then
    printf '::warning::[sao-lưu] Google Drive: mật khẩu crypt không giống chuỗi đã `rclone obscure` (%s ký tự) — KHÔNG ghi cấu hình mới. Dán đúng chuỗi obscure, không dán mật khẩu gốc.\n' "${#mk}"
    return 0
  fi
  if ! json="$(chuan_hoa_token "$token")"; then
    printf '::warning::[sao-lưu] Google Drive: RCLONE_GDRIVE_TOKEN (%s ký tự) không chứa JSON token có refresh_token — KHÔNG ghi cấu hình mới. Dán đúng dòng {...} mà `rclone authorize "drive"` in ra.\n' "${#token}"
    return 0
  fi
  b64="$(printf '%s' "$json" | base64 | tr -d '\r\n')"

  noi_dung="# Sinh bởi scripts/erp-backup.sh configure-offsite ở mỗi lần deploy — ĐỪNG sửa tay, lần deploy sau ghi đè.
# Nguồn: GitHub Secrets RCLONE_GDRIVE_TOKEN / RCLONE_CRYPT_PASSWORD[2] + Variable BACKUP_GDRIVE_FOLDER_ID.
# Token lưu base64 (đuôi _B64) — erp-backup.sh giải mã lúc nạp. Xem docs/backup-restore.md.
BACKUP_OFFSITE_REMOTE=$REMOTE_CRYPT:
RCLONE_CONFIG_${REMOTE_DRIVE^^}_TYPE=drive
RCLONE_CONFIG_${REMOTE_DRIVE^^}_SCOPE=drive
RCLONE_CONFIG_${REMOTE_DRIVE^^}_ROOT_FOLDER_ID=$thu_muc
RCLONE_CONFIG_${REMOTE_DRIVE^^}_TOKEN_B64=$b64
RCLONE_CONFIG_${REMOTE_CRYPT^^}_TYPE=crypt
RCLONE_CONFIG_${REMOTE_CRYPT^^}_REMOTE=$REMOTE_DRIVE:$THU_MUC_TREN_DRIVE
RCLONE_CONFIG_${REMOTE_CRYPT^^}_PASSWORD=$mk"
  [ -z "$mk2" ] || noi_dung="$noi_dung
RCLONE_CONFIG_${REMOTE_CRYPT^^}_PASSWORD2=$mk2"
  noi_dung="$noi_dung
RCLONE_CONFIG_${REMOTE_CRYPT^^}_FILENAME_ENCRYPTION=standard"

  thu_muc_tep="$(dirname "$TEP_NGOAI_MAY")"
  mkdir -p "$thu_muc_tep"
  chmod 700 "$thu_muc_tep"
  cu="$(cat "$TEP_NGOAI_MAY" 2>/dev/null || true)"
  if [ "$cu" = "$noi_dung" ]; then
    bao "Google Drive: cấu hình không đổi ($TEP_NGOAI_MAY) — thư mục $thu_muc, remote $REMOTE_CRYPT: (crypt) → $REMOTE_DRIVE:$THU_MUC_TREN_DRIVE"
    return 0
  fi
  tam="$TEP_NGOAI_MAY.tam.$$"
  ( umask 077; printf '%s\n' "$noi_dung" > "$tam" )
  chmod 600 "$tam"
  mv -f "$tam" "$TEP_NGOAI_MAY"
  bao "Google Drive: đã ghi $TEP_NGOAI_MAY (600) — thư mục $thu_muc, remote $REMOTE_CRYPT: (crypt) → $REMOTE_DRIVE:$THU_MUC_TREN_DRIVE · token ${#json} ký tự · mật khẩu crypt ${#mk} ký tự$( [ -z "$mk2" ] || printf ' · salt %s ký tự' "${#mk2}" ) (không in giá trị)"
}

main() {
  local lenh="${1:-}"
  shift || true
  # >>> TỔ CHỨC KHÁC NHÀ — lệnh nhận MÃ tổ chức làm tham số nên đi trước vòng đọc --trigger của nhà.
  # Gọi trong ngữ cảnh `||` (tắt set -e cho cả cây hàm, đúng luật khối): mọi bước tự kiểm và trả mã.
  if [ "$lenh" = "restore-drill-org" ]; then
    local ma_dien_tap=0
    cmd_restore_drill_to_chuc "$@" || ma_dien_tap=$?
    return "$ma_dien_tap"
  fi
  if [ "$lenh" = "hourly-org" ]; then
    local ma_gio=0
    cmd_sao_luu_gio_to_chuc "$@" || ma_gio=$?
    return "$ma_gio"
  fi
  if [ "$lenh" = "drill-org-weekly" ]; then
    local ma_tuan=0
    cmd_dien_tap_tuan_to_chuc "$@" || ma_tuan=$?
    return "$ma_tuan"
  fi
  # <<< TỔ CHỨC KHÁC NHÀ
  local a
  for a in "$@"; do
    case "$a" in
      --trigger=ops) TRIGGER="ops" ;;
      --trigger=manual) TRIGGER="manual" ;;
      *) loi "tham số không nhận: $a"; exit 2 ;;
    esac
  done
  case "$lenh" in
    run) cmd_run ;;
    cron) cmd_cron ;;
    status) cmd_status ;;
    restore-drill) cmd_restore_drill ;;
    install-cron) cmd_install_cron ;;
    configure-offsite) cmd_configure_offsite ;;
    *) echo "Dùng: $0 run [--trigger=ops|manual] | cron | status | restore-drill | install-cron | configure-offsite" >&2; exit 2 ;;
  esac
}

# Bài kiểm `source` tệp này để gọi thẳng từng hàm (xoay vòng, kiểm ổ đĩa…) — chỉ chạy `main` khi
# được GỌI. `exit` nằm CÙNG DÒNG: bash đọc tệp dần theo lệnh, nên nếu deploy thay tệp trong lúc một
# lượt đang chạy thì dòng sau `main` sẽ là của tệp mới.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; exit $?; fi
