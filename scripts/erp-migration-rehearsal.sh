#!/usr/bin/env bash
# ═══════════════ CHẠY THỬ MIGRATION TRÊN BẢN SAO CỦA MỘT CSDL TỔ CHỨC — ops `migration-rehearsal` ═══════════════
#
# VÌ SAO CÓ (P0 12/10/2026): migration 0245 (#792 — cột turn_unhandled + last_read_at, hàm `sales_chat_turn_unhandled_*`,
# trigger, MỘT câu UPDATE dẫn xuất) chạy xong trên CSDL nhà + 6 tổ chức, nhưng tổ chức `qa` (959 hội thoại, dump 4,5 MB)
# TIMEOUT lặp lại ở câu UPDATE dẫn xuất (statement_timeout 600 s do chính 0245 đặt). Chủ shop đòi root cause bằng SỐ ĐO:
# kế hoạch thực thi, số dòng, thống kê bảng / chỉ mục, câu nào > 600 s, vì sao 959 hội thoại vẫn quá trần — và nếu cần chỉ
# mục thì phải đo trên BẢN SAO trước / sau. Tệp này là phép đo đó. Nó KHÔNG sửa production và KHÔNG ghi gì vào erp-db.
#
# CÁCH LÀM — mọi bước trên CSDL TẠM trong container TẠM:
#   0. Khôi phục bản dump MỚI NHẤT của MỘT CSDL erp_org_* bằng ĐÚNG đường của `restore-drill-org`
#      (`dung_ban_sao_tam_to_chuc` trong scripts/erp-backup.sh — cùng ảnh erp-db, --network none, trần RAM, trap dọn).
#      Không một `pg_restore` thứ hai, không một lệnh nào vào erp-db ngoài `docker inspect` lấy tên ảnh.
#   1. (a) Đếm dòng + kích thước + chỉ mục + pg_stats của năm bảng hộp thư; hình dạng sổ tin (luồng / page / dòng sau lượt
#      khách cuối / ứng viên vế tin mẫu chéo luồng). ANALYZE trước (bản khôi phục KHÔNG mang thống kê) — `--no-analyze` để đo
#      đúng trường hợp «chưa từng ANALYZE».
#   2. (b) Sổ migration của bản sao so với drizzle/meta/_journal.json của bản ĐÃ DEPLOY: đã áp tới đâu, còn thiếu mục nào.
#   3. (d)(e) CHẨN ĐOÁN trong một giao dịch ROLLBACK: chạy phần DDL của các migration còn thiếu (BỎ câu ghi dữ liệu), rồi
#      bấm giờ hàm của 0245 cho TỪNG hội thoại (ngân sách `--budget`), đo bốn biến thể trên mẫu hội thoại chậm nhất (đủ vế ·
#      bỏ vế tin mẫu chéo luồng · bỏ vế UNKNOWN lồng · bỏ cả hai) ⇒ thời gian thuộc vế nào, và EXPLAIN (ANALYZE, BUFFERS)
#      thân hàm (kế hoạch CHUNG, như hàm SQL thật) trên `--explain` luồng nặng nhất.
#   4. (c) CHẠY THẬT các migration còn thiếu trong MỘT giao dịch như drizzle (ROLLBACK cuối), bấm giờ TỪNG câu. Trần
#      statement_timeout của tệp (600 s ở 0245) được nâng lên `--timeout` vì đây là bản sao; câu nào vượt trần GỐC bị đánh dấu.
#   5. `--candidate-index`: dựng chỉ mục thử (CHI_MUC_THU) trên bản sao, ANALYZE, đo lại bước 3 (mẫu) + bước 4 ⇒ trước / sau.
#
# ĐẦU RA: kết quả của cả lượt bị MÃ HOÁ (ops-vps.yml `ma_hoa_ket_qua`). Ra log công khai CHỈ các dòng tiền tố `[ops:tom-tat] `:
# số đếm, thời gian, tên bảng / chỉ mục / migration, tên nút kế hoạch. Không chữ tin, SĐT, tên, mã hội thoại / page / luồng,
# không tên CSDL / mã tổ chức. Kế hoạch đầy đủ (JSON) chỉ nằm ở phần mã hoá.
#
#   erp-migration-rehearsal.sh <mã tổ chức> [--timeout=1800] [--budget=600] [--sample=20] [--explain=3]
#                              [--candidate-index] [--compare-jit] [--no-analyze] [--skip-diagnose] [--skip-migrate]
#
# Mã thoát: 0 = lượt đo XONG (kết luận nằm ở dòng «KẾT LUẬN»); 1 = không đo được (thiếu bản, thiếu RAM / ổ, container hỏng);
# 2 = tham số sai. Câu migration quá trần trên bản sao KHÔNG phải mã 1 — đó là một kết quả đo.
set -euo pipefail

THU_MUC_SCRIPT_MR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=erp-backup.sh
source "$THU_MUC_SCRIPT_MR/erp-backup.sh"

# ═══════════════ HẰNG SỐ — KHAI Ở ĐÚNG MỘT CHỖ NÀY ═══════════════
MR_NHAN="erp.migration-rehearsal=1"       # nhãn docker RIÊNG: dọn container sót của lượt này không đụng diễn tập khôi phục
MR_TIEN_TO_CONTAINER="erp-migration-rehearsal"
MR_TRAN_MAC_DINH=1200        # giây / câu migration trên bản sao (production: trần của chính tệp migration) — ba lượt chạy + chẩn đoán vừa trần tổng
MR_TRAN_TOI_THIEU=60
MR_TRAN_TOI_DA=5400
MR_NGAN_SACH_MAC_DINH=600    # giây cho phép bấm giờ từng hội thoại
MR_NGAN_SACH_TOI_DA=3600
MR_MAU_MAC_DINH=20           # số hội thoại chậm nhất đưa vào phép đo biến thể
MR_MAU_TOI_DA=50
MR_EXPLAIN_MAC_DINH=3        # số luồng nặng nhất được EXPLAIN (ANALYZE)
MR_EXPLAIN_TOI_DA=10
MR_TRAN_TONG_GIAY=6000       # 100 phút: ops-vps.yml command_timeout là 110 phút — bước nào không vừa phần còn lại thì BỎ và nói ra
MR_HE_SO_O_DIA=20            # ổ cần ≈ 20 × cỡ bản dump (-Fc nén) + DU_TRU_O_DIA_MB
MR_TEP_MAU="/tmp/dien-tap-mau.csv"   # TRONG container tạm (mất cùng container) — mẫu hội thoại giữa hai giao dịch chẩn đoán
# Chỉ mục ỨNG VIÊN cho vế «tin mẫu tự động» chéo luồng của #803: mỗi dòng PAGE_REPLY cũ (sender_kind NULL, ≥ 40 ký tự) sau
# lượt khách cuối dò MỌI dòng PAGE_REPLY cùng page trong 168 giờ với `btrim(regexp_replace(text…)) = …` — chỉ mục (page, luồng,
# …) chỉ thu hẹp được theo page. Băm (hash) theo ĐÚNG biểu thức của hàm: tra bằng nhau, không giới hạn độ dài chữ (btree
# từ chối dòng > ~2,7 KB). CHỈ dựng trên BẢN SAO; vào production thì phải là một migration drizzle có số hiệu.
MR_CHI_MUC_THU_TEN="sales_chat_inbound_page_reply_text_hash_idx"
MR_CHI_MUC_THU="CREATE INDEX IF NOT EXISTS \"$MR_CHI_MUC_THU_TEN\" ON \"sales_chat_inbound\" USING hash ((btrim(regexp_replace(\"text\", '[[:space:]]+', ' ', 'g')))) WHERE \"note\" = 'PAGE_REPLY'"
MR_TIEN_TO_TT='[ops:tom-tat] '

mr_tt() { printf '%s%s\n' "$MR_TIEN_TO_TT" "$*"; }

