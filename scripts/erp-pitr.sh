#!/usr/bin/env bash
# ═══════════════════════ PITR CỦA erp-db — MỘT TỆP, MỘT LUẬT ═══════════════════════
#
# Quyết định của chủ nền tảng (30/09/2026): «PITR POSTGRESQL: Chuẩn bị và thực hiện PITR theo phương án đã audit. Yêu
# cầu: backup hiện tại phải healthy trước khi thay đổi; downtime tối thiểu; không mất migration/data; verify WAL/PITR thực
# sự hoạt động; thực hiện restore drill ở môi trường an toàn; xác nhận RPO/RTO sau khi bật; VNX smoke đầy đủ sau thay đổi.»
# Phương án đã audit: docs/platform/backup-recovery.md §9.4.
#
# Ba mảnh, mỗi mảnh ở đúng một chỗ:
#   · CẤU HÌNH Postgres: docker-compose.prod.yml, dịch vụ `db`, `command:` (postgres -c …). Không sửa tay tệp nào trong volume.
#   · LƯU TỪNG ĐOẠN WAL: deploy/pitr-luu-wal.sh — `archive_command`, chạy TRONG erp-db (busybox sh).
#   · MỌI THỨ CÒN LẠI (tệp này, chạy trên máy chủ): bản nền, xoay vòng, đẩy ngoài máy, trạng thái, dòng đánh dấu, diễn tập.
#
#   erp-pitr.sh chuan-bi              tạo /root/backups/pitr/{wal,base} (chủ uid 70 = postgres của ảnh alpine). install-vps.sh
#                                     gọi TRƯỚC `compose up -d db` — thiếu nó Docker tự tạo thư mục của root và mọi lượt
#                                     lưu WAL hỏng vì sai quyền.
#   erp-pitr.sh base [--trigger=ops]  chụp bản nền NGAY (ops `pitr-basebackup`)
#   erp-pitr.sh base-cron             cron phút PITR_PHUT_CRON_NEN mỗi giờ; chỉ chạy khung đêm, SAU bản đêm của nhà
#   erp-pitr.sh push-wal              cron mỗi 15 phút: đẩy kho WAL lên `gcrypt:pitr/wal/` (copy, không sync)
#   erp-pitr.sh status                CHỈ ĐỌC (ops `pitr-status`): pg_stat_archiver, kho WAL, bản nền, RPO, ngoài máy
#   erp-pitr.sh mark                  GHI đúng MỘT dòng settings `platform.pitr.marker` (ops `pitr-mark`)
#   erp-pitr.sh drill [mốc ISO]       CHỈ ĐỌC production (ops `pitr-drill`): khôi phục tới một mốc trong container TẠM
#   erp-pitr.sh pause | resume        phanh tay (ops `pitr-pause`, arg `resume`): tạm dừng / chạy lại việc lưu WAL
#   erp-pitr.sh install-cron          cài /etc/cron.d/erp-pitr (install-vps.sh gọi mỗi lần deploy)
#
# TỆP NÀY KHÔNG ĐỔI MỘT BYTE ĐƯỜNG SAO LƯU CỦA NHÀ. Nó `source` scripts/erp-backup.sh để DÙNG LẠI tiện ích (khoá, JSON,
# ổ đĩa, cấu hình ngoài máy) — không chép lại, không định nghĩa đè. Lịch của nó ở một tệp cron RIÊNG. `BAM_PHAN_NHA` của
# tests/backup.test.ts vẫn khớp.
#
# Mọi dòng người vận hành cần thấy ngay mang tiền tố `[ops:tom-tat] ` (kênh tóm tắt của ops-vps.yml): chỉ con số, tên
# đoạn WAL (hex), mốc thời gian — không một dòng dữ liệu nghiệp vụ nào.
set -euo pipefail

THU_MUC_SCRIPT_PITR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=erp-backup.sh
source "$THU_MUC_SCRIPT_PITR/erp-backup.sh"

# ═══════════════ HẰNG SỐ — KHAI Ở ĐÚNG MỘT CHỖ NÀY ═══════════════
#
# `tests/pitr.test.ts` đòi: compose, cron và phép xoay vòng đọc đúng các hằng số này, không gõ lại con số.
PITR_DIR="$BACKUP_DIR/pitr"            # bind mount vào erp-db tại PITR_TRONG_CONTAINER (docker-compose.prod.yml)
PITR_WAL="$PITR_DIR/wal"
PITR_BASE="$PITR_DIR/base"
PITR_TRONG_CONTAINER="/pitr"
PITR_UID=70                             # postgres của ảnh postgres:16-alpine
PITR_ARCHIVE_TIMEOUT=900                # giây — PHẢI bằng `archive_timeout` trong compose (RPO trên máy ≤ 15 phút)
PITR_RPO_DO_GIAY=$((PITR_ARCHIVE_TIMEOUT * 2))  # đoạn gần nhất cũ hơn 2 chu kỳ ⇒ đỏ (một chu kỳ trễ là bình thường)
PITR_GIU_BAN_NEN=2                      # giữ 2 bản nền + mọi WAL từ bản nền CŨ NHẤT còn giữ
PITR_PHUT_CRON_NEN=27                   # 10 phút sau lượt đêm của nhà (phút 17), cùng khung GIO_BAT_DAU–GIO_KET_THUC
PITR_PHUT_DAY_WAL="8,23,38,53"          # mỗi 15 phút, lệch khỏi phút 0 và khỏi mọi phút của erp-backup.sh
# Diễn tập PITR có trần RAM RIÊNG (không dùng hằng số của restore-drill nhà — phần đó khoá bằng BAM_PHAN_NHA). Đo 30/09/2026:
# VPS 1.963 MB, RAM «available» dao động 690–700 MB giờ thấp điểm ⇒ ngưỡng 700 của restore-drill bỏ qua diễn tập PITR hai lần
# liền. Khôi phục một cụm ~1 GB với shared_buffers mặc định (128 MB) không cần 512 MB; 384 MB + ngưỡng 512 MB vẫn chừa
# ≥ 128 MB cho production (còn 1,7 GB swap), và diễn tập chạy được đúng lúc cần.
BO_NHO_DIEN_TAP_PITR=384m
RAM_TOI_THIEU_DIEN_TAP_PITR_MB=512
PITR_TUOI_NEN_VANG_GIO=36               # bản nền mới nhất cũ hơn chừng này ⇒ vàng (bỏ lỡ một đêm)
PITR_NGOAI_MAY_VANG_PHUT=45             # lượt đẩy WAL thành công gần nhất cũ hơn chừng này ⇒ vàng (lỡ 2 lượt)
PITR_TOC_DO_NEN="32M"                   # trần đọc của pg_basebackup — máy 2 nhân đang phục vụ người dùng thật
PITR_ANH_DIEN_TAP="postgres:16-alpine"  # PHẢI bằng ảnh của dịch vụ db — diễn tập KHÔNG hỏi erp-db ảnh gì
PITR_LUI_MOC_GIAY=120                   # mốc mặc định của diễn tập: lùi 2 phút so với đoạn WAL mới nhất đã lưu
PITR_NHAN_DIEN_TAP="erp.pitr-drill=1"
PITR_KHOA_MARKER="platform.pitr.marker"
CO_TAM_DUNG=".tam-dung"                 # PHẢI trùng deploy/pitr-luu-wal.sh
SO_LO_HONG=".lo-hong.log"               # PHẢI trùng deploy/pitr-luu-wal.sh
TEP_CRON_PITR="${ERP_PITR_CRON_FILE:-/etc/cron.d/erp-pitr}"
KHOA_DAY_WAL="$LOCK_DIR/erp-pitr-wal.lock"   # FD 6 — chỉ chống chạy chồng lượt đẩy WAL, KHÔNG CHỜ
MAU_BAN_NEN='^base-[0-9]{8}-[0-9]{4}$'

tt() { printf '[ops:tom-tat] %s\n' "$*"; }
epoch_cua() { [ -n "${1:-}" ] || return 0; date -u -d "$1" +%s 2>/dev/null || true; } # ISO → giây; rỗng / hỏng ⇒ rỗng (CHƯA BIẾT) — `date -d ""` là nửa đêm hôm nay, không phải "không biết"
moc_pg() { date -u -d "@$1" '+%Y-%m-%d %H:%M:%S+00'; }
iso_cua() { date -u -d "@$1" +%FT%TZ; }
json_chuoi() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" "$2" 2>/dev/null | head -n 1 || true; } # $1=khoá $2=tệp
json_so() { sed -n "s/.*\"$1\":\([0-9][0-9]*\).*/\1/p" "$2" 2>/dev/null | head -n 1 || true; }

# ═══════════════ CHUẨN BỊ THƯ MỤC ═══════════════
#
# Thư mục thuộc uid 70: Postgres (trong erp-db) ghi WAL vào wal/, pg_basebackup ghi vào base/. Chỉ sửa QUYỀN của ba thư
# mục, không đệ quy — tệp đã có giữ nguyên.
cmd_chuan_bi() {
  mkdir -p "$PITR_WAL" "$PITR_BASE" "$STATUS_DIR" || return 1
  chown "$PITR_UID:$PITR_UID" "$PITR_DIR" "$PITR_WAL" "$PITR_BASE" || return 1
  chmod 700 "$PITR_DIR" "$PITR_WAL" "$PITR_BASE" || return 1
  return 0
}

