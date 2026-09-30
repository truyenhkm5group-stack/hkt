import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * ═══════════ PITR CỦA erp-db — BÀI KIỂM CHẠY SHELL THẬT, KHÔNG MÔ PHỎNG BẰNG LỜI ═══════════
 *
 * Quyết định của chủ nền tảng (30/09/2026): bật PITR theo phương án đã audit (docs/platform/backup-recovery.md §9.4),
 * "verify WAL/PITR thực sự hoạt động", "restore drill ở môi trường an toàn". Bài này khoá phần đo được mà không cần máy
 * chủ, và CHẠY THẬT từng mảnh bằng `bash` / `sh` với `docker` / `df` / `du` / `free` / `rclone` GIẢ qua PATH:
 *
 *  1. CẤU HÌNH — compose truyền đủ tham số bằng `postgres -c`, không đổi ảnh / volume / mật khẩu; hằng số khớp script.
 *  2. LƯU WAL — deploy/pitr-luu-wal.sh chạy bằng `sh` thật: cùng nội dung ⇒ 0, khác ⇒ ≠0 và KHÔNG ghi đè; phanh tay,
 *     sàn ổ trống, trần kho.
 *  3. XOAY VÒNG — giữ đúng PITR_GIU_BAN_NEN bản nền, xoá WAL cũ hơn bản cũ nhất còn giữ, giữ .history.
 *  4. BẢN NỀN — cmd_base thật: archive_mode tắt ⇒ từ chối; bản hỏng ⇒ xoá; đủ ⇒ kiểm, xoay vòng, đẩy ngoài máy.
 *  5. DIỄN TẬP — không một tham chiếu nào tới container / volume / mạng của production (quét nguồn + docker giả), hai
 *     pha quanh dòng đánh dấu, và phép so KHÔNG mù (docker giả "luôn có dòng đánh dấu" ⇒ ĐỎ).
 *  6. OPS — năm thao tác đúng làn khoá, đi qua ma_hoa_ket_qua, gọi CHUNG scripts/erp-pitr.sh.
 *
 * Không đọc process.env / process.platform (tests/test-hygiene.test.ts): mọi biến của tình huống đặt BÊN TRONG kịch
 * bản bash. `chown` (cần root) và `flock` (không có trên Git Bash) được thay bằng hàm ghi lại lời gọi — và nói ra.
 *
 * Đăng ký trong tests/sync-fixtures.test.ts (`testPitr`).
 */

const SCRIPT = "scripts/erp-pitr.sh";
const LUU_WAL = "deploy/pitr-luu-wal.sh";
const doc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const bashPath = (p: string) => path.resolve(p).split(path.sep).join("/");
const boChuThichShell = (s: string) => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