# ═══════════════ THAM SỐ — HÀM THUẦN (tests/migration-rehearsal.test.ts gọi thẳng) ═══════════════
#
# Đặt MR_MA · MR_CSDL · MR_TAM · MR_TRAN · MR_NGAN_SACH · MR_MAU · MR_EXPLAIN · MR_CHI_MUC · MR_JIT · MR_ANALYZE · MR_CHAN_DOAN ·
# MR_CHAY. Trả 2 + câu lỗi KHÔNG chứa giá trị người gõ (chỉ độ dài) khi sai. Không có cờ ghi nào: `--apply`/`--write`/`--fix`
# bị từ chối như mọi cờ lạ — lượt này không bao giờ ghi ở đâu ngoài CSDL tạm.
mr_so_trong() { # $1=giá trị $2=min $3=max
  [[ "${1:-}" =~ ^[0-9]{1,6}$ ]] || return 1
  (( 10#$1 >= $2 && 10#$1 <= $3 ))
}
mr_phan_tich_tham_so() {
  local a v
  MR_MA=""; MR_CSDL=""; MR_TAM=""
  MR_TRAN=$MR_TRAN_MAC_DINH; MR_NGAN_SACH=$MR_NGAN_SACH_MAC_DINH; MR_MAU=$MR_MAU_MAC_DINH; MR_EXPLAIN=$MR_EXPLAIN_MAC_DINH
  MR_CHI_MUC=0; MR_JIT=0; MR_ANALYZE=1; MR_CHAN_DOAN=1; MR_CHAY=1
  for a in "$@"; do
    v="${a#*=}"
    case "$a" in
      --timeout=*) mr_so_trong "$v" "$MR_TRAN_TOI_THIEU" "$MR_TRAN_TOI_DA" || { loi "--timeout phải là số giây ${MR_TRAN_TOI_THIEU}–${MR_TRAN_TOI_DA}."; return 2; }; MR_TRAN=$((10#$v)) ;;
      --budget=*) mr_so_trong "$v" 0 "$MR_NGAN_SACH_TOI_DA" || { loi "--budget phải là số giây 0–${MR_NGAN_SACH_TOI_DA}."; return 2; }; MR_NGAN_SACH=$((10#$v)) ;;
      --sample=*) mr_so_trong "$v" 1 "$MR_MAU_TOI_DA" || { loi "--sample phải là 1–${MR_MAU_TOI_DA}."; return 2; }; MR_MAU=$((10#$v)) ;;
      --explain=*) mr_so_trong "$v" 0 "$MR_EXPLAIN_TOI_DA" || { loi "--explain phải là 0–${MR_EXPLAIN_TOI_DA}."; return 2; }; MR_EXPLAIN=$((10#$v)) ;;
      --candidate-index) MR_CHI_MUC=1 ;;
      --compare-jit) MR_JIT=1 ;;
      --no-analyze) MR_ANALYZE=0 ;;
      --skip-diagnose) MR_CHAN_DOAN=0 ;;
      --skip-migrate) MR_CHAY=0 ;;
      -*) loi "tham số không nhận (${#a} ký tự). Nhận: <mã tổ chức> --timeout= --budget= --sample= --explain= --candidate-index --compare-jit --no-analyze --skip-diagnose --skip-migrate"; return 2 ;;
      *)
        if [ -n "$MR_MA" ]; then loi "chỉ nhận MỘT mã tổ chức."; return 2; fi
        MR_MA="$a" ;;
    esac
  done
  if [ -z "$MR_MA" ]; then loi "cần MÃ tổ chức (chữ thường, số, gạch ngang) — lượt này không luân phiên."; return 2; fi
  MR_CSDL="$(csdl_tu_ma_to_chuc "$MR_MA")" || { loi "mã tổ chức không hợp lệ (${#MR_MA} ký tự)."; return 2; }
  MR_TAM="$(ten_csdl_tam "$MR_CSDL")" || { loi "tên CSDL tạm không qua hàng rào tên."; return 2; }
  return 0
}

# ═══════════════ SỔ MIGRATION — HÀM THUẦN ═══════════════

# drizzle/meta/_journal.json ⇒ "mốc tên" mỗi dòng, ĐÚNG thứ tự mảng (thứ tự drizzle áp). Không cần jq trên máy chủ.
mr_doc_so() { # $1=tệp sổ
  awk '
    match($0, /"when": *[0-9]+/) { w = substr($0, RSTART, RLENGTH); gsub(/[^0-9]/, "", w) }
    match($0, /"tag": *"[^"]+"/) { t = substr($0, RSTART, RLENGTH); sub(/^"tag": *"/, "", t); sub(/"$/, "", t); if (w != "") print w " " t; w = "" }
  ' "$1"
}