# ═══════════════ XOAY VÒNG BẢN NỀN + DỌN WAL ═══════════════

ds_ban_nen() { ls -1 "$PITR_BASE" 2>/dev/null | grep -E "$MAU_BAN_NEN" | sort || true; }

# Xoá mọi đoạn WAL CŨ HƠN đoạn bắt đầu của bản nền cũ nhất còn giữ (so tên 24 ký tự hex = timeline + vị trí, đúng phép so
# của pg_archivecleanup). `.history` luôn giữ (vài byte, cần để đi đúng timeline). Dòng lỗ hổng cũ hơn mốc đó cũng bỏ.
don_wal_truoc() { # $1=đoạn WAL bắt đầu (24 hex)
  local moc="$1" f ten n=0 tam
  [[ "$moc" =~ ^[0-9A-F]{24}$ ]] || { loi "dọn WAL: mốc '$moc' không phải tên đoạn WAL — KHÔNG xoá gì"; return 1; }
  for f in "$PITR_WAL"/*.gz; do
    [ -f "$f" ] || continue
    ten="$(basename "$f")"
    [[ "$ten" =~ ^([0-9A-F]{24})(\.partial|\.[0-9A-F]{8}\.backup)?\.gz$ ]] || continue
    if [[ "${BASH_REMATCH[1]}" < "$moc" ]]; then rm -f -- "$f"; n=$((n + 1)); fi
  done
  if [ -f "$PITR_WAL/$SO_LO_HONG" ]; then
    tam="$(awk -v m="$moc" '$2 >= m' "$PITR_WAL/$SO_LO_HONG")" || true
    # `cat >` giữ nguyên chủ tệp (uid 70 — Postgres còn phải ghi tiếp vào nó).
    if [ -n "$tam" ]; then printf '%s\n' "$tam" > "$PITR_WAL/$SO_LO_HONG"; else : > "$PITR_WAL/$SO_LO_HONG"; fi
  fi
  bao "PITR: dọn $n đoạn WAL cũ hơn $moc (bản nền cũ nhất còn giữ)"
  DA_DON_WAL=$n
}

# Giữ PITR_GIU_BAN_NEN bản nền mới nhất (theo MỐC TRONG TÊN), rồi dọn WAL theo bản cũ nhất còn lại.
xoay_vong_ban_nen() {
  local ds d cu moc
  DA_DON_WAL=0
  if ! [ "$PITR_GIU_BAN_NEN" -ge 1 ] 2>/dev/null; then loi "xoay vòng bản nền: số bản giữ '$PITR_GIU_BAN_NEN' không hợp lệ — KHÔNG xoá gì"; return 1; fi
  ds="$(ds_ban_nen)"
  [ -n "$ds" ] || return 0
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    rm -rf -- "${PITR_BASE:?}/$d"
    bao "PITR: xoay vòng — xoá bản nền $d"
  done < <(printf '%s\n' "$ds" | sort -r | tail -n +"$((PITR_GIU_BAN_NEN + 1))")
  cu="$(ds_ban_nen | head -n 1)"
  moc="$(cat "$PITR_BASE/$cu/bat-dau-wal" 2>/dev/null || true)"
  if [ -z "$moc" ]; then loi "bản nền $cu không có tệp bat-dau-wal — KHÔNG dọn WAL (giữ thừa an toàn hơn xoá thiếu)"; return 0; fi
  don_wal_truoc "$moc"
}

# ═══════════════ NGOÀI MÁY ═══════════════
#
# Cùng luật với erp-backup.sh: `copyto` từng tệp + đọc lại kích thước ở đầu kia, KHÔNG BAO GIỜ `sync` (sync xoá bên kia khi
# bên này bị xoá — đúng thứ bản ngoài máy sinh ra để giữ). Lỗi đẩy KHÔNG đụng bản cục bộ.
day_ban_nen_ngoai_may() { # $1=tên bản nền
  local ten="$1" remote="${BACKUP_OFFSITE_REMOTE:-}" f dich kt_xa kt_goc tep_loi="$STATUS_DIR/.rclone-pitr.err"
  PITR_OFFSITE_STATE="NOT_CONFIGURED"; PITR_OFFSITE_REASON=""
  if [ -z "$remote" ]; then PITR_OFFSITE_REASON="Chưa khai BACKUP_OFFSITE_REMOTE — bản nền chỉ nằm trên VPS."; return 0; fi
  if ! command -v rclone >/dev/null 2>&1; then PITR_OFFSITE_STATE="FAILED"; PITR_OFFSITE_REASON="Đã khai nơi lưu ngoài máy nhưng máy chưa có rclone."; return 0; fi
  for f in "$PITR_BASE/$ten"/*; do
    [ -f "$f" ] || continue
    dich="$(noi_duong "$remote" "pitr/base/$ten/$(basename "$f")")"
    if ! timeout "$TRAN_LENH_GIAY" rclone copyto --retries 3 "$f" "$dich" 2>"$tep_loi"; then
      PITR_OFFSITE_STATE="FAILED"; PITR_OFFSITE_REASON="rclone copyto lỗi cho $(basename "$f"): $(tail -n 1 "$tep_loi" 2>/dev/null || true)"
      rm -f "$tep_loi"; return 0
    fi
    kt_xa="$(timeout 300 rclone lsf --format s "$dich" 2>/dev/null | head -n 1 || true)"
    kt_goc="$(kich_thuoc "$f")"
    if [ "$kt_xa" != "$kt_goc" ]; then
      PITR_OFFSITE_STATE="FAILED"; PITR_OFFSITE_REASON="Đầu kia báo $(basename "$f") nặng '${kt_xa:-không thấy}' byte, bản gốc $kt_goc byte."
      rm -f "$tep_loi"; return 0
    fi
  done
  rm -f "$tep_loi"
  PITR_OFFSITE_STATE="OK"
  # Dọn theo TUỔI: bản nền một đêm một bản, giữ PITR_GIU_BAN_NEN bản + 2 ngày đệm.
  timeout 900 rclone delete "$(noi_duong "$remote" pitr/base)" --min-age "$((PITR_GIU_BAN_NEN + 2))d" 2>/dev/null || true
  timeout 900 rclone rmdirs "$(noi_duong "$remote" pitr/base)" --leave-root 2>/dev/null || true
  return 0
}

ghi_trang_thai_ngoai_may() { # $1=state $2=lý do $3=lastOkAt
  ghi_json "$STATUS_DIR/pitr-offsite.json" "$(printf '{"schema":1,"kind":"pitr-offsite","state":%s,"reason":%s,"lastRunAt":%s,"lastOkAt":%s}' \
    "$(js "$1")" "$(js "$2")" "$(js "$(bay_gio_utc)")" "$(js "$3")")"
}

# ═══════════════ LỆNH: push-wal — ĐẨY KHO WAL NGOÀI MÁY MỖI 15 PHÚT ═══════════════
#
# RPO ngoài máy ≤ archive_timeout + 15 phút. `rclone copy` chỉ chép tệp mới / khác (so kích thước + mốc), KHÔNG xoá
# gì ở đầu kia theo đầu này. Dọn đầu kia theo TUỔI, khớp số bản nền giữ. Khoá riêng (FD 6, không chờ): đẩy WAL không
# đụng CSDL nên không cần xếp hàng sau lượt dump đêm — chỉ cần không chạy chồng chính nó.
cmd_push_wal() {
  local remote tep_loi cu_ok
  mkdir -p "$STATUS_DIR"
  nap_cau_hinh
  remote="${BACKUP_OFFSITE_REMOTE:-}"
  cu_ok="$(json_chuoi lastOkAt "$STATUS_DIR/pitr-offsite.json")"
  if [ -z "$remote" ]; then
    ghi_trang_thai_ngoai_may NOT_CONFIGURED "Chưa khai BACKUP_OFFSITE_REMOTE — WAL chỉ nằm trên VPS." "$cu_ok"
    return 0
  fi
  [ -d "$PITR_WAL" ] || return 0
  mkdir -p "$LOCK_DIR"
  exec 6>"$KHOA_DAY_WAL"
  flock -n 6 || return 0
  if ! command -v rclone >/dev/null 2>&1; then
    ghi_trang_thai_ngoai_may FAILED "Đã khai nơi lưu ngoài máy nhưng máy chưa có rclone." "$cu_ok"
    return 1
  fi
  tep_loi="$STATUS_DIR/.rclone-pitr-wal.err"
  if ! timeout "$TRAN_LENH_GIAY" rclone copy --retries 3 --exclude '.*' "$PITR_WAL" "$(noi_duong "$remote" pitr/wal)" 2>"$tep_loi"; then
    ghi_trang_thai_ngoai_may FAILED "rclone copy kho WAL lỗi: $(tail -n 1 "$tep_loi" 2>/dev/null || true)" "$cu_ok"
    rm -f "$tep_loi"
    loi "PITR: đẩy WAL ngoài máy LỖI — bản cục bộ giữ nguyên"
    return 1
  fi
  rm -f "$tep_loi"
  ghi_trang_thai_ngoai_may OK "" "$(bay_gio_utc)"
  timeout 900 rclone delete "$(noi_duong "$remote" pitr/wal)" --min-age "$((PITR_GIU_BAN_NEN + 2))d" 2>/dev/null || true
  return 0
}

# ═══════════════ LỆNH: base — BẢN NỀN (pg_basebackup) ═══════════════
#
# LUẬT:
#  · Chỉ khi archive_mode = on — bản nền không có chuỗi WAL đi kèm thì không phải PITR (bản đêm pg_dump đã làm việc đó).
#  · `pg_basebackup -Ft -X stream -Z 1` chạy TRONG erp-db, ghi thẳng vào /pitr/base (bind mount) — không qua stdout, không
#    chép hai lần. `-X stream` mang theo đúng WAL cần để bản nền tự nhất quán (pg_wal.tar.gz), không phụ thuộc kho WAL.
#    `-c spread` + `-r PITR_TOC_DO_NEN`: không checkpoint dồn, không vắt IO của máy đang phục vụ người dùng.
#  · Kiểm TRƯỚC: container chạy, archive_mode, ổ trống ≥ cỡ cụm + DU_TRU_O_DIA_MB. Kiểm SAU: hai tệp tar không rỗng,
#    `gzip -t`, đọc được `backup_label` và đoạn WAL bắt đầu. Hỏng bất kỳ ⇒ xoá bản dở, FAILED, không xoay vòng.
#  · Xoay vòng CHỈ SAU khi bản mới đã kiểm; dọn WAL theo bản cũ nhất còn giữ.
#  · Khoá: FD 7 không chờ (một lượt sao lưu / diễn tập tại một thời điểm) → FD 8 → FD 9, đúng thứ tự của erp-backup.sh.
#  · Được gọi trong ngữ cảnh `||` (set -e TẮT): mọi bước tự kiểm và `return`.
ghi_trang_thai_nen() { # $1=kết quả $2=lý do
  ghi_json "$STATUS_DIR/pitr-base.json" "$(printf '{"schema":1,"kind":"pitr-base","result":%s,"trigger":%s,"startedAt":%s,"finishedAt":%s,"reason":%s,"base":{"name":%s,"bytes":%s,"startWal":%s},"clusterBytes":%s,"prunedWal":%s,"offsite":{"state":%s,"reason":%s},"retention":{"base":%s}}' \
    "$(js "$1")" "$(js "$TRIGGER")" "$(js "$BAT_DAU")" "$(js "$(bay_gio_utc)")" "$(js "$2")" "$(js "${NEN_TEN:-}")" "$(jn "${NEN_BYTES:-}")" "$(js "${NEN_WAL:-}")" \
    "$(jn "${CUM_BYTES:-}")" "$(jn "${DA_DON_WAL:-}")" "$(js "${PITR_OFFSITE_STATE:-NOT_RUN}")" "$(js "${PITR_OFFSITE_REASON:-}")" "$PITR_GIU_BAN_NEN")" || true
}

cmd_base() {
  local moc tam dong_loi nhan cum_mb tu_do can tep_loi ma_thoat_ban=75 f
  BAT_DAU="$(bay_gio_utc)"; NEN_TEN=""; NEN_BYTES=""; NEN_WAL=""; CUM_BYTES=""; DA_DON_WAL=""
  PITR_OFFSITE_STATE="NOT_RUN"; PITR_OFFSITE_REASON=""
  [ "$TRIGGER" = "cron" ] && ma_thoat_ban=0
  cmd_chuan_bi || { loi "PITR: không chuẩn bị được $PITR_DIR"; return 1; }
  nap_cau_hinh
  if ! khoa_chong_chong; then
    bao "PITR: một lượt sao lưu / diễn tập khác đang giữ $KHOA_SAO_LUU — bản nền KHÔNG chạy lúc này."
    return "$ma_thoat_ban"
  fi
  giu_khoa 8 "$KHOA_DOC_DB" -x "$TRAN_CHO_KHOA_GIAY" || { loi "PITR: hết giờ chờ khoá đọc nặng — bản nền KHÔNG chạy."; return 75; }
  giu_khoa 9 "$KHOA_VONG_DOI" -s "$TRAN_CHO_KHOA_GIAY" || { loi "PITR: hết giờ chờ khoá vòng đời — bản nền KHÔNG chạy."; return 75; }

  if [ "$(docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null || true)" != "true" ]; then
    ghi_trang_thai_nen FAILED "Container $DB_CONTAINER không chạy."; loi "PITR: $DB_CONTAINER không chạy."; return 1
  fi
  nhan="$(docker exec "$DB_CONTAINER" psql -U erp -d erp -Atc "select setting from pg_settings where name = 'archive_mode'" 2>/dev/null || true)"
  if [ "$nhan" != "on" ]; then
    ghi_trang_thai_nen FAILED "archive_mode = '${nhan:-không đọc được}' — PITR CHƯA BẬT, bản nền không có chuỗi WAL đi kèm (deploy cấu hình compose trước)."
    loi "PITR: archive_mode = '${nhan:-?}' — chưa bật, KHÔNG chụp bản nền."; return 1
  fi
  CUM_BYTES="$(docker exec "$DB_CONTAINER" psql -U erp -d erp -Atc "select sum(pg_database_size(datname))::bigint from pg_database" 2>/dev/null || true)"
  if ! [[ "$CUM_BYTES" =~ ^[0-9]+$ ]]; then
    CUM_BYTES=""; ghi_trang_thai_nen FAILED "Không đọc được cỡ cụm — KHÔNG chụp khi không biết cần bao nhiêu chỗ."
    loi "PITR: không đọc được cỡ cụm."; return 1
  fi
  cum_mb="$(mb_cua "$CUM_BYTES")"
  tu_do="$(o_trong_mb "$PITR_DIR")"
  can=$((cum_mb + DU_TRU_O_DIA_MB))
  if [ -z "$tu_do" ] || [ "$tu_do" -lt "$can" ]; then
    ghi_trang_thai_nen FAILED "Ổ đĩa còn ${tu_do:-?} MB, cần ≥ $can MB (cụm $cum_mb MB + dự trữ $DU_TRU_O_DIA_MB MB) — KHÔNG chụp bản nền."
    loi "PITR: không đủ ổ đĩa cho bản nền (còn ${tu_do:-?} MB, cần ≥ $can MB)."; return 1
  fi

  moc="$(gio_vn +%Y%m%d-%H%M)"
  NEN_TEN="base-$moc"
  if [ -e "$PITR_BASE/$NEN_TEN" ]; then
    ghi_trang_thai_nen FAILED "Bản nền $NEN_TEN đã có (hai lượt trong cùng một phút) — KHÔNG ghi đè."
    loi "PITR: $NEN_TEN đã có."; return 1
  fi
  rm -rf -- "$PITR_BASE"/.dang-ghi-* 2>/dev/null || true
  tam="$PITR_BASE/.dang-ghi-$moc"
  mkdir -p "$tam" && chown "$PITR_UID:$PITR_UID" "$tam" 2>/dev/null; chmod 700 "$tam" 2>/dev/null || true
  tep_loi="$STATUS_DIR/.pitr-base.err"
  bao "PITR: pg_basebackup → $tam (cụm $cum_mb MB, trần đọc $PITR_TOC_DO_NEN/s)"
  if ! timeout "$TRAN_LENH_GIAY" docker exec "$DB_CONTAINER" pg_basebackup -U erp -D "$PITR_TRONG_CONTAINER/base/.dang-ghi-$moc" \
    -Ft -X stream -Z 1 -c spread -r "$PITR_TOC_DO_NEN" -l "erp-pitr-$moc" 2>"$tep_loi"; then
    dong_loi="$(tail -n 1 "$tep_loi" 2>/dev/null || true)"
    rm -rf -- "$tam" "$tep_loi"
    ghi_trang_thai_nen FAILED "pg_basebackup lỗi: ${dong_loi:-không có thông báo} (cần dòng 'local replication' trong pg_hba.conf — mặc định của ảnh postgres có)."
    loi "PITR: pg_basebackup lỗi: ${dong_loi:-?}"; return 1
  fi
  rm -f "$tep_loi"

  # KIỂM TOÀN VẸN — `pg_wal.tar.gz` (nén) hoặc `pg_wal.tar` tuỳ bản pg_basebackup; bản nền bắt buộc có.
  local wal_tar=""
  for f in pg_wal.tar.gz pg_wal.tar; do [ -s "$tam/$f" ] && wal_tar="$tam/$f" && break; done
  if [ ! -s "$tam/base.tar.gz" ] || [ -z "$wal_tar" ] || ! gzip -t "$tam/base.tar.gz" 2>/dev/null \
    || { [[ "$wal_tar" == *.gz ]] && ! gzip -t "$wal_tar" 2>/dev/null; }; then
    rm -rf -- "$tam"
    ghi_trang_thai_nen FAILED "Bản nền thiếu base.tar.gz / pg_wal.tar(.gz) hoặc tệp nén hỏng — đã xoá bản dở."
    loi "PITR: bản nền vừa chụp không qua kiểm toàn vẹn — đã xoá."; return 1
  fi
  nhan="$(tar -xzOf "$tam/base.tar.gz" backup_label 2>/dev/null || true)"
  NEN_WAL="$(sed -n 's/^START WAL LOCATION: .*(file \([0-9A-F]\{24\}\))$/\1/p' <<< "$nhan" | head -n 1)"
  if ! [[ "$NEN_WAL" =~ ^[0-9A-F]{24}$ ]]; then
    rm -rf -- "$tam"; NEN_WAL=""
    ghi_trang_thai_nen FAILED "Không đọc được backup_label / đoạn WAL bắt đầu trong base.tar.gz — đã xoá bản dở."
    loi "PITR: base.tar.gz không có backup_label đọc được — đã xoá."; return 1
  fi
  printf '%s\n' "$NEN_WAL" > "$tam/bat-dau-wal"
  NEN_BYTES=0
  for f in "$tam"/*; do [ -f "$f" ] && NEN_BYTES=$((NEN_BYTES + $(kich_thuoc "$f"))); done
  ghi_json "$tam/nen.json" "$(printf '{"schema":1,"kind":"pitr-base-meta","name":%s,"startWal":%s,"startedAt":%s,"finishedAt":%s,"bytes":%s,"clusterBytes":%s}' \
    "$(js "$NEN_TEN")" "$(js "$NEN_WAL")" "$(js "$BAT_DAU")" "$(js "$(bay_gio_utc)")" "$(jn "$NEN_BYTES")" "$(jn "$CUM_BYTES")")"
  if ! mv "$tam" "$PITR_BASE/$NEN_TEN"; then
    rm -rf -- "$tam"; ghi_trang_thai_nen FAILED "Không đổi tên được bản nền."; loi "PITR: không đổi tên được bản nền."; return 1
  fi
  bao "PITR: bản nền $NEN_TEN — $NEN_BYTES byte, bắt đầu ở đoạn $NEN_WAL"

  xoay_vong_ban_nen || true
  day_ban_nen_ngoai_may "$NEN_TEN"
  if [ "$PITR_OFFSITE_STATE" = "FAILED" ]; then
    ghi_trang_thai_nen PARTIAL "Bản nền đã chụp và kiểm; phần hỏng: bản ngoài máy ($PITR_OFFSITE_REASON)"
  else
    ghi_trang_thai_nen OK ""
  fi
  [ "$TRIGGER" != "cron" ] || printf '%s\n' "$(gio_vn +%F)" > "$STATUS_DIR/pitr-base-done"
  tt "PITR bản nền: $NEN_TEN · $(mb_cua "$NEN_BYTES") MB · bắt đầu ở đoạn $NEN_WAL · giữ $PITR_GIU_BAN_NEN bản · dọn ${DA_DON_WAL:-0} đoạn WAL cũ · ngoài máy $PITR_OFFSITE_STATE"
  [ "$PITR_OFFSITE_STATE" != "FAILED" ] || return 1
  return 0
}

# Cron mỗi giờ: chỉ trong khung đêm của nhà, SAU bản đêm (daily-done = hôm nay), hoặc ở giờ cuối khung dù bản đêm hỏng
# (PITR không được chết theo pg_dump). Mỗi đêm một bản. archive_mode chưa bật ⇒ im lặng: cấu hình chưa deploy.
cmd_base_cron() {
  local gio hom_nay
  gio=$((10#$(gio_vn +%H)))
  if [ "$gio" -lt "$GIO_BAT_DAU" ] || [ "$gio" -gt "$GIO_KET_THUC" ]; then return 0; fi
  hom_nay="$(gio_vn +%F)"
  [ "$(cat "$STATUS_DIR/pitr-base-done" 2>/dev/null || true)" != "$hom_nay" ] || return 0
  if [ "$(cat "$STATUS_DIR/daily-done" 2>/dev/null || true)" != "$hom_nay" ] && [ "$gio" -lt "$GIO_KET_THUC" ]; then return 0; fi
  [ "$(docker exec "$DB_CONTAINER" psql -U erp -d erp -Atc "select setting from pg_settings where name = 'archive_mode'" 2>/dev/null || true)" = "on" ] || return 0
  TRIGGER="cron"
  cmd_base
}

# ═══════════════ LỆNH: status — CHỈ ĐỌC ═══════════════
#
# Phán quyết là hàm THUẦN trên các biến X_* (bài kiểm gọi thẳng): mỗi lý do một dòng `DO|…` hoặc `VANG|…`, rồi
# PITR_KET_LUAN = OK | VANG | DO. Chưa biết (rỗng) KHÔNG BAO GIỜ được đọc thành "ổn" (AGENTS.md mục 42).
phan_xu_pitr() {
  local do_=0 vang=0 rpo tuoi
  PITR_LY_DO=""
  _do() { PITR_LY_DO="${PITR_LY_DO}DO|$1"$'\n'; do_=1; }
  _vang() { PITR_LY_DO="${PITR_LY_DO}VANG|$1"$'\n'; vang=1; }
  [ "${X_MODE:-}" = "on" ] || _do "archive_mode = '${X_MODE:-không đọc được}' — PITR CHƯA BẬT"
  case "${X_LEVEL:-}" in replica | logical) ;; *) _do "wal_level = '${X_LEVEL:-không đọc được}' — không đủ cho lưu WAL" ;; esac
  [ "${X_PHANH:-}" != "PHANH" ] || _do "archive_command = /bin/true — phanh khẩn đang kéo, WAL KHÔNG được lưu"
  [ "${X_TAM_DUNG:-0}" != "1" ] || _do "cờ tạm dừng ($CO_TAM_DUNG) đang bật — mọi đoạn WAL đang bị bỏ"
  if [ -z "${X_LAST_ARCH:-}" ]; then
    _do "chưa lưu được đoạn WAL nào (pg_stat_archiver.last_archived_time rỗng)"
  elif [ -n "${X_NOW:-}" ]; then
    rpo=$((X_NOW - X_LAST_ARCH))
    [ "$rpo" -le "$PITR_RPO_DO_GIAY" ] || _do "đoạn WAL gần nhất lưu cách đây $((rpo / 60)) phút > $((PITR_RPO_DO_GIAY / 60)) phút"
  fi
  if [ -n "${X_LAST_FAIL:-}" ] && { [ -z "${X_LAST_ARCH:-}" ] || [ "$X_LAST_FAIL" -gt "$X_LAST_ARCH" ]; }; then
    _do "lượt lưu gần nhất THẤT BẠI (sau lượt thành công gần nhất) — đọc log erp-db, dòng 'erp-pitr luu-wal'"
  fi
  [ "${X_READY:-0}" -le 3 ] 2>/dev/null || _vang "${X_READY} đoạn WAL đang chờ lưu trong pg_wal"
  if [ -z "${X_BASE_EPOCH:-}" ]; then
    _do "chưa có bản nền nào — chạy ops pitr-basebackup"
  elif [ -n "${X_NOW:-}" ]; then
    tuoi=$((X_NOW - X_BASE_EPOCH))
    [ "$tuoi" -le $((PITR_TUOI_NEN_VANG_GIO * 3600)) ] || _vang "bản nền mới nhất đã $((tuoi / 3600)) giờ > $PITR_TUOI_NEN_VANG_GIO giờ"
  fi
  [ "${X_LO_HONG:-0}" = "0" ] || _do "chuỗi WAL ĐỨT sau bản nền mới nhất (${X_LO_HONG} đoạn bị bỏ) — cần bản nền mới"
  [ "${X_BAN_LUU_WAL:-}" != "KHAC" ] || _vang "kịch bản lưu WAL trong erp-db khác bản trong kho — nhận khi erp-db được tạo lại"
  case "${X_OFF_STATE:-}" in
    OK)
      if [ -z "${X_OFF_EPOCH:-}" ] || [ -z "${X_NOW:-}" ] || [ $((X_NOW - X_OFF_EPOCH)) -gt $((PITR_NGOAI_MAY_VANG_PHUT * 60)) ]; then
        _vang "lượt đẩy WAL ngoài máy thành công gần nhất quá $PITR_NGOAI_MAY_VANG_PHUT phút"
      fi ;;
    NOT_CONFIGURED) _vang "CHƯA CÓ BẢN SAO NGOÀI MÁY cho WAL / bản nền (BACKUP_OFFSITE_REMOTE)" ;;
    FAILED) _vang "đẩy WAL ngoài máy đang LỖI" ;;
    *) _vang "chưa có lượt đẩy WAL ngoài máy nào" ;;
  esac
  if [ "$do_" = 1 ]; then PITR_KET_LUAN="DO"; elif [ "$vang" = 1 ]; then PITR_KET_LUAN="VANG"; else PITR_KET_LUAN="OK"; fi
}

SQL_TRANG_THAI="select (select setting from pg_settings where name='wal_level'), (select setting from pg_settings where name='archive_mode'), (select setting from pg_settings where name='archive_timeout'), case when current_setting('archive_command') = '/bin/true' then 'PHANH' else 'THUONG' end, a.archived_count, coalesce(a.last_archived_wal, ''), coalesce(extract(epoch from a.last_archived_time)::bigint::text, ''), a.failed_count, coalesce(extract(epoch from a.last_failed_time)::bigint::text, ''), extract(epoch from now())::bigint, (select count(*) from pg_ls_archive_statusdir() where name like '%.ready'), (select coalesce(sum(size), 0) / 1048576 from pg_ls_waldir()) from pg_stat_archiver a"

cmd_pitr_status() {
  local dong x_timeout x_count x_last_wal x_failed pg_wal_mb so_tep wal_mb moi moi_ep nen cu_nen so_nen nen_json nen_wal nen_bytes host_sha ct_sha
  X_MODE=""; X_LEVEL=""; X_PHANH=""; X_LAST_ARCH=""; X_LAST_FAIL=""; X_NOW=""; X_READY=""; X_BASE_EPOCH=""; X_TAM_DUNG=0; X_LO_HONG=0
  X_OFF_STATE=""; X_OFF_EPOCH=""; X_BAN_LUU_WAL=""
  tt "PITR — trạng thái lúc $(bay_gio_utc) (CHỈ ĐỌC)"
  if dong="$(docker exec "$DB_CONTAINER" psql -U erp -d erp -AtF '|' -c "$SQL_TRANG_THAI" 2>/dev/null)" && [ -n "$dong" ]; then
    IFS='|' read -r X_LEVEL X_MODE x_timeout X_PHANH x_count x_last_wal X_LAST_ARCH x_failed X_LAST_FAIL X_NOW X_READY pg_wal_mb <<< "$dong"
    tt "Postgres: wal_level=$X_LEVEL · archive_mode=$X_MODE · archive_timeout=${x_timeout}s · archive_command: $([ "$X_PHANH" = PHANH ] && echo '/bin/true (PHANH)' || echo 'kịch bản lưu WAL')"
    tt "pg_stat_archiver: đã lưu $x_count đoạn · gần nhất ${x_last_wal:-—} lúc $([ -n "$X_LAST_ARCH" ] && iso_cua "$X_LAST_ARCH" || echo —) · lỗi $x_failed lần$([ -n "$X_LAST_FAIL" ] && printf ', lần gần nhất %s' "$(iso_cua "$X_LAST_FAIL")") · chờ lưu $X_READY đoạn · pg_wal ${pg_wal_mb} MB"
    if [ -n "$X_LAST_ARCH" ]; then tt "RPO hiện tại (trên máy) = now − last_archived_time = $(((X_NOW - X_LAST_ARCH) / 60)) phút $(((X_NOW - X_LAST_ARCH) % 60)) giây"; fi
  else
    tt "Postgres: KHÔNG đọc được pg_stat_archiver ($DB_CONTAINER không chạy hoặc psql lỗi) — CHƯA BIẾT"
  fi
  X_NOW="${X_NOW:-$(date +%s)}"

  # Kịch bản lưu WAL trong container có đúng bản trong kho không (mount MỘT TỆP giữ inode cũ tới khi tạo lại erp-db).
  host_sha="$(sha256sum "$ERP_DIR/deploy/pitr-luu-wal.sh" 2>/dev/null | cut -c1-16 || true)"
  ct_sha="$(docker exec "$DB_CONTAINER" sha256sum /erp-pitr-bin/luu-wal.sh 2>/dev/null | cut -c1-16 || true)"
  if [ -n "$host_sha" ] && [ -n "$ct_sha" ]; then [ "$host_sha" = "$ct_sha" ] && X_BAN_LUU_WAL="KHOP" || X_BAN_LUU_WAL="KHAC"; fi
  tt "Kịch bản lưu WAL: kho ${host_sha:-—} · trong erp-db ${ct_sha:-—}"

  so_tep="$(ls -1 "$PITR_WAL" 2>/dev/null | grep -cE '^[0-9A-F]{24}(\.partial)?\.gz$' || true)"
  wal_mb="$(du -sm "$PITR_WAL" 2>/dev/null | cut -f1 || true)"
  moi="$(ls -1 "$PITR_WAL" 2>/dev/null | grep -E '^[0-9A-F]{24}(\.partial)?\.gz$' | sort | tail -n 1 || true)"
  moi_ep=""; [ -z "$moi" ] || moi_ep="$(stat -c %Y "$PITR_WAL/$moi" 2>/dev/null || true)"
  [ ! -e "$PITR_WAL/$CO_TAM_DUNG" ] || X_TAM_DUNG=1
  tt "Kho WAL trên máy: ${so_tep:-0} đoạn · ${wal_mb:-?} MB · mới nhất ${moi:-—}$([ -n "$moi_ep" ] && printf ' (%s)' "$(iso_cua "$moi_ep")") · tạm dừng: $([ "$X_TAM_DUNG" = 1 ] && echo CÓ || echo không)"

  so_nen="$(ds_ban_nen | grep -c . || true)"
  nen="$(ds_ban_nen | tail -n 1)"; cu_nen="$(ds_ban_nen | head -n 1)"
  if [ -n "$nen" ]; then
    nen_json="$PITR_BASE/$nen/nen.json"
    X_BASE_EPOCH="$(epoch_cua "$(json_chuoi finishedAt "$nen_json")")"
    nen_wal="$(cat "$PITR_BASE/$nen/bat-dau-wal" 2>/dev/null || true)"
    nen_bytes="$(json_so bytes "$nen_json")"
    if [ -f "$PITR_WAL/$SO_LO_HONG" ] && [[ "$nen_wal" =~ ^[0-9A-F]{24}$ ]]; then
      X_LO_HONG="$(awk -v m="$nen_wal" '$2 >= m' "$PITR_WAL/$SO_LO_HONG" | grep -c . || true)"
    fi
    tt "Bản nền: $so_nen bản (giữ $PITR_GIU_BAN_NEN) · mới nhất $nen · $([ -n "$nen_bytes" ] && mb_cua "$nen_bytes" || echo ?) MB · tuổi $([ -n "$X_BASE_EPOCH" ] && echo "$(((X_NOW - X_BASE_EPOCH) / 3600)) giờ" || echo '?') · cửa sổ PITR từ lúc bản $cu_nen xong tới đoạn WAL mới nhất"
  else
    tt "Bản nền: CHƯA CÓ — chạy ops pitr-basebackup"
  fi
  X_OFF_STATE="$(json_chuoi state "$STATUS_DIR/pitr-offsite.json")"
  X_OFF_EPOCH="$(epoch_cua "$(json_chuoi lastOkAt "$STATUS_DIR/pitr-offsite.json")")"
  tt "Ngoài máy (gcrypt:pitr/): ${X_OFF_STATE:-chưa chạy} · đẩy thành công gần nhất $([ -n "$X_OFF_EPOCH" ] && iso_cua "$X_OFF_EPOCH" || echo —)"
  [ ! -f "$STATUS_DIR/pitr-drill.json" ] || tt "Diễn tập PITR gần nhất: $(json_chuoi result "$STATUS_DIR/pitr-drill.json") lúc $(json_chuoi finishedAt "$STATUS_DIR/pitr-drill.json")"

  phan_xu_pitr
  while IFS= read -r dong; do
    [ -n "$dong" ] || continue
    tt "$([ "${dong%%|*}" = DO ] && echo 'ĐỎ' || echo 'VÀNG'): ${dong#*|}"
  done <<< "$PITR_LY_DO"
  tt "KẾT LUẬN PITR: $PITR_KET_LUAN"
  [ "$PITR_KET_LUAN" != "DO" ] || return 1
  return 0
}

# ═══════════════ LỆNH: mark — MỘT DÒNG ĐÁNH DẤU CHO DIỄN TẬP ═══════════════
#
# Ghi ĐÚNG MỘT dòng `settings` (khoá PITR_KHOA_MARKER) = nonce ngẫu nhiên, và lưu nonce + mốc COMMIT (giờ của CSDL) vào
# status/pitr-marker.json trên máy chủ. Diễn tập đọc tệp đó — không bao giờ hỏi erp-db — rồi đòi: khôi phục tới mốc TRƯỚC
# dòng ⇒ nonce VẮNG; tới mốc SAU ⇒ nonce CÓ. Đó là bằng chứng khôi phục ĐÚNG mốc, không chỉ "khôi phục được".
cmd_mark() {
  local nonce at
  mkdir -p "$STATUS_DIR"
  if [ "$(docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null || true)" != "true" ]; then
    loi "PITR: $DB_CONTAINER không chạy — không ghi dòng đánh dấu."; return 1
  fi
  nonce="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  [[ "$nonce" =~ ^[0-9a-f]{16}$ ]] || { loi "PITR: không sinh được nonce."; return 1; }
  at="$(docker exec "$DB_CONTAINER" psql -U erp -d erp -v ON_ERROR_STOP=1 -qAt -c "insert into settings (key, value, updated_at) values ('$PITR_KHOA_MARKER', '{\"nonce\":\"$nonce\",\"by\":\"ops pitr-mark\"}', now()) on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at returning to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')" 2>/dev/null | head -n 1 || true)"
  if ! [[ "$at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]]; then
    loi "PITR: ghi dòng đánh dấu KHÔNG xác nhận được (psql không trả mốc) — không lưu tệp đánh dấu."; return 1
  fi
  ghi_json "$STATUS_DIR/pitr-marker.json" "$(printf '{"schema":1,"kind":"pitr-marker","key":%s,"nonce":%s,"at":%s}' "$(js "$PITR_KHOA_MARKER")" "$(js "$nonce")" "$(js "$at")")"
  tt "PITR dòng đánh dấu: settings.$PITR_KHOA_MARKER = nonce ${nonce:0:4}… · mốc commit $at · chờ ≥ 1 chu kỳ archive (${PITR_ARCHIVE_TIMEOUT}s) rồi chạy pitr-drill"
  return 0
}

# ═══════════════ LỆNH: pause / resume — PHANH TAY KHÔNG CẦN KHỞI ĐỘNG LẠI ═══════════════
cmd_pause() {
  [ -d "$PITR_WAL" ] || { loi "PITR: chưa có $PITR_WAL — chưa bật PITR, không có gì để tạm dừng."; return 1; }
  : > "$PITR_WAL/$CO_TAM_DUNG"
  chmod 644 "$PITR_WAL/$CO_TAM_DUNG"
  tt "PITR TẠM DỪNG: mọi đoạn WAL từ giờ bị BỎ (ghi vào $SO_LO_HONG) — Postgres thôi dồn WAL, chuỗi PITR ĐỨT. Chạy lại: ops pitr-pause arg resume, rồi pitr-basebackup."
}
cmd_resume() {
  rm -f "$PITR_WAL/$CO_TAM_DUNG"
  tt "PITR CHẠY LẠI: đoạn WAL mới được lưu tiếp. Chuỗi đã đứt trong lúc tạm dừng ⇒ chạy ops pitr-basebackup để có mốc khôi phục mới."
}

# ═══════════════ LỆNH: drill — DIỄN TẬP PITR TRONG CONTAINER TẠM ═══════════════
#
# LUẬT (tests/pitr.test.ts quét nguồn VÀ chạy với docker giả):
#  · KHÔNG BAO GIỜ nhắc tới container, volume, cổng hay mạng của production. Ảnh là HẰNG SỐ (PITR_ANH_DIEN_TAP), không hỏi
#    erp-db. Dữ liệu lấy từ bản nền trên đĩa, WAL từ kho WAL (gắn CHỈ-ĐỌC), dòng đánh dấu từ status/pitr-marker.json.
#  · Container `--network none`, trần RAM như restore-drill, kiểm RAM + ổ TRƯỚC khi dựng; thư mục tạm + container xoá bằng
#    trap EXIT kể cả khi hỏng giữa chừng.
#  · Hai pha trên CÙNG thư mục dữ liệu (không giải nén hai lần): pha TRƯỚC dừng ở (mốc đánh dấu − 1 giây) và đòi nonce VẮNG;
#    pha SAU tiếp tục phục hồi tới mốc yêu cầu và đòi nonce CÓ + bảng lõi có dữ liệu. `recovery_target_action=pause` +
#    hot standby: đọc được mà không promote, nên pha sau đi tiếp được từ chỗ pha trước dừng.
#  · Kết quả: OK (mọi vế đạt) · PARTIAL (phục hồi được nhưng vế đánh dấu không đo được — thiếu dòng đánh dấu / chưa đủ WAL
#    sau nó) · FAILED. Chỉ OK thoát 0.
DRILL_PITR_THU_MUC=""
don_dien_tap_pitr() {
  docker ps -aq --filter "label=$PITR_NHAN_DIEN_TAP" 2>/dev/null | xargs -r docker rm -f -v >/dev/null 2>&1 || true
  if [ -n "$DRILL_PITR_THU_MUC" ] && [[ "$DRILL_PITR_THU_MUC" == */.pitr-dien-tap.* ]]; then rm -rf -- "$DRILL_PITR_THU_MUC"; fi
}

