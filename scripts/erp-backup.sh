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
#   erp-backup.sh install-cron                 cài /etc/cron.d/erp-backup (install-vps.sh gọi mỗi lần deploy)
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

# Đọc cấu hình ngoài máy từ .env của ERP — CHỈ các khoá trong danh sách trắng, không `source` cả tệp
# (.env chứa mọi secret của ERP; nạp hết vào môi trường của pg_dump/rclone là mở rộng bán kính vô cớ).
# Biến đã có sẵn trong môi trường thì thắng.
nap_cau_hinh() {
  local tep="$ERP_DIR/.env" dong khoa gia_tri
  [ -f "$tep" ] || return 0
  while IFS= read -r dong || [ -n "$dong" ]; do
    case "$dong" in
      BACKUP_OFFSITE_REMOTE=* | RCLONE_CONFIG_*=*) ;;
      *) continue ;;
    esac
    khoa="${dong%%=*}"
    [[ "$khoa" =~ ^[A-Z0-9_]+$ ]] || continue
    [ -z "${!khoa:-}" ] || continue
    gia_tri="${dong#*=}"
    gia_tri="${gia_tri#\"}"
    gia_tri="${gia_tri%\"}"
    export "$khoa=$gia_tri"
  done < "$tep"
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
    dich="${remote%/}/$sub/$(basename "$f")"
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
  # Dọn theo TUỔI, suy từ đúng hằng số giữ lại ở trên (+1 ngày đệm).
  timeout 900 rclone delete "${remote%/}/daily" --min-age "$((GIU_BAN_NGAY + 1))d" 2>/dev/null || true
  timeout 900 rclone delete "${remote%/}/weekly" --min-age "$((GIU_BAN_TUAN * 7 + 1))d" 2>/dev/null || true
  timeout 900 rclone delete "${remote%/}/manual" --min-age "$((GIU_BAN_NGAY + 1))d" 2>/dev/null || true
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

  # ─── 7 · BẢN NGOÀI MÁY ───
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
  [ "$KET_QUA" = "OK" ] || { loi "$LY_DO"; exit 1; }
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
  fi
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
    if command -v apt-get >/dev/null 2>&1; then apt-get install -y -qq rclone || loi "cài rclone thất bại — bản ngoài máy sẽ báo FAILED"; fi
  fi
}

main() {
  local lenh="${1:-}"
  shift || true
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
    *) echo "Dùng: $0 run [--trigger=ops|manual] | cron | status | restore-drill | install-cron" >&2; exit 2 ;;
  esac
}

# Bài kiểm `source` tệp này để gọi thẳng từng hàm (xoay vòng, kiểm ổ đĩa…) — chỉ chạy `main` khi
# được GỌI. `exit` nằm CÙNG DÒNG: bash đọc tệp dần theo lệnh, nên nếu deploy thay tệp trong lúc một
# lượt đang chạy thì dòng sau `main` sẽ là của tệp mới.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; exit $?; fi