# Kịch bản psql cho các tệp migration, cắt câu ĐÚNG như drizzle (`--> statement-breakpoint`). Mỗi câu có một dòng
# `\echo @@CAU <migration> <số> <loại>` đứng trước. Chế độ `ddl` BỎ câu ghi dữ liệu (UPDATE / INSERT / DELETE / WITH / MERGE /
# COPY) — dùng cho giao dịch chẩn đoán. `SET LOCAL statement_timeout = 'Ns'` của tệp được nâng lên trần bản sao, trần gốc ghi ở
# `\echo @@TRAN_GOC`. Không BEGIN / ROLLBACK — người gọi bọc.
mr_dung_kich_ban() { # $1=full|ddl $2=trần giây $3...=tệp migration (theo thứ tự sổ)
  local che_do="$1" tran="$2"
  shift 2
  awk -v che_do="$che_do" -v tran="$tran" -v q="'" '
    function loai_cau(s,   n, i, d, k) {
      n = split(s, d, "\n")
      for (i = 1; i <= n; i++) {
        k = d[i]; sub(/^[ \t]+/, "", k)
        if (k == "" || substr(k, 1, 2) == "--") continue
        # Bỏ cả dấu nháy: `\echo` của psql tự đọc nháy, một nhãn bị cắt giữa cặp nháy làm hỏng dòng đánh dấu.
        sub(/\(.*/, "", k); gsub(/[^A-Za-z0-9_ .]/, "", k); gsub(/ +/, " ", k); sub(/ +$/, "", k)
        return substr(k, 1, 60)
      }
      return ""
    }
    function xa(   k, goc, mau) {
      if (buf !~ /[^ \t\r\n]/) { buf = ""; return }
      k = loai_cau(buf)
      if (k == "") { buf = ""; return }
      so++
      mau = "SET LOCAL statement_timeout = " q "[0-9]+s" q
      if (match(buf, mau)) {
        goc = substr(buf, RSTART, RLENGTH); gsub(/[^0-9]/, "", goc)
        print "\\echo @@TRAN_GOC " tag " " so " " goc
        sub(mau, "SET LOCAL statement_timeout = " q tran "s" q, buf)
      }
      if (che_do == "ddl" && toupper(k) ~ /^(UPDATE|INSERT|DELETE|WITH|MERGE|COPY)( |$)/) {
        print "\\echo @@BO_QUA " tag " " so " " k
        buf = ""; return
      }
      print "\\echo @@CAU " tag " " so " " k
      printf "%s\n;\n", buf
      buf = ""
    }
    FNR == 1 { if (NR > 1) xa(); tag = FILENAME; sub(/^.*\//, "", tag); sub(/\.sql$/, "", tag); so = 0 }
    {
      d = $0; sub(/\r$/, "", d)
      while ((i = index(d, "--> statement-breakpoint")) > 0) { buf = buf substr(d, 1, i - 1) "\n"; xa(); d = substr(d, i + 24) }
      buf = buf d "\n"
    }
    END { xa() }
  ' "$@"
}

# Đầu ra psql của một lượt chạy ⇒ thời gian TỪNG câu (dòng thường, vào phần mã hoá) + dòng tóm tắt. Dòng `@@CAU` và `Time:`
# cùng đi stdout nên thứ tự giữa chúng đúng; lỗi (stderr) định vị bằng SỐ DÒNG của kịch bản (`psql:<stdin>:N:`) đối chiếu
# với vị trí từng `@@CAU` trong kịch bản — không dựa vào thứ tự trộn hai luồng. Chỉ in LOẠI lỗi, không in câu lỗi (câu lỗi
# ràng buộc có thể mang giá trị dữ liệu).
mr_tom_tat_chay() { # $1=tệp kịch bản $2=tệp đầu ra $3=nhãn lượt $4=mã thoát psql
  awk -v tt="$MR_TIEN_TO_TT" -v nhan="$3" -v ma="${4:-0}" '
    FNR == NR {
      if ($0 ~ /^\\echo @@CAU /) { nd++; dong_cau[nd] = FNR; split($0, p, " "); id_cau[nd] = p[3] "#" p[4] }
      next
    }
    /^@@TRAN_GOC / { goc[$2 "#" $3] = $4; next }
    /^@@CAU / { hien = $2 "#" $3; mig[hien] = $2; k = $0; sub(/^@@CAU [^ ]+ [^ ]+ /, "", k); loai[hien] = k; thu_tu[++n] = hien; ms[hien] = 0; next }
    /^Time: [0-9.]+ ms/ { if (hien != "") ms[hien] += $2; next }
    /^UPDATE [0-9]+$/ { if (hien != "") dong[hien] = $2; next }
    /ERROR: / {
      loi_co = 1
      if (match($0, /^psql:[^:]*:[0-9]+:/)) { s = substr($0, 1, RLENGTH - 1); sub(/^.*:/, "", s); dl = s + 0
        for (i = 1; i <= nd; i++) if (dong_cau[i] <= dl) cau_loi = id_cau[i] }
      if ($0 ~ /statement timeout/) loai_loi = "hết trần statement_timeout"
      else if ($0 ~ /lock timeout/) loai_loi = "hết trần lock_timeout (chờ khoá)"
      else if ($0 ~ /out of memory/) loai_loi = "hết bộ nhớ"
      else if (loai_loi == "") loai_loi = "lỗi khác (xem phần mã hoá)"
      next
    }
    END {
      tong = 0
      for (i = 1; i <= n; i++) {
        h = thu_tu[i]; tong += ms[h]; tm[mig[h]] += ms[h]
        printf "  %s câu %s (%s): %.0f ms%s\n", mig[h], substr(h, index(h, "#") + 1), loai[h], ms[h], (h in dong) ? " · " dong[h] " dòng" : ""
      }
      for (m in tm) printf "%s%s · %s: %.1f s (tổng các câu)\n", tt, nhan, m, tm[m] / 1000
      # năm câu chậm nhất
      for (r = 1; r <= 5; r++) {
        best = ""; bms = -1
        for (i = 1; i <= n; i++) { h = thu_tu[i]; if (!(h in da) && ms[h] > bms) { bms = ms[h]; best = h } }
        if (best == "" || bms < 1000) break
        da[best] = 1
        printf "%s%s · chậm #%d: %s câu %s (%s) %.1f s%s\n", tt, nhan, r, mig[best], substr(best, index(best, "#") + 1), loai[best], bms / 1000, (best in dong) ? " · " dong[best] " dòng" : ""
      }
      # trần GỐC của tệp: câu nào vượt
      for (i = 1; i <= n; i++) {
        h = thu_tu[i]; m = mig[h]; tg = ""
        for (g in goc) { split(g, gp, "#"); if (gp[1] == m) tg = goc[g] }
        if (tg != "" && ms[h] > tg * 1000) printf "%s%s · VƯỢT TRẦN PRODUCTION: %s câu %s (%s) %.1f s > %s s\n", tt, nhan, m, substr(h, index(h, "#") + 1), loai[h], ms[h] / 1000, tg
      }
      if (loi_co) printf "%s%s · LỖI ở %s: %s\n", tt, nhan, (cau_loi != "" ? cau_loi : "câu chưa định vị được"), loai_loi
      else if (ma != 0) printf "%s%s · psql thoát %s mà không có dòng ERROR (container bị giết? hết RAM?) sau %d câu, %.1f s\n", tt, nhan, ma, n, tong / 1000
      else printf "%s%s · xong %d câu, %.1f s, không lỗi\n", tt, nhan, n, tong / 1000
    }
  ' "$1" "$2"
}

# ═══════════════ CHẠY psql TRONG CONTAINER TẠM ═══════════════
#
# PGOPTIONS đặt trần của PHIÊN = trần bản sao: `SET LOCAL statement_timeout = DEFAULT` ở cuối tệp migration trả về đúng trần
# này, không về 0 (vô hạn). Dòng `TT|` (NOTICE hoặc dòng kết quả) được đổi thành tiền tố kênh tóm tắt; mọi dòng khác giữ nguyên
# và chỉ nằm ở phần mã hoá.
# MR_PGOPTIONS_THEM: cờ phiên thêm cho MỘT lượt (lượt so JIT: `-c jit=off`). Mặc định rỗng = đúng mặc định của ảnh erp-db.
MR_PGOPTIONS_THEM=""
mr_psql() { # stdin = SQL · $@ = cờ psql thêm
  docker exec -i -e PGOPTIONS="-c statement_timeout=${MR_TRAN}s${MR_PGOPTIONS_THEM:+ $MR_PGOPTIONS_THEM}" "$DRILL_TEN_TO_CHUC" \
    psql -X -At -U erp -d "$MR_TAM" -P pager=off "$@"
}
mr_doi_tt() { sed -E 's/^((psql:[^ ]+ )?(NOTICE|INFO):  )?TT\|/[ops:tom-tat] /'; }

# ═══════════════ SQL CỦA TỪNG BƯỚC (chỉ in ra stdout — để bài kiểm chạy được trên Postgres thật không cần docker) ═══════════════

mr_sql_thong_ke() { # (a) — chỉ ĐỌC
  cat <<'SQL'
\set ON_ERROR_STOP 0
SET statement_timeout = '300s';
DO $$
DECLARE t text; n bigint; c record;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_chat_inbound','sales_chat_conversations','sales_chat_messages','sales_chat_staff_messages','sales_chat_reads'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN RAISE NOTICE 'TT|bảng %: KHÔNG CÓ trong bản sao', t; CONTINUE; END IF;
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
    SELECT pg_relation_size(k.oid) AS heap, pg_indexes_size(k.oid) AS idx, coalesce(pg_total_relation_size(k.reltoastrelid), 0) AS toast, k.reltuples::bigint AS rt,
      s.last_analyze, s.last_autoanalyze
      INTO c FROM pg_class k LEFT JOIN pg_stat_user_tables s ON s.relid = k.oid WHERE k.oid = ('public.' || t)::regclass;
    RAISE NOTICE 'TT|bảng %: % dòng · heap % · chỉ mục % · toast % · reltuples % · ANALYZE gần nhất %', t, n, pg_size_pretty(c.heap), pg_size_pretty(c.idx),
      pg_size_pretty(c.toast), c.rt, coalesce(to_char(greatest(c.last_analyze, c.last_autoanalyze), 'YYYY-MM-DD HH24:MI'), 'CHƯA (bản khôi phục không mang thống kê)');
  END LOOP;
END $$;
-- Chỉ mục: tên + cỡ ra kênh tóm tắt; định nghĩa đầy đủ chỉ ở phần mã hoá.
SELECT 'TT|chỉ mục ' || t.relname || '.' || i.relname || ' · ' || pg_size_pretty(pg_relation_size(i.oid)) || ' · ' || am.amname
  || CASE WHEN x.indisunique THEN ' · UNIQUE' ELSE '' END || CASE WHEN x.indpred IS NOT NULL THEN ' · một phần' ELSE '' END
  FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid JOIN pg_am am ON am.oid = i.relam
  WHERE t.relname IN ('sales_chat_inbound','sales_chat_conversations','sales_chat_messages','sales_chat_staff_messages','sales_chat_reads')
  ORDER BY t.relname, i.relname;
SELECT 'định nghĩa chỉ mục: ' || indexdef FROM pg_indexes
  WHERE schemaname = 'public' AND tablename IN ('sales_chat_inbound','sales_chat_conversations','sales_chat_messages','sales_chat_staff_messages','sales_chat_reads')
  ORDER BY tablename, indexname;
-- Hình dạng sổ tin — chỉ số đếm.
WITH t AS (SELECT page_id, thread_id, count(*) AS n FROM sales_chat_inbound GROUP BY 1, 2),
  pg AS (SELECT page_id, count(*) AS n, count(*) FILTER (WHERE note = 'PAGE_REPLY') AS n_reply FROM sales_chat_inbound GROUP BY 1)
SELECT 'TT|sổ tin: ' || (SELECT count(*) FROM pg) || ' page · page lớn nhất ' || coalesce((SELECT max(n) FROM pg), 0) || ' dòng ('
  || coalesce((SELECT n_reply FROM pg ORDER BY n DESC LIMIT 1), 0) || ' PAGE_REPLY) · ' || count(*) || ' luồng · dòng/luồng p50 '
  || coalesce(percentile_disc(0.5) WITHIN GROUP (ORDER BY n), 0) || ' · p95 ' || coalesce(percentile_disc(0.95) WITHIN GROUP (ORDER BY n), 0)
  || ' · max ' || coalesce(max(n), 0) || ' · luồng ≥ 1000 dòng: ' || count(*) FILTER (WHERE n >= 1000) FROM t;
SELECT 'TT|loại dòng sổ tin: PAGE_REPLY ' || count(*) FILTER (WHERE note = 'PAGE_REPLY')
  || ' (sender_kind NULL ' || count(*) FILTER (WHERE note = 'PAGE_REPLY' AND sender_kind IS NULL)
  || ' · staff-out ' || count(*) FILTER (WHERE note = 'PAGE_REPLY' AND message_id LIKE 'staff-out:%') || ')'
  || ' · BOT_SENT ' || count(*) FILTER (WHERE note = 'BOT_SENT') || ' · MEDIA_ONLY ' || count(*) FILTER (WHERE note = 'MEDIA_ONLY')
  || ' · không ghi chú ' || count(*) FILTER (WHERE note IS NULL) || ' · khác ' || count(*) FILTER (WHERE note NOT IN ('PAGE_REPLY','BOT_SENT','MEDIA_ONLY'))
  || ' · nhập lịch sử ' || count(*) FILTER (WHERE imported_at IS NOT NULL) || ' · 7 ngày cuối ' || count(*) FILTER (WHERE created_at >= (SELECT max(created_at) FROM sales_chat_inbound) - interval '7 days')
  FROM sales_chat_inbound;
SELECT 'TT|hội thoại: ' || count(*) || ' · nhánh luồng (có page + luồng) ' || count(*) FILTER (WHERE page_id IS NOT NULL AND thread_id IS NOT NULL)
  || ' · nhánh chat web ' || count(*) FILTER (WHERE page_id IS NULL OR thread_id IS NULL)
  || ' · trùng (page, luồng) ' || (count(*) FILTER (WHERE page_id IS NOT NULL AND thread_id IS NOT NULL) - count(DISTINCT (page_id, thread_id)) FILTER (WHERE page_id IS NOT NULL AND thread_id IS NOT NULL))
  FROM sales_chat_conversations;
-- Dòng SAU lượt khách cuối (xấp xỉ theo khoá xếp thứ nhất của #803) — đó là tập `o` mà hàm duyệt cho mỗi hội thoại; ứng viên
-- vế tin mẫu chéo luồng và Σ số dòng cùng page / Σ số phép so chữ mà vế ấy phải lọc ⇒ đo được độ «bậc hai».
WITH lc AS (
  SELECT page_id, thread_id, max(date_trunc('milliseconds', coalesce(source_at, created_at))) AS k
  FROM sales_chat_inbound
  WHERE imported_at IS NULL AND coalesce(note, '') NOT IN ('BOT_SENT', 'PAGE_REPLY')
    AND (note = 'MEDIA_ONLY' OR text ~ '[^[:space:]]' OR (jsonb_typeof(image_urls) = 'array' AND jsonb_array_length(image_urls) > 0))
  GROUP BY 1, 2
), sau AS (
  SELECT i.page_id, i.thread_id, i.created_at, i.imported_at, i.note, i.message_id, i.sender_kind,
    (i.imported_at IS NULL AND i.note = 'PAGE_REPLY' AND i.message_id NOT LIKE 'staff-out:%' AND i.sender_kind IS NULL
      AND char_length(btrim(regexp_replace(i.text, '[[:space:]]+', ' ', 'g'))) >= 40) AS la_mau,
    (i.imported_at IS NULL AND i.note = 'PAGE_REPLY' AND i.message_id NOT LIKE 'staff-out:%' AND (i.sender_kind IS NULL OR i.sender_kind = 'UNKNOWN')) AS la_unknown
  FROM lc JOIN sales_chat_inbound i ON i.page_id = lc.page_id AND i.thread_id = lc.thread_id
    AND date_trunc('milliseconds', coalesce(i.source_at, i.created_at)) > lc.k
), theo_luong AS (
  SELECT page_id, thread_id, count(*) AS n, count(*) FILTER (WHERE la_mau) AS n_mau, count(*) FILTER (WHERE la_unknown) AS n_unk FROM sau GROUP BY 1, 2
), page_dong AS (SELECT page_id, count(*) AS n FROM sales_chat_inbound GROUP BY 1)
SELECT 'TT|sau lượt khách cuối (xấp xỉ): ' || (SELECT count(*) FROM lc) || ' luồng có lượt khách · dòng sau: tổng ' || coalesce(sum(n), 0)
  || ' · max/luồng ' || coalesce(max(n), 0) || ' · ứng viên vế tin mẫu (PAGE_REPLY, sender_kind NULL, ≥ 40 ký tự): tổng ' || coalesce(sum(n_mau), 0)
  || ' · max/luồng ' || coalesce(max(n_mau), 0) || ' · luồng có ứng viên ' || count(*) FILTER (WHERE n_mau > 0)
  || ' · ứng viên vế UNKNOWN: tổng ' || coalesce(sum(n_unk), 0) || ' · max/luồng ' || coalesce(max(n_unk), 0)
  || ' · Σ dòng cùng page vế tin mẫu phải lọc ≈ ' || coalesce((SELECT sum(pd.n) FROM sau s JOIN page_dong pd ON pd.page_id = s.page_id WHERE s.la_mau), 0)
  || ' · Σ PAGE_REPLY luồng khác trong 168 giờ trước (số phép so chữ tối đa) ' || coalesce((SELECT sum((SELECT count(*) FROM sales_chat_inbound p
      WHERE p.page_id = s.page_id AND p.thread_id <> s.thread_id AND p.note = 'PAGE_REPLY' AND p.created_at < s.created_at AND p.created_at >= s.created_at - interval '168 hours'))
      FROM sau s WHERE s.la_mau), 0)
  FROM theo_luong;
SQL
}

mr_sql_cau_hinh() { # cấu hình planner / JIT của bản sao (cùng ảnh erp-db, cùng mặc định — production không đặt các khoá này)
  cat <<'SQL'
\set ON_ERROR_STOP 0
SELECT 'TT|cấu hình bản sao: ' || version_num || ' · JIT có sẵn ' || CASE WHEN pg_jit_available() THEN 'có' ELSE 'KHÔNG' END || ' · '
  || string_agg(name || '=' || setting, ' · ' ORDER BY name)
  FROM pg_settings, (SELECT current_setting('server_version_num') AS version_num) v
  WHERE name IN ('jit', 'jit_above_cost', 'jit_inline_above_cost', 'jit_optimize_above_cost', 'work_mem', 'random_page_cost', 'plan_cache_mode')
  GROUP BY version_num;
SQL
}

mr_sql_pg_stats() { # sau ANALYZE — chỉ con số thống kê, KHÔNG most_common_vals / histogram (đó là dữ liệu)
  cat <<'SQL'
\set ON_ERROR_STOP 0
SELECT 'TT|pg_stats ' || tablename || '.' || attname || ': n_distinct ' || n_distinct || ' · null_frac ' || round(null_frac::numeric, 3)
  || ' · avg_width ' || avg_width || ' · correlation ' || coalesce(round(correlation::numeric, 3)::text, '—')
  FROM pg_stats WHERE schemaname = 'public'
    AND tablename IN ('sales_chat_inbound','sales_chat_conversations','sales_chat_messages','sales_chat_staff_messages','sales_chat_reads')
    AND attname IN ('page_id','thread_id','note','sender_kind','created_at','source_at','imported_at','conversation_id','role','status','seq')
  ORDER BY tablename, attname;
SQL
}

# Chẩn đoán — chạy SAU phần DDL của migration còn thiếu, TRONG giao dịch ROLLBACK. $1 = full (bấm giờ từng hội thoại, lưu mẫu)
# | mau (đọc lại mẫu đã lưu — lượt sau chỉ mục thử). Số đã soát ở mr_phan_tich_tham_so trước khi tới đây.
mr_sql_chan_doan() { # $1=full|mau $2=nhãn
  local che_do="$1" nhan="$2"
  cat <<SQL
\\set ON_ERROR_STOP 0
\\set ON_ERROR_ROLLBACK on
SELECT set_config('dien_tap.ngan_sach', '$MR_NGAN_SACH', false), set_config('dien_tap.mau', '$MR_MAU', false),
  set_config('dien_tap.explain', '$MR_EXPLAIN', false), set_config('dien_tap.nhan', '$nhan', false), set_config('dien_tap.jit', current_setting('jit'), false);
SET statement_timeout = '$(( MR_NGAN_SACH + MR_TRAN ))s';
DO \$\$ BEGIN
  IF to_regprocedure('sales_chat_turn_unhandled_thread(text,text,timestamptz)') IS NULL THEN
    RAISE NOTICE 'TT|chẩn đoán %: bản sao không có hàm sales_chat_turn_unhandled_thread sau phần DDL — bỏ phép đo hàm', current_setting('dien_tap.nhan');
  END IF;
END \$\$;
CREATE TEMP TABLE _dt_do (thu_tu serial, id text, nhanh text, page_id text, thread_id text, seen timestamptz, ms numeric, n_luong int);
CREATE TEMP TABLE _dt_mau (id text, nhanh text, page_id text, thread_id text, seen timestamptz, ms numeric, n_luong int);
CREATE TEMP TABLE _dt_ke_hoach (hang int, ke_hoach jsonb);
SQL
  if [ "$che_do" = full ]; then
    cat <<'SQL'
-- Bấm giờ hàm của 0245 cho TỪNG hội thoại, đúng mốc đọc của câu dẫn xuất. Hội thoại luồng dài đo trước. Mỗi lần gọi trong
-- PL/pgSQL lập kế hoạch lại thân hàm SQL (UPDATE thật lập MỘT lần) ⇒ số ở đây gồm thêm thời gian lập kế hoạch mỗi lần.
DO $$
DECLARE r record; t0 timestamptz; d numeric; n int := 0; tong int; cham int := 0;
  han timestamptz := clock_timestamp() + make_interval(secs => current_setting('dien_tap.ngan_sach')::int);
BEGIN
  IF to_regprocedure('sales_chat_turn_unhandled_of(text,text,text,timestamptz)') IS NULL THEN RETURN; END IF;
  SELECT count(*) INTO tong FROM sales_chat_conversations;
  FOR r IN
    SELECT c.id, c.page_id, c.thread_id, coalesce(t.n, 0)::int AS n_luong,
      greatest((SELECT max(x.read_through_at) FROM sales_chat_reads x WHERE x.conversation_id = c.id), c.staff_seen_at) AS seen
    FROM sales_chat_conversations c
    LEFT JOIN (SELECT page_id, thread_id, count(*) AS n FROM sales_chat_inbound GROUP BY 1, 2) t ON t.page_id = c.page_id AND t.thread_id = c.thread_id
    ORDER BY coalesce(t.n, 0) DESC, c.id
  LOOP
    EXIT WHEN clock_timestamp() > han;
    t0 := clock_timestamp();
    PERFORM sales_chat_turn_unhandled_of(r.id, r.page_id, r.thread_id, r.seen);
    d := extract(epoch FROM clock_timestamp() - t0) * 1000;
    n := n + 1;
    INSERT INTO _dt_do (id, nhanh, page_id, thread_id, seen, ms, n_luong)
      VALUES (r.id, CASE WHEN r.page_id IS NOT NULL AND r.thread_id IS NOT NULL THEN 'LUONG' ELSE 'WEB' END, r.page_id, r.thread_id, r.seen, d, r.n_luong);
    IF d >= 1000 AND cham < 25 THEN
      cham := cham + 1;
      RAISE NOTICE 'TT|chậm: hội thoại đo thứ % (luồng % dòng) mất % ms', n, r.n_luong, round(d);
    END IF;
  END LOOP;
  RAISE NOTICE 'TT|đo từng hội thoại: % / % hội thoại trong ngân sách % s (thứ tự: luồng dài trước)', n, tong, current_setting('dien_tap.ngan_sach');
END $$;
SELECT 'TT|phân bố ms/hội thoại (' || count(*) || ' đã đo): tổng ' || round(sum(ms)) || ' · p50 ' || round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ms))
  || ' · p95 ' || round(percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)) || ' · max ' || round(max(ms))
  || ' · ≥ 1 s: ' || count(*) FILTER (WHERE ms >= 1000) || ' · ≥ 10 s: ' || count(*) FILTER (WHERE ms >= 10000)
  || ' · 10 hội thoại chậm nhất chiếm ' || coalesce(round(100 * (SELECT sum(ms) FROM (SELECT ms FROM _dt_do ORDER BY ms DESC LIMIT 10) x) / nullif(sum(ms), 0)), 0) || '%'
  FROM _dt_do HAVING count(*) > 0;
SELECT 'TT|theo nhánh ' || nhanh || ': ' || count(*) || ' hội thoại · tổng ' || round(sum(ms)) || ' ms · p95 ' || round(percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)) || ' · max ' || round(max(ms))
  FROM _dt_do GROUP BY nhanh ORDER BY nhanh;
SELECT 'TT|tương quan: luồng ≥ 500 dòng ' || count(*) FILTER (WHERE n_luong >= 500) || ' hội thoại / ' || coalesce(round(sum(ms) FILTER (WHERE n_luong >= 500)), 0)
  || ' ms · luồng < 500 dòng ' || count(*) FILTER (WHERE n_luong < 500) || ' / ' || coalesce(round(sum(ms) FILTER (WHERE n_luong < 500)), 0) || ' ms'
  FROM _dt_do HAVING count(*) > 0;
INSERT INTO _dt_mau SELECT id, nhanh, page_id, thread_id, seen, ms, n_luong FROM _dt_do ORDER BY ms DESC LIMIT current_setting('dien_tap.mau')::int;
-- Đo không được (hàm chưa có / ngân sách 0) ⇒ mẫu theo độ dài luồng, không theo thời gian.
INSERT INTO _dt_mau
  SELECT c.id, 'LUONG', c.page_id, c.thread_id,
    greatest((SELECT max(x.read_through_at) FROM sales_chat_reads x WHERE x.conversation_id = c.id), c.staff_seen_at), NULL, t.n
  FROM sales_chat_conversations c JOIN (SELECT page_id, thread_id, count(*)::int AS n FROM sales_chat_inbound GROUP BY 1, 2) t ON t.page_id = c.page_id AND t.thread_id = c.thread_id
  WHERE NOT EXISTS (SELECT 1 FROM _dt_mau) ORDER BY t.n DESC LIMIT current_setting('dien_tap.mau')::int;
SQL
    printf "COPY (SELECT id, nhanh, page_id, thread_id, seen, ms, n_luong FROM _dt_mau) TO '%s' WITH (FORMAT csv);\n" "$MR_TEP_MAU"
    cat <<'SQL'
SELECT 'TT|mẫu chậm hạng ' || row_number() OVER (ORDER BY ms DESC NULLS LAST, n_luong DESC) || ': ' || coalesce(round(ms)::text, '—') || ' ms · nhánh ' || nhanh || ' · luồng ' || coalesce(n_luong, 0) || ' dòng'
  FROM _dt_mau ORDER BY ms DESC NULLS LAST, n_luong DESC LIMIT 10;
SQL
  else
    printf "COPY _dt_mau FROM '%s' WITH (FORMAT csv);\n" "$MR_TEP_MAU"
  fi
  cat <<'SQL'
SELECT 'TT|mẫu ' || current_setting('dien_tap.nhan') || ': ' || count(*) || ' hội thoại (' || count(*) FILTER (WHERE nhanh = 'LUONG') || ' nhánh luồng)'
  || CASE WHEN count(*) = 0 THEN ' — RỖNG, biến thể / EXPLAIN không có gì để đo' ELSE '' END FROM _dt_mau;
-- Bốn biến thể của thân hàm luồng trên CÙNG mẫu ⇒ thời gian thuộc vế nào. Vô hiệu một vế bằng cách thêm `false and` vào điều
-- kiện câu con của nó (neo bằng chữ của chính thân hàm; neo không khớp ⇒ nói ra, không đo bừa). Kết quả logic của biến thể
-- KHÔNG dùng — chỉ thời gian.
DO $$
DECLARE src text; v record; r record; t0 timestamptz; tong numeric; so int; m int := 0; han timestamptz; neo_p text := '"sales_chat_inbound" p where'; neo_s text := '"sales_chat_inbound" s where';
BEGIN
  IF to_regprocedure('sales_chat_turn_unhandled_thread(text,text,timestamptz)') IS NULL THEN RETURN; END IF;
  SELECT prosrc INTO src FROM pg_proc WHERE oid = 'sales_chat_turn_unhandled_thread(text,text,timestamptz)'::regprocedure;
  RAISE NOTICE 'TT|biến thể %: neo vế tin mẫu khớp % chỗ · neo vế UNKNOWN lồng khớp % chỗ', current_setting('dien_tap.nhan'),
    (length(src) - length(replace(src, neo_p, ''))) / length(neo_p), (length(src) - length(replace(src, neo_s, ''))) / length(neo_s);
  han := clock_timestamp() + make_interval(secs => greatest(current_setting('dien_tap.ngan_sach')::int / 2, 60));
  FOR v IN SELECT * FROM (VALUES
      (1, 'ĐỦ VẾ', src),
      (2, 'BỎ VẾ TIN MẪU CHÉO LUỒNG', replace(src, neo_p, neo_p || ' false and')),
      (3, 'BỎ VẾ UNKNOWN LỒNG', replace(src, neo_s, neo_s || ' false and')),
      (4, 'BỎ CẢ HAI', replace(replace(src, neo_p, neo_p || ' false and'), neo_s, neo_s || ' false and')),
      (5, 'ĐỦ VẾ · JIT TẮT', src)) x(thu_tu, nhan, than) ORDER BY thu_tu
  LOOP
    -- Biến thể 5: cùng thân hàm, tắt JIT cho riêng phép đo — JIT của PG 16 biên dịch lại MỖI lần hàm SQL chạy câu bên trong.
    IF v.thu_tu = 5 AND NOT pg_jit_available() THEN RAISE NOTICE 'TT|biến thể %: bản sao không có JIT — bỏ', v.nhan; CONTINUE; END IF;
    PERFORM set_config('jit', CASE WHEN v.thu_tu = 5 THEN 'off' ELSE current_setting('dien_tap.jit') END, true);
    IF v.thu_tu > 1 AND v.than = src THEN RAISE NOTICE 'TT|biến thể %: neo không khớp thân hàm — KHÔNG đo', v.nhan; CONTINUE; END IF;
    EXECUTE format('CREATE OR REPLACE FUNCTION pg_temp.dien_tap_bien_the(p_page text, p_thread text, p_seen timestamp with time zone) RETURNS boolean LANGUAGE sql STABLE AS %L', v.than);
    tong := 0; so := 0;
    FOR r IN SELECT * FROM _dt_mau WHERE nhanh = 'LUONG' ORDER BY ms DESC NULLS LAST, n_luong DESC LOOP
      -- Biến thể ĐỦ VẾ đặt cỡ mẫu theo ngân sách; ba biến thể sau đo ĐÚNG m hội thoại ấy để so được với nhau.
      EXIT WHEN (v.thu_tu = 1 AND so > 0 AND clock_timestamp() > han) OR (v.thu_tu > 1 AND so >= m);
      t0 := clock_timestamp();
      PERFORM pg_temp.dien_tap_bien_the(r.page_id, r.thread_id, r.seen);
      tong := tong + extract(epoch FROM clock_timestamp() - t0) * 1000;
      so := so + 1;
    END LOOP;
    IF v.thu_tu = 1 THEN m := so; END IF;
    PERFORM set_config('jit', current_setting('dien_tap.jit'), true);
    RAISE NOTICE 'TT|biến thể % · %: % ms trên % hội thoại mẫu', current_setting('dien_tap.nhan'), v.nhan, round(tong), so;
  END LOOP;
END $$;
-- EXPLAIN (ANALYZE, BUFFERS) thân hàm luồng — PREPARE với tham số rồi ÉP kế hoạch CHUNG (hàm SQL của PG 16 lập kế hoạch với
-- tham số không giá trị ⇒ kế hoạch chung). Dòng tóm tắt chỉ tên nút / bảng / chỉ mục / số; JSON đầy đủ ở phần mã hoá.
SELECT 'PREPARE dien_tap_q(text, text, timestamp with time zone) AS '
  || regexp_replace(regexp_replace(regexp_replace(regexp_replace(prosrc, ';\s*$', ''), '\mp_page\M', '$1', 'g'), '\mp_thread\M', '$2', 'g'), '\mp_seen\M', '$3', 'g')
  FROM pg_proc WHERE oid = to_regprocedure('sales_chat_turn_unhandled_thread(text,text,timestamptz)') AND current_setting('dien_tap.explain')::int > 0 \gexec
SET plan_cache_mode = force_generic_plan;
DO $$
DECLARE r record; j jsonb; i int := 0; nd record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_prepared_statements WHERE name = 'dien_tap_q') THEN RETURN; END IF;
  FOR r IN SELECT * FROM _dt_mau WHERE nhanh = 'LUONG' ORDER BY ms DESC NULLS LAST, n_luong DESC LIMIT current_setting('dien_tap.explain')::int LOOP
    i := i + 1;
    EXECUTE format('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE dien_tap_q(%L, %L, %L)', r.page_id, r.thread_id, r.seen) INTO j;
    INSERT INTO _dt_ke_hoach VALUES (i, j);
    RAISE NOTICE 'TT|EXPLAIN % #% (luồng % dòng): thực thi % ms · lập kế hoạch % ms', current_setting('dien_tap.nhan'), i, coalesce(r.n_luong, 0),
      round((j -> 0 ->> 'Execution Time')::numeric), round((j -> 0 ->> 'Planning Time')::numeric, 1);
    RAISE NOTICE 'TT|  EXPLAIN #% chi phí ước lượng % · JIT %', i, round((j -> 0 -> 'Plan' ->> 'Total Cost')::numeric),
      CASE WHEN j -> 0 ? 'JIT' THEN (j -> 0 -> 'JIT' ->> 'Functions') || ' hàm, biên dịch ' || round((j -> 0 -> 'JIT' -> 'Timing' ->> 'Total')::numeric) || ' ms' ELSE 'không' END;
    FOR nd IN
      SELECT n ->> 'Node Type' AS nut, coalesce(n ->> 'Relation Name', '') AS bang, coalesce(n ->> 'Index Name', '') AS chi_muc,
        coalesce(n ->> 'Subplan Name', n ->> 'Parent Relationship', '') AS vai, (n ->> 'Actual Loops')::numeric AS vong,
        (n ->> 'Actual Rows')::numeric AS dong, coalesce((n ->> 'Rows Removed by Filter')::numeric, 0) AS loai,
        (n ->> 'Actual Total Time')::numeric * (n ->> 'Actual Loops')::numeric AS gop
      FROM jsonb_path_query(j, 'strict $.**') n
      WHERE jsonb_typeof(n) = 'object' AND n ? 'Node Type' AND n ? 'Actual Loops'
      ORDER BY 8 DESC LIMIT 8
    LOOP
      RAISE NOTICE 'TT|  EXPLAIN #% nút: % % % [%] · vòng % · dòng/vòng % · lọc bỏ/vòng % · gộp % ms', i, nd.nut, nd.bang, nd.chi_muc, nd.vai, nd.vong, nd.dong, nd.loai, round(nd.gop);
    END LOOP;
  END LOOP;