# Dựng một pha: phục hồi tới $2 (epoch) rồi dừng (pause). Trả 0 khi đã dừng ở mốc; 1 kèm PHA_LY_DO khi không.
chay_pha_pitr() { # $1=tên pha $2=mốc epoch
  local pha="$1" moc="$2" i trang_thai nhat_ky
  PHA_CONTAINER="erp-pitr-drill-$(date +%s)-$pha"; PHA_LY_DO=""
  if ! docker run -d --name "$PHA_CONTAINER" --label "$PITR_NHAN_DIEN_TAP" --network none \
    --memory "$BO_NHO_DIEN_TAP_PITR" --memory-swap "$BO_NHO_DIEN_TAP_PITR" --cpus 1 --pids-limit 256 \
    -v "$DRILL_PITR_THU_MUC/data:/var/lib/postgresql/data" -v "$PITR_WAL:/pitr-wal:ro" "$PITR_ANH_DIEN_TAP" \
    postgres -c archive_mode=off -c shared_buffers=32MB -c fsync=off -c hot_standby=on \
    -c "restore_command=gzip -dc /pitr-wal/%f.gz > %p" -c "recovery_target_time=$(moc_pg "$moc")" \
    -c recovery_target_action=pause >/dev/null; then
    PHA_LY_DO="không dựng được container tạm"; return 1
  fi
  for i in $(seq 1 $((TRAN_LENH_GIAY / 2))); do
    trang_thai="$(docker exec "$PHA_CONTAINER" psql -U erp -d erp -Atc "select pg_is_in_recovery()::text || '|' || pg_get_wal_replay_pause_state()" 2>/dev/null || true)"
    [ "$trang_thai" != "true|paused" ] || return 0
    if [ "$(docker inspect -f '{{.State.Running}}' "$PHA_CONTAINER" 2>/dev/null || true)" != "true" ]; then
      nhat_ky="$(docker logs "$PHA_CONTAINER" 2>&1 | tail -n 40 || true)"
      if grep -q "recovery ended before configured recovery target was reached" <<< "$nhat_ky"; then
        PHA_LY_DO="kho WAL chưa phủ tới mốc $(iso_cua "$moc") — chọn mốc sớm hơn hoặc chờ thêm một chu kỳ archive"
      elif grep -q "before consistent recovery point" <<< "$nhat_ky"; then
        PHA_LY_DO="mốc $(iso_cua "$moc") nằm TRƯỚC lúc bản nền nhất quán"
      else
        PHA_LY_DO="Postgres tạm dừng giữa chừng: $(grep -m1 -E 'FATAL|PANIC' <<< "$nhat_ky" | sed -E 's/[0-9]{4,}/####/g' | cut -c1-160 || true)"
      fi
      return 1
    fi
    sleep 2
  done
  PHA_LY_DO="hết ${TRAN_LENH_GIAY}s chờ phục hồi tới mốc"
  return 1
}