function hangSo(tep: string, ten: string): string {
  const m = new RegExp(`^${ten}=("([^"]*)"|(\\S+))`, "m").exec(doc(tep));
  assert.ok(m, `${tep} phải khai hằng số ${ten}`);
  return (m[2] ?? m[3]).replace(/\s+#.*$/, "");
}
const soHang = (tep: string, ten: string) => {
  const v = Number(hangSo(tep, ten));
  assert.ok(Number.isFinite(v), `${ten} phải là số`);
  return v;
};

type Ra = { ma: number; ra: string };
function chayBash(noiDung: string, trinh = "bash"): Ra {
  const tmp = mkdtempSync(path.join(tmpdir(), "pitr-kiem-"));
  const kich = path.join(tmp, "run.sh");
  writeFileSync(kich, noiDung);
  try {
    return { ma: 0, ra: execFileSync(trinh, [kich], { stdio: "pipe", encoding: "utf8", maxBuffer: 1 << 24 }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { ma: err.status ?? 1, ra: String(err.stdout ?? "") + String(err.stderr ?? "") };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
function phan(ra: string, ten: string): string {
  const dong = ra.split("\n");
  const i = dong.indexOf(`@@${ten}`);
  if (i < 0) return "";
  const ket = dong.findIndex((d, k) => k > i && d.startsWith("@@"));
  return dong.slice(i + 1, ket < 0 ? undefined : ket).join("\n").trim();
}

/** Thân các hàm shell giữa hai mốc chữ trong erp-pitr.sh (đã bỏ chú thích). */
function doan(tuMoc: string, denMoc: string): string {
  const s = doc(SCRIPT);
  const i = s.indexOf(tuMoc);
  const j = s.indexOf(denMoc, i + 1);
  assert.ok(i > 0 && j > i, `không tìm thấy đoạn ${tuMoc} … ${denMoc} trong ${SCRIPT}`);
  return boChuThichShell(s.slice(i, j));
}

/* ═════════════ 1 · CẤU HÌNH: compose + install-vps + hằng số ═════════════ */

function khoiDichVu(compose: string, ten: string): string {
  const i = compose.indexOf(`\n  ${ten}:\n`);
  assert.ok(i >= 0, `không thấy dịch vụ ${ten}`);
  const sau = compose.slice(i + ten.length + 5);
  const ke = sau.search(/\n {2}[a-z][\w-]*:\n|\nvolumes:\n/);
  return ke < 0 ? sau : sau.slice(0, ke);
}

export function testPitrCauHinh() {
  const compose = doc("docker-compose.prod.yml");
  const db = khoiDichVu(compose, "db");
  const dong = db.split("\n").filter((d) => !/^\s*#/.test(d));

  // Không đổi ảnh, container, volume dữ liệu, mật khẩu.
  for (const d of ["    image: postgres:16-alpine", "    container_name: erp-db", "      POSTGRES_USER: erp", "      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-erp_secret}", "      POSTGRES_DB: erp", "      - erp_pgdata:/var/lib/postgresql/data"]) {
    assert.ok(dong.includes(d), `dịch vụ db phải giữ nguyên dòng «${d.trim()}» — PITR không đổi ảnh / volume / mật khẩu`);
  }
  assert.match(compose, /\nvolumes:\n {2}erp_pgdata:\n/, "volume erp_pgdata vẫn là volume có tên, không đổi");

  // `command:` dạng danh sách: postgres + các cặp -c.
  const iCmd = dong.indexOf("    command:");
  assert.ok(iCmd > 0, "dịch vụ db phải truyền cấu hình bằng `command:` (postgres -c …) — không sửa tệp trong volume");
  const args: string[] = [];
  for (const d of dong.slice(iCmd + 1)) {
    const m = /^ {6}- (.*)$/.exec(d);
    if (!m) break;
    args.push(m[1]);
  }
  assert.equal(args[0], "postgres", "lệnh phải là `postgres` — entrypoint của ảnh vẫn chạy (chown, không initdb lại)");
  const thamSo = new Map<string, string>();
  for (let k = 1; k < args.length; k += 2) {
    assert.equal(args[k], "-c", `tham số thứ ${k} phải là -c, thấy ${args[k]}`);
    const [ten, ...gt] = args[k + 1].split("=");
    thamSo.set(ten, gt.join("="));
  }
  const timeout = soHang(SCRIPT, "PITR_ARCHIVE_TIMEOUT");
  assert.equal(thamSo.get("wal_level"), "replica", "wal_level phải khai TƯỜNG MINH replica");
  assert.equal(thamSo.get("archive_mode"), "on");
  assert.equal(Number(thamSo.get("archive_timeout")), timeout, "archive_timeout trong compose PHẢI bằng PITR_ARCHIVE_TIMEOUT của erp-pitr.sh");
  assert.ok(timeout > 0 && timeout <= 900, `archive_timeout ${timeout}s — RPO trên máy phải ≤ 15 phút`);
  assert.equal(thamSo.get("archive_command"), "/bin/sh /erp-pitr-bin/luu-wal.sh %p %f", "archive_command gọi kịch bản bằng /bin/sh (ảnh alpine không có bash; không phụ thuộc bit thực thi)");
  assert.equal(thamSo.size, 4, `chỉ bốn tham số PITR — thấy ${[...thamSo.keys()].join(", ")}`);
  assert.match(db, /\n {4}stop_grace_period: \d+s\n/, "db phải có stop_grace_period — không SIGKILL giữa checkpoint lúc tạo lại");

  // Hai mount, khớp hằng số của script.
  const macDinh = /^BACKUP_DIR="\$\{ERP_BACKUP_DIR:-([^}]+)\}"/m.exec(doc("scripts/erp-backup.sh"))?.[1];
  assert.ok(macDinh);
  const trong = hangSo(SCRIPT, "PITR_TRONG_CONTAINER");
  assert.ok(dong.includes(`      - ${macDinh}/pitr:${trong}`), `db phải mount ${macDinh}/pitr → ${trong} (PITR_DIR của script)`);
  assert.ok(dong.includes("      - ./deploy/pitr-luu-wal.sh:/erp-pitr-bin/luu-wal.sh:ro"), "kịch bản lưu WAL mount MỘT TỆP, chỉ-đọc");
  assert.ok(existsSync(LUU_WAL), `${LUU_WAL} phải có trong kho`);
  assert.equal(hangSo(LUU_WAL, "KHO_WAL"), `\${ERP_PITR_WAL_DIR:-${trong}/wal}`, "kho WAL của kịch bản = <mount>/wal");
  for (const svc of ["app", "scheduler", "chatbot", "caddy"]) {
    const k = khoiDichVu(compose, svc);
    assert.ok(!k.includes("/pitr") && !k.includes("pitr-luu-wal"), `dịch vụ ${svc} KHÔNG được gắn kho WAL / bản nền — trong đó có toàn bộ dữ liệu`);
  }
  assert.equal(hangSo(SCRIPT, "PITR_ANH_DIEN_TAP"), "postgres:16-alpine", "ảnh diễn tập PHẢI bằng ảnh erp-db (diễn tập không hỏi erp-db)");
  for (const ten of ["CO_TAM_DUNG", "SO_LO_HONG"]) assert.equal(hangSo(SCRIPT, ten), hangSo(LUU_WAL, ten), `${ten} phải trùng giữa erp-pitr.sh và pitr-luu-wal.sh`);

  // install-vps: chuẩn bị thư mục TRƯỚC khi dựng db, hỏng thì DỪNG; cài lịch PITR ở mọi lần deploy.
  const install = boChuThichShell(doc("scripts/install-vps.sh"));
  const iChuanBi = install.indexOf("bash scripts/erp-pitr.sh chuan-bi ||");
  const iDb = install.indexOf("$COMPOSE up -d --build db");
  assert.ok(iChuanBi > 0 && iDb > iChuanBi, "install-vps.sh phải chạy `erp-pitr.sh chuan-bi` TRƯỚC `up -d --build db`");
  assert.match(install.slice(iChuanBi, iDb), /exit 1/, "chuẩn bị thư mục PITR hỏng ⇒ DỪNG deploy trước khi đụng erp-db");
  assert.ok(install.indexOf("bash scripts/erp-pitr.sh install-cron") > install.indexOf("bash scripts/erp-backup.sh install-cron"), "lịch PITR cài cạnh lịch sao lưu, ở mọi lần deploy");
  assert.match(doc(SCRIPT), /chown "\$PITR_UID:\$PITR_UID" "\$PITR_DIR" "\$PITR_WAL" "\$PITR_BASE"/, "chuan-bi đặt chủ uid 70 cho ba thư mục");
  assert.equal(soHang(SCRIPT, "PITR_UID"), 70, "uid của postgres trong ảnh alpine là 70");

  // Không định nghĩa ĐÈ hàm nào của erp-backup.sh (tệp ấy `source` vào): phần của nhà giữ nguyên nghĩa.
  const ham = (s: string) => new Set([...s.matchAll(/^([a-z_][a-z0-9_]*)\(\) \{/gm)].map((m) => m[1]));
  const chung = [...ham(doc(SCRIPT))].filter((h) => ham(doc("scripts/erp-backup.sh")).has(h));
  assert.deepEqual(chung, [], `erp-pitr.sh định nghĩa đè hàm của erp-backup.sh: ${chung.join(", ")}`);
  assert.match(doc(SCRIPT), /^source "\$THU_MUC_SCRIPT_PITR\/erp-backup\.sh"$/m, "erp-pitr.sh DÙNG LẠI tiện ích của erp-backup.sh, không chép");

  console.log(`✓ PITR cấu hình: postgres -c wal_level=replica · archive_mode=on · archive_timeout=${timeout}s (= hằng số script) · archive_command /bin/sh kịch bản mount một tệp chỉ-đọc · ảnh/volume/mật khẩu giữ nguyên · chỉ db gắn ${macDinh}/pitr · install-vps chuẩn bị thư mục TRƯỚC khi dựng db, hỏng thì dừng · không đè hàm nào của erp-backup.sh`);
}

/* ═════════════ 2 · LƯU WAL: idempotent, không ghi đè, phanh, sàn, trần — chạy `sh` thật ═════════════ */

export function testPitrLuuWal() {
  const san = soHang(LUU_WAL, "SAN_O_TRONG_MB");
  const tran = soHang(LUU_WAL, "TRAN_KHO_WAL_MB");
  const S = bashPath(LUU_WAL);
  const A = "000000010000000000000001";
  const r = chayBash(
    [
      "#!/bin/sh",
      // %p là đường TƯƠNG ĐỐI với thư mục dữ liệu (Postgres chạy archive_command ở đó) ⇒ đứng ở $T như Postgres đứng ở PGDATA.
      'T="$(mktemp -d)"; K="$T/kho"; mkdir -p "$T/bin" "$K" "$T/pg_wal"; cd "$T"',
      // df / du GIẢ: đầu ra là đầu vào của tình huống, không phải ổ đĩa của máy đang chạy kiểm thử.
      "cat > \"$T/bin/df\" <<'EOF'",
      "#!/bin/sh",
      'echo "Filesystem 1024-blocks Used Available Capacity Mounted"',
      '[ -z "$STUB_DF_KB" ] || echo "/dev/gia 1 1 $STUB_DF_KB 1% /"',
      "EOF",
      "cat > \"$T/bin/du\" <<'EOF'",
      "#!/bin/sh",
      'printf "%s\\t%s\\n" "$STUB_DU_KB" "$2"',
      "EOF",
      'chmod +x "$T/bin/df" "$T/bin/du"',
      'export PATH="$T/bin:$PATH" ERP_PITR_WAL_DIR="$K" STUB_DF_KB=99999999 STUB_DU_KB=10',
      `S="${S}"`,
      'lam() { sh "$S" "$@" > /dev/null 2>"$T/err"; echo $?; }',
      `head -c 70000 /dev/urandom > "$T/pg_wal/${A}"`,
      `echo "@@LAN1"; lam "pg_wal/${A}" ${A}`,
      `echo "@@TRUNG1"; gzip -dc "$K/${A}.gz" | cmp -s - "$T/pg_wal/${A}" && echo trung || echo khac`,
      `SHA1="$(sha256sum "$K/${A}.gz" | cut -c1-64)"`,
      `echo "@@LAN2"; lam "pg_wal/${A}" ${A}`,
      // Nguồn đổi nội dung (hai cụm cùng ghi một kho / timeline lệch): phải TỪ CHỐI và KHÔNG ghi đè.
      `head -c 70000 /dev/urandom > "$T/pg_wal/${A}"`,
      `echo "@@LAN3"; lam "pg_wal/${A}" ${A}`,
      'echo "@@LOI3"; cat "$T/err"',
      `echo "@@GIUNGUYEN"; [ "$(sha256sum "$K/${A}.gz" | cut -c1-64)" = "$SHA1" ] && echo nguyen || echo bi-ghi-de`,
      // Tên lạ.
      `echo "@@TENLA"; lam "pg_wal/${A}" "../x"; lam "pg_wal/${A}" "$(printf '${A}\\nx')"; lam "pg_wal/${A}" "${A.slice(0, 23)}a"`,
      // Phanh tay.
      'head -c 1000 /dev/urandom > "$T/pg_wal/000000010000000000000002"; : > "$K/.tam-dung"',
      'echo "@@PHANH"; lam pg_wal/000000010000000000000002 000000010000000000000002; ls "$K" | grep -c "^000000010000000000000002" || true',
      'rm -f "$K/.tam-dung"',
      // Sàn ổ trống.
      `head -c 1000 /dev/urandom > "$T/pg_wal/000000010000000000000003"; export STUB_DF_KB=$((${san} * 1024 - 1))`,
      'echo "@@SAN"; lam pg_wal/000000010000000000000003 000000010000000000000003; ls "$K" | grep -c "^000000010000000000000003" || true',
      'export STUB_DF_KB=99999999',
      // Trần kho.
      `head -c 1000 /dev/urandom > "$T/pg_wal/000000010000000000000004"; export STUB_DU_KB=$((${tran} * 1024 + 1))`,
      'echo "@@TRAN"; lam pg_wal/000000010000000000000004 000000010000000000000004; ls "$K" | grep -c "^000000010000000000000004" || true',
      'export STUB_DU_KB=10',
      // df không đọc được ⇒ CHƯA BIẾT ⇒ không lưu, không bỏ.
      'export STUB_DF_KB=""; echo "@@DFLOI"; lam pg_wal/000000010000000000000004 000000010000000000000004; export STUB_DF_KB=99999999',
      // .history + .partial vẫn là tên hợp lệ.
      'echo h > "$T/pg_wal/00000002.history"; echo p > "$T/pg_wal/000000010000000000000005.partial"',
      'echo "@@HOPLE"; lam pg_wal/00000002.history 00000002.history; lam pg_wal/000000010000000000000005.partial 000000010000000000000005.partial',
      'echo "@@LOHONG"; cat "$K/.lo-hong.log"',
      'echo "@@TAMSOT"; ls -A "$K" | grep -c "dang-ghi" || true',
      'echo "@@HET"; rm -rf "$T"',
      "",
    ].join("\n"),
    "sh",
  );
  assert.equal(phan(r.ra, "LAN1"), "0", `lần đầu phải lưu được:\n${r.ra}`);
  assert.equal(phan(r.ra, "TRUNG1"), "trung", "tệp .gz giải nén ra ĐÚNG đoạn WAL");
  assert.equal(phan(r.ra, "LAN2"), "0", "lưu lại CÙNG nội dung (lượt thử lại sau sự cố) ⇒ thành công — idempotent");
  assert.notEqual(phan(r.ra, "LAN3"), "0", "đích đã có với nội dung KHÁC ⇒ PHẢI thất bại để Postgres giữ đoạn và lỗi lộ ra");
  assert.match(phan(r.ra, "LOI3"), /KHÁC — KHÔNG ghi đè/, "thất bại phải nói vì sao");
  assert.equal(phan(r.ra, "GIUNGUYEN"), "nguyen", "KHÔNG BAO GIỜ ghi đè một đoạn WAL đã lưu");
  assert.deepEqual(phan(r.ra, "TENLA").split("\n"), ["2", "2", "2"], "tên lạ (.., xuống dòng, chữ thường) bị từ chối, không đi vào đường dẫn");
  assert.deepEqual(phan(r.ra, "PHANH").split("\n"), ["0", "0"], "phanh tay ⇒ thoát 0 (Postgres thôi dồn WAL) và KHÔNG lưu");
  assert.deepEqual(phan(r.ra, "SAN").split("\n"), ["0", "0"], `ổ dưới sàn ${san} MB ⇒ bỏ đoạn (thoát 0) thay vì để pg_wal làm đầy ổ`);
  const tranRa = phan(r.ra, "TRAN").split("\n");
  assert.deepEqual([tranRa[0] !== "0", tranRa[1]], [true, "0"], `kho vượt trần ${tran} MB ⇒ thất bại NHÌN THẤY ĐƯỢC, không lưu`);
  assert.notEqual(phan(r.ra, "DFLOI"), "0", "không đọc được ổ trống ⇒ CHƯA BIẾT ⇒ thất bại (không phải 'còn chỗ', không phải 'bỏ')");
  assert.deepEqual(phan(r.ra, "HOPLE").split("\n"), ["0", "0"], ".history / .partial là tên hợp lệ");
  const loHong = phan(r.ra, "LOHONG");
  assert.match(loHong, /000000010000000000000002 TAM_DUNG/, "đoạn bị bỏ vì phanh phải ghi vào sổ lỗ hổng");
  assert.match(loHong, /000000010000000000000003 O_DAY/, "đoạn bị bỏ vì ổ đầy phải ghi vào sổ lỗ hổng");
  assert.equal(phan(r.ra, "TAMSOT"), "0", "không để lại tệp tạm");
  console.log(`✓ PITR lưu WAL (sh thật): cùng nội dung ⇒ 0 · khác ⇒ ≠0 và KHÔNG ghi đè · tên lạ ⇒ 2 · phanh tay / ổ dưới sàn ${san} MB ⇒ bỏ + sổ lỗ hổng · kho > trần ${tran} MB hoặc df lỗi ⇒ thất bại nhìn thấy được · không tệp tạm sót`);
}

/* ═════════════ Khung chung: nạp erp-pitr.sh với công cụ giả ═════════════ */

/**
 * `docker` giả đủ cho bản nền, trạng thái, dòng đánh dấu và diễn tập. Nó ghi MỌI lời gọi vào $DOCKER_LOG để bài kiểm
 * đọc lại: diễn tập không được một lần nào nhắc tới erp-db / erp_pgdata.
 */
const DOCKER_GIA = [
  "cat > \"$T/bin/docker\" <<'EOF'",
  "#!/usr/bin/env bash",
  'echo "docker $*" >> "$DOCKER_LOG"',
  'case "$1" in',
  "  inspect)",
  '    case "$*" in',
  '      *"erp-db"*) echo true ;;',
  '      *) [ "${STUB_PHUC_HOI:-ok}" = ok ] && echo true || echo false ;;',
  "    esac ;;",
  "  run)",
  '    ten=""; moc=""; prev=""',
  '    for a in "$@"; do [ "$prev" = "--name" ] && ten="$a"; case "$a" in recovery_target_time=*) moc="${a#recovery_target_time=}" ;; esac; prev="$a"; done',
  '    printf "%s" "$moc" > "$STATE/$ten.moc"; echo cid ;;',
  "  exec)",
  '    c="$2"; shift 2',
  '    case "$*" in',
  '      *pg_basebackup*)',
  '        [ "${STUB_BB:-ok}" = ok ] || { echo "pg_basebackup: loi gia" >&2; exit 1; }',
  '        d=""; prev=""; for a in "$@"; do [ "$prev" = "-D" ] && d="$a"; prev="$a"; done',
  '        h="$PITR_HOST${d#/pitr}"; w="$(mktemp -d)"; mkdir -p "$w/wal"',
  '        printf "START WAL LOCATION: 0/20000028 (file %s)\\nCHECKPOINT LOCATION: 0/20000060\\nSTART TIME: 2026-09-30 02:27:00 UTC\\n" "$STUB_START_WAL" > "$w/backup_label"',
  '        echo 16 > "$w/PG_VERSION"; echo wal > "$w/wal/$STUB_START_WAL"',
  '        (cd "$w" && tar czf "$h/base.tar.gz" backup_label PG_VERSION) && (cd "$w/wal" && tar czf "$h/pg_wal.tar.gz" .) && echo "{}" > "$h/backup_manifest"; rm -rf "$w" ;;',
  '      *"name = \'archive_mode\'"*) echo "${STUB_ARCHIVE_MODE:-on}" ;;',
  '      *pg_database_size*) echo 1048576 ;;',
  '      *"insert into settings"*) printf "%s\\n" "${STUB_MARK_AT:-}" ;;',
  '      *pg_stat_archiver*) printf "%s\\n" "$STUB_ARCHIVER" ;;',
  '      *sha256sum*) sha256sum "$ERP_DIR/deploy/pitr-luu-wal.sh" ;;',
  '      *pg_is_in_recovery*) [ "${STUB_PHUC_HOI:-ok}" = ok ] && echo "true|paused" || exit 2 ;;',
  '      *"from settings where key"*)',
  '        t="$(date -u -d "$(cat "$STATE/$c.moc")" +%s)"',
  '        if [ "${STUB_LUON_CO:-0}" = 1 ] || [ "$t" -ge "$STUB_M_EP" ]; then echo "{\\"nonce\\":\\"$STUB_NONCE\\"}"; else echo "{\\"nonce\\":\\"0000000000000000\\"}"; fi ;;',
  '      *pg_last_xact_replay_timestamp*) echo 2026-09-30T20:00:00Z ;;',
  '      *"count(*)"*) echo 42 ;;',
  "    esac ;;",
  '  logs) echo "FATAL:  recovery ended before configured recovery target was reached" ;;',
  "  stop | rm | ps) : ;;",
  "esac",
  "EOF",
];

function khung(dong: string[]): string {
  return [
    "#!/usr/bin/env bash",
    "set -uo pipefail",
    'T="$(mktemp -d)"; mkdir -p "$T/bin" "$T/erp/deploy" "$T/remote" "$T/state"',
    ...DOCKER_GIA,
    "cat > \"$T/bin/df\" <<'EOF'",
    "#!/usr/bin/env bash",
    'echo "Filesystem 1048576-blocks Used Available Capacity Mounted"; echo "/dev/gia 40000 1 999999 1% /"',
    "EOF",
    "cat > \"$T/bin/free\" <<'EOF'",
    "#!/usr/bin/env bash",
    'echo "              total used free shared buff/cache available"; echo "Mem: 1900 900 100 0 900 ${STUB_RAM:-4000}"',
    "EOF",
    "cat > \"$T/bin/rclone\" <<'EOF'",
    "#!/usr/bin/env bash",
    'echo "rclone $*" >> "$DOCKER_LOG"',
    'dich() { printf "%s" "$REMOTE_DIR/${1#gia:}"; }',
    'case "$1" in',
    '  copyto) [ "${STUB_RCLONE_LOI:-0}" = 1 ] && { echo "rclone: loi mang gia" >&2; exit 1; }; shift; while [ "${1#--}" != "$1" ]; do shift; [ "$1" = 3 ] && shift; done; mkdir -p "$(dirname "$(dich "$2")")"; cp "$1" "$(dich "$2")" ;;',
    '  copy) [ "${STUB_RCLONE_LOI:-0}" = 1 ] && { echo "rclone: loi mang gia" >&2; exit 1; }; src="${@: -2:1}"; d="$(dich "${!#}")"; mkdir -p "$d"; for f in "$src"/*; do [ -f "$f" ] && cp "$f" "$d/"; done ;;',
    '  lsf) f="$(dich "${!#}")"; [ -f "$f" ] || exit 1; stat -c %s "$f" ;;',
    "  delete | rmdirs) : ;;",
    "esac",
    "EOF",
    'chmod +x "$T/bin/"*',
    `cp "${bashPath(LUU_WAL)}" "$T/erp/deploy/pitr-luu-wal.sh"`,
    'export PATH="$T/bin:$PATH" DOCKER_LOG="$T/docker.log" REMOTE_DIR="$T/remote" STATE="$T/state"',
    'export ERP_BACKUP_DIR="$T/backups" ERP_DIR="$T/erp" ERP_LOCK_DIR="$T/locks" ERP_PITR_CRON_FILE="$T/cron.d/erp-pitr" ERP_BACKUP_LOG="$T/log"',
    'export PITR_HOST="$T/backups/pitr"',
    "unset BACKUP_OFFSITE_REMOTE",
    ': > "$DOCKER_LOG"',
    `source "${bashPath(SCRIPT)}"`,
    "set +e",
    // Khoá đo riêng bằng flock THẬT ở tests/backup.test.ts; chown cần root (máy chạy kiểm thử không phải root) — ghi lại lời gọi.
    'khoa_chong_chong() { echo "KHOA-7" >> "$DOCKER_LOG"; [ "${STUB_KHOA_BAN:-0}" != 1 ]; }',
    "giu_khoa() { return 0; }",
    'chown() { echo "chown $*" >> "$DOCKER_LOG"; }',
    "flock() { return 0; }",
    "sleep() { :; }",
    'gio_vn() { date -u -d "${STUB_GIO_VN:-2026-09-30 03:27:00}" "$@"; }',
    ...dong,
    'echo "@@HET"; rm -rf "$T"',
    "",
  ].join("\n");
}

/* ═════════════ 3 · XOAY VÒNG BẢN NỀN + DỌN WAL ═════════════ */

export function testPitrXoayVong() {
  const giu = soHang(SCRIPT, "PITR_GIU_BAN_NEN");
  assert.equal(giu, 2, "đề xuất đã duyệt: giữ 2 bản nền");
  const W = (h: string) => `0000000100000000000000${h}`;
  const r = chayBash(
    khung([
      'mkdir -p "$PITR_HOST/wal" "$PITR_HOST/base"',
      `for x in "20260901-0227 ${W("10")}" "20260902-0227 ${W("20")}" "20260903-0227 ${W("30")}"; do set -- $x; mkdir -p "$PITR_HOST/base/base-$1"; echo "$2" > "$PITR_HOST/base/base-$1/bat-dau-wal"; done`,
      `for n in ${W("0F")} ${W("10")} ${W("1F")} ${W("20")} ${W("25")} ${W("30")} ${W("31")} ${W("12")}.00000028.backup ${W("0A")}.partial 00000002.history; do echo x > "$PITR_HOST/wal/$n.gz"; done`,
      `printf '2026-09-01T00:00:00Z ${W("0F")} TAM_DUNG\\n2026-09-02T00:00:00Z ${W("25")} O_DAY\\n' > "$PITR_HOST/wal/.lo-hong.log"`,
      'echo x > "$PITR_HOST/wal/.tam-dung"',
      "xoay_vong_ban_nen > /dev/null 2>&1",
      'echo "@@BASE"; ls -1 "$PITR_HOST/base"',
      'echo "@@WAL"; ls -1 "$PITR_HOST/wal"',
      'echo "@@LOHONG"; cat "$PITR_HOST/wal/.lo-hong.log"',
      'echo "@@CO"; [ -e "$PITR_HOST/wal/.tam-dung" ] && echo con',
    ]),
  );
  const base = phan(r.ra, "BASE").split("\n");
  assert.equal(base.length, giu, `giữ đúng ${giu} bản nền:\n${r.ra}`);
  assert.deepEqual(base, ["base-20260902-0227", "base-20260903-0227"], "giữ các bản MỚI NHẤT theo mốc trong tên");
  assert.deepEqual(
    phan(r.ra, "WAL").split("\n").sort(),
    [`00000002.history.gz`, `${W("20")}.gz`, `${W("25")}.gz`, `${W("30")}.gz`, `${W("31")}.gz`].sort(),
    "xoá mọi đoạn (kể cả .partial, .backup) CŨ HƠN đoạn bắt đầu của bản nền cũ nhất còn giữ; giữ .history và mọi đoạn từ đó trở đi",
  );
  assert.equal(phan(r.ra, "LOHONG"), `2026-09-02T00:00:00Z ${W("25")} O_DAY`, "sổ lỗ hổng bỏ dòng cũ hơn bản nền cũ nhất, giữ dòng còn ảnh hưởng");
  assert.equal(phan(r.ra, "CO"), "con", "xoay vòng không đụng cờ tạm dừng");
  console.log(`✓ PITR xoay vòng: giữ ${giu} bản nền mới nhất · xoá WAL / .partial / .backup cũ hơn bản cũ nhất còn giữ · giữ .history · sổ lỗ hổng tỉa theo cùng mốc`);
}

/* ═════════════ 4 · BẢN NỀN CHẠY THẬT ═════════════ */

export function testPitrBanNen() {
  const W = (h: string) => `0000000100000000000000${h}`;
  const r = chayBash(
    khung([
      "export BACKUP_OFFSITE_REMOTE=gia:",
      // archive_mode tắt ⇒ từ chối, không tạo gì.
      'export STUB_ARCHIVE_MODE=off; TRIGGER=ops; cmd_base > "$T/o0" 2>&1; rc=$?; echo "@@TAT"; echo $rc; ls -A "$PITR_HOST/base" | wc -l; cat "$T/backups/status/pitr-base.json"',
      "export STUB_ARCHIVE_MODE=on",
      `STUB_GIO_VN="2026-09-28 03:27:00" STUB_START_WAL=${W("10")} cmd_base > "$T/o1" 2>&1; rc=$?; echo "@@B1"; echo $rc`,
      `STUB_GIO_VN="2026-09-29 03:27:00" STUB_START_WAL=${W("20")} cmd_base > "$T/o2" 2>&1; rc=$?; echo "@@B2"; echo $rc`,
      `for n in ${W("0F")} ${W("10")} ${W("1F")} ${W("20")} ${W("21")}; do echo x > "$PITR_HOST/wal/$n.gz"; done`,
      // pg_basebackup hỏng: bản dở bị xoá, các bản cũ không bị xoay vòng.
      `STUB_BB=fail STUB_GIO_VN="2026-09-30 02:27:00" STUB_START_WAL=${W("30")} cmd_base > "$T/o3" 2>&1; rc=$?; echo "@@HONG"; echo $rc; ls -1A "$PITR_HOST/base" | tr '\\n' ' '; echo; grep -o '"result":"[A-Z]*"' "$T/backups/status/pitr-base.json"`,
      `TRIGGER=cron STUB_GIO_VN="2026-09-30 03:27:00" STUB_START_WAL=${W("30")} cmd_base > "$T/o4" 2>&1; rc=$?; echo "@@B3"; echo $rc`,
      'echo "@@BASE"; ls -1A "$PITR_HOST/base"',
      'echo "@@WAL"; ls -1 "$PITR_HOST/wal"',
      'echo "@@NEN"; cat "$PITR_HOST/base/base-20260930-0327/nen.json"; echo; cat "$PITR_HOST/base/base-20260930-0327/bat-dau-wal"',
      'echo "@@STATUS"; cat "$T/backups/status/pitr-base.json"',
      'echo "@@DONE"; cat "$T/backups/status/pitr-base-done"',
      'echo "@@REMOTE"; (cd "$T/remote" && find . -type f | sort)',
      'echo "@@TOMTAT"; grep "^\\[ops:tom-tat\\]" "$T/o4"',
      'echo "@@DOCKER"; cat "$DOCKER_LOG"',
    ]),
  );
  const tat = phan(r.ra, "TAT").split("\n");
  assert.equal(tat[0], "1", `archive_mode tắt ⇒ bản nền thất bại:\n${r.ra}`);
  assert.equal(tat[1], "0", "archive_mode tắt ⇒ không tạo bản nền nào");
  assert.match(tat.slice(2).join("\n"), /"result":"FAILED".*archive_mode = 'off'/, "trạng thái nói rõ PITR CHƯA BẬT");
  for (const b of ["B1", "B2", "B3"]) assert.equal(phan(r.ra, b), "0", `lượt ${b} phải đạt:\n${r.ra}`);
  const hong = phan(r.ra, "HONG").split("\n");
  assert.equal(hong[0], "1", "pg_basebackup hỏng ⇒ thoát 1");
  assert.equal(hong[1].trim(), "base-20260928-0327 base-20260929-0327", "bản dở bị xoá, hai bản cũ còn nguyên (không xoay vòng khi bản mới hỏng)");
  assert.equal(hong[2], '"result":"FAILED"');
  assert.deepEqual(phan(r.ra, "BASE").split("\n"), ["base-20260929-0327", "base-20260930-0327"], "giữ 2 bản nền mới nhất, không bản dở nào sót");
  assert.deepEqual(phan(r.ra, "WAL").split("\n"), [`${W("20")}.gz`, `${W("21")}.gz`], "WAL cũ hơn bản nền cũ nhất còn giữ (…20) đã dọn");
  const nen = phan(r.ra, "NEN");
  assert.match(nen, new RegExp(`"startWal":"${W("30")}"`), "nen.json mang đoạn WAL bắt đầu đọc từ backup_label");
  assert.match(nen, /"clusterBytes":1048576/, "nen.json mang cỡ cụm lúc chụp (diễn tập dùng để kiểm ổ đĩa)");
  assert.match(nen, new RegExp(`\n${W("30")}$`), "bat-dau-wal đúng đoạn bắt đầu");
  assert.match(phan(r.ra, "STATUS"), /"result":"OK".*"trigger":"cron".*"offsite":\{"state":"OK"/, "trạng thái bản nền OK, ngoài máy OK");
  assert.equal(phan(r.ra, "DONE"), "2026-09-30", "lượt cron đánh dấu đêm nay xong");
  const remote = phan(r.ra, "REMOTE");
  for (const f of ["base.tar.gz", "pg_wal.tar.gz", "backup_manifest", "nen.json", "bat-dau-wal"]) {
    assert.ok(remote.includes(`./pitr/base/base-20260930-0327/${f}`), `bản nền đẩy ngoài máy đủ tệp ${f}:\n${remote}`);
  }
  assert.match(phan(r.ra, "TOMTAT"), /^\[ops:tom-tat\] PITR bản nền: base-20260930-0327 · \d+ MB · bắt đầu ở đoạn /, "kênh tóm tắt chỉ in con số + tên bản");
  const dk = phan(r.ra, "DOCKER");
  assert.match(dk, /docker exec erp-db pg_basebackup -U erp -D \/pitr\/base\/\.dang-ghi-20260930-0327 -Ft -X stream -Z 1 -c spread -r 32M /, "pg_basebackup: tar, WAL stream, nén, checkpoint spread, có trần đọc, ghi thẳng vào mount");
  assert.match(dk, /chown 70:70 \S+\/pitr \S+\/pitr\/wal \S+\/pitr\/base/, "chuan-bi đặt chủ uid 70");
  assert.ok((dk.match(/KHOA-7/g) ?? []).length >= 4, "mỗi lượt bản nền cầm khoá sao lưu (FD 7)");
  console.log("✓ PITR bản nền (chạy thật, docker giả): archive_mode tắt ⇒ từ chối · pg_basebackup hỏng ⇒ xoá bản dở, không xoay vòng · đạt ⇒ backup_label → đoạn bắt đầu, giữ 2 bản, dọn WAL, đẩy gcrypt:pitr/base/, lượt cron đánh dấu đêm");
}

/* ═════════════ 5 · DIỄN TẬP: KHÔNG CHẠM PRODUCTION (nguồn + docker giả), hai pha, phép so không mù ═════════════ */

export function testPitrDienTapMaNguon() {
  const code = doan("# ═══════════════ LỆNH: drill", "# ═══════════════ LỆNH: install-cron");
  for (const [re, ly] of [
    [/DB_CONTAINER/, "không hỏi tới container production"],
    [/erp-db/, "không nhắc tên container production"],
    [/erp_pgdata/, "không gắn volume dữ liệu production"],
    [/--volumes-from|--link\b|--net=|--network (?!none)/, "không mượn volume / mạng của container khác"],
    [/(?<!mkdir) -p ["$\d]|--publish/, "không mở cổng"], // `-p <cổng>` của docker run; `mkdir -p` không phải
  ] as const) {
    assert.ok(!re.test(code), `diễn tập PITR: ${ly} (${re})`);
  }
  assert.match(code, /--network none/, "container diễn tập không có mạng");
  assert.match(code, /--memory "\$BO_NHO_DIEN_TAP_PITR" --memory-swap "\$BO_NHO_DIEN_TAP_PITR"/, "trần RAM riêng của diễn tập PITR");
  assert.match(readFileSync("scripts/erp-pitr.sh", "utf8"), /^BO_NHO_DIEN_TAP_PITR=384m$/m, "trần 384 MB");
  assert.match(readFileSync("scripts/erp-pitr.sh", "utf8"), /^RAM_TOI_THIEU_DIEN_TAP_PITR_MB=512$/m, "ngưỡng RAM trống 512 MB");
  assert.match(code, /if \[ "\$1" != "OK" \]; then tt "PITR diễn tập: \$1/, "lý do bỏ qua / hỏng ra kênh tóm tắt");
  assert.match(code, /-v "\$PITR_WAL:\/pitr-wal:ro"/, "kho WAL gắn CHỈ-ĐỌC");
  assert.match(code, /"\$PITR_ANH_DIEN_TAP"/, "ảnh là hằng số, không đọc từ erp-db");
  assert.match(code, /trap don_dien_tap_pitr EXIT/, "container + thư mục tạm bị dọn cả khi hỏng giữa chừng");
  // Trong thân lệnh: kiểm RAM + ổ TRƯỚC lần dựng container đầu tiên (chay_pha_pitr là chỗ DUY NHẤT gọi docker run).
  const than = code.slice(code.indexOf("cmd_drill_than() {"));
  const iRam = than.indexOf("RAM_TOI_THIEU_DIEN_TAP_PITR_MB");
  const iDung = than.indexOf("chay_pha_pitr ");
  assert.ok(iRam > 0 && iDung > iRam && than.indexOf("DU_TRU_O_DIA_MB") < iDung, "kiểm RAM + ổ đĩa TRƯỚC khi dựng container");
  assert.equal((code.match(/docker run /g) ?? []).length, 1, "đúng MỘT chỗ dựng container tạm");
  assert.match(code, /recovery_target_action=pause/, "dừng ở mốc, không promote — pha sau đi tiếp được");
  console.log("✓ PITR diễn tập (mã nguồn): 0 tham chiếu tới erp-db / erp_pgdata / mạng / cổng · --network none · trần RAM · WAL chỉ-đọc · ảnh hằng số · trap dọn · kiểm RAM trước");
}

export function testPitrDienTap() {
  const W = "000000010000000000000020";
  const dung = (kichBan: string[]) =>
    chayBash(
      khung([
        'mkdir -p "$PITR_HOST/wal" "$PITR_HOST/base/base-20260930-0227" "$T/backups/status"',
        'NOW=$(date +%s); B=$((NOW - 3600)); M=$((NOW - 1800))',
        'w="$(mktemp -d)"; echo "START WAL LOCATION: 0/20000028 (file ' + W + ')" > "$w/backup_label"; echo 16 > "$w/PG_VERSION"',
        '(cd "$w" && tar czf "$PITR_HOST/base/base-20260930-0227/base.tar.gz" backup_label PG_VERSION); mkdir -p "$w/wal"; echo x > "$w/wal/' + W + '"; (cd "$w/wal" && tar czf "$PITR_HOST/base/base-20260930-0227/pg_wal.tar.gz" .); rm -rf "$w"',
        `printf '{"schema":1,"finishedAt":"%s","clusterBytes":1048576}' "$(date -u -d "@$B" +%FT%TZ)" > "$PITR_HOST/base/base-20260930-0227/nen.json"`,
        `echo x | gzip > "$PITR_HOST/wal/${W}.gz"`,
        'export STUB_NONCE=a1b2c3d4e5f60718 STUB_M_EP=$M',
        `printf '{"schema":1,"kind":"pitr-marker","nonce":"%s","at":"%s.482913Z"}' "$STUB_NONCE" "$(date -u -d "@$M" +%FT%T)" > "$T/backups/status/pitr-marker.json"`,
        ...kichBan,
        'echo "@@TMP"; ls -A "$T/backups" | grep -c "pitr-dien-tap" || true',
        'echo "@@DRILL"; cat "$T/backups/status/pitr-drill.json"',
        'echo "@@DOCKER"; cat "$DOCKER_LOG"',
      ]),
    );

  // ĐẠT: mốc sau dòng đánh dấu ⇒ pha trước (M−1) VẮNG, pha sau CÓ.
  const ok = dung(['cmd_drill "$(date -u -d "@$((NOW - 600))" +%FT%TZ)" > "$T/o" 2>&1; rc=$?; echo "@@EXIT"; echo $rc', 'echo "@@OUT"; cat "$T/o"', 'echo "@@MOC"; date -u -d "@$((M - 1))" "+%Y-%m-%d %H:%M:%S+00"; date -u -d "@$((NOW - 600))" "+%Y-%m-%d %H:%M:%S+00"']);
  assert.equal(phan(ok.ra, "EXIT"), "0", `diễn tập đủ điều kiện phải ĐẠT:\n${ok.ra}`);
  assert.match(phan(ok.ra, "DRILL"), /"result":"OK".*"marker":\{"before":"VANG","after":"CO"\}.*"orders":42/, "trạng thái: OK, dòng đánh dấu VẮNG trước / CÓ sau, bảng lõi có dữ liệu");
  const [mocTruoc, mocSau] = phan(ok.ra, "MOC").split("\n");
  const dk = phan(ok.ra, "DOCKER");
  const run = dk.split("\n").filter((d) => d.startsWith("docker run "));
  assert.equal(run.length, 2, `hai pha = hai container tạm trên CÙNG thư mục dữ liệu:\n${dk}`);
  assert.ok(run[0].includes(`recovery_target_time=${mocTruoc}`), `pha trước dừng ở (mốc đánh dấu − 1 giây, làm tròn xuống): ${run[0]}`);
  assert.ok(run[1].includes(`recovery_target_time=${mocSau}`), `pha sau dừng ở mốc yêu cầu: ${run[1]}`);
  for (const d of run) {
    assert.match(d, /--network none/, "mỗi container tạm không có mạng");
    assert.match(d, /--memory 384m --memory-swap 384m/, "mỗi container tạm có trần RAM (trần riêng của diễn tập PITR)");
    assert.match(d, /\/pitr\/wal:\/pitr-wal:ro/, "kho WAL gắn chỉ-đọc");
    assert.match(d, /restore_command=gzip -dc \/pitr-wal\/%f\.gz > %p/, "restore_command giải nén từ kho WAL");
    assert.match(d, /postgres:16-alpine/, "cùng ảnh với erp-db");
  }
  const tuDienTap = dk.split("\n").filter((d) => d.startsWith("docker "));
  assert.ok(!tuDienTap.some((d) => /erp-db|erp_pgdata/.test(d)), `diễn tập KHÔNG một lời gọi docker nào nhắm vào erp-db / erp_pgdata:\n${tuDienTap.filter((d) => /erp-db|erp_pgdata/.test(d)).join("\n")}`);
  assert.equal(phan(ok.ra, "TMP"), "0", "thư mục dữ liệu tạm bị xoá");
  assert.match(phan(ok.ra, "OUT"), /\[ops:tom-tat\] RTO phần máy: giải nén \d+s · pha trước \d+s · phục hồi tới mốc \d+s · tổng \d+s/, "in RTO phần máy qua kênh tóm tắt");

  // PHÉP SO KHÔNG MÙ: bản khôi phục "luôn có" dòng đánh dấu (vd khôi phục nhầm tới cuối WAL) ⇒ ĐỎ.
  const mu = dung(['STUB_LUON_CO=1 cmd_drill "$(date -u -d "@$((NOW - 600))" +%FT%TZ)" > /dev/null 2>&1; rc=$?; echo "@@EXIT"; echo $rc']);
  assert.equal(phan(mu.ra, "EXIT"), "1", "khôi phục tới TRƯỚC dòng đánh dấu mà vẫn thấy nó ⇒ mốc SAI ⇒ thất bại");
  assert.match(phan(mu.ra, "DRILL"), /"result":"FAILED".*mốc khôi phục KHÔNG đúng/);

  // WAL chưa phủ tới mốc ⇒ thất bại có lý do, vẫn dọn.
  const thieu = dung(['STUB_PHUC_HOI=het cmd_drill > /dev/null 2>&1; rc=$?; echo "@@EXIT"; echo $rc']);
  assert.equal(phan(thieu.ra, "EXIT"), "1");
  assert.match(phan(thieu.ra, "DRILL"), /"result":"FAILED".*kho WAL chưa phủ tới mốc/, "lý do: WAL chưa phủ tới mốc");
  assert.equal(phan(thieu.ra, "TMP"), "0", "hỏng giữa chừng vẫn dọn thư mục tạm");

  // Không có dòng đánh dấu ⇒ PARTIAL (phục hồi được, CHƯA chứng minh đúng mốc) — không phải OK.
  const khong = dung(['rm -f "$T/backups/status/pitr-marker.json"; cmd_drill > /dev/null 2>&1; rc=$?; echo "@@EXIT"; echo $rc']);
  assert.equal(phan(khong.ra, "EXIT"), "1");
  assert.match(phan(khong.ra, "DRILL"), /"result":"PARTIAL".*Chưa có dòng đánh dấu/);
  assert.equal((phan(khong.ra, "DOCKER").match(/^docker run /gm) ?? []).length, 1, "không có dòng đánh dấu ⇒ một pha");

  // Mốc trước bản nền ⇒ từ chối trước khi dựng gì. Thiếu RAM ⇒ SKIPPED, không dựng gì.
  const som = dung(['cmd_drill "$(date -u -d "@$((B - 60))" +%FT%TZ)" > /dev/null 2>&1; rc=$?; echo "@@EXIT"; echo $rc']);
  assert.equal(phan(som.ra, "EXIT"), "1");
  assert.match(phan(som.ra, "DRILL"), /"result":"FAILED".*không sau lúc bản nền/);
  assert.ok(!/^docker run /m.test(phan(som.ra, "DOCKER")), "mốc sai ⇒ không dựng container nào");
  const ram = dung(['STUB_RAM=300 cmd_drill > /dev/null 2>&1; rc=$?; echo "@@EXIT"; echo $rc']);
  assert.match(phan(ram.ra, "DRILL"), /"result":"SKIPPED".*RAM/);
  assert.ok(!/^docker run /m.test(phan(ram.ra, "DOCKER")), "thiếu RAM ⇒ không dựng container nào");

  console.log("✓ PITR diễn tập (chạy thật, docker giả): hai pha trên cùng dữ liệu — (đánh dấu − 1s) VẮNG, mốc yêu cầu CÓ ⇒ OK · docker giả 'luôn có' ⇒ FAILED (phép so không mù) · WAL chưa phủ ⇒ FAILED có lý do · không đánh dấu ⇒ PARTIAL · mốc trước bản nền / thiếu RAM ⇒ không dựng gì · 0 lời gọi tới erp-db · luôn dọn");
}

/* ═════════════ 6 · TRẠNG THÁI, ĐÁNH DẤU, ĐẨY WAL, PHANH, LỊCH ═════════════ */

export function testPitrPhanXu() {
  const r = chayBash(
    khung([
      "N=1790000000",
      'xet() { X_MODE=on X_LEVEL=replica X_PHANH=THUONG X_TAM_DUNG=0 X_LAST_ARCH=$((N - 300)) X_LAST_FAIL="" X_NOW=$N X_READY=0 X_BASE_EPOCH=$((N - 3600)) X_LO_HONG=0 X_BAN_LUU_WAL=KHOP X_OFF_STATE=OK X_OFF_EPOCH=$((N - 600)); eval "$1"; phan_xu_pitr; echo "$PITR_KET_LUAN|$(printf "%s" "$PITR_LY_DO" | head -n 1)"; }',
      'echo "@@X"',
      'xet ":"',
      'xet "X_MODE=off"',
      'xet "X_PHANH=PHANH"',
      'xet "X_TAM_DUNG=1"',
      'xet "X_LAST_ARCH=\\$((N - 3000))"',
      'xet "X_LAST_FAIL=\\$((N - 10))"',
      'xet "X_LAST_FAIL=\\$((N - 900))"',
      'xet "X_LAST_ARCH="',
      'xet "X_BASE_EPOCH="',
      'xet "X_BASE_EPOCH=\\$((N - 40 * 3600))"',
      'xet "X_LO_HONG=2"',
      'xet "X_OFF_STATE=NOT_CONFIGURED"',
      'xet "X_OFF_EPOCH=\\$((N - 3600))"',
      'xet "X_READY=9"',
      'xet "X_BAN_LUU_WAL=KHAC"',
    ]),
  );
  const x = phan(r.ra, "X").split("\n");
  const ky = [
    ["OK", ""],
    ["DO", "archive_mode = 'off'"],
    ["DO", "phanh khẩn"],
    ["DO", "cờ tạm dừng"],
    ["DO", "đoạn WAL gần nhất lưu cách đây 50 phút"],
    ["DO", "THẤT BẠI"],
    ["OK", ""],
    ["DO", "chưa lưu được đoạn WAL nào"],
    ["DO", "chưa có bản nền"],
    ["VANG", "bản nền mới nhất đã 40 giờ"],
    ["DO", "chuỗi WAL ĐỨT"],
    ["VANG", "CHƯA CÓ BẢN SAO NGOÀI MÁY"],
    ["VANG", "quá 45 phút"],
    ["VANG", "9 đoạn WAL đang chờ lưu"],
    ["VANG", "khác bản trong kho"],
  ];
  assert.equal(x.length, ky.length, `đọc hụt kết quả:\n${r.ra}`);
  ky.forEach(([kl, cau], i) => {
    assert.ok(x[i].startsWith(`${kl}|`), `tình huống ${i}: kỳ vọng ${kl}, thấy ${x[i]}`);
    assert.ok(x[i].includes(cau), `tình huống ${i}: lý do phải nói «${cau}», thấy ${x[i]}`);
  });
  console.log(`✓ PITR phán xử (hàm thuần): ${ky.length} tình huống — chưa bật / phanh / tạm dừng / RPO > 2 chu kỳ / đang lỗi / chưa lưu gì / chưa bản nền / chuỗi đứt ⇒ ĐỎ · bản nền cũ / ngoài máy thiếu-cũ / dồn chờ lưu / kịch bản lệch ⇒ VÀNG · lỗi cũ đã tự lành ⇒ OK`);
}

export function testPitrTrangThaiDanhDauDayWal() {
  const r = chayBash(
    khung([
      'mkdir -p "$PITR_HOST/wal" "$PITR_HOST/base/base-20260930-0227" "$T/backups/status"',
      "N=$(date +%s)",
      'printf "%s\\n" 000000010000000000000020 > "$PITR_HOST/base/base-20260930-0227/bat-dau-wal"',
      `printf '{"finishedAt":"%s","bytes":5242880}' "$(date -u -d "@$((N - 7200))" +%FT%TZ)" > "$PITR_HOST/base/base-20260930-0227/nen.json"`,
      'echo x > "$PITR_HOST/wal/000000010000000000000021.gz"',
      `printf '{"state":"OK","lastOkAt":"%s"}' "$(date -u -d "@$((N - 300))" +%FT%TZ)" > "$T/backups/status/pitr-offsite.json"`,
      'export STUB_ARCHIVER="replica|on|900|THUONG|12|000000010000000000000021|$((N - 240))|0||$N|0|48"',
      'cmd_pitr_status > "$T/o1" 2>&1; rc=$?; echo "@@S1"; echo $rc; grep -c "^\\[ops:tom-tat\\]" "$T/o1"; grep "KẾT LUẬN" "$T/o1"; grep "RPO" "$T/o1"',
      'cmd_pause > /dev/null; cmd_pitr_status > "$T/o2" 2>&1; rc=$?; echo "@@S2"; echo $rc; grep "KẾT LUẬN" "$T/o2"',
      'cmd_resume > /dev/null; echo "@@RESUME"; [ -e "$PITR_HOST/wal/.tam-dung" ] && echo con || echo het',
      // Dòng đánh dấu: một insert, trạng thái trên máy chủ mang nonce + mốc commit.
      'STUB_MARK_AT=2026-09-30T13:15:00.482913Z cmd_mark > "$T/o3" 2>&1; rc=$?; echo "@@MARK"; echo $rc; cat "$T/backups/status/pitr-marker.json"; grep -c "insert into settings" "$DOCKER_LOG"',
      'rm -f "$T/backups/status/pitr-marker.json"; STUB_MARK_AT=rac cmd_mark > /dev/null 2>&1; rc=$?; echo "@@MARKHONG"; echo $rc; [ -e "$T/backups/status/pitr-marker.json" ] && echo co || echo khong',
      // Đẩy WAL: chưa khai ⇒ NOT_CONFIGURED; có ⇒ chép (bỏ tệp chấm); lỗi ⇒ FAILED, bản cục bộ còn.
      'cmd_push_wal; rc=$?; echo "@@P0"; echo $rc; grep -o \'"state":"[A-Z_]*"\' "$T/backups/status/pitr-offsite.json"',
      "export BACKUP_OFFSITE_REMOTE=gia:",
      ': > "$PITR_HOST/wal/.lo-hong.log"; cmd_push_wal; rc=$?; echo "@@P1"; echo $rc; grep -o \'"state":"[A-Z_]*"\' "$T/backups/status/pitr-offsite.json"; ls -A "$T/remote/pitr/wal"',
      'STUB_RCLONE_LOI=1 cmd_push_wal 2>/dev/null; rc=$?; echo "@@P2"; echo $rc; grep -o \'"state":"[A-Z_]*"\' "$T/backups/status/pitr-offsite.json"; ls "$PITR_HOST/wal"',
      // Lịch: tệp RIÊNG, idempotent, không `%`.
      'cmd_pitr_install_cron > /dev/null; cp "$ERP_PITR_CRON_FILE" "$T/c1"; cmd_pitr_install_cron > /dev/null; echo "@@CRON"; cmp -s "$T/c1" "$ERP_PITR_CRON_FILE" && echo giong; grep -v "^#" "$ERP_PITR_CRON_FILE" | grep erp-pitr',
    ]),
  );
  const s1 = phan(r.ra, "S1").split("\n");
  assert.equal(s1[0], "0", `trạng thái khoẻ ⇒ thoát 0:\n${r.ra}`);
  assert.ok(Number(s1[1]) >= 8, "mọi dòng người vận hành cần đều đi qua kênh [ops:tom-tat]");
  assert.match(s1[2], /KẾT LUẬN PITR: OK/);
  assert.match(s1[3], /RPO hiện tại \(trên máy\) = now − last_archived_time = 4 phút 0 giây/, "RPO = now − last_archived_time");
  const s2 = phan(r.ra, "S2").split("\n");
  assert.equal(s2[0], "1", "đang tạm dừng ⇒ ĐỎ, thoát 1");
  assert.match(s2[1], /KẾT LUẬN PITR: DO/);
  assert.equal(phan(r.ra, "RESUME"), "het", "resume gỡ cờ tạm dừng");
  const mark = phan(r.ra, "MARK").split("\n");
  assert.equal(mark[0], "0");
  assert.match(mark[1], /^\{"schema":1,"kind":"pitr-marker","key":"platform\.pitr\.marker","nonce":"[0-9a-f]{16}","at":"2026-09-30T13:15:00\.482913Z"\}$/, "tệp đánh dấu mang khoá, nonce 16 hex, mốc commit");
  assert.equal(mark[2], "1", "ĐÚNG MỘT lệnh ghi settings");
  assert.deepEqual(phan(r.ra, "MARKHONG").split("\n"), ["1", "khong"], "psql không trả mốc ⇒ thất bại, KHÔNG lưu tệp đánh dấu (diễn tập không được tin một dòng chưa xác nhận)");
  assert.deepEqual(phan(r.ra, "P0").split("\n"), ["0", '"state":"NOT_CONFIGURED"']);
  const p1 = phan(r.ra, "P1").split("\n");
  assert.deepEqual(p1.slice(0, 2), ["0", '"state":"OK"']);
  assert.ok(p1.includes("000000010000000000000021.gz") && !p1.includes(".lo-hong.log"), "đẩy đoạn WAL, không đẩy tệp chấm");
  const p2 = phan(r.ra, "P2").split("\n");
  assert.deepEqual(p2.slice(0, 2), ["1", '"state":"FAILED"'], "lỗi đẩy ⇒ FAILED, thoát 1");
  assert.ok(p2.includes("000000010000000000000021.gz"), "lỗi đẩy KHÔNG đụng bản cục bộ");
  const cron = phan(r.ra, "CRON").split("\n");
  assert.equal(cron[0], "giong", "install-cron chạy lại không đổi tệp");
  assert.match(cron[1], new RegExp(`^${soHang(SCRIPT, "PITR_PHUT_CRON_NEN")} \\* \\* \\* \\* root .*erp-pitr\\.sh base-cron >> `));
  assert.match(cron[2], new RegExp(`^${hangSo(SCRIPT, "PITR_PHUT_DAY_WAL")} \\* \\* \\* \\* root .*erp-pitr\\.sh push-wal >> `));
  assert.ok(!phan(r.ra, "CRON").includes("%"), "`%` là ký tự đặc biệt của crontab");
  assert.equal(hangSo(SCRIPT, "TEP_CRON_PITR"), "${ERP_PITR_CRON_FILE:-/etc/cron.d/erp-pitr}", "lịch PITR ở tệp cron RIÊNG — /etc/cron.d/erp-backup không đổi");
  console.log("✓ PITR trạng thái / đánh dấu / đẩy WAL / phanh / lịch (chạy thật): RPO = now − last_archived_time qua kênh tóm tắt · tạm dừng ⇒ ĐỎ · một insert settings, mốc commit xác nhận mới lưu tệp · đẩy WAL: chưa khai / OK / lỗi không đụng bản cục bộ · cron riêng, idempotent");
}

/* ═════════════ 7 · OPS ═════════════ */

export function testPitrOps() {
  const ops = doc(".github/workflows/ops-vps.yml");
  const opts = ops.slice(ops.indexOf("        options:\n"), ops.indexOf("      days:"));
  const lop = (ten: string) => (new RegExp(`^ +${ten}="([^"]*)"`, "m").exec(ops)?.[1] ?? "").split(/\s+/);
  const maHoa = (/^ {2}OPS_THAO_TAC_MA_HOA: "([^"]+)"$/m.exec(ops)?.[1] ?? "").split(/\s+/);
  const ky: Record<string, { lan: string; goi: RegExp }> = {
    "pitr-status": { lan: "DOC_NHE", goi: /ma_hoa_ket_qua env ERP_DIR=\/root\/erp bash "\$SP" status\s*$/ },
    "pitr-basebackup": { lan: "DOC_NANG", goi: /ma_hoa_ket_qua env ERP_DIR=\/root\/erp bash "\$SP" base --trigger=ops\s*$/ },
    "pitr-mark": { lan: "GHI", goi: /ma_hoa_ket_qua env ERP_DIR=\/root\/erp bash "\$SP" mark\s*$/ },
    "pitr-drill": { lan: "DOC_NANG", goi: /ma_hoa_ket_qua env ERP_DIR=\/root\/erp bash "\$SP" drill "\$ARG"\s*$/ },
    "pitr-pause": { lan: "GHI", goi: /ma_hoa_ket_qua env ERP_DIR=\/root\/erp bash "\$SP" "\$LENH_PITR"\s*$/ },
  };
  for (const [a, { lan, goi }] of Object.entries(ky)) {
    assert.match(opts, new RegExp(`^ {10}- ${a} `, "m"), `ops phải có thao tác ${a}`);
    assert.ok(maHoa.includes(a), `${a} phải nằm trong OPS_THAO_TAC_MA_HOA — chỉ con số ra log qua kênh tóm tắt`);
    const trongLan = ["DOC_NHE", "DOC_PROBE", "DOC_NANG"].filter((l) => lop(l).includes(a));
    assert.deepEqual(trongLan, lan === "GHI" ? [] : [lan], `${a} phải ở làn ${lan}`);
    const i = ops.indexOf(`\n              ${a})\n`);
    assert.ok(i > 0, `không tìm thấy nhánh ${a}`);
    const than = ops.slice(i, i + 1 + ops.slice(i + 1).search(/\n {14}[a-z0-9-]+\)\n/));
    assert.match(than.trimEnd().replace(/\s*;;$/, ""), goi, `${a} phải gọi CHUNG scripts/erp-pitr.sh qua ma_hoa_ket_qua`);
    assert.match(than, /SP=\/root\/erp\/scripts\/erp-pitr\.sh\n/, `${a} chạy ĐÚNG bản đã deploy`);
  }
  // pitr-drill soát ô arg bằng danh sách ký tự CHO PHÉP trước khi dùng.
  const iDrill = ops.indexOf("\n              pitr-drill)\n");
  assert.match(ops.slice(iDrill, iDrill + 900), /case "\$ARG" in\s*\n\s*\*\[!0-9TZ:\+-\]\*\)/, "pitr-drill: ô arg chỉ nhận ký tự của mốc ISO");
  assert.ok(!/pg_dump|pg_basebackup/.test(boChuThichShell(ops)), "ops-vps.yml không tự viết pg_dump / pg_basebackup — một luật, một chỗ");
  assert.match(doc(SCRIPT), /^tt\(\) \{ printf '\[ops:tom-tat\] %s\\n' "\$\*"; \}$/m, "erp-pitr.sh in tóm tắt bằng đúng tiền tố kênh tóm tắt");
  console.log("✓ PITR ops: 5 thao tác trong OPS_THAO_TAC_MA_HOA · pitr-status DOC_NHE · pitr-basebackup / pitr-drill DOC_NANG (8 → 9 như backup) · pitr-mark / pitr-pause GHI · cùng gọi scripts/erp-pitr.sh đã deploy qua ma_hoa_ket_qua · arg của drill soát ký tự");
}

export function testPitr() {
  testPitrCauHinh();
  testPitrLuuWal();
  testPitrXoayVong();
  testPitrBanNen();
  testPitrDienTapMaNguon();
  testPitrDienTap();
  testPitrPhanXu();
  testPitrTrangThaiDanhDauDayWal();
  testPitrOps();
}