END $$;
SELECT 'kế hoạch #' || hang || E':\n' || jsonb_pretty(ke_hoach) FROM _dt_ke_hoach ORDER BY hang;
RESET plan_cache_mode;
SQL
}

mr_sql_chi_muc_thu() { # dựng chỉ mục ỨNG VIÊN trên BẢN SAO, bấm giờ, ANALYZE lại bảng
  cat <<SQL
\\set ON_ERROR_STOP 0
DO \$mr\$
DECLARE t0 timestamptz := clock_timestamp();
BEGIN
  EXECUTE \$ci\$$MR_CHI_MUC_THU\$ci\$;
  RAISE NOTICE 'TT|chỉ mục thử %: dựng % ms · % trên bản sao', '$MR_CHI_MUC_THU_TEN', round(extract(epoch FROM clock_timestamp() - t0) * 1000),
    pg_size_pretty(pg_relation_size(to_regclass('"$MR_CHI_MUC_THU_TEN"')));
END \$mr\$;
ANALYZE "sales_chat_inbound";
SQL
}

# ═══════════════ CÁC BƯỚC (chạy trong container tạm) ═══════════════

MR_THU_MUC_TAM=""
mr_don() {
  if [ -n "$MR_THU_MUC_TAM" ]; then rm -rf "$MR_THU_MUC_TAM"; fi
  don_dien_tap_to_chuc
}