# Nonce của dòng đánh dấu có trong bản đang phục hồi không: CO | VANG | LOI (không đọc được — KHÔNG phải vắng).
doc_danh_dau() { # $1=nonce
  local v
  if ! v="$(docker exec "$PHA_CONTAINER" psql -U erp -d erp -Atc "select value from settings where key = '$PITR_KHOA_MARKER'" 2>/dev/null)"; then echo LOI; return 0; fi
  if grep -qF "$1" <<< "$v"; then echo CO; else echo VANG; fi
}

dung_pha() { docker stop -t 60 "$PHA_CONTAINER" >/dev/null 2>&1 || true; docker rm -f -v "$PHA_CONTAINER" >/dev/null 2>&1 || true; }

ghi_dien_tap_pitr() { # $1=kết quả $2=lý do
  # Lý do BỎ QUA / HỎNG ra kênh tóm tắt: kết quả chi tiết bị mã hoá, và "diễn tập hỏng" không kèm lý do thì người trực
  # phải đoán (30/09/2026: hai lượt SKIPPED vì RAM chỉ đọc ra được qua pitr-status). Lý do chỉ mang con số + tên bản.
  if [ "$1" != "OK" ]; then tt "PITR diễn tập: $1 — $2"; fi
  ghi_json "$STATUS_DIR/pitr-drill.json" "$(printf '{"schema":1,"kind":"pitr-drill","result":%s,"startedAt":%s,"finishedAt":%s,"reason":%s,"base":%s,"target":%s,"replayedTo":%s,"marker":{"before":%s,"after":%s},"tables":{"orders":%s,"shipments":%s,"settings":%s,"migrations":%s},"seconds":{"extract":%s,"before":%s,"after":%s,"total":%s}}' \
    "$(js "$1")" "$(js "$BAT_DAU")" "$(js "$(bay_gio_utc)")" "$(js "$2")" "$(js "${D_NEN:-}")" "$(js "${D_MOC_ISO:-}")" "$(js "${D_TOI:-}")" \
    "$(js "${D_TRUOC:-}")" "$(js "${D_SAU:-}")" "$(jn "${D_ORDERS:-}")" "$(jn "${D_SHIPMENTS:-}")" "$(jn "${D_SETTINGS:-}")" "$(jn "${D_MIG:-}")" \
    "$(jn "${D_S_GIAI:-}")" "$(jn "${D_S_TRUOC:-}")" "$(jn "${D_S_SAU:-}")" "$(jn "${D_S_TONG:-}")")" || true
}

cmd_drill_than() { # $1 = mốc ISO (UTC 'Z' hoặc lệch giờ ±HH:MM) | rỗng ⇒ mốc mặc định
  local nen nen_json nen_ep cum_bytes avail tu_do can moc moi moi_ep bay_gio nonce m_iso m_ep moc_truoc="" ky_vong_sau="" t0 t1 f wal_tar ket ly_do="" dem b
  BAT_DAU="$(bay_gio_utc)"; D_NEN=""; D_MOC_ISO=""; D_TOI=""; D_TRUOC="CHUA_DO"; D_SAU="CHUA_DO"
  D_ORDERS=""; D_SHIPMENTS=""; D_SETTINGS=""; D_MIG=""; D_S_GIAI=""; D_S_TRUOC=""; D_S_SAU=""; D_S_TONG=""
  if [ "$#" -gt 1 ]; then loi "pitr-drill nhận TỐI ĐA một tham số (mốc ISO)."; return 2; fi
  mkdir -p "$STATUS_DIR"
  if ! khoa_chong_chong; then loi "PITR diễn tập: một lượt sao lưu / bản nền khác đang giữ $KHOA_SAO_LUU — không dựng Postgres thứ hai lúc này."; return 75; fi
  giu_khoa 8 "$KHOA_DOC_DB" -x "$TRAN_CHO_KHOA_GIAY" || { loi "Hết giờ chờ khoá đọc nặng — diễn tập KHÔNG chạy."; return 75; }
  giu_khoa 9 "$KHOA_VONG_DOI" -s "$TRAN_CHO_KHOA_GIAY" || { loi "Hết giờ chờ khoá vòng đời — diễn tập KHÔNG chạy."; return 75; }

  nen="$(ds_ban_nen | tail -n 1)"
  if [ -z "$nen" ]; then ghi_dien_tap_pitr SKIPPED "Chưa có bản nền — chạy ops pitr-basebackup."; loi "PITR diễn tập: chưa có bản nền."; return 1; fi
  D_NEN="$nen"; nen_json="$PITR_BASE/$nen/nen.json"
  nen_ep="$(epoch_cua "$(json_chuoi finishedAt "$nen_json")")"
  cum_bytes="$(json_so clusterBytes "$nen_json")"
  if [ -z "$nen_ep" ] || [ -z "$cum_bytes" ]; then ghi_dien_tap_pitr FAILED "Bản nền $nen thiếu nen.json đọc được."; loi "PITR diễn tập: $nen thiếu nen.json."; return 1; fi

  avail="$(free -m 2>/dev/null | awk '/^Mem:/ {print $7}' || true)"
  if [ -z "$avail" ] || ! [ "$avail" -ge "$RAM_TOI_THIEU_DIEN_TAP_PITR_MB" ] 2>/dev/null; then
    ghi_dien_tap_pitr SKIPPED "RAM dùng được ${avail:-?} MB < ${RAM_TOI_THIEU_DIEN_TAP_PITR_MB} MB — không dựng container tạm lúc máy đang chật."
    loi "PITR diễn tập: RAM dùng được ${avail:-?} MB < ${RAM_TOI_THIEU_DIEN_TAP_PITR_MB} MB — KHÔNG chạy (không phải lỗi của PITR)."; return 1
  fi
  tu_do="$(o_trong_mb "$BACKUP_DIR")"
  can=$(($(mb_cua "$cum_bytes") + DU_TRU_O_DIA_MB))
  if [ -z "$tu_do" ] || [ "$tu_do" -lt "$can" ]; then
    ghi_dien_tap_pitr SKIPPED "Ổ đĩa còn ${tu_do:-?} MB, cần ≥ $can MB (cụm lúc chụp + dự trữ)."
    loi "PITR diễn tập: không đủ ổ đĩa (còn ${tu_do:-?} MB, cần ≥ $can MB)."; return 1
  fi

  # MỐC: người chọn, hoặc lùi PITR_LUI_MOC_GIAY so với đoạn WAL mới nhất đã lưu (cần ít nhất một commit SAU mốc trong kho,
  # nếu không Postgres 16 báo "recovery ended before configured recovery target was reached").
  bay_gio="$(date +%s)"
  if [ -n "${1:-}" ]; then
    if ! [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?(Z|[+-][0-9]{2}:[0-9]{2})$ ]]; then
      loi "Mốc phải dạng ISO, ví dụ 2026-09-30T20:15:00Z hoặc 2026-10-01T03:15:00+07:00."; return 2
    fi
    moc="$(epoch_cua "$1")"
    [ -n "$moc" ] || { loi "Không đọc được mốc."; return 2; }
  else
    moi="$(ls -1 "$PITR_WAL" 2>/dev/null | grep -E '^[0-9A-F]{24}\.gz$' | sort | tail -n 1 || true)"
    moi_ep=""; [ -z "$moi" ] || moi_ep="$(stat -c %Y "$PITR_WAL/$moi" 2>/dev/null || true)"
    if [ -z "$moi_ep" ]; then ghi_dien_tap_pitr FAILED "Kho WAL trống — archive chưa chạy."; loi "PITR diễn tập: kho WAL trống."; return 1; fi
    moc=$((bay_gio - PITR_LUI_MOC_GIAY))
    [ "$((moi_ep - PITR_LUI_MOC_GIAY))" -ge "$moc" ] || moc=$((moi_ep - PITR_LUI_MOC_GIAY))
  fi
  D_MOC_ISO="$(iso_cua "$moc")"
  if [ "$moc" -le "$nen_ep" ]; then
    ghi_dien_tap_pitr FAILED "Mốc $D_MOC_ISO không sau lúc bản nền $nen xong ($(iso_cua "$nen_ep")) — PITR chỉ khôi phục tới mốc SAU bản nền."
    loi "PITR diễn tập: mốc $D_MOC_ISO trước bản nền."; return 1
  fi

  # KẾ HOẠCH ĐÁNH DẤU
  nonce="$(json_chuoi nonce "$STATUS_DIR/pitr-marker.json")"; m_iso="$(json_chuoi at "$STATUS_DIR/pitr-marker.json")"
  # Phần lẻ của giây bị CẮT (làm tròn xuống): mốc "trước" = sàn(M) − 1 ≤ M − 1 giây, vẫn trước commit của dòng đánh dấu.
  m_ep=""
  case "$m_iso" in
    "") ;;
    *.*Z) m_ep="$(epoch_cua "${m_iso%%.*}Z")" ;;
    *) m_ep="$(epoch_cua "$m_iso")" ;;
  esac
  if [[ "$nonce" =~ ^[0-9a-f]{16}$ ]] && [ -n "$m_ep" ]; then
    if [ "$moc" -ge $((m_ep + 1)) ]; then
      ky_vong_sau="CO"
      [ $((m_ep - 1)) -le "$nen_ep" ] || moc_truoc=$((m_ep - 1))
    elif [ "$moc" -lt "$m_ep" ]; then
      ky_vong_sau="VANG"
    fi
  else
    nonce=""
  fi

  # Thư mục tạm sót lại từ lượt bị cắt ngang (tên khác PID) — dọn trước, chỉ đúng mẫu tên của diễn tập.
  rm -rf -- "$BACKUP_DIR"/.pitr-dien-tap.* 2>/dev/null || true
  DRILL_PITR_THU_MUC="$BACKUP_DIR/.pitr-dien-tap.$$"
  trap don_dien_tap_pitr EXIT
  don_dien_tap_pitr
  mkdir -p "$DRILL_PITR_THU_MUC/data/pg_wal"
  bao "PITR diễn tập: bản nền $nen → mốc $D_MOC_ISO · RAM ${avail} MB · ổ còn ${tu_do} MB · pha trước: $([ -n "$moc_truoc" ] && iso_cua "$moc_truoc" || echo 'không')"
  t0=$(date +%s)
  wal_tar=""; for f in pg_wal.tar.gz pg_wal.tar; do [ -s "$PITR_BASE/$nen/$f" ] && wal_tar="$PITR_BASE/$nen/$f" && break; done
  if ! tar --numeric-owner -xzf "$PITR_BASE/$nen/base.tar.gz" -C "$DRILL_PITR_THU_MUC/data" \
    || [ -z "$wal_tar" ] || ! tar --numeric-owner "$([[ "$wal_tar" == *.gz ]] && echo -xzf || echo -xf)" "$wal_tar" -C "$DRILL_PITR_THU_MUC/data/pg_wal"; then
    ghi_dien_tap_pitr FAILED "Không giải nén được bản nền $nen."; loi "PITR diễn tập: giải nén bản nền lỗi."; return 1
  fi
  rm -f "$DRILL_PITR_THU_MUC/data/standby.signal" "$DRILL_PITR_THU_MUC/data/postmaster.pid"
  : > "$DRILL_PITR_THU_MUC/data/recovery.signal"
  chown -R "$PITR_UID:$PITR_UID" "$DRILL_PITR_THU_MUC/data" 2>/dev/null || true
  chmod 700 "$DRILL_PITR_THU_MUC/data" 2>/dev/null || true
  t1=$(date +%s); D_S_GIAI=$((t1 - t0))

  # PHA TRƯỚC — dòng đánh dấu phải VẮNG
  if [ -n "$moc_truoc" ]; then
    t0=$(date +%s)
    if ! chay_pha_pitr truoc "$moc_truoc"; then
      dung_pha; ghi_dien_tap_pitr FAILED "Pha trước ($(iso_cua "$moc_truoc")): $PHA_LY_DO"; loi "PITR diễn tập pha trước: $PHA_LY_DO"; return 1
    fi
    D_TRUOC="$(doc_danh_dau "$nonce")"
    dung_pha
    D_S_TRUOC=$(($(date +%s) - t0))
  fi

  # PHA SAU — tới mốc yêu cầu
  t0=$(date +%s)
  if ! chay_pha_pitr sau "$moc"; then
    dung_pha; ghi_dien_tap_pitr FAILED "Pha sau ($D_MOC_ISO): $PHA_LY_DO"; loi "PITR diễn tập: $PHA_LY_DO"; return 1
  fi
  D_S_SAU=$(($(date +%s) - t0))
  D_TOI="$(docker exec "$PHA_CONTAINER" psql -U erp -d erp -Atc "select to_char(pg_last_xact_replay_timestamp() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')" 2>/dev/null || true)"
  [ -z "$nonce" ] || [ -z "$ky_vong_sau" ] || D_SAU="$(doc_danh_dau "$nonce")"
  dem_bang() { docker exec "$PHA_CONTAINER" psql -U erp -d erp -Atc "select count(*) from $1" 2>/dev/null | grep -E '^[0-9]+$' || true; }
  D_ORDERS="$(dem_bang public.orders)"; D_SHIPMENTS="$(dem_bang public.shipments)"; D_SETTINGS="$(dem_bang public.settings)"; D_MIG="$(dem_bang drizzle.__drizzle_migrations)"
  dung_pha
  D_S_TONG=$((D_S_GIAI + ${D_S_TRUOC:-0} + D_S_SAU))

  # PHÁN QUYẾT
  for b in "orders:$D_ORDERS" "shipments:$D_SHIPMENTS" "settings:$D_SETTINGS" "__drizzle_migrations:$D_MIG"; do
    dem="${b#*:}"
    if [ -z "$dem" ] || [ "$dem" -eq 0 ]; then ly_do="$ly_do ${b%%:*}(${dem:-không đọc được})"; fi
  done
  if [ -n "$ly_do" ]; then
    ket="FAILED"; ly_do="Bảng lõi rỗng / không đọc được ở bản khôi phục:$ly_do"
  elif [ -n "$moc_truoc" ] && [ "$D_TRUOC" != "VANG" ]; then
    ket="FAILED"; ly_do="Khôi phục tới TRƯỚC dòng đánh dấu mà nonce $D_TRUOC — mốc khôi phục KHÔNG đúng."
  elif [ -n "$ky_vong_sau" ] && [ "$D_SAU" != "$ky_vong_sau" ]; then
    ket="FAILED"; ly_do="Khôi phục tới $D_MOC_ISO: nonce $D_SAU, kỳ vọng $ky_vong_sau — mốc khôi phục KHÔNG đúng."
  elif [ -z "$nonce" ]; then
    ket="PARTIAL"; ly_do="Chưa có dòng đánh dấu (ops pitr-mark) — phục hồi tới mốc ĐẠT nhưng CHƯA chứng minh được đúng mốc."
  elif [ -z "$moc_truoc" ] || [ "$ky_vong_sau" != "CO" ]; then
    ket="PARTIAL"; ly_do="Dòng đánh dấu không nằm gọn giữa bản nền và mốc khôi phục — chỉ đo được một vế (chạy pitr-mark SAU bản nền, chờ ≥ 1 chu kỳ archive)."
  else
    ket="OK"
  fi
  ghi_dien_tap_pitr "$ket" "$ly_do"
  tt "PITR diễn tập: $ket · bản nền $nen · mốc $D_MOC_ISO · phục hồi tới giao dịch lúc ${D_TOI:-?}"
  tt "Dòng đánh dấu: trước mốc ⇒ $D_TRUOC (kỳ vọng VANG) · sau mốc ⇒ $D_SAU (kỳ vọng ${ky_vong_sau:-—})"
  tt "Bảng lõi ở bản khôi phục: orders ${D_ORDERS:-?} · shipments ${D_SHIPMENTS:-?} · settings ${D_SETTINGS:-?} · migration ${D_MIG:-?}"
  tt "RTO phần máy: giải nén ${D_S_GIAI}s · pha trước ${D_S_TRUOC:-0}s · phục hồi tới mốc ${D_S_SAU}s · tổng ${D_S_TONG}s (container tạm, --network none, trần $BO_NHO_DIEN_TAP_PITR)"
  [ -z "$ly_do" ] || tt "Lý do: $ly_do"
  [ "$ket" = "OK" ] || return 1
  return 0
}