MR_BAT_DAU_GIAY=0
mr_con_lai() { echo $(( MR_TRAN_TONG_GIAY - ( $(date +%s) - MR_BAT_DAU_GIAY ) )); }
mr_du_gio() { # $1=giây bước cần · $2=tên bước — không đủ ⇒ nói ra, trả 1
  local con
  con="$(mr_con_lai)"
  if [ "$con" -lt "$1" ]; then mr_tt "BỎ bước $2: còn ${con} s trong trần tổng ${MR_TRAN_TONG_GIAY} s, bước cần tới ${1} s"; return 1; fi
  return 0
}

# Các migration còn thiếu (mốc > mốc lớn nhất đã áp, đúng luật của drizzle) ⇒ MR_CON_THIEU (đường dẫn tệp, thứ tự sổ).
MR_CON_THIEU=()
mr_buoc_so_migration() {
  local so_tep="$ERP_DIR/drizzle/meta/_journal.json" da_ap moc_max so_ap w t thieu_ten="" bo_qua=0 n_so=0 ten_max=""
  MR_CON_THIEU=()
  if [ ! -f "$so_tep" ]; then loi "không có $so_tep — không biết sổ migration của bản đã deploy."; return 1; fi
  da_ap="$(printf 'SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY 1;\n' | mr_psql -v ON_ERROR_STOP=1 2>/dev/null)" || { loi "không đọc được drizzle.__drizzle_migrations của bản sao."; return 1; }
  so_ap="$(grep -c '^[0-9]' <<< "$da_ap" || true)"
  moc_max="$(grep '^[0-9]' <<< "$da_ap" | sort -n | tail -n 1 || true)"
  while read -r w t; do
    [ -n "${t:-}" ] || continue
    n_so=$((n_so + 1))
    [[ "$t" =~ ^[0-9]{4}_[a-z0-9_]+$ ]] || { loi "tên migration lạ trong sổ — dừng."; return 1; }
    [ "$w" = "${moc_max:-}" ] && ten_max="$t"
    if grep -qx "$w" <<< "$da_ap"; then continue; fi
    if [ -n "$moc_max" ] && [ "$w" -le "$moc_max" ]; then bo_qua=$((bo_qua + 1)); continue; fi
    [ -f "$ERP_DIR/drizzle/$t.sql" ] || { loi "thiếu tệp drizzle/$t.sql của bản đã deploy."; return 1; }
    MR_CON_THIEU+=("$ERP_DIR/drizzle/$t.sql")
    thieu_ten="${thieu_ten:+$thieu_ten }$t"
  done < <(mr_doc_so "$so_tep")
  mr_tt "sổ migration: bản sao đã áp ${so_ap} mục · mục mới nhất đã áp ${ten_max:-không khớp sổ} · sổ của bản đã deploy ${n_so} mục · còn thiếu ${#MR_CON_THIEU[@]}: ${thieu_ten:-không} · bị bỏ qua vĩnh viễn (mốc cũ hơn mục đã áp): ${bo_qua}"
  return 0
}