# Dọn NGAY khi xong (đạt hay hỏng), không đợi tiến trình thoát: thư mục dữ liệu tạm cỡ cả cụm không được nằm lại trên
# một ổ từng đầy 100% trong lúc tiến trình gọi còn làm việc khác. trap EXIT bên trong vẫn là lưới cuối.
cmd_drill() {
  local ma=0
  cmd_drill_than "$@" || ma=$?
  don_dien_tap_pitr
  trap - EXIT
  return "$ma"
}

# ═══════════════ LỆNH: install-cron ═══════════════
#
# Tệp cron RIÊNG — /etc/cron.d/erp-backup (của erp-backup.sh) không đổi một byte. Idempotent: nội dung giống thì không ghi.
cmd_pitr_install_cron() {
  local noi_dung cu
  noi_dung="# Sinh bởi scripts/erp-pitr.sh install-cron ở mỗi lần deploy — ĐỪNG sửa tay, lần deploy sau ghi đè.
# PITR của erp-db (docs/platform/backup-recovery.md §9.4): bản nền mỗi đêm SAU bản đêm của nhà · đẩy kho WAL ngoài máy mỗi 15 phút.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HOME=/root
$PITR_PHUT_CRON_NEN * * * * root ERP_DIR=$ERP_DIR ERP_BACKUP_DIR=$BACKUP_DIR /bin/bash $ERP_DIR/scripts/erp-pitr.sh base-cron >> $TEP_LOG 2>&1
$PITR_PHUT_DAY_WAL * * * * root ERP_DIR=$ERP_DIR ERP_BACKUP_DIR=$BACKUP_DIR /bin/bash $ERP_DIR/scripts/erp-pitr.sh push-wal >> $TEP_LOG 2>&1"
  cu="$(cat "$TEP_CRON_PITR" 2>/dev/null || true)"
  if [ "$cu" = "$noi_dung" ]; then bao "lịch PITR đã có sẵn, không đổi: $TEP_CRON_PITR"; return 0; fi
  mkdir -p "$(dirname "$TEP_CRON_PITR")"
  printf '%s\n' "$noi_dung" > "$TEP_CRON_PITR.tam"
  chmod 644 "$TEP_CRON_PITR.tam"
  mv -f "$TEP_CRON_PITR.tam" "$TEP_CRON_PITR"
  bao "đã cài lịch PITR: $TEP_CRON_PITR"
}

main_pitr() {
  local lenh="${1:-}" ma=0
  shift || true
  case "$lenh" in
    chuan-bi) cmd_chuan_bi || ma=$? ;;
    base)
      TRIGGER="ops"
      case "${1:-}" in '' | --trigger=ops) ;; --trigger=manual) TRIGGER="manual" ;; *) loi "tham số không nhận: $1"; return 2 ;; esac
      cmd_base || ma=$? ;;
    base-cron) cmd_base_cron || ma=$? ;;
    push-wal) cmd_push_wal || ma=$? ;;
    status) cmd_pitr_status || ma=$? ;;
    mark) cmd_mark || ma=$? ;;
    drill) cmd_drill "$@" || ma=$? ;;
    pause) cmd_pause || ma=$? ;;
    resume) cmd_resume || ma=$? ;;
    install-cron) cmd_pitr_install_cron || ma=$? ;;
    *) echo "Dùng: $0 chuan-bi | base [--trigger=ops|manual] | base-cron | push-wal | status | mark | drill [mốc ISO] | pause | resume | install-cron" >&2; return 2 ;;
  esac
  return "$ma"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main_pitr "$@"; exit $?; fi