# (c) Chạy THẬT các migration còn thiếu trong MỘT giao dịch như drizzle, ROLLBACK cuối. $1 = nhãn lượt.
mr_buoc_chay() {
  local nhan="$1" kb ra t0 t1 ma=0
  kb="$MR_THU_MUC_TAM/chay-$RANDOM.sql"; ra="$kb.out"
  { printf '\\set ON_ERROR_STOP 1\n\\timing on\nBEGIN;\n'; mr_dung_kich_ban full "$MR_TRAN" "${MR_CON_THIEU[@]}"; printf 'ROLLBACK;\n'; } > "$kb"
  bao "chạy thử ${#MR_CON_THIEU[@]} migration ($nhan) — trần câu ${MR_TRAN} s…"
  t0=$(date +%s)
  mr_psql < "$kb" > "$ra" 2>&1 || ma=$?
  t1=$(date +%s)
  echo "── đầu ra psql ($nhan) ──"; cat "$ra"
  mr_tom_tat_chay "$kb" "$ra" "$nhan" "$ma"
  mr_tt "$nhan · đồng hồ ngoài: $((t1 - t0)) s · psql thoát $ma"
  MR_KQ_CHAY="$(( t1 - t0 ))|$ma"
}

# (d)(e) Chẩn đoán trong giao dịch ROLLBACK: DDL của migration còn thiếu, rồi SQL chẩn đoán.
mr_buoc_chan_doan() { # $1=full|mau $2=nhãn
  local kb
  kb="$MR_THU_MUC_TAM/chan-doan-$RANDOM.sql"
  { printf '\\set ON_ERROR_STOP 1\nBEGIN;\n'; mr_dung_kich_ban ddl "$MR_TRAN" "${MR_CON_THIEU[@]}"; mr_sql_chan_doan "$1" "$2"; printf 'ROLLBACK;\n'; } > "$kb"
  bao "chẩn đoán ($2)…"
  mr_psql < "$kb" 2>&1 | mr_doi_tt || mr_tt "chẩn đoán $2: psql thoát khác 0 (xem phần mã hoá)"
}

cmd_migration_rehearsal() {
  local ban ten_ban moc_ban avail ban_mb tu_do can kq_truoc="" kq_sau="" kq_jit=""
  MR_BAT_DAU_GIAY=$(date +%s)
  mr_phan_tich_tham_so "$@" || return $?
  chuan_bi_thu_muc || { loi "Không chuẩn bị được thư mục sao lưu."; return 1; }
  giu_khoa 8 "$KHOA_DOC_DB" -x "$TRAN_CHO_KHOA_GIAY" || { loi "Hết giờ chờ khoá đọc nặng — KHÔNG chạy."; return 75; }
  giu_khoa 9 "$KHOA_VONG_DOI" -s "$TRAN_CHO_KHOA_GIAY" || { loi "Hết giờ chờ khoá vòng đời — KHÔNG chạy."; return 75; }

  ban="$(ban_moi_nhat_to_chuc "$MR_CSDL")"
  if [ -z "$ban" ]; then loi "chưa có bản sao lưu nào của CSDL này trên máy — KHÔNG chạy."; mr_tt "KHÔNG CHẠY: chưa có bản sao lưu của tổ chức này trên máy"; return 1; fi
  ten_ban="$(basename "$ban")"
  moc_ban="${ten_ban%.dump}"; moc_ban="${moc_ban: -13}"
  ban_mb="$(mb_cua "$(kich_thuoc "$ban")")"

  # Tài nguyên TRƯỚC khi dựng gì — cùng ngưỡng RAM với diễn tập; ổ ước từ cỡ BẢN DUMP (không hỏi CSDL sống).
  avail="$(free -m 2>/dev/null | awk '/^Mem:/ {print $7}' || true)"
  if [ -z "$avail" ] || ! [ "$avail" -ge "$RAM_TOI_THIEU_DIEN_TAP_MB" ] 2>/dev/null; then
    mr_tt "KHÔNG CHẠY: RAM dùng được ${avail:-?} MB < ${RAM_TOI_THIEU_DIEN_TAP_MB} MB"
    loi "RAM dùng được ${avail:-?} MB < ${RAM_TOI_THIEU_DIEN_TAP_MB} MB — KHÔNG chạy."; return 1
  fi
  tu_do="$(o_trong_mb /var/lib/docker)"; [ -n "$tu_do" ] || tu_do="$(o_trong_mb /)"
  can=$(( ban_mb * MR_HE_SO_O_DIA + DU_TRU_O_DIA_MB ))
  if [ -z "$tu_do" ] || [ "$tu_do" -lt "$can" ]; then
    mr_tt "KHÔNG CHẠY: ổ còn ${tu_do:-?} MB, cần ≥ ${can} MB"
    loi "Không đủ ổ đĩa: còn ${tu_do:-?} MB, cần ≥ ${can} MB — KHÔNG chạy."; return 1
  fi
  echo "CSDL nguồn: $MR_CSDL · bản $ten_ban → CSDL tạm $MR_TAM"
  mr_tt "chạy thử migration trên BẢN SAO: bản dump ${moc_ban} (${ban_mb} MB) · trần câu ${MR_TRAN} s · ngân sách đo ${MR_NGAN_SACH} s · mẫu ${MR_MAU} · EXPLAIN ${MR_EXPLAIN} · chỉ mục thử $([ "$MR_CHI_MUC" = 1 ] && echo có || echo không) · so JIT $([ "$MR_JIT" = 1 ] && echo có || echo không) · ANALYZE $([ "$MR_ANALYZE" = 1 ] && echo có || echo không) · RAM dùng được ${avail} MB · container tạm 1 CPU / ${BO_NHO_DIEN_TAP} / shared_buffers 32MB / fsync tắt (khác production — so TRƯỚC/SAU trên cùng bản sao, không coi là giờ production)"

  # 0 · Bản sao: ĐƯỜNG DUY NHẤT của khối tổ chức (trap dọn gài bên trong, trước docker run).
  if ! dung_ban_sao_tam_to_chuc "$MR_NHAN" "$MR_TIEN_TO_CONTAINER" "$MR_TAM" "$ban"; then
    mr_tt "KHÔNG ĐO ĐƯỢC: $LY_DO_BAN_SAO"
    loi "Dựng bản sao thất bại: $LY_DO_BAN_SAO"; return 1
  fi
  MR_THU_MUC_TAM="$(mktemp -d /dev/shm/erp-mig-dien-tap.XXXXXX 2>/dev/null || mktemp -d)"
  chmod 700 "$MR_THU_MUC_TAM"
  trap mr_don EXIT
  mr_tt "bản sao sẵn sàng sau $(( $(date +%s) - MR_BAT_DAU_GIAY )) s"

  # 1 · (a) thống kê + cấu hình
  mr_sql_cau_hinh | mr_psql 2>&1 | mr_doi_tt || true
  mr_sql_thong_ke | mr_psql 2>&1 | mr_doi_tt || true
  if [ "$MR_ANALYZE" = 1 ]; then
    local t0; t0=$(date +%s)
    printf 'ANALYZE;\n' | mr_psql >/dev/null 2>&1 || mr_tt "ANALYZE lỗi"
    mr_tt "ANALYZE toàn bản sao: $(( $(date +%s) - t0 )) s"
    mr_sql_pg_stats | mr_psql 2>&1 | mr_doi_tt || true
  else
    mr_tt "KHÔNG ANALYZE (--no-analyze): planner chạy KHÔNG có thống kê — đúng trường hợp CSDL chưa từng được ANALYZE"
  fi

  # 2 · (b) sổ migration
  mr_buoc_so_migration || return 1
  if [ "${#MR_CON_THIEU[@]}" -eq 0 ]; then
    mr_tt "KẾT LUẬN: bản sao không thiếu migration nào so với sổ của bản đã deploy — không có gì để chạy thử"
    return 0
  fi

  # 3 · (d)(e) chẩn đoán
  # Ngân sách: bấm giờ từng hội thoại ≤ budget, năm biến thể ≤ ~1,5 × budget (biến thể đầu ≤ budget/2, các biến thể sau đo
  # đúng chừng ấy hội thoại), EXPLAIN vài luồng ⇒ xin 3 × budget + 300 s.
  if [ "$MR_CHAN_DOAN" = 1 ] && mr_du_gio $(( MR_NGAN_SACH * 3 + 300 )) "chẩn đoán"; then mr_buoc_chan_doan full "TRƯỚC"; fi

  # 4 · (c) chạy thật
  if [ "$MR_CHAY" = 1 ] && mr_du_gio $(( MR_TRAN + 120 )) "chạy migration"; then mr_buoc_chay "TRƯỚC"; kq_truoc="$MR_KQ_CHAY"; fi
  # 4b · cùng lượt, TẮT JIT cho phiên — production để JIT mặc định (bật) và migration không tắt nó.
  if [ "$MR_JIT" = 1 ] && [ "$MR_CHAY" = 1 ] && mr_du_gio $(( MR_TRAN + 120 )) "chạy migration JIT tắt"; then
    MR_PGOPTIONS_THEM="-c jit=off"; mr_buoc_chay "TRƯỚC · JIT TẮT"; kq_jit="$MR_KQ_CHAY"; MR_PGOPTIONS_THEM=""
  fi

  # 5 · chỉ mục thử — CHỈ trên bản sao
  if [ "$MR_CHI_MUC" = 1 ] && mr_du_gio $(( MR_TRAN + 600 )) "chỉ mục thử"; then
    mr_sql_chi_muc_thu | mr_psql 2>&1 | mr_doi_tt || true
    if [ "$MR_CHAN_DOAN" = 1 ] && mr_du_gio $(( MR_NGAN_SACH * 2 + 300 )) "chẩn đoán sau chỉ mục"; then mr_buoc_chan_doan mau "SAU CHỈ MỤC"; fi
    if [ "$MR_CHAY" = 1 ] && mr_du_gio $(( MR_TRAN + 120 )) "chạy migration sau chỉ mục"; then mr_buoc_chay "SAU CHỈ MỤC"; kq_sau="$MR_KQ_CHAY"; fi
  fi

  if [ -n "$kq_truoc" ]; then
    mr_tt "KẾT LUẬN: migration còn thiếu trên bản sao — TRƯỚC ${kq_truoc%%|*} s (psql thoát ${kq_truoc##*|})$( [ -n "$kq_jit" ] && printf ' · JIT TẮT %s s (psql thoát %s)' "${kq_jit%%|*}" "${kq_jit##*|}")$( [ -n "$kq_sau" ] && printf ' · SAU CHỈ MỤC THỬ %s s (psql thoát %s)' "${kq_sau%%|*}" "${kq_sau##*|}") · trần câu bản sao ${MR_TRAN} s — xem các dòng «VƯỢT TRẦN PRODUCTION» / «LỖI» ở trên"
  else
    mr_tt "KẾT LUẬN: không chạy bước migration (đã bỏ hoặc --skip-migrate) — chỉ có số chẩn đoán"
  fi
  mr_tt "tổng thời gian lượt: $(( $(date +%s) - MR_BAT_DAU_GIAY )) s · container tạm và CSDL tạm bị xoá khi thoát"
  return 0
}

main_migration_rehearsal() {
  local ma=0
  cmd_migration_rehearsal "$@" || ma=$?
  return "$ma"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main_migration_rehearsal "$@"; exit $?; fi
