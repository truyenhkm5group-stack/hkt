import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BACKUP_DRILL_MAX_AGE_DAYS,
  BACKUP_MAX_AGE_HOURS,
  BACKUP_STATUS_DIR_DEFAULT,
  ORG_BACKUP_DATABASE_PATTERN,
  ORG_BACKUP_RPO_ALERT_HOURS,
  UNPARSABLE,
  evaluateBackupHealth,
  formatBackupSize,
  parseBackupDrill,
  parseBackupRun,
  parseOrgBackupSummary,
  type BackupTarget,
} from "@/lib/constants/backup";
import { backupTargetFor, readBackupStatusFiles } from "@/lib/queries/backup-status";

/**
 * ═══════════ SAO LƯU TỰ ĐỘNG — BÀI KIỂM CHẠY SHELL THẬT, KHÔNG MÔ PHỎNG BẰNG LỜI ═══════════
 *
 * Hiện trạng trước bản này (24/09/2026): KHÔNG có sao lưu tự động, chỉ một ops `backup` bấm tay
 * ghi ngay trên chính VPS; không bản ngoài máy, không xoay vòng, chưa từng thử khôi phục; ổ đĩa
 * từng đầy 100%. Và `install-vps.sh` bỏ qua Variable rỗng, nên XOÁ Variable `ADS_WRITE_ENABLED`
 * không tắt được đường ghi quảng cáo.
 *
 * `tsc`/`eslint` không đọc shell, `bash -n` chỉ đọc cú pháp. Mỗi hàng rào dưới đây được CHẠY:
 * trích / nạp đúng mã sẽ chạy trên máy chủ, cho nó một `docker`/`df`/`rclone` giả qua PATH, rồi đọc
 * lại thứ nó ghi. Kỳ vọng dựng TỪ CHÍNH HẰNG SỐ của script (AGENTS.md mục 65), không gõ lại số.
 *
 * Đăng ký trong tests/sync-fixtures.test.ts (`testSaoLuu`).
 */

const SCRIPT = "scripts/erp-backup.sh";
const src = () => readFileSync(SCRIPT, "utf8");
/** Đường dẫn bash hiểu được trên cả Windows (Git Bash) lẫn Linux. */
const bashPath = (p: string) => path.resolve(p).split(path.sep).join("/");

function hangSo(ten: string): number {
  const m = new RegExp(`^${ten}=(\\d+)`, "m").exec(src());
  assert.ok(m, `scripts/erp-backup.sh phải khai hằng số ${ten}`);
  return Number(m[1]);
}

/** Bỏ dòng chú thích shell: một đoạn GIẢI THÍCH về lệnh cấm không phải là lệnh cấm. */
const boChuThichShell = (s: string) => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

type Ra = { ma: number; ra: string };
/**
 * Chạy một kịch bản bash (ghi vào tệp tạm của Node), trả mã thoát + toàn bộ đầu ra. `env` đi qua
 * MÔI TRƯỜNG của tiến trình, không qua chữ của kịch bản — giá trị có `"`, `'`, `$`, `\`, `` ` `` tới
 * bash nguyên vẹn đúng như Actions truyền một Secret xuống, không qua một lớp trích dẫn nào của bài kiểm.
 */
function chayBash(noiDung: string, env?: Record<string, string>): Ra {
  const tmp = mkdtempSync(path.join(tmpdir(), "backup-kiem-"));
  const kich = path.join(tmp, "run.sh");
  writeFileSync(kich, noiDung);
  try {
    const ra = execFileSync("bash", [kich], { stdio: "pipe", encoding: "utf8", maxBuffer: 1 << 24, env: env ? { ...process.env, ...env } : process.env });
    return { ma: 0, ra };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { ma: err.status ?? 1, ra: String(err.stdout ?? "") + String(err.stderr ?? "") };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Lấy phần giữa hai mốc `@@TEN` trong đầu ra của kịch bản. */
function phan(ra: string, ten: string): string {
  const dong = ra.split("\n");
  const i = dong.indexOf(`@@${ten}`);
  if (i < 0) return "";
  const ket = dong.findIndex((d, k) => k > i && d.startsWith("@@"));
  return dong.slice(i + 1, ket < 0 ? undefined : ket).join("\n").trim();
}

/**
 * Khung chạy `cmd_run` với công cụ GIẢ trên PATH. Thư mục tạm dựng BẰNG `mktemp` của bash để mọi
 * đường dẫn là POSIX — `tar` của Git Bash hiểu `C:/…` là máy chủ từ xa tên "C".
 *
 * Hai hàm khoá được THAY bằng hàm rỗng, và nói thẳng ra: bài này đo luật ổ đĩa / toàn vẹn / xoay
 * vòng / ngoài máy, còn khoá được đo riêng bằng `flock` THẬT ở `testKhoaSaoLuuChayThat`.
 */
function khungChay(opts: { dfAvail: number; dump?: "ok" | "fail"; list?: "ok" | "thieu"; offsite?: "none" | "ok" | "sai-kich-thuoc"; truoc?: string }): string {
  return [
    "#!/usr/bin/env bash",
    "set -uo pipefail",
    'T="$(mktemp -d)"',
    'mkdir -p "$T/bin" "$T/erp" "$T/bot" "$T/remote"',
    'echo "khoa-bot-gia" > "$T/bot/bot.env"',
    "cat > \"$T/bin/docker\" <<'EOF'",
    "#!/usr/bin/env bash",
    'echo "$*" >> "$DOCKER_LOG"',
    'case "$1" in',
    "  inspect)",
    '    case "$*" in',
    "      *State.Running*) echo true ;;",
    "      *Destination*) echo erp_chatbot_data ;;",
    "      *Config.Image*) echo postgres:16-alpine ;;",
    "    esac ;;",
    "  exec)",
    '    case "$*" in',
    '      *pg_dump*) [ "$STUB_DUMP" = ok ] || { echo "pg_dump: loi gia" >&2; exit 1; }; printf "PGDMP-ban-gia-%0300d" 7 ;;',
    '      *"pg_restore --list"*) cat > /dev/null; printf "; mục lục giả\\n1; 0 0 TABLE DATA public users erp\\n2; 0 0 TABLE DATA public shipments erp\\n"; [ "$STUB_LIST" = thieu ] || printf "3; 0 0 TABLE DATA public orders erp\\n" ;;',
    "    esac ;;",
    '  run) cd "$BOT_DATA" && tar --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - . | gzip -n ;;',
    "esac",
    "EOF",
    "cat > \"$T/bin/df\" <<'EOF'",
    "#!/usr/bin/env bash",
    'echo "Filesystem 1048576-blocks Used Available Capacity Mounted"',
    'echo "/dev/gia 40000 1 $STUB_DF_AVAIL 1% /"',
    "EOF",
    "cat > \"$T/bin/rclone\" <<'EOF'",
    "#!/usr/bin/env bash",
    'echo "rclone $*" >> "$DOCKER_LOG"',
    'dich() { printf "%s" "$REMOTE_DIR/${1#gia:}"; }',
    'case "$1" in',
    '  copyto) shift; while [ "${1#--}" != "$1" ]; do shift; [ "$1" = 3 ] && shift; done; mkdir -p "$(dirname "$(dich "$2")")"; cp "$1" "$(dich "$2")" ;;',
    '  lsf) f="$(dich "${!#}")"; [ -f "$f" ] || exit 1; n=$(stat -c %s "$f"); [ "$STUB_RCLONE_SAI" = 1 ] && n=$((n + 1)); echo "$n" ;;',
    "  delete) : ;;",
    "esac",
    "EOF",
    'chmod +x "$T/bin/docker" "$T/bin/df" "$T/bin/rclone"',
    'export PATH="$T/bin:$PATH" DOCKER_LOG="$T/docker.log" BOT_DATA="$T/bot" REMOTE_DIR="$T/remote"',
    `export STUB_DF_AVAIL=${opts.dfAvail} STUB_DUMP=${opts.dump ?? "ok"} STUB_LIST=${opts.list ?? "ok"} STUB_RCLONE_SAI=${opts.offsite === "sai-kich-thuoc" ? 1 : 0}`,
    'export ERP_BACKUP_DIR="$T/backups" ERP_DIR="$T/erp" ERP_LOCK_DIR="$T/locks"',
    "unset BACKUP_OFFSITE_REMOTE",
    opts.offsite && opts.offsite !== "none" ? "export BACKUP_OFFSITE_REMOTE=gia:" : "",
    ': > "$DOCKER_LOG"',
    `source "${bashPath(SCRIPT)}"`,
    "set +e",
    "khoa_chong_chong() { return 0; }   # khoá: đo riêng bằng flock THẬT",
    "giu_khoa() { return 0; }",
    opts.truoc ?? "",
    '( set -e; TRIGGER=cron; cmd_run ) > "$T/out" 2>&1; rc=$?', // set -e: ĐÚNG cờ của script khi chạy thật
    'echo "@@EXIT"; echo "$rc"',
    'echo "@@OUT"; cat "$T/out"',
    'echo "@@RUN"; cat "$T/backups/status/last-run.json" 2>/dev/null',
    'echo "@@SUCCESS"; cat "$T/backups/status/last-success.json" 2>/dev/null',
    'echo "@@DAILY"; ls -1A "$T/backups/daily" 2>/dev/null',
    'echo "@@DOCKER"; cat "$DOCKER_LOG"',
    'echo "@@REMOTE"; ls -1 "$T/remote/daily" 2>/dev/null',
    'echo "@@HET"',
    'rm -rf "$T"',
    "",
  ].join("\n");
}

/* ═════════════ 1 · LỊCH ĐƯỢC CÀI — Ở MỌI LẦN DEPLOY, IDEMPOTENT ═════════════ */

export function testLichSaoLuuDuocCai() {
  const install = readFileSync("scripts/install-vps.sh", "utf8");
  const code = boChuThichShell(install);
  assert.match(code, /^bash scripts\/erp-backup\.sh install-cron /m, "install-vps.sh phải cài lịch sao lưu ở MỌI lần deploy");
  const iCai = code.indexOf("bash scripts/erp-backup.sh install-cron");
  const iAnh = code.indexOf('if [ -n "${ERP_IMAGE:-}" ]; then\n  say "Kéo image');
  assert.ok(iAnh > 0 && iCai > code.indexOf("\nfi\n", iAnh), "lịch phải cài SAU khối khởi chạy, ở CẢ HAI đường (kéo image từ CI lẫn dựng trên máy) — không nằm trong một nhánh");
  // Dòng lệnh THẬT (không phải dòng gợi ý trong khối INFO in ra màn hình, nơi `run` đi kèm chú thích).
  assert.ok(
    !/^\s*bash scripts\/erp-backup\.sh (run|cron)\s*(\|\||&&|;|$)/m.test(code),
    "deploy KHÔNG được chạy một lượt sao lưu: nó đang cầm khoá vòng đời ĐỘC QUYỀN, sao lưu cần FD 8 trước FD 9",
  );

  const phutCron = hangSo("PHUT_CRON");
  const r = chayBash(
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      'T="$(mktemp -d)"; mkdir -p "$T/bin" "$T/erp" "$T/logrotate"',
      // `cron` và `systemctl` giả: bài này không cài gói hệ thống lên máy chạy kiểm thử.
      'printf "#!/usr/bin/env bash\\nexit 0\\n" > "$T/bin/cron"; cp "$T/bin/cron" "$T/bin/systemctl"; chmod +x "$T/bin/cron" "$T/bin/systemctl"',
      'export PATH="$T/bin:$PATH" ERP_DIR="$T/erp" ERP_BACKUP_DIR="$T/backups" ERP_CRON_FILE="$T/cron.d/erp-backup" ERP_LOGROTATE_FILE="$T/logrotate/erp-backup" ERP_BACKUP_LOG="$T/erp-backup.log"',
      "unset BACKUP_OFFSITE_REMOTE",
      `bash "${bashPath(SCRIPT)}" install-cron; rc=$?; echo "@@EXIT1"; echo $rc`,
      'echo "@@CRON"; cat "$T/cron.d/erp-backup"',
      'cp "$T/cron.d/erp-backup" "$T/truoc"',
      `bash "${bashPath(SCRIPT)}" install-cron; rc=$?; echo "@@EXIT2"; echo $rc`,
      'echo "@@GIONG"; cmp -s "$T/truoc" "$T/cron.d/erp-backup" && echo giong || echo khac',
      'echo "@@QUYEN"; stat -c %a "$T/backups/daily" "$T/backups/status"',
      'echo "@@LOGROTATE"; cat "$T/logrotate/erp-backup"',
      'echo "@@HET"; rm -rf "$T"',
      "",
    ].join("\n"),
  );
  assert.equal(phan(r.ra, "EXIT1"), "0", `install-cron lần đầu phải thành công:\n${r.ra}`);
  assert.equal(phan(r.ra, "EXIT2"), "0", "install-cron chạy lại (mỗi lần deploy) phải thành công");
  assert.equal(phan(r.ra, "GIONG"), "giong", "chạy lại KHÔNG được đổi tệp cron — idempotent");
  const cron = phan(r.ra, "CRON");
  const dong = cron.split("\n").find((l) => /erp-backup\.sh cron/.test(l)) ?? "";
  assert.match(dong, new RegExp(`^${phutCron} \\* \\* \\* \\* root `), `cron phải gọi phút ${phutCron} MỖI GIỜ với quyền root (script tự lọc khung thấp điểm): "${dong}"`);
  assert.match(dong, /ERP_DIR=\S+ ERP_BACKUP_DIR=\S+ \/bin\/bash \S+\/scripts\/erp-backup\.sh cron >> \S+ 2>&1$/, "dòng cron phải ghim thư mục ERP, thư mục sao lưu, và ghi log");
  assert.match(cron, /^PATH=.*\/usr\/bin/m, "cron phải khai PATH — PATH mặc định của cron có thể không thấy docker");
  assert.ok(!cron.includes("%"), "`%` là ký tự đặc biệt của crontab — không được xuất hiện trong dòng lệnh");
  // Tệp trong /etc/cron.d có dấu chấm trong tên bị cron BỎ QUA im lặng.
  assert.ok(!path.basename("/etc/cron.d/erp-backup").includes("."), "tên tệp cron.d không được có dấu chấm");
  assert.match(src(), /TEP_CRON="\$\{ERP_CRON_FILE:-\/etc\/cron\.d\/erp-backup\}"/, "đường cài cron thật phải là /etc/cron.d/erp-backup");
  assert.match(src(), /chmod 700 "\$BACKUP_DIR\/daily" "\$BACKUP_DIR\/weekly" "\$BACKUP_DIR\/manual"/, "bản sao lưu chỉ root đọc");
  assert.match(src(), /chmod 755 "\$STATUS_DIR"/, "thư mục trạng thái mở đọc để ERP mount");
  if (process.platform === "linux") {
    assert.deepEqual(phan(r.ra, "QUYEN").split(/\s+/), ["700", "755"], "bản sao lưu chỉ root đọc (700); thư mục trạng thái mở đọc để ERP mount (755)");
  } else {
    // NTFS dưới Git Bash không giữ bit quyền POSIX — đo ở đây là đo cái máy, không đo mã nguồn.
    console.log(`⚠ Quyền 700/755 khi chạy thật: CHƯA ĐO ĐƯỢC trên ${process.platform} (NTFS không giữ bit POSIX); dòng chmod đã kiểm ở mức mã nguồn, chạy thật đo trên Linux/CI.`);
  }
  assert.match(phan(r.ra, "LOGROTATE"), /rotate \d+/, "log của cron phải có xoay vòng — cron gọi mỗi giờ");

  console.log(`✓ Lịch sao lưu: install-vps cài ở mọi lần deploy, sau khối khởi chạy · cron phút ${phutCron} mỗi giờ, root, có PATH · chạy lại không đổi tệp · chmod 700 (bản) / 755 (trạng thái)`);
}

/* ═════════════ 2 · XOAY VÒNG: HẰNG SỐ KHAI MỘT CHỖ, VÀ CHẠY THẬT ═════════════ */

export function testXoayVongMotChoKhai() {
  const s = src();
  const code = boChuThichShell(s);
  for (const ten of ["GIU_BAN_NGAY", "GIU_BAN_TUAN", "GIU_BAN_TAY"]) {
    const n = (code.match(new RegExp(`^${ten}=`, "gm")) ?? []).length;
    assert.equal(n, 1, `${ten} phải được khai ĐÚNG MỘT lần (đang ${n})`);
  }
  // Mọi lời gọi xoay vòng phải đọc hằng số, không gõ lại một con số.
  const goi = [...code.matchAll(/^\s*xoay_vong "[^"]+" "?\$?\w+"? (\S+)\s*$/gm)].map((m) => m[1]);
  assert.ok(goi.length >= 3, `phải tìm thấy lời gọi xoay vòng cho ba thư mục (thấy ${goi.length})`);
  for (const g of goi) assert.match(g, /^"\$GIU_BAN_(NGAY|TUAN|TAY)"$/, `lời gọi xoay vòng dùng "${g}" — phải là một hằng số GIU_BAN_*`);
  // Dọn bản ngoài máy cũng SUY từ cùng hằng số.
  for (const m of code.matchAll(/rclone delete .*--min-age "([^"]+)"/g)) {
    assert.match(m[1], /GIU_BAN_/, `dọn ngoài máy "--min-age ${m[1]}" phải suy từ GIU_BAN_*, không gõ lại số ngày`);
  }
  assert.ok(!/rclone sync/.test(code), "KHÔNG BAO GIỜ `rclone sync`: nó xoá bản ngoài máy khi bản trên máy mất — đúng thứ bản ngoài máy sinh ra để giữ");

  const ngay = hangSo("GIU_BAN_NGAY");
  const tuan = hangSo("GIU_BAN_TUAN");
  const tay = hangSo("GIU_BAN_TAY");
  const tao = (thuMuc: string, n: number) =>
    `for i in $(seq 1 ${n}); do d=$(printf '%02d' $i); touch "$T/backups/${thuMuc}/erp-202609$d-0217.dump" "$T/backups/${thuMuc}/chatbot-202609$d-0217.tar.gz"; done`;
  const r = chayBash(
    [
      "#!/usr/bin/env bash",
      'T="$(mktemp -d)"',
      'export ERP_BACKUP_DIR="$T/backups" ERP_DIR="$T/erp" ERP_LOCK_DIR="$T/locks"',
      `source "${bashPath(SCRIPT)}"`,
      "set +e",
      "chuan_bi_thu_muc",
      // Thư mục RỖNG: "không có gì để xoá" là trạng thái bình thường — dưới pipefail không được đổ.
      '( set -e; xoay_vong_tat_ca ) > /dev/null; rc=$?; echo "@@RONG"; echo $rc', // set -e: ĐÚNG cờ lúc chạy thật
      tao("daily", ngay + 3),
      tao("weekly", tuan + 2),
      tao("manual", tay + 4),
      'touch "$T/backups/daily/ghi-chu.txt" "$T/backups/erp-2026-09-01-0300.sql.gz"',
      '( set -e; xoay_vong_tat_ca ) > /dev/null; rc=$?; echo "@@EXIT"; echo $rc',
      'echo "@@DAILY"; ls -1 "$T/backups/daily"',
      'echo "@@WEEKLY"; ls -1 "$T/backups/weekly"',
      'echo "@@MANUAL"; ls -1 "$T/backups/manual"',
      'echo "@@GOC"; ls -1 "$T/backups"',
      'xoay_vong "$T/backups/daily" erp 0 > /dev/null 2>&1; rc=$?; echo "@@KHONG"; echo $rc; ls -1 "$T/backups/daily" | grep -c "^erp-"',
      'echo "@@HET"; rm -rf "$T"',
      "",
    ].join("\n"),
  );
  assert.equal(phan(r.ra, "RONG"), "0", `xoay vòng trên thư mục rỗng phải sống (bài học deploy #244):\n${r.ra}`);
  assert.equal(phan(r.ra, "EXIT"), "0", `xoay vòng phải chạy trót lọt:\n${r.ra}`);
  const ds = (ten: string) => phan(r.ra, ten).split("\n").filter(Boolean);
  const daily = ds("DAILY");
  const moiNhat = (n: number, tong: number) =>
    Array.from({ length: n }, (_, k) => String(tong - k).padStart(2, "0")).map((d) => `erp-202609${d}-0217.dump`).sort();
  assert.deepEqual(daily.filter((f) => f.startsWith("erp-")).sort(), moiNhat(ngay, ngay + 3), `daily/ phải giữ đúng ${ngay} bản CSDL MỚI NHẤT`);
  assert.equal(daily.filter((f) => f.startsWith("chatbot-")).length, ngay, `daily/ phải giữ đúng ${ngay} bản bot`);
  assert.ok(daily.includes("ghi-chu.txt"), "tệp không mang mẫu tên sao lưu KHÔNG được đụng tới");
  assert.equal(ds("WEEKLY").filter((f) => f.startsWith("erp-")).length, tuan, `weekly/ phải giữ đúng ${tuan} bản`);
  assert.equal(ds("MANUAL").filter((f) => f.startsWith("erp-")).length, tay, `manual/ phải giữ đúng ${tay} bản`);
  assert.ok(ds("GOC").includes("erp-2026-09-01-0300.sql.gz"), "bản tay KIỂU CŨ ở thư mục gốc KHÔNG được tự xoá — xoá dữ liệu cần chủ shop đồng ý");
  const [maKhong, conLai] = phan(r.ra, "KHONG").split("\n");
  assert.notEqual(maKhong, "0", "số bản giữ = 0 phải bị TỪ CHỐI");
  assert.equal(Number(conLai), ngay, "…và không xoá một tệp nào");

  console.log(`✓ Xoay vòng: ${ngay} ngày + ${tuan} tuần + ${tay} tay khai MỘT chỗ, mọi lời gọi đọc hằng số · chạy thật giữ đúng bản mới nhất · thư mục rỗng sống · không đụng tệp lạ / bản kiểu cũ · giữ 0 bị từ chối`);
}

/* ═════════════ 3 · KIỂM Ổ ĐĨA TRƯỚC KHI DUMP, KIỂM TOÀN VẸN SAU DUMP ═════════════ */

export function testKiemODiaVaToanVen() {
  const code = boChuThichShell(src());
  const iRun = code.indexOf("cmd_run() {");
  const than = code.slice(iRun, code.indexOf("\n}\n", iRun));
  const iDia = than.indexOf("kiem_o_dia ||");
  const iDump = than.indexOf("pg_dump");
  assert.ok(iDia > 0 && iDump > 0 && iDia < iDump, "cmd_run phải kiểm ổ đĩa TRƯỚC lệnh pg_dump");
  assert.match(code, /DU_TRU_O_DIA_MB=(\d+)/, "phải khai dự trữ ổ đĩa");
  const duTru = hangSo("DU_TRU_O_DIA_MB");
  const congDeploy = Number(/if \[ "\$\{DISK_MB:-0\}" -lt (\d+) \]/.exec(readFileSync("scripts/install-vps.sh", "utf8"))?.[1]);
  assert.equal(duTru, congDeploy, `dự trữ sau sao lưu (${duTru} MB) phải BẰNG cổng ổ đĩa của deploy (${congDeploy} MB) — sao lưu làm deploy kế tiếp chết ở cổng là tự khoá mình ngoài máy`);

  // ───────── THIẾU CHỖ ⇒ KHÔNG DUMP, trạng thái THẤT BẠI có lý do ─────────
  const thieu = chayBash(khungChay({ dfAvail: 1000 }));
  assert.equal(phan(thieu.ra, "EXIT"), "1", `thiếu ổ đĩa thì lượt sao lưu phải THẤT BẠI:\n${thieu.ra}`);
  assert.ok(!phan(thieu.ra, "DOCKER").includes("pg_dump"), "thiếu ổ đĩa thì KHÔNG được gọi pg_dump — làm đầy ổ là đúng sự cố #242");
  const runThieu = JSON.parse(phan(thieu.ra, "RUN")) as { result: string; reason: string; freeMbBefore: number; needMb: number };
  assert.equal(runThieu.result, "FAILED");
  assert.match(runThieu.reason, /KHÔNG dump/, "lý do phải nói rõ là đã KHÔNG dump");
  assert.equal(runThieu.freeMbBefore, 1000, "trạng thái phải ghi số MB còn trống");
  assert.ok(runThieu.needMb >= duTru, "và số MB cần — đủ để người đọc biết thiếu bao nhiêu");
  assert.equal(phan(thieu.ra, "SUCCESS"), "", "một lượt thất bại KHÔNG được ghi thành bản thành công");
  assert.equal(phan(thieu.ra, "DAILY"), "", "không để lại tệp nào");

  // ───────── MỤC LỤC THIẾU BẢNG orders ⇒ bản hỏng bị xoá, không tính là sao lưu ─────────
  const hong = chayBash(khungChay({ dfAvail: 999_999, list: "thieu" }));
  assert.equal(phan(hong.ra, "EXIT"), "1", "bản dump mà pg_restore --list không thấy dữ liệu orders thì phải THẤT BẠI");
  assert.equal(phan(hong.ra, "DAILY"), "", "bản hỏng phải bị XOÁ — một tệp nằm đó trông y như một bản sao lưu tốt");
  assert.match((JSON.parse(phan(hong.ra, "RUN")) as { reason: string }).reason, /orders/);

  // ───────── pg_dump lỗi ⇒ THẤT BẠI, không để lại tệp dở ─────────
  const loi = chayBash(khungChay({ dfAvail: 999_999, dump: "fail" }));
  assert.equal(phan(loi.ra, "EXIT"), "1");
  assert.equal(phan(loi.ra, "DAILY"), "", "pg_dump lỗi thì không được để lại tệp đang-ghi");
  assert.match((JSON.parse(phan(loi.ra, "RUN")) as { reason: string }).reason, /pg_dump lỗi: pg_dump: loi gia/, "lý do phải mang dòng lỗi thật của pg_dump");

  // ───────── ĐỦ CHỖ, CHƯA KHAI NGOÀI MÁY ⇒ có bản, nhưng nói thẳng CHƯA CÓ BẢN NGOÀI MÁY ─────────
  const tot = chayBash(khungChay({ dfAvail: 999_999 }));
  assert.equal(phan(tot.ra, "EXIT"), "0", `lượt sao lưu đủ điều kiện phải thành công:\n${tot.ra}`);
  const daily = phan(tot.ra, "DAILY").split("\n");
  assert.ok(daily.some((f) => /^erp-\d{8}-\d{4}\.dump$/.test(f)), "phải có bản CSDL -Fc trong daily/");
  assert.ok(daily.some((f) => /^chatbot-\d{8}-\d{4}\.tar\.gz$/.test(f)), "phải có bản dữ liệu bot chat");
  assert.ok(!daily.some((f) => f.startsWith(".")), "không còn tệp đang-ghi");
  assert.match(phan(tot.ra, "DOCKER"), /exec erp-db pg_dump -U erp -d erp -Fc/, "dump phải là định dạng -Fc (khôi phục chọn lọc được)");
  assert.match(phan(tot.ra, "DOCKER"), /exec -i erp-db pg_restore --list/, "phải đọc lại mục lục bằng pg_restore --list");
  assert.match(phan(tot.ra, "DOCKER"), /run --rm --network none -v erp_chatbot_data:\/data:ro /, "volume bot phải gắn CHỈ-ĐỌC vào container không mạng");
  const run = parseBackupRun(JSON.parse(phan(tot.ra, "RUN")));
  assert.ok(run, "tệp trạng thái script ghi phải đọc được bằng CHÍNH bộ đọc của ERP — hai phía một hình dạng");
  assert.equal(run.result, "OK");
  assert.equal(run.offsite.state, "NOT_CONFIGURED", "chưa khai BACKUP_OFFSITE_REMOTE ⇒ NOT_CONFIGURED, không giả vờ");
  assert.match(run.offsite.reason ?? "", /CHƯA CÓ BẢN SAO NGOÀI MÁY/);
  assert.equal(run.retention.daily, hangSo("GIU_BAN_NGAY"), "số bản giữ in lên ERP phải là lời khai của script, không phải số thứ hai");
  assert.ok((run.db.bytes ?? 0) > 0 && run.db.tableData === 3, "kích thước > 0 và số bảng có dữ liệu đọc từ mục lục");
  assert.match(phan(tot.ra, "OUT"), /CHƯA CÓ BẢN SAO NGOÀI MÁY/, "log của lượt chạy phải nói thẳng chưa có bản ngoài máy");

  // ───────── CÓ KHAI NGOÀI MÁY: đẩy xong phải ĐỌC LẠI kích thước ─────────
  const ngoai = chayBash(khungChay({ dfAvail: 999_999, offsite: "ok" }));
  assert.equal(phan(ngoai.ra, "EXIT"), "0", `đẩy ngoài máy trót lọt:\n${ngoai.ra}`);
  assert.equal(parseBackupRun(JSON.parse(phan(ngoai.ra, "RUN")))?.offsite.state, "OK");
  assert.equal(phan(ngoai.ra, "REMOTE").split("\n").filter(Boolean).length, 2, "đầu kia phải có đủ bản CSDL lẫn bản bot");
  const sai = chayBash(khungChay({ dfAvail: 999_999, offsite: "sai-kich-thuoc" }));
  const runSai = parseBackupRun(JSON.parse(phan(sai.ra, "RUN")));
  assert.equal(runSai?.offsite.state, "FAILED", "đầu kia báo sai kích thước ⇒ FAILED: 'lệnh thoát 0' chưa phải 'tệp nằm ở đó'");
  assert.equal(runSai?.result, "PARTIAL", "…và lượt ấy là MỘT PHẦN, không phải đạt");
  assert.notEqual(phan(sai.ra, "EXIT"), "0", "lượt một phần phải thoát khác 0 để ops đỏ");
  assert.ok(phan(sai.ra, "SUCCESS").length > 0, "bản CSDL vẫn dùng được ⇒ vẫn là bản thành công gần nhất");

  console.log(`✓ Kiểm ổ đĩa TRƯỚC pg_dump (thiếu ⇒ 0 lệnh dump, lý do có số MB) · dự trữ ${duTru} MB = cổng deploy · mục lục thiếu orders ⇒ xoá bản hỏng · ngoài máy: chưa khai nói thẳng, sai kích thước ⇒ FAILED`);
}

/* ═════════════ 4 · KHOÁ: flock THẬT — CHƯA ĐO ĐƯỢC ở nơi không có flock, ĐỎ trên Linux thiếu flock ═════════════ */

function coFlock(): boolean {
  try {
    execFileSync("flock", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function testKhoaSaoLuuChayThat() {
  // Phần đọc được ở mức mã nguồn — đo ở MỌI nền.
  const code = boChuThichShell(src());
  const iRun = code.indexOf("cmd_run() {");
  const than = code.slice(iRun, code.indexOf("\n}\n", iRun));
  const i7 = than.indexOf("khoa_chong_chong");
  const i8 = than.indexOf("giu_khoa 8");
  const i9 = than.indexOf("giu_khoa 9");
  assert.ok(i7 > 0 && i7 < i8 && i8 < i9, "thứ tự khoá phải là 7 (chống chồng) → 8 (đọc nặng) → 9 (vòng đời), đúng thứ tự 8 → 9 của ops-vps.yml");
  assert.match(than, /giu_khoa 8 "\$KHOA_DOC_DB" -x /, "khoá đọc nặng phải ĐỘC QUYỀN");
  assert.match(than, /giu_khoa 9 "\$KHOA_VONG_DOI" -s /, "khoá vòng đời phải CHIA SẺ — sao lưu không chặn các lượt đọc khác, chỉ chặn deploy");
  assert.match(code, /flock -n 7/, "chống chạy chồng phải KHÔNG CHỜ — FD 7 chờ được là mở đường cho một chu trình với ops");
  assert.match(code, /KHOA_DOC_DB="\$LOCK_DIR\/erp-readonly-db\.lock"/, "dùng CHUNG ổ khoá đọc nặng với ops-vps.yml");
  assert.match(code, /KHOA_VONG_DOI="\$LOCK_DIR\/erp-lifecycle\.lock"/, "dùng CHUNG ổ khoá vòng đời với ops-vps.yml và deploy");

  if (!coFlock()) {
    assert.notEqual(process.platform, "linux", "Linux PHẢI có flock — thiếu nó thì khoá sao lưu không được đo, và đó là lỗi hạ tầng CI chứ không phải chuyện bỏ qua được");
    console.log(`⚠ Khoá sao lưu (chạy thật): CHƯA ĐO ĐƯỢC trên ${process.platform} (không có flock). Phần mã nguồn ở trên đã đo; phần chạy thật đo đủ trên Linux/CI.`);
    return;
  }

  const r = chayBash(
    [
      "#!/usr/bin/env bash",
      'T="$(mktemp -d)"; mkdir -p "$T/that"; ln -s "$T/that" "$T/lienket"',
      // /var/lock trên Ubuntu là liên kết tới /run/lock: tiến trình cha mở qua đường THẬT, script
      // hỏi qua đường LIÊN KẾT — so chuỗi thô sẽ không nhận ra đó là cùng một khoá và tự chờ chính mình.
      'export ERP_BACKUP_DIR="$T/backups" ERP_DIR="$T/erp" ERP_LOCK_DIR="$T/lienket"',
      `S="${bashPath(SCRIPT)}"`,
      'exec 8>"$T/that/erp-readonly-db.lock"; flock -x 8',
      'exec 9>"$T/that/erp-lifecycle.lock"; flock -s 9',
      'echo "@@DUNGLAI"',
      // Script truyền qua $1, KHÔNG qua $0: `bash -c '…' "$S"` đặt $0 = đường dẫn script, trùng
      // BASH_SOURCE[0], nên chốt cuối tệp tưởng mình đang được GỌI, chạy `main` không tham số và thoát 2
      // trước khi tới giu_khoa — hai khối dưới in ra rỗng (chỉ lộ trên Linux, Windows không có flock).
      'timeout 20 bash -c \'source "$1"; set +e; giu_khoa 8 "$KHOA_DOC_DB" -x 2 >/dev/null && echo ok8; giu_khoa 9 "$KHOA_VONG_DOI" -s 2 >/dev/null && echo ok9\' _ "$S"',
      'exec 8>&- 9>&-',
      // Một tiến trình KHÁC cầm khoá đọc nặng ⇒ phải HẾT GIỜ, không lách qua.
      '( flock -x "$T/that/erp-readonly-db.lock" sleep 6 ) & sleep 1',
      'echo "@@HETGIO"',
      'timeout 20 bash -c \'source "$1"; set +e; giu_khoa 8 "$KHOA_DOC_DB" -x 1 >/dev/null; echo $?\' _ "$S"',
      // Lượt sao lưu thứ hai tới khi lượt đầu còn giữ FD 7 ⇒ thoát 75 NGAY, không ghi trạng thái.
      '( flock -x "$T/that/erp-backup.lock" sleep 6 ) & sleep 1',
      'echo "@@CHONG"',
      'timeout 20 bash "$S" run --trigger=ops > /dev/null 2>&1; echo $?; ls "$T/backups/status/last-run.json" 2>/dev/null || echo "khong-ghi"',
      "wait",
      'echo "@@HET"; rm -rf "$T"',
      "",
    ].join("\n"),
  );
  assert.deepEqual(phan(r.ra, "DUNGLAI").split("\n"), ["ok8", "ok9"], `khoá cha đang cầm (FD thừa kế, qua liên kết) phải được DÙNG LẠI ngay, không tự chờ chính mình:\n${r.ra}`);
  assert.equal(phan(r.ra, "HETGIO"), "1", "khoá do tiến trình KHÁC cầm thì phải hết giờ và trả 1");
  assert.deepEqual(phan(r.ra, "CHONG").split("\n"), ["75", "khong-ghi"], "lượt thứ hai phải thoát 75 NGAY và KHÔNG ghi đè trạng thái của lượt đang chạy");
  console.log("✓ Khoá sao lưu (flock thật): 7 → 8 → 9 · FD thừa kế dùng lại được kể cả qua liên kết /var/lock → /run/lock · khoá người khác ⇒ hết giờ · lượt chồng ⇒ thoát 75, không ghi trạng thái");
}

/* ═════════════ 5 · CÔNG TẮC GHI / CHI TIỀN: FAIL-CLOSED ═════════════ */

function khoiCongTac(): string {
  const s = readFileSync("scripts/install-vps.sh", "utf8");
  const iHam = s.indexOf("upsert_env() {");
  assert.ok(iHam > 0, "không tìm thấy upsert_env trong install-vps.sh");
  const ham = s.slice(iHam, s.indexOf("\n}\n", iHam) + 3);
  const i = s.indexOf("# ═══ CÔNG TẮC AN TOÀN");
  assert.ok(i > 0, "không tìm thấy khối CÔNG TẮC AN TOÀN trong install-vps.sh");
  const j = s.indexOf("# đọc lại các giá trị cần dùng bên dưới", i);
  assert.ok(j > i, "không tìm thấy mốc kết thúc khối công tắc");
  return `${ham}\n${s.slice(i, j)}`;
}

function chayCongTac(envBanDau: string, bien: Record<string, string>): { ma: number; env: string; ra: string } {
  const tmp = mkdtempSync(path.join(tmpdir(), "cong-tac-"));
  writeFileSync(path.join(tmp, ".env"), envBanDau);
  const r = chayBash(
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail", // ĐÚNG cờ của install-vps.sh
      `cd "${bashPath(tmp)}"`,
      'say() { echo "SAY $*"; }',
      'warn() { echo "WARN $*"; }',
      "unset ADS_WRITE_ENABLED ADS_WRITE_MODE CREATIVE_LOOP_EVERY_MINUTES MARKETING_LEDGER_EVERY_MINUTES",
      ...Object.entries(bien).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`),
      khoiCongTac(),
      "",
    ].join("\n"),
  );
  const env = readFileSync(path.join(tmp, ".env"), "utf8");
  rmSync(tmp, { recursive: true, force: true });
  return { ma: r.ma, env, ra: r.ra };
}

export function testCongTacGhiFailClosed() {
  const install = readFileSync("scripts/install-vps.sh", "utf8");
  const code = boChuThichShell(install);
  for (const ten of ["ADS_WRITE_ENABLED", "ADS_WRITE_MODE", "CREATIVE_LOOP_EVERY_MINUTES"]) {
    assert.ok(
      !new RegExp(`\\[ -n "\\$\\{${ten}:-\\}" \\] && upsert_env`).test(code),
      `${ten} không được đi luật "rỗng ⇒ giữ nguyên": xoá Variable phải TẮT được nó`,
    );
  }
  assert.ok(
    code.indexOf("CONG_TAC_AN_TOAN=") > code.indexOf('say "Đã ghi .env (chmod 600)"'),
    "khối công tắc phải chạy SAU cả hai nhánh .env — lần cài đầu cũng phải nhận Variable",
  );

  // Mọi Variable mở đường GHI / CHI TIỀN mà deploy truyền xuống phải nằm trong danh sách fail-closed.
  const deploy = readFileSync(".github/workflows/deploy-vps.yml", "utf8");
  const danhSach = /^CONG_TAC_AN_TOAN="([^"]+)"/m.exec(install)?.[1].split(/\s+/).map((c) => c.split("=")[0]) ?? [];
  const bienGhi = [...deploy.matchAll(/^\s+([A-Z0-9_]+): \$\{\{ vars\.\1 \}\}$/gm)].map((m) => m[1]).filter((k) => /WRITE|SPEND|LOOP|APPLY|BUDGET|VIDEO_SCALE/.test(k));
  assert.ok(bienGhi.length >= 3, `phải đọc được các Variable ghi/chi tiền từ deploy-vps.yml (thấy ${bienGhi.join(", ")})`);
  for (const k of bienGhi) assert.ok(danhSach.includes(k), `${k} mở đường ghi / chi tiền nhưng KHÔNG nằm trong CONG_TAC_AN_TOAN — xoá Variable sẽ không tắt được nó`);

  const ENV_DANG_BAT = 'PANCAKE_API_KEY="pk-dang-chay"\nADS_WRITE_ENABLED="true"\nADS_WRITE_MODE="COPILOT"\nCREATIVE_LOOP_EVERY_MINUTES="10"\nMARKETING_LEDGER_EVERY_MINUTES="30"\n';

  // ───────── VARIABLE BỊ XOÁ ⇒ TẮT (đúng lỗi đã sửa) ─────────
  const xoa = chayCongTac(ENV_DANG_BAT, {});
  assert.equal(xoa.ma, 0, `khối công tắc phải chạy trót lọt dưới set -euo pipefail:\n${xoa.ra}`);
  assert.match(xoa.env, /^ADS_WRITE_ENABLED="false"$/m, "xoá Variable ADS_WRITE_ENABLED ⇒ .env phải thành false");
  assert.match(xoa.env, /^ADS_WRITE_MODE="OFF"$/m, "xoá Variable ADS_WRITE_MODE ⇒ OFF");
  assert.match(xoa.env, /^CREATIVE_LOOP_EVERY_MINUTES="0"$/m, "xoá Variable CREATIVE_LOOP_EVERY_MINUTES ⇒ 0 (vòng chi tiền ra khỏi lịch)");
  assert.match(xoa.env, /^MARKETING_LEDGER_EVERY_MINUTES="30"$/m, "biến THƯỜNG (job chỉ đọc) giữ nguyên hành vi cũ: rỗng ⇒ không đụng");
  assert.match(xoa.env, /^PANCAKE_API_KEY="pk-dang-chay"$/m, "không đụng khoá của tích hợp khác");
  assert.match(xoa.ra, /WARN ADS_WRITE_ENABLED: Variable rỗng \/ đã xoá ⇒ TẮT \(true → false\)/, "tắt một thứ đang bật phải được NÓI RA trong log deploy");

  // ───────── VARIABLE CÓ GIÁ TRỊ ⇒ ghi đúng giá trị ─────────
  const bat = chayCongTac('ADS_WRITE_ENABLED="false"\n', { ADS_WRITE_ENABLED: "true", ADS_WRITE_MODE: "COPILOT", CREATIVE_LOOP_EVERY_MINUTES: "15" });
  assert.equal(bat.ma, 0);
  assert.match(bat.env, /^ADS_WRITE_ENABLED="true"$/m);
  assert.match(bat.env, /^ADS_WRITE_MODE="COPILOT"$/m);
  assert.match(bat.env, /^CREATIVE_LOOP_EVERY_MINUTES="15"$/m);
  assert.equal((bat.env.match(/^ADS_WRITE_ENABLED=/gm) ?? []).length, 1, "không nhân đôi dòng");

  // ───────── .env CHƯA CÓ KHOÁ (lần cài đầu) ⇒ khai tường minh trạng thái TẮT ─────────
  const moi = chayCongTac('ERP_DOMAIN="erp.vi-du.vn"\n', {});
  assert.equal(moi.ma, 0, `.env mới chưa có khoá: grep không khớp là BÌNH THƯỜNG, không được đổ script:\n${moi.ra}`);
  assert.match(moi.env, /^ADS_WRITE_ENABLED="false"$/m);
  assert.ok(!/WARN/.test(moi.ra), "không có gì đang bật thì không cảnh báo nhầm");

  console.log(`✓ Công tắc ghi/chi tiền FAIL-CLOSED: ${danhSach.join(", ")} — xoá Variable ⇒ false/OFF/0 và nói ra log · có giá trị ⇒ ghi đúng · biến thường giữ luật cũ · mọi Variable ghi/chi tiền của deploy đều được phân loại`);
}

/* ═════════════ 6 · OPS DÙNG CHUNG SCRIPT, ĐÚNG LÀN KHOÁ ═════════════ */

export function testOpsSaoLuu() {
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  const opts = ops.slice(ops.indexOf("        options:\n"), ops.indexOf("      days:"));
  for (const a of ["backup", "backup-status", "restore-drill"]) assert.match(opts, new RegExp(`^ {10}- ${a} `, "m"), `ops phải có thao tác ${a}`);
  const lop = (ten: string) => (new RegExp(`^ +${ten}="([^"]*)"`, "m").exec(ops)?.[1] ?? "").split(/\s+/);
  assert.ok(lop("DOC_NANG").includes("backup"), "backup: làn DOC_NANG — đọc nặng, một lượt tại một thời điểm, cùng cặp khoá 8 → 9 với cron");
  assert.ok(lop("DOC_NANG").includes("restore-drill"), "restore-drill: làn DOC_NANG — dựng một Postgres thứ hai trên máy 2 GB");
  assert.ok(lop("DOC_NHE").includes("backup-status"), "backup-status: làn DOC_NHE — chỉ đọc vài tệp nhỏ");
  const nhanh = (a: string) => {
    const i = ops.indexOf(`\n              ${a})\n`);
    assert.ok(i > 0, `không tìm thấy nhánh ${a}`);
    return ops.slice(i, ops.indexOf(";;", i));
  };
  assert.match(nhanh("backup"), /bash "\$SB" run --trigger=ops\s*$/, "ops backup phải gọi CHUNG scripts/erp-backup.sh");
  assert.match(nhanh("backup-status"), /bash "\$SB" status\s*$/);
  assert.match(nhanh("restore-drill"), /bash "\$SB" restore-drill\s*$/);
  assert.ok(!/pg_dump/.test(boChuThichShell(ops)), "ops-vps.yml không được còn một `pg_dump` tự viết — một luật sao lưu, một chỗ");

  // Diễn tập: container TẠM không mạng, trần RAM, cùng ảnh, và được dọn.
  const code = boChuThichShell(src());
  const iDt = code.indexOf("cmd_restore_drill() {");
  const dt = code.slice(iDt, code.indexOf("\n}\n", iDt));
  assert.match(dt, /--network none/, "container diễn tập KHÔNG có mạng");
  assert.ok(!/ -p |--publish/.test(dt), "container diễn tập KHÔNG mở cổng");
  assert.match(dt, /--memory "\$BO_NHO_DIEN_TAP" --memory-swap "\$BO_NHO_DIEN_TAP"/, "container diễn tập phải có trần bộ nhớ (VPS ~1,9 GB)");
  assert.match(dt, /trap don_dien_tap EXIT/, "container tạm phải bị xoá cả khi diễn tập thất bại giữa chừng");
  assert.match(dt, /RAM_TOI_THIEU_DIEN_TAP_MB/, "phải kiểm RAM trước khi dựng container");
  assert.ok(dt.indexOf("RAM_TOI_THIEU_DIEN_TAP_MB") < dt.indexOf("docker run"), "…TRƯỚC khi dựng");
  assert.ok(!/pg_restore[^\n]*-d erp[^\n]*"\$DB_CONTAINER"|"\$DB_CONTAINER" pg_restore/.test(dt), "diễn tập KHÔNG BAO GIỜ pg_restore vào CSDL sống");
  const bang = hangSoChuoi("BANG_DIEN_TAP");
  const schema = readFileSync("db/schema.ts", "utf8");
  for (const t of ["orders", "shipments", "shipment_events", "order_items", "expenses", "users"]) assert.ok(bang.includes(t), `diễn tập phải đếm bảng then chốt ${t}`);
  for (const t of bang) assert.ok(schema.includes(`"${t}"`), `bảng diễn tập ${t} không có trong db/schema.ts — đếm một bảng không tồn tại là in "THIẾU" cho mọi lượt`);

  console.log(`✓ Ops: backup / restore-drill ở làn DOC_NANG, backup-status ở DOC_NHE · cả ba gọi CHUNG erp-backup.sh · diễn tập không mạng, không cổng, trần RAM, luôn dọn · đếm ${bang.length} bảng đều có trong schema`);
}

function hangSoChuoi(ten: string): string[] {
  const m = new RegExp(`^${ten}="([^"]+)"`, "m").exec(src());
  assert.ok(m, `phải khai ${ten}`);
  return m[1].split(/\s+/);
}

/* ═════════════ 7 · ERP ĐỌC TRẠNG THÁI QUA MOUNT CHỈ-ĐỌC ═════════════ */

export function testMountTrangThaiChiDoc() {
  const compose = readFileSync("docker-compose.prod.yml", "utf8");
  const iApp = compose.indexOf("\n  app:\n");
  const app = compose.slice(iApp, compose.indexOf("\n  scheduler:\n"));
  const macDinh = /^BACKUP_DIR="\$\{ERP_BACKUP_DIR:-([^}]+)\}"/m.exec(src())?.[1];
  assert.ok(macDinh, "script phải khai BACKUP_DIR mặc định");
  assert.ok(app.includes(`- ${macDinh}/status:${BACKUP_STATUS_DIR_DEFAULT}:ro`), `app phải mount ${macDinh}/status → ${BACKUP_STATUS_DIR_DEFAULT} CHỈ-ĐỌC — đúng chỗ script ghi, đúng chỗ ERP đọc`);
  assert.ok(!new RegExp(`- ${macDinh}(/daily|/weekly|/manual)?:`).test(compose), "KHÔNG mount bản sao lưu vào container nào — trong đó có dữ liệu khách hàng và khoá bot");
  console.log(`✓ Mount: ${macDinh}/status → ${BACKUP_STATUS_DIR_DEFAULT}:ro · không container nào thấy bản sao lưu`);
}

/* ═════════════ 8 · CHẤM: KHÔNG CÓ BẰNG CHỨNG THÌ KHÔNG "KHOẺ" ═════════════ */

export function testChamSaoLuu() {
  const BAY_GIO = new Date("2026-09-24T03:00:00Z");
  const truoc = (gio: number) => new Date(BAY_GIO.getTime() - gio * 3_600_000).toISOString();
  const ban = (gioTruoc: number, over: Record<string, unknown> = {}) => ({
    schema: 1,
    kind: "backup",
    result: "OK",
    trigger: "cron",
    startedAt: truoc(gioTruoc + 0.1),
    finishedAt: truoc(gioTruoc),
    reason: null,
    freeMbBefore: 20000,
    needMb: 3600,
    db: { file: "erp-20260924-0217.dump", bytes: 52_428_800, tableData: 110 },
    chatbot: { state: "OK", file: "chatbot-20260924-0217.tar.gz", bytes: 20480, reason: null },
    offsite: { state: "OK", remote: "b2:", reason: null },
    retention: { daily: 7, weekly: 4, manual: 3 },
    schedule: "hằng ngày",
    ...over,
  });
  const dienTap = (gioTruoc: number, result = "OK") => ({ schema: 1, kind: "restore-drill", result, finishedAt: truoc(gioTruoc), reason: result === "OK" ? null : "lỗi giả", dumpFile: "erp-x.dump", tables: [{ name: "orders", restored: 10, live: 12 }] });
  const cham = (f: Parameters<typeof evaluateBackupHealth>[0]) => evaluateBackupHealth(f, BAY_GIO);

  // Không mount ⇒ CHƯA ĐỦ CĂN CỨ, không phải "hỏng" cũng không phải "khoẻ".
  assert.equal(cham({ dirReadable: false }).state, "UNKNOWN");
  // Có thư mục mà chưa có tệp nào ⇒ chưa có bản sao lưu nào: DOWN.
  const rong = cham({ dirReadable: true });
  assert.equal(rong.state, "DOWN", "thư mục có mà không có lượt nào ⇒ KHÔNG có bản sao lưu — đó là hỏng, không phải chưa biết");

  const du = { dirReadable: true, lastRun: ban(2), lastSuccess: ban(2), lastDrill: dienTap(72) };
  assert.equal(cham(du).state, "HEALTHY", "đủ năm vế ⇒ HEALTHY");
  assert.deepEqual(cham(du).issues, []);

  // Biên 36 giờ — tính từ hằng số, không gõ lại số.
  assert.equal(cham({ ...du, lastRun: ban(BACKUP_MAX_AGE_HOURS), lastSuccess: ban(BACKUP_MAX_AGE_HOURS) }).state, "HEALTHY", `đúng ${BACKUP_MAX_AGE_HOURS} giờ vẫn chưa quá hạn`);
  const cu = cham({ ...du, lastRun: ban(BACKUP_MAX_AGE_HOURS + 1), lastSuccess: ban(BACKUP_MAX_AGE_HOURS + 1) });
  assert.equal(cu.state, "DOWN", `bản mới nhất cũ hơn ${BACKUP_MAX_AGE_HOURS} giờ ⇒ DOWN`);
  assert.match(cu.reason, new RegExp(`quá ${BACKUP_MAX_AGE_HOURS} giờ`));

  const khongNgoai = cham({ ...du, lastRun: ban(2, { offsite: { state: "NOT_CONFIGURED", remote: null, reason: "x" } }), lastSuccess: ban(2, { offsite: { state: "NOT_CONFIGURED", remote: null, reason: "x" } }) });
  assert.equal(khongNgoai.state, "DEGRADED", "chưa có bản ngoài máy ⇒ KHÔNG được xanh");
  assert.match(khongNgoai.reason, /CHƯA CÓ BẢN SAO NGOÀI MÁY/);

  const hongSau = cham({ ...du, lastRun: ban(1, { result: "FAILED", reason: "Ổ đĩa còn 900 MB" }) });
  assert.equal(hongSau.state, "DEGRADED", "lượt mới nhất hỏng (bản cũ còn trong hạn) ⇒ DEGRADED");
  assert.match(hongSau.reason, /Ổ đĩa còn 900 MB/, "lý do của script phải tới được màn hình nguyên văn");

  assert.equal(cham({ ...du, lastDrill: undefined }).state, "DEGRADED", "chưa từng diễn tập ⇒ chưa chứng minh dùng được");
  assert.equal(cham({ ...du, lastDrill: dienTap(5, "FAILED") }).state, "DOWN", "diễn tập THẤT BẠI ⇒ DOWN: bản sao lưu có thể không dùng được");
  assert.equal(cham({ ...du, lastDrill: dienTap(5, "SKIPPED") }).state, "DEGRADED", "diễn tập bị từ chối vì thiếu RAM không phải bản hỏng — nhưng cũng không phải đã chứng minh");
  assert.equal(cham({ ...du, lastDrill: dienTap((BACKUP_DRILL_MAX_AGE_DAYS + 1) * 24) }).state, "DEGRADED", `diễn tập cũ hơn ${BACKUP_DRILL_MAX_AGE_DAYS} ngày ⇒ DEGRADED`);
  assert.equal(cham({ ...du, lastSuccess: ban(2, { chatbot: { state: "NOT_FOUND", reason: "x" } }) }).state, "DEGRADED", "dữ liệu bot không được sao lưu ⇒ DEGRADED");

  // Tệp hỏng / sai hình dạng ⇒ KHÔNG BAO GIỜ xanh.
  assert.notEqual(cham({ ...du, lastRun: UNPARSABLE }).state, "HEALTHY", "tệp trạng thái hỏng không được làm bảng xanh");
  assert.notEqual(cham({ ...du, lastSuccess: { ...ban(2), schema: 2 } }).state, "HEALTHY", "schema lạ không phải căn cứ");
  assert.equal(parseBackupRun({ ...ban(2), offsite: { state: "LẠ" } })?.offsite.state, "FAILED", "trạng thái ngoài máy lạ phải rơi về vế XẤU");

  // CHƯA BIẾT không in thành 0 (AGENTS.md mục 42).
  assert.equal(formatBackupSize(null), "—");
  assert.equal(parseBackupRun({ ...ban(2), db: { file: "x", bytes: null, tableData: "?" } })?.db.bytes, null);

  console.log(`✓ Chấm sao lưu: không mount ⇒ UNKNOWN · chưa có bản ⇒ DOWN · biên ${BACKUP_MAX_AGE_HOURS} giờ · chưa có ngoài máy / chưa diễn tập / bot thiếu ⇒ DEGRADED · diễn tập hỏng ⇒ DOWN · tệp hỏng không bao giờ xanh`);
}

/* ═════════════ 9 · NGOÀI MÁY: GOOGLE DRIVE + CRYPT, CẤU HÌNH TỪ SECRETS — KHÔNG SSH ═════════════ */

/**
 * Token OAuth mẫu mang ĐỦ những ký tự từng giết một đường ghi `.env`: `"` (trích dẫn của dotenv),
 * `/` `+` `=` (base64 của Google), `|` `&` `\` (ký tự của `sed` trong upsert_env), `$` `` ` `` `'`
 * (ký tự của shell). JSON hợp lệ: `\\\\` trong chuỗi TS là `\\` trong JSON, tức một dấu gạch ngược.
 */
const TOKEN_MAU =
  '{"access_token":"ya29.a0/Ab+c=d|e&f$g\'h`i\\\\j k","token_type":"Bearer","refresh_token":"1//0gX-y+z/w==|&x","expiry":"2026-09-25T10:00:00.123+07:00"}';
const MK_MAU = "Q3JpcHRNYXRLaGF1R2lhS2hvbmdUaGF0XzEyMzQ1Ng-_x";
const MK2_MAU = "TXVvaUdpYUtob25nVGhhdF85ODc2NTQzMjEw_-y";
const THU_MUC_MAU = "ThuMucGia_1234567890-KhongPhaiThat";
const BIEN_NGOAI_MAY = ["RCLONE_GDRIVE_TOKEN", "RCLONE_CRYPT_PASSWORD", "RCLONE_CRYPT_PASSWORD2", "BACKUP_GDRIVE_FOLDER_ID"] as const;

type KetQuaCauHinh = { exit: string; out: string; tep: string | null; quyen: string; nap: Map<string, string>; token: string; raw: string };

/**
 * Chạy `erp-backup.sh configure-offsite` THẬT với các biến cho trước (qua môi trường), rồi ở một tiến
 * trình SẠCH (đã unset mọi Secret) `source` script và gọi `nap_cau_hinh` — đúng đường mà cron và ops
 * `backup` đi. Token nạp được trả về qua base64 để so từng BYTE, không qua một lớp in ấn nào.
 */
function chayCauHinh(bien: Partial<Record<(typeof BIEN_NGOAI_MAY)[number], string>>, truoc = ""): KetQuaCauHinh {
  const r = chayBash(
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      'unset BACKUP_OFFSITE_REMOTE $(compgen -v RCLONE_CONFIG_ || true)',
      'T="$(mktemp -d)"; mkdir -p "$T/erp"',
      `S="${bashPath(SCRIPT)}"`,
      'export ERP_BACKUP_OFFSITE_ENV="$T/cfg/offsite.env" ERP_DIR="$T/erp" ERP_BACKUP_DIR="$T/b"',
      truoc,
      'bash "$S" configure-offsite > "$T/out" 2>&1; rc=$?',
      'echo "@@EXIT"; echo "$rc"',
      'echo "@@OUT"; cat "$T/out"',
      'echo "@@TEP"; if [ -f "$ERP_BACKUP_OFFSITE_ENV" ]; then cat "$ERP_BACKUP_OFFSITE_ENV"; else echo "--KHONG-CO-TEP--"; fi',
      'echo "@@QUYEN"; stat -c %a "$T/cfg" "$ERP_BACKUP_OFFSITE_ENV" 2>/dev/null | tr "\\n" " "; echo',
      `unset ${BIEN_NGOAI_MAY.join(" ")}`,
      // Tiến trình MỚI, đúng như cron: không Secret nào trong môi trường, chỉ có tệp trên đĩa.
      'bash -c \'source "$1"; set +e; nap_cau_hinh; env | grep -E "^(RCLONE_CONFIG_|BACKUP_OFFSITE_REMOTE=)" | grep -v "^RCLONE_CONFIG_GDRIVE_TOKEN=" | sort; printf "%s" "${RCLONE_CONFIG_GDRIVE_TOKEN:-}" > "$2/token.out"\' _ "$S" "$T" > "$T/nap" 2>&1',
      'echo "@@NAP"; cat "$T/nap"',
      'echo "@@TOKEN"; base64 < "$T/token.out" | tr -d "\\r\\n"; echo',
      'echo "@@HET"; rm -rf "$T"',
      "",
    ].join("\n"),
    Object.fromEntries(Object.entries(bien).filter(([, v]) => v !== undefined)) as Record<string, string>,
  );
  const tep = phan(r.ra, "TEP");
  const nap = new Map(
    phan(r.ra, "NAP")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as [string, string]),
  );
  return {
    exit: phan(r.ra, "EXIT"),
    out: phan(r.ra, "OUT"),
    tep: tep === "--KHONG-CO-TEP--" ? null : tep,
    quyen: phan(r.ra, "QUYEN"),
    nap,
    token: Buffer.from(phan(r.ra, "TOKEN"), "base64").toString("utf8"),
    raw: r.ra,
  };
}

/** Đầu ra (log Actions công khai) không được chứa một mảnh giá trị bí mật nào. */
function khongLoBiMat(out: string, nhan: string) {
  const manh = [TOKEN_MAU, "1//0gX-y+z/w==", "ya29.a0/Ab+c", MK_MAU, MK_MAU.slice(0, 12), MK2_MAU, MK2_MAU.slice(0, 12), Buffer.from(TOKEN_MAU).toString("base64").slice(0, 24)];
  for (const m of manh) assert.ok(!out.includes(m), `${nhan}: log in ra một mảnh giá trị bí mật ("${m.slice(0, 6)}…") — log Actions của kho PUBLIC ai cũng đọc được`);
}

export function testNgoaiMayGoogleDrive() {
  assert.doesNotThrow(() => JSON.parse(TOKEN_MAU), "token mẫu phải là JSON hợp lệ — nếu không, bài kiểm đo một thứ rclone không bao giờ nhận");
  const DU = { RCLONE_GDRIVE_TOKEN: TOKEN_MAU, RCLONE_CRYPT_PASSWORD: MK_MAU, RCLONE_CRYPT_PASSWORD2: MK2_MAU, BACKUP_GDRIVE_FOLDER_ID: THU_MUC_MAU };

  // ───────── MỨC MÃ NGUỒN: deploy truyền đủ biến, install-vps gọi đúng chỗ, không ai in giá trị ─────────
  const deploy = readFileSync(".github/workflows/deploy-vps.yml", "utf8");
  const iSsh = deploy.indexOf("- name: SSH vào VPS và chạy bootstrap");
  assert.ok(iSsh > 0, "không tìm thấy bước SSH của deploy");
  const ssh = deploy.slice(iSsh, deploy.indexOf("\n      - name:", iSsh + 10));
  const nguon: Record<(typeof BIEN_NGOAI_MAY)[number], "secrets" | "vars"> = {
    RCLONE_GDRIVE_TOKEN: "secrets",
    RCLONE_CRYPT_PASSWORD: "secrets",
    RCLONE_CRYPT_PASSWORD2: "secrets",
    BACKUP_GDRIVE_FOLDER_ID: "vars",
  };
  const envs = (/^\s+envs: (.+)$/m.exec(ssh)?.[1] ?? "").split(",");
  const xuat = (/^\s+export (ERP_BRANCH .+)$/m.exec(ssh)?.[1] ?? "").split(/\s+/);
  for (const [ten, loai] of Object.entries(nguon)) {
    assert.match(ssh, new RegExp(`^\\s+${ten}: \\$\\{\\{ ${loai}\\.${ten} \\}\\}$`, "m"), `bước SSH phải khai ${ten} từ ${loai}.${ten}${loai === "vars" ? " — ID thư mục không bí mật, để ở Variable cho đọc lại được" : ""}`);
    assert.ok(envs.includes(ten), `${ten} phải nằm trong danh sách envs: của bước SSH — thiếu thì VPS không bao giờ nhận được nó`);
    assert.ok(xuat.includes(ten), `${ten} phải nằm trong dòng export của kịch bản SSH`);
  }
  // Mọi lần deploy nhắc tới giá trị Secret chỉ được để HỎI CÓ / KHÔNG, không bao giờ in.
  for (const m of boChuThichShell(deploy).matchAll(/.*\$\{?(RCLONE_GDRIVE_TOKEN|RCLONE_CRYPT_PASSWORD2?)\b.*/g)) {
    const conLai = m[0].replace(/\[ -n "\$(RCLONE_GDRIVE_TOKEN|RCLONE_CRYPT_PASSWORD2?)" \]/g, "");
    assert.ok(!/\$\{?(RCLONE_GDRIVE_TOKEN|RCLONE_CRYPT_PASSWORD2?)\b/.test(conLai), `deploy-vps.yml chỉ được HỎI Secret có hay không, không in: "${m[0].trim().slice(0, 100)}"`);
  }
  const install = boChuThichShell(readFileSync("scripts/install-vps.sh", "utf8"));
  assert.match(install, /^bash scripts\/erp-backup\.sh configure-offsite \|\| warn /m, "install-vps.sh phải dựng cấu hình ngoài máy ở MỌI lần deploy, và hỏng thì cảnh báo chứ không đổ deploy");
  assert.ok(install.indexOf("erp-backup.sh configure-offsite") < install.indexOf("erp-backup.sh install-cron"), "configure-offsite phải chạy TRƯỚC install-cron — install-cron chỉ cài rclone khi đã có nơi lưu");
  assert.ok(!/\$\{?(RCLONE_GDRIVE_TOKEN|RCLONE_CRYPT_PASSWORD2?|BACKUP_GDRIVE_FOLDER_ID)\b/.test(install), "install-vps.sh không được tự đụng tới giá trị Secret Drive — không upsert_env vào .env (compose nạp .env vào container app), không in");
  assert.ok(!/upsert_env\s+(RCLONE|BACKUP_OFFSITE)/.test(install), "cấu hình rclone KHÔNG đi vào .env");
  // Không ghi cứng ID thư mục Drive (33 ký tự bắt đầu bằng 1) vào mã: đổi thư mục là đổi Variable.
  for (const f of ["scripts/erp-backup.sh", "scripts/install-vps.sh", ".github/workflows/deploy-vps.yml", ".github/workflows/ops-vps.yml"]) {
    assert.ok(!/(?<![A-Za-z0-9_])1[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/.test(readFileSync(f, "utf8")), `${f} ghi cứng một ID thư mục Google Drive — nó phải đi qua Variable BACKUP_GDRIVE_FOLDER_ID`);
  }
  const ham = boChuThichShell(src());
  const iCfg = ham.indexOf("cmd_configure_offsite() {");
  const cfg = ham.slice(iCfg, ham.indexOf("\n}\n", iCfg));
  // Dòng GÁN từ một phép thế lệnh (`x="$(printf … | tr …)"`) không in gì ra log — bỏ qua; mọi dòng
  // còn lại có bao/loi/echo/printf là một dòng IN.
  const dongIn = cfg.split("\n").filter((l) => /\b(bao|loi|echo|printf)\b/.test(l) && !/> "\$tam"/.test(l) && !/^\s*(if !\s+)?\w+="\$\(/.test(l));
  assert.ok(dongIn.length >= 4, `phải tìm thấy các dòng in của configure-offsite (thấy ${dongIn.length})`);
  for (const dong of dongIn) {
    const conLai = dong.replace(/\[ -[nz] "\$\w+" \]/g, ""); // HỎI rỗng hay không thì không in gì
    assert.ok(!/\$\{?(token|json|b64|mk2?|RCLONE_GDRIVE_TOKEN|RCLONE_CRYPT_PASSWORD2?)\b/.test(conLai),`configure-offsite in một giá trị bí mật: "${dong.trim().slice(0, 100)}" — chỉ được in độ dài (\${#…})`);
  }

  // ───────── ĐỦ BA ⇒ GHI TỆP, VÀ JSON ĐI QUA NGUYÊN VẸN TỪNG BYTE ─────────
  const du = chayCauHinh(DU, 'printf \'BACKUP_OFFSITE_REMOTE="cu-trong-env:"\\nRCLONE_CONFIG_GCRYPT_PASSWORD="tu-env-cu"\\n\' > "$T/erp/.env"');
  assert.equal(du.exit, "0", `configure-offsite đủ biến phải thành công:\n${du.raw}`);
  assert.ok(du.tep, "đủ ba thứ bắt buộc thì phải ghi tệp cấu hình");
  assert.equal(du.token, TOKEN_MAU, "JSON token nạp lại phải GIỐNG TỪNG BYTE bản chủ shop dán vào Secret — `\"`, `/`, `+`, `=`, `|`, `&`, `\\`, `$`, `` ` ``, `'`, dấu cách");
  const mongDoi: Record<string, string> = {
    BACKUP_OFFSITE_REMOTE: "gcrypt:",
    RCLONE_CONFIG_GDRIVE_TYPE: "drive",
    RCLONE_CONFIG_GDRIVE_SCOPE: "drive",
    RCLONE_CONFIG_GDRIVE_ROOT_FOLDER_ID: THU_MUC_MAU,
    RCLONE_CONFIG_GCRYPT_TYPE: "crypt",
    RCLONE_CONFIG_GCRYPT_REMOTE: "gdrive:erp-backup",
    RCLONE_CONFIG_GCRYPT_PASSWORD: MK_MAU,
    RCLONE_CONFIG_GCRYPT_PASSWORD2: MK2_MAU,
    RCLONE_CONFIG_GCRYPT_FILENAME_ENCRYPTION: "standard",
  };
  assert.deepEqual(Object.fromEntries(du.nap), mongDoi, "nạp lại phải ra ĐÚNG bộ biến rclone đọc — và tệp ngoài máy phải THẮNG giá trị cũ trong .env");
  assert.ok(!du.nap.has("RCLONE_CONFIG_GDRIVE_TOKEN_B64"), "khoá _B64 KHÔNG được export — rclone sẽ đọc nó như một tuỳ chọn lạ của remote");
  assert.ok(!du.tep.includes(TOKEN_MAU) && !du.tep.includes('"refresh_token"'), "token nằm trên đĩa ở dạng base64, không phải JSON thô");
  assert.equal((du.tep.match(/^BACKUP_OFFSITE_REMOTE=/gm) ?? []).length, 1, "mỗi khoá đúng một dòng");
  khongLoBiMat(du.out, "đủ biến");
  assert.match(du.out, new RegExp(`token ${TOKEN_MAU.length} ký tự`), "log phải in ĐỘ DÀI token để người vận hành biết đã nhận được gì");
  if (process.platform === "linux") {
    assert.deepEqual(du.quyen.split(/\s+/).filter(Boolean), ["700", "600"], "thư mục cấu hình 700, tệp 600 — chỉ root đọc");
  } else {
    console.log(`⚠ Quyền 700/600 của tệp cấu hình ngoài máy: CHƯA ĐO ĐƯỢC trên ${process.platform} (NTFS không giữ bit POSIX); đo trên Linux/CI.`);
  }

  // Chạy lại (mỗi lần deploy) với cùng Secret ⇒ tệp không đổi.
  const lai = chayCauHinh(DU, `mkdir -p "$T/cfg"; cat > "$ERP_BACKUP_OFFSITE_ENV" <<'EOF_CU'\n${du.tep}\nEOF_CU`);
  assert.equal(lai.tep, du.tep, "chạy lại với cùng Secret phải ra đúng tệp cũ");
  assert.match(lai.out, /không đổi/, "…và nói là không đổi");

  // Dán kèm hai dòng mũi tên của `rclone authorize`, xuống dòng Windows ⇒ vẫn đúng token.
  const dan = chayCauHinh({ ...DU, RCLONE_GDRIVE_TOKEN: `Paste the following into your remote machine --->\r\n${TOKEN_MAU}\r\n<---End paste\r\n` });
  assert.equal(dan.token, TOKEN_MAU, `dán cả khối mũi tên + CRLF phải ra đúng JSON token:\n${dan.raw}`);
  // rclone vài bản in token dạng một khối base64.
  const b64 = chayCauHinh({ ...DU, RCLONE_GDRIVE_TOKEN: Buffer.from(TOKEN_MAU).toString("base64") });
  assert.equal(b64.token, TOKEN_MAU, "token dán ở dạng base64 phải được giải ra đúng JSON");

  // ───────── THIẾU MỘT TRONG BA ⇒ KHÔNG GHI GÌ MỚI, CẤU HÌNH CŨ GIỮ NGUYÊN, NÓI RÕ THIẾU GÌ ─────────
  const CU = "BACKUP_OFFSITE_REMOTE=cu:";
  const coTepCu = `mkdir -p "$T/cfg"; printf '%s\\n' '${CU}' > "$ERP_BACKUP_OFFSITE_ENV"`;
  for (const thieu of ["RCLONE_GDRIVE_TOKEN", "RCLONE_CRYPT_PASSWORD", "BACKUP_GDRIVE_FOLDER_ID"] as const) {
    const bien = { ...DU } as Partial<typeof DU>;
    delete bien[thieu];
    const k = chayCauHinh(bien, coTepCu);
    assert.equal(k.exit, "0", `thiếu ${thieu}: không được làm đổ deploy`);
    assert.equal(k.tep, CU, `thiếu ${thieu}: KHÔNG được ghi gì mới — tệp cũ giữ nguyên từng byte`);
    assert.match(k.out, new RegExp(`::warning::.*THIẾU.*${thieu}`), `thiếu ${thieu}: log phải nói rõ THIẾU ĐÚNG CÁI GÌ`);
    for (const khac of ["RCLONE_GDRIVE_TOKEN", "RCLONE_CRYPT_PASSWORD", "BACKUP_GDRIVE_FOLDER_ID"].filter((x) => x !== thieu)) {
      assert.ok(!new RegExp(`THIẾU[^\\n]*${khac} \\(`).test(k.out), `thiếu ${thieu}: không được báo thiếu nhầm ${khac}`);
    }
    khongLoBiMat(k.out, `thiếu ${thieu}`);
  }
  // Thiếu salt (tuỳ chọn) thì vẫn ghi, và không có dòng PASSWORD2.
  const khongSalt = chayCauHinh({ ...DU, RCLONE_CRYPT_PASSWORD2: "" });
  assert.ok(khongSalt.tep && !/PASSWORD2/.test(khongSalt.tep), "salt là TUỲ CHỌN: không có thì vẫn ghi, và không có dòng PASSWORD2");

  // Chưa khai gì ⇒ không tạo tệp; cấu hình tay kiểu cũ trong .env vẫn chạy như trước.
  const chua = chayCauHinh({}, 'printf \'BACKUP_OFFSITE_REMOTE="b2:kho/erp"\\n\' > "$T/erp/.env"');
  assert.equal(chua.tep, null, "chưa khai Secret nào ⇒ không tạo tệp");
  assert.ok(!/::warning::/.test(chua.out), "chưa khai gì là trạng thái hợp lệ (chủ shop chưa quyết) — không cảnh báo nhầm");
  assert.equal(chua.nap.get("BACKUP_OFFSITE_REMOTE"), "b2:kho/erp", "cấu hình tay kiểu cũ trong .env vẫn được nạp");

  // Giá trị sai dạng ⇒ KHÔNG ghi (một cấu hình hỏng im lặng tệ hơn không có cấu hình).
  for (const [ten, bien] of [
    ["token không có refresh_token", { ...DU, RCLONE_GDRIVE_TOKEN: '{"access_token":"a"}' }],
    ["ID thư mục là cả đường dẫn", { ...DU, BACKUP_GDRIVE_FOLDER_ID: "https://drive.google.com/drive/folders/abc" }],
    ["mật khẩu gốc chưa obscure", { ...DU, RCLONE_CRYPT_PASSWORD: "matkhau goc!" }],
  ] as const) {
    const k = chayCauHinh(bien);
    assert.equal(k.tep, null, `${ten}: KHÔNG được ghi cấu hình`);
    assert.match(k.out, /::warning::/, `${ten}: phải cảnh báo`);
    khongLoBiMat(k.out, ten);
  }

  // ───────── ĐƯỜNG ĐẨY: `gcrypt:` + daily ⇒ `gcrypt:daily/…`, không phải `gcrypt:/daily/…` ─────────
  const day = chayBash(khungChay({ dfAvail: 999_999, offsite: "ok" }));
  const log = phan(day.ra, "DOCKER");
  assert.match(log, /^rclone copyto --retries 3 \S+ gia:daily\/erp-\d{8}-\d{4}\.dump$/m, `đích đẩy phải là remote:thư-mục-con/tệp:\n${log}`);
  assert.match(log, /^rclone lsf --format s gia:daily\/erp-/m, "đọc lại kích thước ở ĐÚNG đường vừa đẩy");
  assert.match(log, /^rclone delete gia:daily --min-age /m, "dọn theo tuổi ở đúng thư mục con");
  assert.ok(!/gia:\//.test(log), "không bao giờ `remote:/…` — dấu `/` đầu đổi nghĩa đường ở vài backend");

  // ───────── install-cron CÀI rclone khi (và chỉ khi) đã có nơi lưu — kể cả khi danh sách gói cũ ─────────
  const cai = chayBash(
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      'unset BACKUP_OFFSITE_REMOTE $(compgen -v RCLONE_CONFIG_ || true)',
      'T="$(mktemp -d)"; mkdir -p "$T/bin" "$T/erp" "$T/logrotate"',
      'printf "#!/usr/bin/env bash\\nexit 0\\n" > "$T/bin/cron"; cp "$T/bin/cron" "$T/bin/systemctl"',
      // apt-get giả: lần `install` đầu hỏng (danh sách gói cũ), sau `update` thì được.
      'printf \'#!/usr/bin/env bash\\necho "apt-get $*" >> "%s/apt.log"\\ncase "$1" in update) : > "%s/da-update" ;; install) [ -f "%s/da-update" ] || exit 100 ;; esac\\n\' "$T" "$T" "$T" > "$T/bin/apt-get"',
      'chmod +x "$T/bin/cron" "$T/bin/systemctl" "$T/bin/apt-get"',
      'export PATH="$T/bin:/usr/bin:/bin" ERP_DIR="$T/erp" ERP_BACKUP_DIR="$T/backups" ERP_CRON_FILE="$T/cron.d/erp-backup" ERP_LOGROTATE_FILE="$T/logrotate/erp-backup" ERP_BACKUP_LOG="$T/erp-backup.log" ERP_BACKUP_OFFSITE_ENV="$T/cfg/offsite.env"',
      'echo "@@CORCLONE"; command -v rclone >/dev/null 2>&1 && echo co || echo khong',
      `S="${bashPath(SCRIPT)}"`,
      'bash "$S" install-cron > /dev/null 2>&1; echo "@@CHUAKHAI"; cat "$T/apt.log" 2>/dev/null; : > "$T/apt.log"',
      'bash "$S" configure-offsite > /dev/null 2>&1',
      'bash "$S" install-cron > "$T/out" 2>&1; echo "@@DAKHAI"; cat "$T/apt.log"',
      'echo "@@HET"; rm -rf "$T"',
      "",
    ].join("\n"),
    DU,
  );
  if (phan(cai.ra, "CORCLONE") === "khong") {
    assert.ok(!/rclone/.test(phan(cai.ra, "CHUAKHAI")), "chưa khai nơi lưu thì KHÔNG cài rclone — không cài công cụ cho một quyết định chưa có");
    assert.deepEqual(
      phan(cai.ra, "DAKHAI").split("\n").map((l) => l.replace(/ -y -qq/, "")),
      ["apt-get install rclone", "apt-get update -qq", "apt-get install rclone"],
      `đã khai qua Secrets ⇒ install-cron cài rclone; danh sách gói cũ ⇒ update rồi thử lại:\n${cai.ra}`,
    );
  } else {
    console.log("⚠ install-cron cài rclone: CHƯA ĐO ĐƯỢC — máy chạy kiểm thử đã có rclone trong /usr/bin nên nhánh cài không bao giờ chạy.");
  }

  console.log(
    `✓ Ngoài máy Google Drive: deploy truyền ${BIEN_NGOAI_MAY.join(" · ")} (token/mật khẩu = Secret, thư mục = Variable) · cấu hình vào tệp RIÊNG 600, không vào .env · JSON ${TOKEN_MAU.length} ký tự có " / + = | & \\ $ \` ' đi qua NGUYÊN VẸN (base64 trên đĩa) · dán kèm mũi tên/CRLF/base64 vẫn đúng · thiếu 1/3 ⇒ không ghi, nói rõ thiếu gì · không in giá trị · đẩy tới remote:daily/… · rclone tự cài`,
  );
}

/* ═════════════ 10 · CSDL TỔ CHỨC KHÁC NHÀ (erp_org_*) — Phase 11 ═════════════ */

/**
 * Băm SHA-256 của `scripts/erp-backup.sh` SAU KHI gỡ mọi khối `# >>> TỔ CHỨC KHÁC NHÀ` … `# <<< TỔ
 * CHỨC KHÁC NHÀ` — tức bản trước Phase 11 (origin/main 64cd4732) cộng ĐÚNG các lần đổi CỐ Ý ghi dưới đây.
 * Đây là lời khẳng định "phần của nhà KHÔNG đổi một byte ngoài các lần đã ghi" ở dạng máy kiểm được.
 *
 * Đỏ ở đây nghĩa là ai đó đã sửa đường sao lưu của CSDL NHÀ (VNX). Nếu việc đó là CỐ Ý: cập nhật băm
 * CÙNG commit, thêm một dòng vào sổ dưới đây và nói trong commit vì sao đường của nhà đổi. Nếu không cố
 * ý: phần tổ chức đã rò ra ngoài khối có dấu — đưa nó về trong khối.
 *
 * Sổ đổi cố ý (băm trước → sau):
 *  · 08/10/2026 — sự cố 403 storageQuotaExceeded: xoay vòng phía Drive xoá HẲN (`CO_KHONG_THUNG_RAC`), lượt `run` dọn
 *    thùng rác CHỈ của thư mục sao lưu trước bước đẩy, `status` đo dung lượng Drive và in ID thư mục ở dạng che (§13).
 *    57d9b50d… → 300ca205…. Đường dump / kiểm toàn vẹn / xoay vòng TRÊN MÁY / trạng thái JSON của nhà không đổi.
 */
const BAM_PHAN_NHA = "300ca205a28d2c986f5989123c19ae741507129a7069985f6aa2ee7ac571f7fa";
const DAU_MO = "# >>> TỔ CHỨC KHÁC NHÀ";
const DAU_DONG = "# <<< TỔ CHỨC KHÁC NHÀ";

/** Tách script thành [phần của nhà, các khối tổ chức]. Kết thúc dòng quy về LF (AGENTS.md mục 65). */
function tachPhanToChuc(): { nha: string; toChuc: string } {
  const nha: string[] = [];
  const toChuc: string[] = [];
  let trong = false;
  for (const dong of src().replace(/\r\n/g, "\n").split("\n")) {
    const t = dong.trimStart();
    if (t.startsWith(DAU_MO)) {
      assert.ok(!trong, "khối tổ chức lồng nhau — thiếu dấu đóng");
      trong = true;
      continue;
    }
    if (t.startsWith(DAU_DONG)) {
      assert.ok(trong, "dấu đóng khối tổ chức không có dấu mở");
      trong = false;
      continue;
    }
    (trong ? toChuc : nha).push(dong);
  }
  assert.ok(!trong, "khối tổ chức cuối cùng không có dấu đóng");
  return { nha: nha.join("\n"), toChuc: toChuc.join("\n") };
}

export function testToChucPhanNhaKhongDoi() {
  const { nha, toChuc } = tachPhanToChuc();
  const bam = createHash("sha256").update(nha).digest("hex");
  assert.equal(bam, BAM_PHAN_NHA, "gỡ các khối TỔ CHỨC KHÁC NHÀ ra phải được NGUYÊN VĂN bản sao lưu của nhà trước Phase 11 cộng đúng các lần đổi cố ý đã ghi — xem sổ trong chú thích BAM_PHAN_NHA");
  assert.ok(!/to_chuc|erp_org|TO_CHUC/i.test(nha), "phần của nhà không được nhắc tới tổ chức khác — mọi thứ về tổ chức nằm trong khối có dấu");

  // Lệnh then chốt của nhà còn nguyên (đọc được cả khi ai đó cố ý cập nhật băm).
  for (const dong of [
    'DB_FILE="erp-$moc.dump"',
    'docker exec "$DB_CONTAINER" pg_dump -U erp -d erp -Fc > "$tam"',
    "grep -q ' TABLE DATA public orders ' <<< \"$danh_sach\"",
    "grep -q ' TABLE DATA public shipments ' <<< \"$danh_sach\"",
    "for tt in erp chatbot; do",
    'for f in "$BACKUP_DIR/$d"/erp-*.dump; do',
    'ghi_json "$STATUS_DIR/last-success.json" "$noi_dung"',
    'day_ngoai_may "$(basename "$thu_muc")" "${tep_da_tao[@]}"',
  ]) {
    assert.ok(nha.includes(dong), `phần của nhà phải còn nguyên dòng: ${dong}`);
  }

  // Khối tổ chức: không `exit` (trừ ĐÚNG MỘT dòng mã thoát cuối cmd_run, sau khi mọi tổ chức đã chạy),
  // không `that_bai`, không dựa vào `set -e`.
  const khoiDu = boChuThichShell(toChuc);
  const DONG_THOAT = /^\s*\[ -z "\$TO_CHUC_HONG" \] \|\| \{ loi "[^"]*"; exit 1; \}\s*$/gm;
  assert.equal((khoiDu.match(DONG_THOAT) ?? []).length, 1, "đúng MỘT dòng mã thoát cho tổ chức hỏng, ở cuối cmd_run");
  const khoi = khoiDu.replace(DONG_THOAT, "");
  assert.ok(!/(^|[;&|{(]\s*|\s)exit\b/m.test(khoi), "khối tổ chức không được `exit` — một tổ chức hỏng thì ghi lỗi rồi sang tổ chức kế tiếp, không dừng script");
  assert.ok(!/\bthat_bai\b/.test(khoi), "khối tổ chức không được gọi that_bai — nó ghi đè trạng thái của NHÀ thành thất bại rồi thoát");
  assert.ok(!/\bset -e\b/.test(khoi), "khối tổ chức không được bật lại set -e");
  assert.ok(!/(^|[^A-Z_])(OFFSITE_\w+|KET_QUA|LY_DO|DB_\w+|BOT_\w+|TU_DO_MB|CAN_MB)=/m.test(khoi), "khối tổ chức không được ghi biến trạng thái của NHÀ (chỉ ORG_* và TO_CHUC_HONG)");
  assert.ok(!/TABLE DATA public (orders|shipments)/.test(khoi), "kiểm toàn vẹn của tổ chức KHÔNG đòi orders/shipments — tổ chức dịch vụ không có đơn");

  // Chỗ gọi: SAU khi trạng thái của nhà đã ghi, trong ngữ cảnh `|| true`.
  const code = src().replace(/\r\n/g, "\n");
  const iRun = code.indexOf("cmd_run() {");
  const than = code.slice(iRun, code.indexOf("\n}\n", iRun));
  const iGoi = than.indexOf('sao_luu_cac_to_chuc "$moc" "$(basename "$thu_muc")" || true');
  assert.ok(iGoi > 0, "cmd_run phải gọi sao_luu_cac_to_chuc trong ngữ cảnh `|| true`");
  assert.ok(iGoi > than.indexOf('ghi_json "$STATUS_DIR/last-success.json"') && iGoi > than.indexOf("daily-done"), "tổ chức chạy SAU khi trạng thái của nhà (last-run, last-success, daily-done) đã ghi");
  assert.ok(than.indexOf('[ "$KET_QUA" = "OK" ] || { loi "$LY_DO"; exit 1; }') < than.indexOf('[ -z "$TO_CHUC_HONG" ]'), "mã thoát của nhà xét TRƯỚC — lý do in ra khi nhà hỏng vẫn là lý do của nhà");

  // Lọc tên chặt, cùng một mẫu ở script và ở ERP.
  const mau = /^MAU_CSDL_TO_CHUC='([^']+)'$/m.exec(code)?.[1];
  assert.equal(mau, "^erp_org_[a-z0-9_]+$", "tên CSDL tổ chức phải lọc bằng ^erp_org_[a-z0-9_]+$");
  assert.equal(ORG_BACKUP_DATABASE_PATTERN.source, mau, "ERP và script phải dùng CÙNG một mẫu tên CSDL");
  assert.match(khoi, /datname like 'erp\\_org\\_%'/, "liệt kê bằng pg_database với LIKE đã thoát dấu _");
  // Xoay vòng riêng theo tiền tố từng CSDL, đọc đúng hằng số của nhà.
  const xoay = [...khoi.matchAll(/^\s*xoay_vong "\$goc\/(daily|weekly|manual)" "\$csdl" "(\$GIU_BAN_\w+)"/gm)].map((m) => `${m[1]}=${m[2]}`);
  assert.deepEqual(xoay, ["daily=$GIU_BAN_NGAY", "weekly=$GIU_BAN_TUAN", "manual=$GIU_BAN_TAY"], "tổ chức xoay vòng ba thư mục của CHÍNH nó, theo tiền tố tên CSDL, bằng hằng số GIU_BAN_*");
  assert.match(code, /grep -E "\^\$\{tien_to\}-\[0-9\]\{8\}-\[0-9\]\{4\}\\\."/, "mẫu xoay vòng dùng chung phải neo `<tiền tố>-<8 số>` — erp_org_ab không ăn vào erp_org_abc");

  console.log(`✓ Tổ chức khác nhà (mã nguồn): gỡ khối có dấu ⇒ đúng băm BAM_PHAN_NHA (bản trước Phase 11 + các lần đổi cố ý đã ghi sổ) · lệnh then chốt của nhà còn nguyên · khối tổ chức không exit / that_bai / set -e, không ghi biến của nhà, không đòi orders · gọi SAU trạng thái của nhà trong ngữ cảnh || true · mẫu tên ${mau} chung với ERP · xoay vòng riêng theo tiền tố`);
}

/** ANSI-C quoting của bash — chuyển nguyên vẹn xuống dòng, nháy, gạch ngược. */
const bq = (s: string) => `$'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;

export function testToChucHamThuan() {
  const hopLe = ["erp_org_ab", "erp_org_a_b_c", "erp_org_x9"];
  const khongHopLe = ["", "erp", "erp_org_", "erp_org_AB", "erp_org_a-b", "erp_org_a;rm -rf /", "erp_org_a b", "erp_org_a/../x", "xerp_org_a", "erp_org_a\nerp", "erp-org-a"];
  const r = chayBash(
    [
      "#!/usr/bin/env bash",
      'T="$(mktemp -d)"',
      'export ERP_BACKUP_DIR="$T/backups" ERP_DIR="$T/erp" ERP_LOCK_DIR="$T/locks"',
      `source "${bashPath(SCRIPT)}"`,
      "set +e",
      'echo "@@TEN"',
      ...[...hopLe, ...khongHopLe].map((n, i) => `ten_csdl_to_chuc_hop_le ${bq(n)}; echo "${i}:$?"`),
      'echo "@@TEP"; ten_tep_to_chuc erp_org_ab 20260928-0217; echo',
      'echo "@@DU"; bang_loi_thieu $\'1; 0 0 TABLE DATA public users erp\\n2; 0 0 TABLE DATA public settings erp\\n3; 0 0 TABLE DATA drizzle __drizzle_migrations erp\\n\'; echo "|"',
      'echo "@@THIEU"; bang_loi_thieu $\'1; 0 0 TABLE DATA public users_cu erp\\n2; 0 0 TABLE DATA drizzle __drizzle_migrations erp\\n3; 0 0 TABLE DATA public orders erp\\n\'; echo',
      // Xoay vòng trong một thư mục chung: tiền tố của tổ chức này không được ăn vào tệp của tổ chức khác / của nhà.
      'D="$T/chung"; mkdir -p "$D"',
      'for i in 01 02 03 04 05; do touch "$D/erp_org_ab-202609$i-0217.dump" "$D/erp_org_abc-202609$i-0217.dump" "$D/erp-202609$i-0217.dump"; done',
      'xoay_vong "$D" erp_org_ab 2 > /dev/null; echo "@@XOAY"; ls -1 "$D" | sort',
      // Liệt kê: docker giả trả cả tên hợp lệ lẫn tên lạ; tên lạ bị bỏ và nói ra ở stderr.
      "docker() { printf 'erp_org_alpha\\nerp_org_Bad;x\\nerp_org_beta\\r\\n'; }",
      'ds="$(liet_ke_csdl_to_chuc 2>"$T/err")"; echo "@@LIET"; echo "$ds"; echo "@@LIETLOI"; cat "$T/err"',
      "docker() { echo 'psql: loi gia' >&2; return 2; }",
      'liet_ke_csdl_to_chuc > /dev/null 2>&1; rc=$?; echo "@@LIETHONG"; echo $rc',
      'echo "@@HET"; rm -rf "$T"',
      "",
    ].join("\n"),
  );
  const ten = phan(r.ra, "TEN").split("\n");
  hopLe.forEach((n, i) => assert.equal(ten[i], `${i}:0`, `"${n}" phải là tên CSDL tổ chức hợp lệ`));
  khongHopLe.forEach((n, k) => assert.notEqual(ten[hopLe.length + k], `${hopLe.length + k}:0`, `${JSON.stringify(n)} KHÔNG được coi là tên CSDL tổ chức — nó sẽ đi vào đường dẫn và lệnh pg_dump`));

  const tep = phan(r.ra, "TEP");
  assert.equal(tep, "erp_org_ab-20260928-0217.dump");
  assert.ok(!tep.startsWith("erp-") && !/^erp-[0-9]{8}-[0-9]{4}\./.test(tep), "tên tệp tổ chức không được khớp glob `erp-*.dump` (ban_moi_nhat) hay mẫu xoay vòng của nhà");
  assert.equal(phan(r.ra, "DU"), "|", "mục lục đủ users + settings + __drizzle_migrations ⇒ không thiếu gì — KHÔNG đòi orders");
  assert.equal(phan(r.ra, "THIEU"), "public.users public.settings", "users_cu không phải users; có orders cũng không bù được bảng lõi thiếu");

  const xoay = phan(r.ra, "XOAY").split("\n");
  assert.deepEqual(xoay.filter((f) => f.startsWith("erp_org_ab-")), ["erp_org_ab-20260904-0217.dump", "erp_org_ab-20260905-0217.dump"], "xoay vòng giữ đúng 2 bản MỚI NHẤT của erp_org_ab");
  assert.equal(xoay.filter((f) => f.startsWith("erp_org_abc-")).length, 5, "tệp của erp_org_abc KHÔNG bị xoay theo tiền tố erp_org_ab");
  assert.equal(xoay.filter((f) => f.startsWith("erp-")).length, 5, "tệp của nhà KHÔNG bị xoay theo tiền tố tổ chức");

  assert.deepEqual(phan(r.ra, "LIET").split("\n"), ["erp_org_alpha", "erp_org_beta"], "liệt kê chỉ trả tên hợp lệ (bỏ CR)");
  assert.match(phan(r.ra, "LIETLOI"), /bỏ qua CSDL tên lạ .*erp_org_Bad/, "tên lạ bị bỏ và NÓI RA");
  assert.equal(phan(r.ra, "LIETHONG"), "1", "không hỏi được Postgres ⇒ trả 1 (CHƯA BIẾT), không phải danh sách rỗng");

  console.log(`✓ Tổ chức khác nhà (hàm thuần, chạy bash thật): ${hopLe.length} tên hợp lệ · ${khongHopLe.length} tên lạ bị từ chối (có ; / .. dấu cách, xuống dòng, chữ hoa, gạch ngang) · tên tệp không khớp glob của nhà · bảng lõi users/settings/__drizzle_migrations, không đòi orders · xoay vòng không ăn sang erp_org_abc hay erp- · psql lỗi ⇒ trả 1`);
}

/**
 * Khung chạy `cmd_run` THẬT với Postgres / Docker / rclone giả, có CSDL tổ chức. `docker` giả đọc
 * tên CSDL từ tham số `-d` và ghi nó vào bản dump giả, để `pg_restore --list` giả trả mục lục đúng
 * LOẠI (nhà: có orders/shipments; tổ chức: bảng lõi, KHÔNG có orders).
 */
function khungToChuc(truoc = "", lenh = "TRIGGER=cron; cmd_run"): string {
  return [
    "#!/usr/bin/env bash",
    "set -uo pipefail",
    'T="$(mktemp -d)"',
    'mkdir -p "$T/bin" "$T/erp" "$T/bot" "$T/remote"',
    'echo "khoa-bot-gia" > "$T/bot/bot.env"',
    "cat > \"$T/bin/docker\" <<'EOF'",
    "#!/usr/bin/env bash",
    'echo "$*" >> "$DOCKER_LOG"',
    'case "$1" in',
    "  inspect)",
    '    case "$*" in',
    "      *State.Running*) echo true ;;",
    "      *Destination*) echo erp_chatbot_data ;;",
    "      *Config.Image*) echo postgres:16-alpine ;;",
    "    esac ;;",
    "  exec)",
    '    case "$*" in',
    '      *pg_database*) [ "${STUB_LIST_ORG:-}" = loi ] && { echo "psql: loi gia" >&2; exit 2; }; printf "%s" "${STUB_ORGS:-}" ;;',
    '      *platform_organizations*) printf "%s" "${STUB_SO:-}" ;;',
    "      *pg_dump*)",
    '        db=""; prev=""; for a in "$@"; do [ "$prev" = "-d" ] && db="$a"; prev="$a"; done',
    '        case " ${STUB_DUMP_HONG:-} " in *" $db "*) echo "pg_dump: loi gia $db" >&2; exit 1 ;; esac',
    '        printf "PGDMP-%s-%0300d" "$db" 7 ;;',
    '      *"pg_restore --list"*)',
    '        noi="$(cat)"; db="${noi#PGDMP-}"; db="${db%%-*}"',
    '        if [ "$db" = erp ]; then printf "1; 0 0 TABLE DATA public users erp\\n2; 0 0 TABLE DATA public shipments erp\\n3; 0 0 TABLE DATA public orders erp\\n"',
    "        else",
    '          printf "1; 0 0 TABLE DATA public users erp\\n2; 0 0 TABLE DATA drizzle __drizzle_migrations erp\\n"',
    '          case " ${STUB_THIEU_SETTINGS:-} " in *" $db "*) ;; *) printf "3; 0 0 TABLE DATA public settings erp\\n" ;; esac',
    "        fi ;;",
    "    esac ;;",
    '  run) cd "$BOT_DATA" && tar --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - . | gzip -n ;;',
    "esac",
    "EOF",
    "cat > \"$T/bin/df\" <<'EOF'",
    "#!/usr/bin/env bash",
    'echo "Filesystem 1048576-blocks Used Available Capacity Mounted"',
    'echo "/dev/gia 40000 1 999999 1% /"',
    "EOF",
    "cat > \"$T/bin/rclone\" <<'EOF'",
    "#!/usr/bin/env bash",
    'echo "rclone $*" >> "$DOCKER_LOG"',
    'dich() { printf "%s" "$REMOTE_DIR/${1#gia:}"; }',
    'case "$1" in',
    '  copyto) [ "${STUB_RCLONE_LOI:-0}" = 1 ] && { echo "rclone: loi mang gia" >&2; exit 1; }; shift; while [ "${1#--}" != "$1" ]; do shift; [ "$1" = 3 ] && shift; done; mkdir -p "$(dirname "$(dich "$2")")"; cp "$1" "$(dich "$2")" ;;',
    '  lsf) f="$(dich "${!#}")"; [ -f "$f" ] || exit 1; stat -c %s "$f" ;;',
    "  delete) : ;;",
    "esac",
    "EOF",
    'chmod +x "$T/bin/docker" "$T/bin/df" "$T/bin/rclone"',
    'export PATH="$T/bin:$PATH" DOCKER_LOG="$T/docker.log" BOT_DATA="$T/bot" REMOTE_DIR="$T/remote"',
    'export ERP_BACKUP_DIR="$T/backups" ERP_DIR="$T/erp" ERP_LOCK_DIR="$T/locks" BACKUP_OFFSITE_REMOTE=gia:',
    ': > "$DOCKER_LOG"',
    `source "${bashPath(SCRIPT)}"`,
    "set +e",
    "khoa_chong_chong() { return 0; }   # khoá: đo riêng bằng flock THẬT",
    "giu_khoa() { return 0; }",
    truoc,
    `( set -e; ${lenh} ) > "$T/out" 2>&1; rc=$?`, // set -e: ĐÚNG cờ của script khi chạy thật
    'echo "@@EXIT"; echo "$rc"',
    'echo "@@OUT"; cat "$T/out"',
    'echo "@@RUN"; cat "$T/backups/status/last-run.json" 2>/dev/null',
    'echo "@@SUCCESS"; cat "$T/backups/status/last-success.json" 2>/dev/null',
    'echo "@@DAILY"; ls -1A "$T/backups/daily" 2>/dev/null',
    'echo "@@ORGFILES"; (cd "$T/backups" && find orgs -type f 2>/dev/null | sort)',
    'echo "@@STATUSFILES"; (cd "$T/backups/status" && find . -type f 2>/dev/null | sort)',
    'echo "@@SUMMARY"; cat "$T/backups/status/orgs-last-run.json" 2>/dev/null',
    'echo "@@ALPHA"; cat "$T/backups/status/orgs/erp_org_alpha/last-run.json" 2>/dev/null',
    'echo "@@BETA"; cat "$T/backups/status/orgs/erp_org_beta/last-run.json" 2>/dev/null',
    'echo "@@HALPHA"; cat "$T/backups/status/orgs/erp_org_alpha/last-hourly.json" 2>/dev/null',
    'echo "@@HBETA"; cat "$T/backups/status/orgs/erp_org_beta/last-hourly.json" 2>/dev/null',
    'echo "@@SALPHA"; cat "$T/backups/status/orgs/erp_org_alpha/last-success.json" 2>/dev/null',
    'echo "@@HSUMMARY"; cat "$T/backups/status/orgs-last-hourly.json" 2>/dev/null',
    'echo "@@REMOTE"; (cd "$T/remote" && find . -type f | sort)',
    'echo "@@DOCKER"; cat "$DOCKER_LOG"',
    'echo "@@HET"',
    'rm -rf "$T"',
    "",
  ].join("\n");
}

/** Bỏ phần phụ thuộc đồng hồ / máy (mốc, thời điểm, tên máy) để so hai lượt chạy. */
const chuanHoa = (s: string) => s.replace(/\d{8}-\d{4}/g, "MOC");
function trangThaiNha(raw: string): Record<string, unknown> {
  const j = JSON.parse(raw) as Record<string, unknown>;
  delete j.startedAt;
  delete j.finishedAt;
  delete j.host;
  /*
    KÍCH THƯỚC TỆP NÉN KHÔNG PHẢI THỨ ĐỂ SO (luật 65). tar ghi mốc giờ của từng tệp vào bản nén, nên
    hai lượt đóng gói CÙNG nội dung lệch nhau vài byte — đo 28/09/2026 trên Windows: chạy riêng bài
    này 3 lần thì 2 xanh 1 đỏ (`chatbot-MOC.tar.gz` 165 ↔ 166 byte). Điều bài này khẳng định là "lượt
    của nhà y hệt như trước", tức cùng thành phần, cùng tên tệp, cùng trạng thái, và tệp KHÔNG RỖNG.
  */
  for (const v of Object.values(j)) {
    if (v && typeof v === "object" && typeof (v as { bytes?: unknown }).bytes === "number") {
      const o = v as { bytes: unknown };
      o.bytes = (o.bytes as number) > 0;
    }
  }
  return JSON.parse(chuanHoa(JSON.stringify(j))) as Record<string, unknown>;
}

export function testToChucChayThat() {
  const ngay = hangSo("GIU_BAN_NGAY");

  // ───────── KHÔNG CÓ CSDL erp_org_* (production hôm nay) ⇒ không làm gì thêm ─────────
  const goc = chayBash(khungToChuc());
  assert.equal(phan(goc.ra, "EXIT"), "0", `không có tổ chức nào: lượt sao lưu của nhà phải đạt như cũ:\n${goc.ra}`);
  assert.equal(phan(goc.ra, "ORGFILES"), "", "không có tổ chức ⇒ không tạo thư mục / tệp nào cho tổ chức");
  assert.deepEqual(phan(goc.ra, "STATUSFILES").split("\n"), ["./daily-done", "./last-run.json", "./last-success.json"], "không có tổ chức ⇒ thư mục trạng thái đúng ba tệp của nhà");
  assert.match(phan(goc.ra, "OUT"), /không có CSDL erp_org_\* nào — không làm gì thêm/);
  assert.ok(!/pg_dump -U erp -d erp_org/.test(phan(goc.ra, "DOCKER")), "không có tổ chức ⇒ không một lệnh dump nào khác");

  // ───────── HAI TỔ CHỨC: alpha tốt, beta pg_dump lỗi, một tên lạ, một tổ chức trong sổ không có CSDL ─────────
  const tao = `for i in $(seq -w 1 ${ngay + 3}); do touch "$ERP_BACKUP_DIR/orgs/erp_org_alpha/daily/erp_org_alpha-202609$i-0217.dump"; done`;
  const hai = chayBash(
    khungToChuc(
      [
        'mkdir -p "$ERP_BACKUP_DIR/orgs/erp_org_alpha/daily"',
        tao,
        'touch "$ERP_BACKUP_DIR/orgs/erp_org_alpha/daily/erp_org_alpha_x-20260901-0217.dump" "$ERP_BACKUP_DIR/orgs/erp_org_alpha/daily/ghi-chu.txt"',
      ].join("\n"),
    ),
    { STUB_ORGS: "erp_org_alpha\nerp_org_Bad;rm -rf /\nerp_org_beta\n", STUB_DUMP_HONG: "erp_org_beta", STUB_SO: "alpha\nbeta\ngamma-x\n" },
  );
  const out = phan(hai.ra, "OUT");
  assert.equal(phan(hai.ra, "EXIT"), "1", `có tổ chức hỏng ⇒ lượt thoát 1 để ops đỏ:\n${hai.ra}`);

  // Bản của NHÀ: y hệt lượt không có tổ chức.
  assert.deepEqual(trangThaiNha(phan(hai.ra, "RUN")), trangThaiNha(phan(goc.ra, "RUN")), "last-run.json của NHÀ phải giống hệt lượt không có tổ chức (trừ mốc giờ)");
  assert.deepEqual(trangThaiNha(phan(hai.ra, "SUCCESS")), trangThaiNha(phan(goc.ra, "SUCCESS")), "last-success.json của NHÀ phải giống hệt");
  assert.equal(parseBackupRun(JSON.parse(phan(hai.ra, "RUN")))?.result, "OK", "tổ chức hỏng KHÔNG làm bản của nhà thành thất bại");
  assert.equal(chuanHoa(phan(hai.ra, "DAILY")), chuanHoa(phan(goc.ra, "DAILY")), "daily/ của nhà giống hệt");
  const xa = (ra: string) => phan(ra, "REMOTE").split("\n");
  assert.deepEqual(xa(hai.ra).filter((f) => f.startsWith("./daily/")).map(chuanHoa), xa(goc.ra).filter((f) => f.startsWith("./daily/")).map(chuanHoa), "bản ngoài máy của nhà giống hệt");
  assert.ok(out.indexOf("KẾT QUẢ: OK") >= 0 && out.indexOf("KẾT QUẢ: OK") < out.indexOf("pg_dump -Fc erp_org_alpha"), "tổ chức chạy SAU khi nhà đã chốt kết quả");

  // alpha: có bản, trạng thái của CHÍNH nó, ngoài máy dưới orgs/erp_org_alpha/.
  const files = phan(hai.ra, "ORGFILES").split("\n");
  const alphaDaily = files.filter((f) => /^orgs\/erp_org_alpha\/daily\/erp_org_alpha-\d{8}-\d{4}\.dump$/.test(f));
  assert.equal(alphaDaily.length, ngay, `alpha: xoay vòng giữ đúng ${ngay} bản của CHÍNH nó (bản mới + ${ngay - 1} bản cũ nhất còn lại)`);
  assert.ok(!alphaDaily.some((f) => /202609(0[1-3])-/.test(f)), "bản cũ nhất của alpha bị xoay đi");
  assert.ok(files.includes("orgs/erp_org_alpha/daily/erp_org_alpha_x-20260901-0217.dump") && files.includes("orgs/erp_org_alpha/daily/ghi-chu.txt"), "tệp không mang đúng tiền tố alpha KHÔNG bị đụng");
  const alpha = parseBackupRun(JSON.parse(phan(hai.ra, "ALPHA")));
  assert.ok(alpha, "trạng thái tổ chức phải đọc được bằng CHÍNH bộ đọc của ERP");
  assert.equal(alpha.scope, "ORGANIZATION");
  assert.equal(alpha.database, "erp_org_alpha");
  assert.equal(alpha.result, "OK", "alpha không có bảng orders mà vẫn ĐẠT — kiểm toàn vẹn theo loại");
  assert.equal(alpha.offsite.state, "OK");
  assert.equal(alpha.chatbot.state, "NOT_APPLICABLE");
  assert.ok(xa(hai.ra).some((f) => /^\.\/orgs\/erp_org_alpha\/daily\/erp_org_alpha-\d{8}-\d{4}\.dump$/.test(f)), "bản ngoài máy của alpha nằm dưới orgs/erp_org_alpha/daily/");
  assert.match(phan(hai.ra, "DOCKER"), /^rclone delete gia:orgs\/erp_org_alpha\/daily --min-age /m, "dọn ngoài máy của tổ chức ở ĐÚNG thư mục của nó — không đụng daily/ của nhà");

  // beta: hỏng, nói rõ, không để lại tệp.
  const beta = parseBackupRun(JSON.parse(phan(hai.ra, "BETA")));
  assert.equal(beta?.result, "FAILED");
  assert.match(beta?.reason ?? "", /pg_dump erp_org_beta lỗi: pg_dump: loi gia erp_org_beta/, "lý do mang dòng lỗi thật của pg_dump");
  assert.ok(!files.some((f) => f.startsWith("orgs/erp_org_beta/") && f.endsWith(".dump")) && !files.some((f) => f.includes(".dang-ghi")), "beta hỏng ⇒ không bản nào, không tệp đang-ghi");
  assert.ok(!phan(hai.ra, "STATUSFILES").includes("orgs/erp_org_beta/last-success.json"), "lượt hỏng KHÔNG được ghi thành bản thành công của beta");

  // Tên lạ: không bao giờ tới pg_dump.
  assert.ok(!/erp_org_Bad/.test(phan(hai.ra, "DOCKER").split("\n").filter((l) => l.includes("pg_dump")).join("\n")), "tên CSDL lạ KHÔNG được đi vào lệnh pg_dump");
  assert.match(out, /bỏ qua CSDL tên lạ/);

  // Tổng hợp: nói rõ tổ chức nào hỏng, tổ chức nào không sao lưu được.
  const tong = parseOrgBackupSummary(JSON.parse(phan(hai.ra, "SUMMARY")));
  assert.ok(tong, "tệp tổng hợp phải đọc được bằng bộ đọc của ERP");
  assert.deepEqual(tong.organizations.map((o) => `${o.database}=${o.result}`), ["erp_org_alpha=OK", "erp_org_beta=FAILED"]);
  assert.deepEqual(tong.missingDatabases, ["erp_org_gamma_x"], "tổ chức trong sổ mà không có CSDL trên erp-db phải được NÊU, không im lặng");
  assert.match(out, /::warning::\[sao-lưu\] tổ chức gamma-x có trong sổ nhưng KHÔNG có CSDL erp_org_gamma_x/);
  assert.match(out, /CSDL nhà đã sao lưu ĐẠT; CSDL tổ chức khác hỏng: erp_org_beta/, "dòng cuối nói rõ nhà ĐẠT và tổ chức NÀO hỏng");

  // ───────── Mục lục thiếu bảng lõi ⇒ tổ chức đó hỏng, bản bị xoá; nhà vẫn đạt ─────────
  const thieu = chayBash(khungToChuc(), { STUB_ORGS: "erp_org_alpha\n", STUB_THIEU_SETTINGS: "erp_org_alpha" });
  assert.equal(phan(thieu.ra, "EXIT"), "1");
  assert.equal(parseBackupRun(JSON.parse(phan(thieu.ra, "RUN")))?.result, "OK", "nhà vẫn ĐẠT");
  assert.match(parseBackupRun(JSON.parse(phan(thieu.ra, "ALPHA")))?.reason ?? "", /thiếu dữ liệu bảng lõi: public\.settings/);
  assert.ok(!phan(thieu.ra, "ORGFILES").split("\n").some((f) => f.endsWith(".dump")), "bản thiếu bảng lõi bị XOÁ");

  // ───────── Không liệt kê được CSDL tổ chức ⇒ CHƯA BIẾT: thoát 1, nhà vẫn đạt, tổng hợp mang lỗi ─────────
  const khongLiet = chayBash(khungToChuc(), { STUB_LIST_ORG: "loi" });
  assert.equal(phan(khongLiet.ra, "EXIT"), "1", "không liệt kê được ⇒ không được im lặng coi như không có tổ chức");
  assert.equal(parseBackupRun(JSON.parse(phan(khongLiet.ra, "RUN")))?.result, "OK");
  assert.match(parseOrgBackupSummary(JSON.parse(phan(khongLiet.ra, "SUMMARY")))?.listError ?? "", /CHƯA BIẾT/);

  console.log(`✓ Tổ chức khác nhà (cmd_run chạy thật): 0 CSDL erp_org_* ⇒ không tệp, không lệnh thêm · 2 tổ chức + 1 hỏng ⇒ trạng thái / tệp / bản ngoài máy của NHÀ giống hệt lượt không có tổ chức, nhà vẫn OK · alpha không có orders vẫn đạt, xoay vòng giữ ${ngay} bản của chính nó, ngoài máy dưới orgs/<csdl>/ · beta hỏng ⇒ FAILED có lý do, không tệp dở · tên lạ không tới pg_dump · tổ chức trong sổ thiếu CSDL được nêu · thiếu bảng lõi ⇒ xoá bản · không liệt kê được ⇒ thoát 1`);
}

export async function testChamSaoLuuToChuc() {
  const BAY_GIO = new Date("2026-09-24T03:00:00Z");
  const truoc = (gio: number) => new Date(BAY_GIO.getTime() - gio * 3_600_000).toISOString();
  const nha = { schema: 1, kind: "backup", result: "OK", trigger: "cron", finishedAt: truoc(2), db: { file: "erp-x.dump", bytes: 1, tableData: 3 }, chatbot: { state: "OK" }, offsite: { state: "OK", remote: "gcrypt:" }, retention: { daily: 7 } };
  const cuaToChuc = (database: string, over: Record<string, unknown> = {}) => ({ ...nha, kind: "org-backup", database, chatbot: undefined, db: { file: `${database}-x.dump`, bytes: 1, tableData: 90 }, ...over });
  const dienTapNha = { schema: 1, kind: "restore-drill", result: "OK", finishedAt: truoc(5), tables: [] };
  const A: BackupTarget = { scope: "ORGANIZATION", database: "erp_org_alpha" };

  // Nhà khoẻ trọn năm vế — kiểm lại để phép so dưới đây có nghĩa.
  const duNha = { dirReadable: true, lastRun: nha, lastSuccess: nha, lastDrill: dienTapNha };
  assert.equal(evaluateBackupHealth(duNha, BAY_GIO).state, "HEALTHY");
  // Đúng lỗi Phase 11 bắt được: tổ chức khác đọc lời khai của nhà ⇒ KHÔNG BAO GIỜ khoẻ.
  const muonNha = evaluateBackupHealth(duNha, BAY_GIO, A);
  assert.equal(muonNha.state, "DOWN", "lời khai của NHÀ không phải căn cứ cho tổ chức khác — tổ chức B không được thấy 'sao lưu tốt' của VNX");
  assert.equal(muonNha.lastSuccess, null);
  assert.ok(muonNha.issues.some((i) => /CSDL KHÁC/.test(i.text)), "tệp đặt nhầm chỗ phải được NÓI RA");
  // Chưa có gì ⇒ "chưa có bản sao" của CHÍNH CSDL đó.
  const chua = evaluateBackupHealth({ dirReadable: true }, BAY_GIO, A);
  assert.equal(chua.state, "DOWN");
  assert.match(chua.reason, /Chưa có bản sao lưu nào cho CSDL của tổ chức này \(erp_org_alpha\)/);
  // Lời khai của tổ chức KHÁC ⇒ không dùng.
  assert.equal(evaluateBackupHealth({ dirReadable: true, lastRun: cuaToChuc("erp_org_beta"), lastSuccess: cuaToChuc("erp_org_beta") }, BAY_GIO, A).lastSuccess, null, "bản của erp_org_beta không phải bản của erp_org_alpha");
  // Lời khai của tổ chức không đọc được thành bản của NHÀ.
  assert.equal(evaluateBackupHealth({ dirReadable: true, lastRun: cuaToChuc("erp_org_alpha"), lastSuccess: cuaToChuc("erp_org_alpha"), lastDrill: dienTapNha }, BAY_GIO).lastSuccess, null, "lời khai của tổ chức không làm căn cứ cho NHÀ");
  // Tổ chức có bản đủ: không vế bot chat; chưa diễn tập ⇒ vàng, nói thẳng.
  const co = evaluateBackupHealth({ dirReadable: true, lastRun: cuaToChuc("erp_org_alpha"), lastSuccess: cuaToChuc("erp_org_alpha") }, BAY_GIO, A);
  assert.equal(co.state, "DEGRADED");
  assert.equal(co.issues.length, 1, `chỉ còn vế diễn tập: ${co.issues.map((i) => i.text).join(" | ")}`);
  assert.match(co.reason, /Chưa diễn tập khôi phục CSDL của tổ chức này/);
  assert.ok(!co.issues.some((i) => /bot chat/.test(i.text)), "tổ chức khác không có bot chat — không đòi vế đó");
  // Diễn tập của NHÀ không phủ tổ chức; diễn tập ghi đúng CSDL thì có.
  assert.equal(evaluateBackupHealth({ dirReadable: true, lastRun: cuaToChuc("erp_org_alpha"), lastSuccess: cuaToChuc("erp_org_alpha"), lastDrill: dienTapNha }, BAY_GIO, A).lastDrill, null, "diễn tập của nhà không chứng minh gì về CSDL tổ chức");
  assert.equal(
    evaluateBackupHealth({ dirReadable: true, lastRun: cuaToChuc("erp_org_alpha"), lastSuccess: cuaToChuc("erp_org_alpha"), lastDrill: { ...dienTapNha, database: "erp_org_alpha" } }, BAY_GIO, A).state,
    "HEALTHY",
  );
  // CSDL ở máy khác ⇒ đỏ, nói rõ vì sao.
  assert.equal(evaluateBackupHealth({ dirReadable: true }, BAY_GIO, { ...A, externalDatabase: true }).issues[0].state, "DOWN");
  // Lời khai tổ chức thiếu tên CSDL ⇒ không thuộc về ai.
  assert.equal(parseBackupRun({ ...cuaToChuc("x"), database: undefined }), null);

  // Nhà: tổng hợp tổ chức đọc được, KHÔNG làm đổi mức của nhà.
  const tong = { schema: 1, kind: "org-backup-summary", finishedAt: truoc(1), listError: null, organizations: [{ database: "erp_org_beta", result: "FAILED", reason: "x" }], missingDatabases: [] };
  const nhaCoTong = evaluateBackupHealth({ ...duNha, orgSummary: tong }, BAY_GIO);
  assert.equal(nhaCoTong.state, "HEALTHY", "CSDL của khách khác hỏng không làm sao lưu của VNX 'xấu đi' — nó là dòng riêng");
  assert.deepEqual(nhaCoTong.organizations?.organizations.map((o) => o.result), ["FAILED"]);
  assert.equal(evaluateBackupHealth({ ...duNha, orgSummary: tong }, BAY_GIO, A).organizations, null, "tổ chức khác không bao giờ thấy tổng hợp của các tổ chức");

  // ───────── Đọc đĩa thật: thư mục có lời khai của NHÀ, tổ chức chưa có gì ─────────
  const dir = mkdtempSync(path.join(tmpdir(), "trang-thai-sao-luu-"));
  try {
    writeFileSync(path.join(dir, "last-run.json"), JSON.stringify(nha));
    writeFileSync(path.join(dir, "last-success.json"), JSON.stringify(nha));
    writeFileSync(path.join(dir, "last-drill.json"), JSON.stringify(dienTapNha));
    const tepA = await readBackupStatusFiles(dir, A);
    assert.equal(tepA.lastRun, undefined, "tổ chức đọc thư mục của CHÍNH nó — không đọc last-run.json của nhà");
    assert.equal(evaluateBackupHealth(tepA, BAY_GIO, A).state, "DOWN");
    mkdirSync(path.join(dir, "orgs", "erp_org_alpha"), { recursive: true });
    writeFileSync(path.join(dir, "orgs", "erp_org_alpha", "last-success.json"), JSON.stringify(cuaToChuc("erp_org_alpha")));
    assert.equal(parseBackupRun((await readBackupStatusFiles(dir, A)).lastSuccess)?.database, "erp_org_alpha");
    // Tên CSDL lạ không bao giờ thành đường dẫn.
    const la = await readBackupStatusFiles(dir, { scope: "ORGANIZATION", database: "../status" });
    assert.deepEqual(la, { dirReadable: true }, "tên CSDL không khớp mẫu ⇒ không đọc tệp nào");
    assert.equal(backupTargetFor({ code: "home", isHome: true }).scope, "HOME");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("✓ Chấm sao lưu theo tổ chức: lời khai của nhà / của tổ chức khác không bao giờ là căn cứ cho một tổ chức (DOWN 'chưa có bản sao', nói ra tệp đặt nhầm) · tổ chức không có vế bot chat · diễn tập của nhà không phủ tổ chức · CSDL ở máy khác ⇒ đỏ · tổng hợp tổ chức chỉ nhà thấy và không đổi mức của nhà · đọc đĩa thật: tổ chức chỉ đọc orgs/<csdl>/, tên lạ không thành đường dẫn");
}

/* ═════════════ 11 · DIỄN TẬP KHÔI PHỤC MỘT CSDL TỔ CHỨC (restore-drill-org) — CHẠY TAY ═════════════ */

/** Thân một hàm shell (từ `ten() {` tới `}` đầu dòng), đã bỏ chú thích. */
function thanHam(ten: string): string {
  const code = src().replace(/\r\n/g, "\n");
  const i = code.indexOf(`\n${ten}() {`);
  assert.ok(i >= 0, `scripts/erp-backup.sh phải có hàm ${ten}`);
  return boChuThichShell(code.slice(i, code.indexOf("\n}\n", i)));
}

export function testDienTapToChucMaNguon() {
  const { toChuc } = tachPhanToChuc();
  const khoi = boChuThichShell(toChuc);
  const dt = thanHam("cmd_restore_drill_to_chuc");
  // Đích khôi phục KHÔNG BAO GIỜ là erp-db.
  assert.ok(!/\b(dropdb|createdb)\b|alter database/i.test(khoi), "khối tổ chức không được tạo / xoá / đổi tên CSDL nào — CSDL tạm sống và chết cùng container tạm");
  for (const dong of khoi.split("\n").filter((d) => /"\$DB_CONTAINER"/.test(d) && /docker exec/.test(d))) {
    assert.ok(/ psql -U erp -d /.test(dong) && /select (count\(\*\)|\(pg_database_size)/.test(dong) || /pg_dump -U erp -d "\$csdl" -Fc/.test(dong) || /pg_restore --list/.test(dong) || /datname|platform_organizations/.test(dong), `lệnh vào erp-db trong khối tổ chức chỉ được ĐỌC: ${dong.trim()}`);
  }
  assert.ok(!/"\$DB_CONTAINER"[^\n]*pg_restore -U|pg_restore -U[^\n]*"\$DB_CONTAINER"/.test(dt), "diễn tập tổ chức KHÔNG BAO GIỜ pg_restore vào erp-db");
  assert.match(dt, /docker exec "\$DRILL_TEN_TO_CHUC" pg_restore -U erp -d "\$tam"/, "pg_restore vào CSDL tạm trong container tạm");
  assert.match(dt, /-e POSTGRES_DB="\$tam"/, "CSDL tạm dựng bằng POSTGRES_DB của container tạm");
  assert.match(dt, /--network none/, "container diễn tập KHÔNG có mạng");
  assert.ok(!/ -p |--publish/.test(dt), "container diễn tập KHÔNG mở cổng");
  assert.match(dt, /--memory "\$BO_NHO_DIEN_TAP" --memory-swap "\$BO_NHO_DIEN_TAP"/, "trần bộ nhớ như diễn tập nhà");
  assert.match(dt, /trap don_dien_tap_to_chuc EXIT/, "container tạm phải bị xoá cả khi diễn tập hỏng giữa chừng");
  assert.match(thanHam("don_dien_tap_to_chuc"), /docker rm -f -v "\$DRILL_TEN_TO_CHUC"/);
  assert.ok(dt.indexOf("RAM_TOI_THIEU_DIEN_TAP_MB") > 0 && dt.indexOf("RAM_TOI_THIEU_DIEN_TAP_MB") < dt.indexOf("docker run"), "kiểm RAM TRƯỚC khi dựng container");
  assert.ok(dt.indexOf('ten_csdl_tam "$csdl"') < dt.indexOf("docker run"), "tên CSDL tạm qua hàng rào TRƯỚC khi dựng gì");
  // Tên tạm: tiền tố KHÔNG giao với mẫu tên CSDL tổ chức — lượt sao lưu đêm không bao giờ coi nó là một tổ chức.
  const tienTo = /^TIEN_TO_CSDL_TAM="([^"]+)"$/m.exec(src())?.[1];
  assert.equal(tienTo, "tam_khoiphuc_");
  assert.ok(!ORG_BACKUP_DATABASE_PATTERN.test(`${tienTo}x`) && !`${tienTo}`.startsWith("erp_org_"), "tiền tố CSDL tạm không được khớp mẫu erp_org_*");
  // Tự động CHỈ qua MỘT cửa: `drill-org-weekly` (quyết định C7, 29/09/2026). Các đường SAO LƯU không bao giờ gọi diễn tập —
  // dựng Postgres thứ hai giữa một lượt dump là hai tiến trình nặng cùng lúc trên máy ~1,9 GB.
  for (const ham of ["cmd_run", "cmd_cron", "sao_luu_cac_to_chuc", "cmd_sao_luu_gio_to_chuc"]) assert.ok(!/restore_drill_to_chuc|restore-drill-org|drill-org-weekly|dien_tap_tuan/.test(thanHam(ham)), `${ham} không được gọi diễn tập tổ chức`);
  assert.deepEqual(thanHam("cmd_install_cron").match(/erp-backup\.sh (restore-drill-org|drill-org-weekly)\b/g), ["erp-backup.sh drill-org-weekly"], "cron gọi diễn tập tổ chức qua ĐÚNG lệnh drill-org-weekly (tự lọc Chủ nhật), không gọi thẳng restore-drill-org mỗi giờ");
  const tuan = thanHam("cmd_dien_tap_tuan_to_chuc");
  assert.deepEqual(tuan.match(/\bcmd_restore_drill\w*/g), ["cmd_restore_drill_to_chuc"], "diễn tập tuần đi qua ĐÚNG hàm diễn tập tổ chức (CSDL tạm trong container tạm) — không qua diễn tập của nhà");
  assert.ok(!/docker |psql|pg_restore|createdb|dropdb/.test(tuan), "diễn tập tuần không tự chạm Postgres — mọi lệnh đi qua cmd_restore_drill_to_chuc");
  assert.ok(tuan.indexOf("khoa_chong_chong") > 0 && tuan.indexOf("khoa_chong_chong") < tuan.indexOf("cmd_restore_drill_to_chuc"), "cầm khoá sao lưu (FD 7) TRƯỚC khi dựng container tạm");
  // Bảng đếm có thật trong lược đồ, và gồm đủ bảng lõi mà lượt sao lưu đã kiểm.
  const bang = hangSoChuoi("BANG_DIEN_TAP_TO_CHUC");
  const schema = readFileSync("db/schema.ts", "utf8");
  for (const b of bang) if (b.startsWith("public.")) assert.ok(schema.includes(`"${b.slice(7)}"`), `bảng diễn tập ${b} không có trong db/schema.ts`);
  for (const b of hangSoChuoi("BANG_LOI_TO_CHUC")) assert.ok(bang.includes(b), `diễn tập tổ chức phải đếm bảng lõi ${b}`);
  for (const b of ["public.meta_pages", "public.meta_custom_fields", "public.workflow_rules", "public.custom_records"]) assert.ok(bang.includes(b), `diễn tập tổ chức phải đếm bảng cấu hình / dữ liệu ${b}`);

  // Ops: thao tác riêng, làn DOC_NANG, soát ô arg rồi mới gọi CHUNG erp-backup.sh.
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  const opts = ops.slice(ops.indexOf("        options:\n"), ops.indexOf("      days:"));
  assert.match(opts, /^ {10}- restore-drill-org /m, "ops phải có thao tác restore-drill-org");
  const lop = (ten: string) => (new RegExp(`^ +${ten}="([^"]*)"`, "m").exec(ops)?.[1] ?? "").split(/\s+/);
  assert.ok(lop("DOC_NANG").includes("restore-drill-org"), "restore-drill-org: làn DOC_NANG — dựng một Postgres thứ hai trên máy 2 GB");
  const i = ops.indexOf("\n              restore-drill-org)\n");
  assert.ok(i > 0, "không tìm thấy nhánh restore-drill-org");
  const nhanh = ops.slice(i, ops.indexOf('"$ARG" ;;', i) + '"$ARG" ;;'.length);
  assert.match(nhanh, /case "\$ARG" in\s*\n\s*\*\[!a-z0-9_-\]\*\)/, "ô arg phải qua danh sách ký tự CHO PHÉP trước khi tới script");
  assert.match(nhanh, /bash "\$SB" restore-drill-org "\$ARG" ;;$/, "ops gọi CHUNG scripts/erp-backup.sh");
  console.log(`✓ Diễn tập tổ chức (mã nguồn): đích là CSDL tạm ${tienTo}<mã> trong container tạm (không mạng, không cổng, trần RAM, trap dọn), 0 lệnh createdb/dropdb/alter database, erp-db chỉ bị ĐỌC · kiểm RAM + tên tạm TRƯỚC khi dựng · tự động chỉ qua drill-org-weekly (cầm FD 7 trước), không đường sao lưu nào gọi · ${bang.length} bảng đều có trong lược đồ · ops restore-drill-org làn DOC_NANG, soát arg`);
}

/** Khung chạy diễn tập tổ chức THẬT với docker / free / df giả. */
function khungDienTap(lenh: string, truoc = ""): string {
  return [
    "#!/usr/bin/env bash",
    "set -uo pipefail",
    'T="$(mktemp -d)"',
    'mkdir -p "$T/bin"',
    "cat > \"$T/bin/docker\" <<'EOF'",
    "#!/usr/bin/env bash",
    'echo "$*" >> "$DOCKER_LOG"',
    'case "$1" in',
    "  inspect) case \"$*\" in *Config.Image*) echo postgres:16-alpine ;; esac ;;",
    "  ps) : ;;",
    '  run) [ "${STUB_RUN:-ok}" = ok ] || exit 1; echo id-gia ;;',
    '  logs) echo "PostgreSQL init process complete; ready for start up." ;;',
    "  rm) : ;;",
    "  exec)",
    '    ct="$2"',
    '    case "$*" in',
    "      *pg_isready*) exit 0 ;;",
    "      *pg_database_size*) echo 42 ;;",
    '      *"pg_restore -U"*) [ "${STUB_RESTORE:-ok}" = ok ] || { echo "pg_restore: error: loi gia" >&2; exit 1; } ;;',
    '      *"select count(*) from"*)',
    '        b="${!#}"; b="${b##*from }"',
    '        if [ "$ct" = erp-db ]; then echo 5; else case " ${STUB_RONG:-} " in *" $b "*) echo 0 ;; *) echo 4 ;; esac; fi ;;',
    "    esac ;;",
    "esac",
    "EOF",
    "cat > \"$T/bin/free\" <<'EOF'",
    "#!/usr/bin/env bash",
    'echo "              total        used        free      shared  buff/cache   available"',
    'echo "Mem:           1900         800         300          10         800        ${STUB_RAM:-1200}"',
    "EOF",
    "cat > \"$T/bin/df\" <<'EOF'",
    "#!/usr/bin/env bash",
    'echo "Filesystem 1048576-blocks Used Available Capacity Mounted"',
    'echo "/dev/gia 40000 1 999999 1% /"',
    "EOF",
    'chmod +x "$T/bin/docker" "$T/bin/free" "$T/bin/df"',
    'export PATH="$T/bin:$PATH" DOCKER_LOG="$T/docker.log"',
    'export ERP_BACKUP_DIR="$T/backups" ERP_DIR="$T/erp" ERP_LOCK_DIR="$T/locks"',
    ': > "$DOCKER_LOG"',
    `source "${bashPath(SCRIPT)}"`,
    "set +e",
    "giu_khoa() { return 0; }   # khoá: đo riêng bằng flock THẬT (testKhoaSaoLuuChayThat)",
    'for c in alpha beta; do mkdir -p "$ERP_BACKUP_DIR/orgs/erp_org_$c/daily" "$ERP_BACKUP_DIR/orgs/erp_org_$c/manual"; done',
    'for m in 20260925-0217 20260926-0217; do echo "PGDMP" > "$ERP_BACKUP_DIR/orgs/erp_org_alpha/daily/erp_org_alpha-$m.dump"; done',
    'echo "PGDMP" > "$ERP_BACKUP_DIR/orgs/erp_org_alpha/manual/erp_org_alpha-20260927-1015.dump"',
    'echo "rac" > "$ERP_BACKUP_DIR/orgs/erp_org_alpha/manual/erp_org_alpha-20991231-2359.dump.dang-ghi"',
    truoc,
    `( set -e; ${lenh} ) > "$T/out" 2>&1; rc=$?`, // set -e: ĐÚNG cờ của script khi chạy thật
    'echo "@@EXIT"; echo "$rc"',
    'echo "@@OUT"; cat "$T/out"',
    'echo "@@ALPHA"; cat "$T/backups/status/orgs/erp_org_alpha/last-drill.json" 2>/dev/null',
    'echo "@@BETA"; cat "$T/backups/status/orgs/erp_org_beta/last-drill.json" 2>/dev/null',
    'echo "@@NHA"; ls "$T/backups/status/last-drill.json" 2>/dev/null',
    'echo "@@TUAN"; cat "$T/backups/status/drill-org-week-done" 2>/dev/null',
    'echo "@@DOCKER"; cat "$DOCKER_LOG"',
    'echo "@@HET"',
    'rm -rf "$T"',
    "",
  ].join("\n");
}

export function testDienTapToChucChayThat() {
  const bang = hangSoChuoi("BANG_DIEN_TAP_TO_CHUC");
  const lenhDocker = (ra: string) => phan(ra, "DOCKER").split("\n").filter(Boolean);
  const chiDocErpDb = (ra: string) => {
    for (const l of lenhDocker(ra).filter((d) => /^exec (-i )?erp-db /.test(d))) {
      assert.match(l, /^exec erp-db psql -U erp -d \S+ -Atc select (count\(\*\) from |\(pg_database_size)/, `lệnh vào erp-db phải chỉ ĐỌC: ${l}`);
    }
  };

  // ───────── ĐẠT — qua ĐÚNG đường main, bản MỚI NHẤT theo tên, CSDL tạm trong container tạm, dọn khi xong ─────────
  const dat = chayBash(khungDienTap("main restore-drill-org alpha"));
  assert.equal(phan(dat.ra, "EXIT"), "0", `diễn tập đạt phải thoát 0:\n${dat.ra}`);
  const ld = lenhDocker(dat.ra);
  const run = ld.find((l) => l.startsWith("run "));
  assert.ok(run, "phải dựng container tạm");
  assert.match(run, /--label erp\.restore-drill-org=1 --network none --memory 512m --memory-swap 512m/);
  assert.match(run, /-e POSTGRES_DB=tam_khoiphuc_alpha /, "CSDL tạm tên tam_khoiphuc_<mã> — KHÔNG bắt đầu bằng erp_org_");
  assert.match(run, /erp_org_alpha-20260927-1015\.dump:\/drill\/ban\.dump:ro/, "chọn bản MỚI NHẤT theo mốc trong tên (manual/ mới hơn daily/), bỏ tệp .dang-ghi");
  const ten = /--name (erp-restore-drill-org-\d+)/.exec(run)?.[1];
  assert.ok(ten);
  assert.ok(ld.some((l) => l.startsWith(`exec ${ten} pg_restore -U erp -d tam_khoiphuc_alpha --no-owner --no-privileges`)), "pg_restore vào CSDL tạm trong container tạm");
  chiDocErpDb(dat.ra);
  assert.equal(ld.at(-1), `rm -f -v ${ten}`, "lệnh docker cuối cùng là xoá container tạm (trap EXIT)");
  const drill = parseBackupDrill(JSON.parse(phan(dat.ra, "ALPHA")));
  assert.ok(drill, "trạng thái diễn tập phải đọc được bằng CHÍNH bộ đọc của ERP");
  assert.equal(drill.database, "erp_org_alpha");
  assert.equal(drill.result, "OK");
  assert.equal(drill.dumpFile, "erp_org_alpha-20260927-1015.dump");
  assert.deepEqual(drill.tables.map((t) => `${t.name}=${t.restored}/${t.live}`), bang.map((b) => `${b}=4/5`));
  assert.equal(phan(dat.ra, "NHA"), "", "diễn tập tổ chức KHÔNG ghi last-drill.json của nhà");
  // ERP: tổ chức có bản + diễn tập của CHÍNH nó ⇒ hết vàng "chưa diễn tập".
  const bayGio = new Date(drill.finishedAt.getTime() + 3_600_000);
  const banToChuc = { schema: 1, kind: "org-backup", database: "erp_org_alpha", result: "OK", trigger: "cron", finishedAt: new Date(bayGio.getTime() - 2 * 3_600_000).toISOString(), db: { file: "erp_org_alpha-x.dump", bytes: 1, tableData: 90 }, offsite: { state: "OK", remote: "gcrypt:" }, retention: { daily: 7 } };
  const A: BackupTarget = { scope: "ORGANIZATION", database: "erp_org_alpha" };
  const suc = evaluateBackupHealth({ dirReadable: true, lastRun: banToChuc, lastSuccess: banToChuc, lastDrill: JSON.parse(phan(dat.ra, "ALPHA")) }, bayGio, A);
  assert.equal(suc.state, "HEALTHY", `thẻ của tổ chức phải nhận diễn tập của chính nó: ${suc.issues.map((x) => x.text).join(" | ")}`);
  assert.equal(evaluateBackupHealth({ dirReadable: true, lastDrill: JSON.parse(phan(dat.ra, "ALPHA")) }, bayGio).lastDrill, null, "diễn tập của tổ chức không làm căn cứ cho NHÀ");

  // ───────── pg_restore lỗi ⇒ FAILED, container VẪN bị xoá ─────────
  const hong = chayBash(khungDienTap("main restore-drill-org alpha"), { STUB_RESTORE: "loi" });
  assert.equal(phan(hong.ra, "EXIT"), "1");
  assert.equal(parseBackupDrill(JSON.parse(phan(hong.ra, "ALPHA")))?.result, "FAILED");
  assert.match(lenhDocker(hong.ra).at(-1) ?? "", /^rm -f -v erp-restore-drill-org-\d+$/, "diễn tập hỏng giữa chừng vẫn xoá container tạm");
  chiDocErpDb(hong.ra);

  // ───────── Bản khôi phục RỖNG ở bảng mà CSDL sống có dòng ⇒ FAILED, nói tên bảng ─────────
  const rong = chayBash(khungDienTap("main restore-drill-org alpha"), { STUB_RONG: "public.meta_pages" });
  assert.equal(phan(rong.ra, "EXIT"), "1");
  assert.match(parseBackupDrill(JSON.parse(phan(rong.ra, "ALPHA")))?.reason ?? "", /public\.meta_pages\(rỗng\)/);

  // ───────── Không có bản ⇒ SKIPPED, không dựng gì ─────────
  const khongBan = chayBash(khungDienTap("main restore-drill-org beta"));
  assert.equal(phan(khongBan.ra, "EXIT"), "1");
  assert.equal(parseBackupDrill(JSON.parse(phan(khongBan.ra, "BETA")))?.result, "SKIPPED");
  assert.ok(!lenhDocker(khongBan.ra).some((l) => l.startsWith("run ")), "không có bản ⇒ không dựng container");

  // ───────── RAM thiếu ⇒ SKIPPED, không dựng gì ─────────
  const ram = chayBash(khungDienTap("main restore-drill-org alpha"), { STUB_RAM: "300" });
  assert.equal(phan(ram.ra, "EXIT"), "1");
  assert.match(parseBackupDrill(JSON.parse(phan(ram.ra, "ALPHA")))?.reason ?? "", /RAM dùng được 300 MB/);
  assert.ok(!lenhDocker(ram.ra).some((l) => l.startsWith("run ")));

  // ───────── Tham số lạ ⇒ thoát 2, KHÔNG một lệnh docker nào ─────────
  for (const xau of ["a;rm -rf /", "../x", "ALPHA", "erp_org_a b", "-x"]) {
    const r = chayBash(khungDienTap(`main restore-drill-org ${bq(xau)}`));
    assert.equal(phan(r.ra, "EXIT"), "2", `tham số ${JSON.stringify(xau)} phải bị từ chối`);
    assert.deepEqual(lenhDocker(r.ra), [], `tham số ${JSON.stringify(xau)}: không lệnh docker nào được chạy`);
  }

  // ───────── Hàm thuần: mọi tên hợp lệ ⇒ tên tạm KHÔNG khớp erp_org_* ─────────
  const tenHam = chayBash(
    [
      "#!/usr/bin/env bash",
      'T="$(mktemp -d)"',
      'export ERP_BACKUP_DIR="$T/backups" ERP_DIR="$T/erp" ERP_LOCK_DIR="$T/locks"',
      `source "${bashPath(SCRIPT)}"`,
      "set +e",
      'echo "@@TEN"',
      ...["bp-a", "erp_org_bp_a", "a1", "org-x-y", "erp_org_x9"].map((v) => `c="$(csdl_tu_ma_to_chuc ${bq(v)})"; t="$(ten_csdl_tam "$c")"; echo "$c|$t"`),
      'echo "@@SAI"',
      ...["", "Bp", "1a", "a", "erp_org_", "bp_a;x"].map((v) => `csdl_tu_ma_to_chuc ${bq(v)} >/dev/null; echo "$?"`),
      'ten_csdl_tam erp_org_ >/dev/null; echo "$?"',
      'rm -rf "$T"',
      "",
    ].join("\n"),
  );
  const cap = phan(tenHam.ra, "TEN").split("\n");
  assert.deepEqual(cap, ["erp_org_bp_a|tam_khoiphuc_bp_a", "erp_org_bp_a|tam_khoiphuc_bp_a", "erp_org_a1|tam_khoiphuc_a1", "erp_org_org_x_y|tam_khoiphuc_org_x_y", "erp_org_x9|tam_khoiphuc_x9"]);
  for (const d of cap) assert.ok(!ORG_BACKUP_DATABASE_PATTERN.test(d.split("|")[1]), "tên tạm không bao giờ khớp mẫu CSDL tổ chức");
  assert.ok(phan(tenHam.ra, "SAI").split("\n").every((x) => x === "1"), `mã sai ⇒ trả 1: ${phan(tenHam.ra, "SAI")}`);

  // ───────── LUÂN PHIÊN: không mã ⇒ tổ chức CHƯA diễn tập đứng trước tổ chức vừa diễn tập ─────────
  const luan = chayBash(
    khungDienTap(
      "main restore-drill-org",
      [
        'echo "PGDMP" > "$ERP_BACKUP_DIR/orgs/erp_org_beta/daily/erp_org_beta-20260926-0217.dump"',
        'mkdir -p "$ERP_BACKUP_DIR/status/orgs/erp_org_alpha"',
        'printf \'{"schema":1,"kind":"restore-drill","database":"erp_org_alpha","result":"OK","finishedAt":"2026-09-27T20:00:00Z"}\\n\' > "$ERP_BACKUP_DIR/status/orgs/erp_org_alpha/last-drill.json"',
      ].join("\n"),
    ),
  );
  assert.equal(phan(luan.ra, "EXIT"), "0", luan.ra);
  assert.match(phan(luan.ra, "OUT"), /luân phiên chọn erp_org_beta/);
  assert.equal(parseBackupDrill(JSON.parse(phan(luan.ra, "BETA")))?.result, "OK");
  const trongKhong = chayBash(khungDienTap("main restore-drill-org", 'rm -rf "$ERP_BACKUP_DIR/orgs"'));
  assert.equal(phan(trongKhong.ra, "EXIT"), "0", "không tổ chức nào có bản ⇒ không có gì để diễn tập — không phải lỗi");
  assert.deepEqual(lenhDocker(trongKhong.ra), []);

  console.log(`✓ Diễn tập tổ chức (chạy bash thật qua main): ĐẠT ⇒ bản mới nhất theo tên, CSDL tạm tam_khoiphuc_alpha trong container tạm, ${bang.length} bảng đếm, erp-db chỉ bị đọc, lệnh cuối là xoá container, trạng thái đọc được bằng bộ đọc của ERP và làm thẻ tổ chức HEALTHY (không phải của nhà) · pg_restore lỗi ⇒ FAILED + vẫn dọn · bảng rỗng ⇒ FAILED nêu tên · không bản / thiếu RAM ⇒ SKIPPED, không dựng gì · 5 tham số lạ ⇒ thoát 2, 0 lệnh docker · luân phiên chọn tổ chức chưa diễn tập`);
}

/* ═════════════ 12 · RPO ≤ 1 GIỜ CHO TỔ CHỨC KHÁCH + DIỄN TẬP TỰ ĐỘNG MỖI TUẦN (quyết định C4/C6/C7, 29/09/2026) ═════════════ */

/**
 * Đồng hồ giả của script: MỌI phép tính giờ VN đi qua `gio_vn`. Ghim nó thì bài kiểm không phụ thuộc giờ máy chạy
 * (AGENTS.md mục 50/65) — không có mốc tuyệt đối nào được so với `now()` thật.
 */
const DONG_HO_GIA = 'gio_vn() { date -u -d "$STUB_GIO_VN" "$@"; }';
/** Ghi MỌI lần xin khoá sao lưu (FD 7) vào nhật ký giả — để khẳng định "không lấy khoá", không chỉ "không dump". */
const KHOA_GHI_LAI = 'khoa_chong_chong() { echo "KHOA-SAO-LUU" >> "$DOCKER_LOG"; [ "${STUB_KHOA_BAN:-0}" != 1 ]; }';

export function testLuotGioToChucMaNguon() {
  const code = boChuThichShell(src().replace(/\r\n/g, "\n"));
  const gio = thanHam("cmd_sao_luu_gio_to_chuc");
  // CSDL NHÀ giữ nguyên lịch đêm: lượt giờ không có một lời gọi pg_dump nào — mọi bản đi qua đúng hàm của tổ chức.
  assert.ok(!/pg_dump|-d erp\b/.test(gio), "lượt giờ không tự gọi pg_dump và không bao giờ nhắc `-d erp`");
  assert.match(gio, /sao_luu_mot_to_chuc "\$csdl" "\$moc" hourly/, "mỗi CSDL tổ chức đi qua ĐÚNG hàm của lượt đêm (kiểm ổ đĩa, dump, kiểm mục lục, xoay vòng, ngoài máy)");
  assert.match(gio, /ds="\$\(liet_ke_csdl_to_chuc\)"/, "danh sách lấy từ pg_database qua cùng hàng rào tên với lượt đêm");
  assert.ok(!/\b(sao_luu_bot|cmd_run|xoay_vong_tat_ca|day_ngoai_may) /.test(gio), "lượt giờ không đụng bot chat, không chạy lượt của nhà, không xoay vòng / đẩy thư mục của nhà");
  assert.ok(!/ghi_json "\$STATUS_DIR\/last-|>\s*"\$STATUS_DIR\/daily-done"/.test(gio), "lượt giờ không ghi last-*.json hay daily-done của NHÀ");
  // Thứ tự: liệt kê (rẻ, không khoá) → FD 7 KHÔNG CHỜ → FD 8 → FD 9 → dump.
  const vt = ["liet_ke_csdl_to_chuc", "khoa_chong_chong", "giu_khoa 8", "giu_khoa 9", "sao_luu_mot_to_chuc"].map((x) => gio.indexOf(x));
  assert.ok(vt.every((v, i) => v > 0 && (i === 0 || v > vt[i - 1])), `thứ tự phải là liệt kê → FD 7 → FD 8 → FD 9 → dump (đang ${vt.join(" · ")})`);
  assert.match(gio, /giu_khoa 8 "\$KHOA_DOC_DB" -x "\$TRAN_CHO_KHOA_GIO_GIAY"/);
  assert.match(gio, /giu_khoa 9 "\$KHOA_VONG_DOI" -s "\$TRAN_CHO_KHOA_GIO_GIAY"/);
  assert.ok(hangSo("TRAN_CHO_KHOA_GIO_GIAY") < 3600, "lượt giờ chờ khoá phải NGẮN hơn một giờ — không được treo sang lượt giờ sau");
  // Khung đêm: đọc daily-done của nhà để BỎ lượt, không bao giờ để chạy chen.
  assert.match(gio, /\$GIO_BAT_DAU" \] && \[ "\$gio" -le "\$GIO_KET_THUC" \] && \[ "\$\(cat "\$STATUS_DIR\/daily-done"/, "khung bản đêm mà bản đêm chưa xong ⇒ bỏ lượt");
  // Xoay vòng + dọn ngoài máy của hourly/ suy từ ĐÚNG MỘT hằng số.
  assert.equal((code.match(/^GIU_BAN_GIO=/gm) ?? []).length, 1, "GIU_BAN_GIO khai đúng một lần");
  assert.ok(hangSo("GIU_BAN_GIO") >= 24, "giữ ít nhất một ngày bản giờ — phủ tới bản đêm kế tiếp");
  assert.match(thanHam("sao_luu_mot_to_chuc"), /xoay_vong "\$goc\/hourly" "\$csdl" "\$GIU_BAN_GIO"/);
  assert.match(thanHam("day_ngoai_may_to_chuc"), /rclone delete "\$\(noi_duong "\$remote" "orgs\/\$csdl\/hourly"\)" --min-age "\$\(\(GIU_BAN_GIO \+ 1\)\)h"/);
  // Ba lịch, ba phút khác nhau.
  const phut = ["PHUT_CRON", "PHUT_CRON_GIO", "PHUT_CRON_DIEN_TAP"].map(hangSo);
  assert.equal(new Set(phut).size, 3, `ba lịch phải ở ba phút khác nhau (đang ${phut.join(", ")})`);
  for (const p of phut) assert.ok(p >= 0 && p <= 59);
  assert.ok(hangSo("GIO_DIEN_TAP_BAT_DAU") > hangSo("GIO_KET_THUC"), "diễn tập tuần chạy SAU khung bản đêm — diễn tập bản vừa sinh, không tranh máy với nó");
  console.log(`✓ Lượt giờ tổ chức (mã nguồn): 0 lời gọi pg_dump / -d erp, qua đúng sao_luu_mot_to_chuc · liệt kê → FD 7 → FD 8 → FD 9 · chờ khoá ${hangSo("TRAN_CHO_KHOA_GIO_GIAY")}s < 1 giờ · bỏ lượt khi bản đêm chưa xong · giữ ${hangSo("GIU_BAN_GIO")} bản giờ, dọn Drive suy từ cùng hằng số · ba lịch ba phút`);
}

export function testLuotGioToChucChayThat() {
  const giu = hangSo("GIU_BAN_GIO");
  const gio = (env: Record<string, string>, truoc = "", lenh = "main hourly-org") =>
    chayBash(khungToChuc([DONG_HO_GIA, KHOA_GHI_LAI, truoc].join("\n"), lenh), { STUB_GIO_VN: "2026-09-29 10:47", ...env });
  const dong = (ra: string, ten: string) => phan(ra, ten).split("\n").filter(Boolean);
  const dump = (ra: string) => dong(ra, "DOCKER").filter((l) => l.includes("pg_dump"));

  // ───────── KHÔNG CÓ CSDL erp_org_* (production hôm nay) ⇒ thoát 0, im lặng, không khoá, không tệp ─────────
  const khong = gio({ STUB_ORGS: "" });
  assert.equal(phan(khong.ra, "EXIT"), "0", `không có tổ chức ⇒ thoát 0:\n${khong.ra}`);
  assert.equal(phan(khong.ra, "OUT"), "", "không có tổ chức ⇒ không một dòng log (cron gọi mỗi giờ)");
  assert.deepEqual(dong(khong.ra, "DOCKER").map((l) => l.replace(/ -Atc .*/, "")), ["exec erp-db psql -U erp -d erp"], "chỉ đúng MỘT câu đọc pg_database — không khoá, không dump");
  assert.equal(phan(khong.ra, "STATUSFILES"), "", "không ghi tệp trạng thái nào");
  assert.equal(phan(khong.ra, "ORGFILES"), "");

  // ───────── HAI TỔ CHỨC: alpha tốt (đã có đầy hourly/), beta pg_dump lỗi ─────────
  const tao = [
    'mkdir -p "$ERP_BACKUP_DIR/orgs/erp_org_alpha/hourly" "$ERP_BACKUP_DIR/orgs/erp_org_alpha/daily" "$ERP_BACKUP_DIR/daily"',
    `for i in $(seq 1 ${giu + 3}); do touch "$ERP_BACKUP_DIR/orgs/erp_org_alpha/hourly/erp_org_alpha-20260926-$(printf %04d $i).dump"; done`,
    'touch "$ERP_BACKUP_DIR/orgs/erp_org_alpha/daily/erp_org_alpha-20260929-0217.dump" "$ERP_BACKUP_DIR/daily/erp-20260929-0217.dump"',
  ].join("\n");
  const hai = gio({ STUB_ORGS: "erp_org_alpha\nerp_org_beta\n", STUB_DUMP_HONG: "erp_org_beta" }, tao);
  assert.equal(phan(hai.ra, "EXIT"), "1", `một tổ chức hỏng ⇒ lượt giờ thoát 1 (log cron đỏ):\n${hai.ra}`);
  // CSDL NHÀ: không một byte nào.
  assert.deepEqual(dump(hai.ra), ["exec erp-db pg_dump -U erp -d erp_org_alpha -Fc", "exec erp-db pg_dump -U erp -d erp_org_beta -Fc"], "lượt giờ chỉ dump CSDL erp_org_* — KHÔNG BAO GIỜ `-d erp`");
  assert.ok(!dong(hai.ra, "DOCKER").some((l) => l.startsWith("run ")), "lượt giờ không đụng volume bot chat");
  assert.ok(!dong(hai.ra, "DOCKER").some((l) => l.includes("platform_organizations")), "đối chiếu sổ là việc của lượt đêm");
  assert.equal(dong(hai.ra, "DOCKER").filter((l) => l === "KHOA-SAO-LUU").length, 1, "xin khoá sao lưu đúng một lần");
  assert.deepEqual(dong(hai.ra, "DAILY"), ["erp-20260929-0217.dump"], "daily/ của nhà không đổi");
  assert.deepEqual(
    phan(hai.ra, "STATUSFILES").split("\n"),
    ["./orgs-last-hourly.json", "./orgs/erp_org_alpha/last-hourly.json", "./orgs/erp_org_alpha/last-success.json", "./orgs/erp_org_beta/last-hourly.json"],
    "chỉ tệp trạng thái của TỔ CHỨC: không last-run / last-success / daily-done của nhà, không last-run.json của tổ chức (đó là lời khai bản đêm), beta hỏng không có last-success",
  );
  // alpha: xoay vòng hourly/ giữ đúng GIU_BAN_GIO, bản đêm của alpha không bị đụng.
  const files = dong(hai.ra, "ORGFILES");
  const hourly = files.filter((f) => f.startsWith("orgs/erp_org_alpha/hourly/"));
  assert.equal(hourly.length, giu, `hourly/ giữ đúng ${giu} bản`);
  assert.ok(hourly.includes("orgs/erp_org_alpha/hourly/erp_org_alpha-20260929-1047.dump"), "bản giờ mới mang mốc giờ VN trong tên");
  assert.ok(["0001", "0002", "0003", "0004"].every((m) => !hourly.includes(`orgs/erp_org_alpha/hourly/erp_org_alpha-20260926-${m}.dump`)), "bốn bản cũ nhất bị xoay đi");
  assert.ok(files.includes("orgs/erp_org_alpha/daily/erp_org_alpha-20260929-0217.dump"), "bản đêm của tổ chức KHÔNG bị lượt giờ đụng");
  assert.ok(!files.some((f) => f.startsWith("orgs/erp_org_beta/") && f.endsWith(".dump")) && !files.some((f) => f.includes(".dang-ghi")), "beta hỏng ⇒ không bản nào, không tệp dở");
  // Ngoài máy: đúng thư mục hourly/ của alpha; dọn theo tuổi suy từ GIU_BAN_GIO; không đụng daily/weekly/manual.
  assert.deepEqual(dong(hai.ra, "REMOTE"), ["./orgs/erp_org_alpha/hourly/erp_org_alpha-20260929-1047.dump"]);
  // Đuôi `--drive-use-trash=false` từ 08/10/2026 (§13): xoá HẲN, không vào thùng rác Drive — đọc từ CHÍNH hằng số của script.
  assert.deepEqual(dong(hai.ra, "DOCKER").filter((l) => l.startsWith("rclone delete")), [`rclone delete gia:orgs/erp_org_alpha/hourly --min-age ${giu + 1}h ${hangSoChuoi("CO_KHONG_THUNG_RAC")[0]}`], "lượt giờ chỉ dọn hourly/ — không 72 lượt gọi Drive vô ích mỗi ngày");
  // Trạng thái đọc được bằng CHÍNH bộ đọc của ERP.
  const h = parseBackupRun(JSON.parse(phan(hai.ra, "HALPHA")));
  assert.ok(h, "last-hourly.json đọc được bằng bộ đọc của ERP");
  assert.equal(h.scope, "ORGANIZATION");
  assert.equal(h.database, "erp_org_alpha");
  assert.equal(h.trigger, "hourly");
  assert.equal(h.result, "OK");
  assert.equal(h.retention.hourly, giu, "số bản giờ in lên ERP là lời khai của script");
  assert.deepEqual(JSON.parse(phan(hai.ra, "SALPHA")), JSON.parse(phan(hai.ra, "HALPHA")), "bản giờ dùng được ⇒ nó LÀ bản thành công gần nhất");
  assert.match(parseBackupRun(JSON.parse(phan(hai.ra, "HBETA")))?.reason ?? "", /pg_dump erp_org_beta lỗi: pg_dump: loi gia erp_org_beta/);
  const tong = parseOrgBackupSummary(JSON.parse(phan(hai.ra, "HSUMMARY")));
  assert.deepEqual(tong?.organizations.map((o) => `${o.database}=${o.result}`), ["erp_org_alpha=OK", "erp_org_beta=FAILED"]);
  // Thẻ của từng tổ chức đọc được lượt giờ.
  const A: BackupTarget = { scope: "ORGANIZATION", database: "erp_org_alpha" };
  const B: BackupTarget = { scope: "ORGANIZATION", database: "erp_org_beta" };
  const luc = new Date(h.finishedAt.getTime() + 30 * 60_000);
  const theA = evaluateBackupHealth({ dirReadable: true, lastSuccess: JSON.parse(phan(hai.ra, "SALPHA")), lastHourly: JSON.parse(phan(hai.ra, "HALPHA")) }, luc, A);
  assert.equal(theA.lastHourly?.trigger, "hourly");
  assert.ok(!theA.issues.some((i) => /RPO|mỗi giờ/.test(i.text)), `bản giờ 30 phút tuổi ⇒ không vế RPO: ${theA.issues.map((i) => i.text).join(" | ")}`);
  const theB = evaluateBackupHealth({ dirReadable: true, lastHourly: JSON.parse(phan(hai.ra, "HBETA")) }, luc, B);
  assert.equal(theB.state, "DOWN");
  assert.ok(theB.issues.some((i) => /Lượt sao lưu mỗi giờ gần nhất THẤT BẠI: pg_dump erp_org_beta lỗi/.test(i.text)), "lượt giờ hỏng phải hiện trên thẻ của CHÍNH tổ chức đó");

  // ───────── Ngoài máy hỏng ⇒ bản cục bộ GIỮ NGUYÊN, PARTIAL, thoát 1 ─────────
  const ngoai = gio({ STUB_ORGS: "erp_org_alpha\n", STUB_RCLONE_LOI: "1" });
  assert.equal(phan(ngoai.ra, "EXIT"), "1");
  assert.ok(dong(ngoai.ra, "ORGFILES").includes("orgs/erp_org_alpha/hourly/erp_org_alpha-20260929-1047.dump"), "lỗi đẩy Drive KHÔNG làm mất bản cục bộ đã kiểm toàn vẹn");
  const hn = parseBackupRun(JSON.parse(phan(ngoai.ra, "HALPHA")));
  assert.equal(hn?.result, "PARTIAL");
  assert.equal(hn?.offsite.state, "FAILED");
  assert.match(hn?.offsite.reason ?? "", /rclone: loi mang gia/);
  assert.ok(phan(ngoai.ra, "SALPHA").length > 0, "bản cục bộ dùng được ⇒ vẫn là bản thành công gần nhất (thẻ báo vàng vế ngoài máy)");

  // ───────── Khung bản đêm: bản đêm hôm nay CHƯA xong ⇒ bỏ lượt; ĐÃ xong ⇒ chạy ─────────
  const dem = gio({ STUB_ORGS: "erp_org_alpha\n", STUB_GIO_VN: "2026-09-29 03:47" });
  assert.equal(phan(dem.ra, "EXIT"), "0");
  assert.deepEqual(dump(dem.ra), [], "khung đêm, bản đêm chưa xong ⇒ KHÔNG dump (bản đêm sẽ dump cả tổ chức)");
  assert.ok(!dong(dem.ra, "DOCKER").includes("KHOA-SAO-LUU"), "…và không tranh khoá với nó");
  assert.match(phan(dem.ra, "OUT"), /bản đêm hôm nay chưa xong — bỏ lượt/);
  const demXong = gio({ STUB_ORGS: "erp_org_alpha\n", STUB_GIO_VN: "2026-09-29 03:47" }, 'mkdir -p "$ERP_BACKUP_DIR/status"; echo 2026-09-29 > "$ERP_BACKUP_DIR/status/daily-done"');
  assert.equal(phan(demXong.ra, "EXIT"), "0", demXong.ra);
  assert.deepEqual(dump(demXong.ra), ["exec erp-db pg_dump -U erp -d erp_org_alpha -Fc"], "bản đêm hôm nay đã xong ⇒ lượt giờ trong khung vẫn chạy");
  const demHomQua = gio({ STUB_ORGS: "erp_org_alpha\n", STUB_GIO_VN: "2026-09-29 03:47" }, 'mkdir -p "$ERP_BACKUP_DIR/status"; echo 2026-09-28 > "$ERP_BACKUP_DIR/status/daily-done"');
  assert.deepEqual(dump(demHomQua.ra), [], "daily-done của HÔM QUA không phải của hôm nay");

  // ───────── Khoá sao lưu BẬN (bản đêm / diễn tập / lượt giờ trước còn chạy) ⇒ bỏ lượt, thoát 0, không ghi gì ─────────
  const ban = gio({ STUB_ORGS: "erp_org_alpha\n", STUB_KHOA_BAN: "1" });
  assert.equal(phan(ban.ra, "EXIT"), "0", "khoá bận là trạng thái BÌNH THƯỜNG của lượt giờ — không đỏ log mỗi giờ");
  assert.deepEqual(dump(ban.ra), [], "khoá bận ⇒ KHÔNG dump");
  assert.equal(phan(ban.ra, "STATUSFILES"), "", "khoá bận ⇒ không ghi đè trạng thái của lượt đang chạy");
  assert.match(phan(ban.ra, "OUT"), /bỏ lượt giờ này/);

  // ───────── Không liệt kê được ⇒ CHƯA BIẾT: thoát 1, không khoá, không tệp ─────────
  const loiLiet = gio({ STUB_LIST_ORG: "loi" });
  assert.equal(phan(loiLiet.ra, "EXIT"), "1", "không hỏi được Postgres ⇒ KHÔNG im lặng coi như không có tổ chức");
  assert.ok(!dong(loiLiet.ra, "DOCKER").includes("KHOA-SAO-LUU"));
  assert.equal(phan(loiLiet.ra, "STATUSFILES"), "");
  assert.equal(phan(gio({ STUB_ORGS: "" }, "", "main hourly-org thua").ra, "EXIT"), "2", "tham số lạ ⇒ thoát 2");

  // ───────── Khoá THẬT (flock): lượt giờ tới khi một lượt khác cầm FD 7 ⇒ thoát 0 NGAY, 0 lệnh dump ─────────
  if (!coFlock()) {
    assert.notEqual(process.platform, "linux", "Linux PHẢI có flock");
    console.log(`⚠ Lượt giờ + khoá THẬT: CHƯA ĐO ĐƯỢC trên ${process.platform} (không có flock). Nhánh "khoá bận" đã chạy thật với khoá giả ở trên; flock thật đo trên Linux/CI.`);
  } else {
    const r = chayBash(
      [
        "#!/usr/bin/env bash",
        'T="$(mktemp -d)"; mkdir -p "$T/bin" "$T/khoa"',
        "cat > \"$T/bin/docker\" <<'EOF'",
        "#!/usr/bin/env bash",
        'echo "$*" >> "$T_LOG"',
        'case "$*" in *pg_database*) echo erp_org_alpha ;; esac',
        "EOF",
        'chmod +x "$T/bin/docker"',
        'export PATH="$T/bin:$PATH" T_LOG="$T/docker.log" ERP_BACKUP_DIR="$T/backups" ERP_DIR="$T/erp" ERP_LOCK_DIR="$T/khoa"',
        ': > "$T_LOG"',
        // Script chạy với đồng hồ THẬT ở đây: đánh dấu bản đêm hôm nay (giờ VN) đã xong để nhánh "khung đêm" không
        // phụ thuộc giờ CI chạy (mục 50) — bài này đo KHOÁ, không đo khung giờ.
        'mkdir -p "$T/backups/status"; date -u -d "@$(( $(date +%s) + 25200 ))" +%F > "$T/backups/status/daily-done"',
        '( flock -x "$T/khoa/erp-backup.lock" sleep 6 ) & sleep 1',
        `timeout 20 bash "${bashPath(SCRIPT)}" hourly-org > "$T/out" 2>&1; rc=$?`,
        'echo "@@MA"; echo $rc; echo "@@DUMP"; grep -c pg_dump "$T_LOG" || true; echo "@@OUT"; cat "$T/out"',
        "wait",
        'echo "@@HET"; rm -rf "$T"',
        "",
      ].join("\n"),
    );
    assert.equal(phan(r.ra, "MA"), "0", `khoá thật bận ⇒ thoát 0:\n${r.ra}`);
    assert.equal(phan(r.ra, "DUMP"), "0", "khoá thật bận ⇒ 0 lệnh pg_dump");
    assert.match(phan(r.ra, "OUT"), /bỏ lượt giờ này/);
  }

  console.log(`✓ Lượt giờ tổ chức (chạy bash thật qua main): 0 tổ chức ⇒ thoát 0, 0 dòng log, 1 câu đọc, 0 khoá, 0 tệp · 2 tổ chức ⇒ chỉ dump -d erp_org_*, 0 lệnh vào bot / sổ, daily/ + trạng thái của nhà không đổi · hourly/ giữ ${giu} bản, bản đêm của tổ chức không bị đụng · Drive chỉ orgs/<csdl>/hourly/, dọn --min-age ${giu + 1}h · last-hourly.json + last-success.json đọc được bằng bộ đọc ERP, thẻ tổ chức thấy lượt hỏng · Drive lỗi ⇒ bản cục bộ giữ, PARTIAL · khung đêm chưa xong ⇒ bỏ · khoá bận ⇒ thoát 0, 0 dump · psql lỗi ⇒ thoát 1`);
}

export function testDienTapTuanToChucChayThat() {
  const dt = (env: Record<string, string>, truoc = "", lenh = "main drill-org-weekly") =>
    chayBash(khungDienTap(lenh, [DONG_HO_GIA, KHOA_GHI_LAI, truoc].join("\n")), { STUB_GIO_VN: "2026-09-27 06:37", ...env });
  const ld = (ra: string) => phan(ra, "DOCKER").split("\n").filter(Boolean);
  const chiDocErpDb = (ra: string) => {
    for (const l of ld(ra).filter((d) => /^exec (-i )?erp-db /.test(d))) {
      assert.match(l, /^exec erp-db psql -U erp -d \S+ -Atc select (count\(\*\) from |\(pg_database_size)/, `lệnh vào erp-db phải chỉ ĐỌC: ${l}`);
    }
  };
  assert.equal(new Date("2026-09-27T06:37:00Z").getUTCDay(), 0, "mốc thử là Chủ nhật");

  // ───────── Chủ nhật 06:37 ⇒ diễn tập luân phiên vào CSDL TẠM, erp-db chỉ bị đọc, đánh dấu tuần xong ─────────
  const dat = dt({});
  assert.equal(phan(dat.ra, "EXIT"), "0", `diễn tập tuần đạt ⇒ thoát 0:\n${dat.ra}`);
  const l = ld(dat.ra);
  const iKhoa = l.indexOf("KHOA-SAO-LUU");
  const iRun = l.findIndex((x) => x.startsWith("run "));
  assert.ok(iKhoa >= 0 && iRun > iKhoa, "cầm khoá sao lưu TRƯỚC khi dựng container tạm");
  assert.match(l[iRun], /--network none --memory 512m --memory-swap 512m .*-e POSTGRES_DB=tam_khoiphuc_alpha /, "đích là CSDL TẠM trong container TẠM (không mạng, trần RAM)");
  assert.ok(l.some((x) => /^exec erp-restore-drill-org-\d+ pg_restore -U erp -d tam_khoiphuc_alpha /.test(x)), "pg_restore vào CSDL tạm");
  assert.ok(!l.some((x) => /^exec (-i )?erp-db (pg_restore|createdb|dropdb)|^exec (-i )?erp-db .*alter database/i.test(x)), "KHÔNG BAO GIỜ khôi phục đè production");
  chiDocErpDb(dat.ra);
  assert.match(l.at(-1) ?? "", /^rm -f -v erp-restore-drill-org-\d+$/, "lệnh docker cuối là xoá container tạm");
  assert.match(phan(dat.ra, "OUT"), /luân phiên chọn erp_org_alpha/, "beta không có bản trên máy ⇒ luân phiên chọn alpha");
  assert.equal(parseBackupDrill(JSON.parse(phan(dat.ra, "ALPHA")))?.result, "OK", "trạng thái ghi vào status/orgs/<csdl>/last-drill.json — thẻ của tổ chức đọc");
  assert.equal(phan(dat.ra, "NHA"), "", "không ghi last-drill.json của nhà");
  assert.equal(phan(dat.ra, "TUAN"), "2026-09-27", "tuần này đã xong");

  // ───────── Đã xong tuần này / ngoài Chủ nhật / ngoài khung / không tổ chức ⇒ thoát 0, 0 lệnh ─────────
  const daXong = dt({}, 'mkdir -p "$ERP_BACKUP_DIR/status"; echo 2026-09-27 > "$ERP_BACKUP_DIR/status/drill-org-week-done"');
  const ngoai: [string, Ra][] = [
    ["đã diễn tập tuần này", daXong],
    ["thứ Ba", dt({ STUB_GIO_VN: "2026-09-29 06:37" })],
    ["Chủ nhật 05:37 (còn khung bản đêm)", dt({ STUB_GIO_VN: "2026-09-27 05:37" })],
    ["Chủ nhật 08:37 (hết khung)", dt({ STUB_GIO_VN: "2026-09-27 08:37" })],
    ["không tổ chức nào có bản", dt({}, 'rm -rf "$ERP_BACKUP_DIR/orgs"')],
  ];
  for (const [ten, r] of ngoai) {
    assert.equal(phan(r.ra, "EXIT"), "0", `${ten} ⇒ thoát 0`);
    assert.deepEqual(ld(r.ra), [], `${ten} ⇒ không khoá, không một lệnh docker`);
    assert.equal(phan(r.ra, "OUT"), "", `${ten} ⇒ im lặng (cron gọi mỗi giờ)`);
  }
  assert.equal(phan(daXong.ra, "TUAN"), "2026-09-27");

  // ───────── Thiếu RAM ⇒ SKIPPED, KHÔNG đánh dấu (giờ sau thử lại); khoá bận ⇒ không dựng gì, không đánh dấu ─────────
  const ram = dt({ STUB_RAM: "300" });
  assert.equal(parseBackupDrill(JSON.parse(phan(ram.ra, "ALPHA")))?.result, "SKIPPED");
  assert.ok(!ld(ram.ra).some((x) => x.startsWith("run ")));
  assert.equal(phan(ram.ra, "TUAN"), "", "SKIPPED không phải kết luận ⇒ 07 giờ thử lại");
  const ban = dt({ STUB_KHOA_BAN: "1" });
  assert.equal(phan(ban.ra, "EXIT"), "0");
  assert.deepEqual(ld(ban.ra), ["KHOA-SAO-LUU"], "khoá sao lưu bận ⇒ không dựng Postgres thứ hai");
  assert.equal(phan(ban.ra, "TUAN"), "");
  // Kết luận CŨ không được tính là của lượt này: hết giờ chờ khoá (không ghi trạng thái) mà tệp cũ ghi OK.
  const cu = dt(
    {},
    [
      "giu_khoa() { return 1; }",
      'mkdir -p "$ERP_BACKUP_DIR/status/orgs/erp_org_alpha"',
      'printf \'{"schema":1,"kind":"restore-drill","database":"erp_org_alpha","result":"OK","finishedAt":"2026-09-20T00:00:00Z"}\\n\' > "$ERP_BACKUP_DIR/status/orgs/erp_org_alpha/last-drill.json"',
    ].join("\n"),
  );
  assert.equal(phan(cu.ra, "EXIT"), "75", `hết giờ chờ khoá ⇒ mã 75:\n${cu.ra}`);
  assert.equal(phan(cu.ra, "TUAN"), "", "kết luận OK của tuần TRƯỚC không được đánh dấu tuần này xong");

  // ───────── pg_restore lỗi ⇒ FAILED, container vẫn dọn, ĐÁNH DẤU (không thử lại cùng bản) ─────────
  const hong = dt({ STUB_RESTORE: "loi" });
  assert.equal(phan(hong.ra, "EXIT"), "1");
  assert.equal(parseBackupDrill(JSON.parse(phan(hong.ra, "ALPHA")))?.result, "FAILED", "thẻ của tổ chức chuyển đỏ");
  assert.match(ld(hong.ra).at(-1) ?? "", /^rm -f -v erp-restore-drill-org-\d+$/);
  assert.equal(phan(hong.ra, "TUAN"), "2026-09-27", "FAILED là kết luận — không dựng lại Postgres thứ hai mỗi giờ để nhận cùng kết luận");
  chiDocErpDb(hong.ra);
  assert.equal(phan(dt({}, "", "main drill-org-weekly erp_org_alpha").ra, "EXIT"), "2", "tham số lạ ⇒ thoát 2 (chọn tổ chức là việc của restore-drill-org)");

  console.log("✓ Diễn tập tuần (chạy bash thật qua main): Chủ nhật 06:37 ⇒ khoá sao lưu TRƯỚC, container tạm không mạng / trần 512m, CSDL tạm tam_khoiphuc_alpha, erp-db chỉ bị đọc, xoá container, trạng thái vào thư mục của tổ chức, đánh dấu tuần · đã xong / thứ Ba / 05:37 / 08:37 / 0 tổ chức ⇒ 0 lệnh, 0 log · thiếu RAM / khoá bận / kết luận cũ ⇒ không đánh dấu (thử lại giờ sau) · pg_restore lỗi ⇒ FAILED + dọn + đánh dấu");
}

export function testLichToChucMoi() {
  // Dòng của NHÀ không đổi: chạy install-cron của bản ĐÃ GỠ khối tổ chức (đúng bản trước Phase 11 — BAM_PHAN_NHA) và
  // của bản đầy đủ, rồi so. Bản đầy đủ = bản của nhà + ĐÚNG ba dòng nối sau (một chú thích + hai lịch).
  const tmp = mkdtempSync(path.join(tmpdir(), "lich-to-chuc-"));
  try {
    const nhaTep = path.join(tmp, "erp-backup-nha.sh");
    writeFileSync(nhaTep, tachPhanToChuc().nha);
    const r = chayBash(
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'T="$(mktemp -d)"; mkdir -p "$T/bin" "$T/erp"',
        'printf "#!/usr/bin/env bash\\nexit 0\\n" > "$T/bin/cron"; cp "$T/bin/cron" "$T/bin/systemctl"; chmod +x "$T/bin/cron" "$T/bin/systemctl"',
        'export PATH="$T/bin:$PATH" ERP_DIR="$T/erp" ERP_BACKUP_DIR="$T/backups" ERP_LOGROTATE_FILE="$T/logrotate" ERP_BACKUP_LOG="$T/erp-backup.log"',
        "unset BACKUP_OFFSITE_REMOTE",
        `ERP_CRON_FILE="$T/moi" bash "${bashPath(SCRIPT)}" install-cron > /dev/null 2>&1; a=$?`,
        `ERP_CRON_FILE="$T/cu" bash "${bashPath(nhaTep)}" install-cron > /dev/null 2>&1; b=$?`,
        'echo "@@MA"; echo "$a $b"',
        'echo "@@MOI"; cat "$T/moi"',
        'echo "@@CU"; cat "$T/cu"',
        'echo "@@HET"; rm -rf "$T"',
        "",
      ].join("\n"),
    );
    assert.equal(phan(r.ra, "MA"), "0 0", `cả hai bản cài được lịch:\n${r.ra}`);
    const moi = phan(r.ra, "MOI").split("\n");
    const cu = phan(r.ra, "CU").split("\n");
    assert.ok(cu.length >= 5 && cu.some((d) => /erp-backup\.sh cron >> /.test(d)), "bản của nhà có lịch đêm");
    assert.deepEqual(moi.slice(0, cu.length), cu, "mọi dòng lịch của NHÀ giữ nguyên từng byte, đúng thứ tự");
    const them = moi.slice(cu.length);
    assert.equal(them.length, 3, `đúng ba dòng thêm (một chú thích + HAI lịch mới): ${JSON.stringify(them)}`);
    assert.match(them[0], /^# /);
    assert.match(them[1], new RegExp(`^${hangSo("PHUT_CRON_GIO")} \\* \\* \\* \\* root ERP_DIR=\\S+ ERP_BACKUP_DIR=\\S+ /bin/bash \\S+/scripts/erp-backup\\.sh hourly-org >> \\S+ 2>&1$`), `lịch giờ: ${them[1]}`);
    assert.match(them[2], new RegExp(`^${hangSo("PHUT_CRON_DIEN_TAP")} \\* \\* \\* \\* root ERP_DIR=\\S+ ERP_BACKUP_DIR=\\S+ /bin/bash \\S+/scripts/erp-backup\\.sh drill-org-weekly >> \\S+ 2>&1$`), `lịch diễn tập: ${them[2]}`);
    assert.ok(!moi.join("\n").includes("%"), "`%` là ký tự đặc biệt của crontab");
    assert.equal(moi.filter((d) => /erp-backup\.sh /.test(d) && !d.startsWith("#")).length, 3, "tổng cộng đúng BA lịch: đêm (nhà + tổ chức), giờ (tổ chức), diễn tập tuần (tổ chức)");
    console.log(`✓ Lịch cron: ${cu.length} dòng của nhà giữ nguyên từng byte (so với bản gỡ khối tổ chức) · thêm đúng hai lịch: hourly-org phút ${hangSo("PHUT_CRON_GIO")}, drill-org-weekly phút ${hangSo("PHUT_CRON_DIEN_TAP")}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function testChamRpoGio() {
  const BAY_GIO = new Date("2026-09-29T04:00:00Z");
  const truoc = (gio: number) => new Date(BAY_GIO.getTime() - gio * 3_600_000).toISOString();
  const A: BackupTarget = { scope: "ORGANIZATION", database: "erp_org_alpha" };
  const ban = (gio: number, over: Record<string, unknown> = {}) => ({
    schema: 1,
    kind: "org-backup",
    database: "erp_org_alpha",
    result: "OK",
    trigger: "hourly",
    finishedAt: truoc(gio),
    db: { file: "erp_org_alpha-x.dump", bytes: 1, tableData: 90 },
    offsite: { state: "OK", remote: "gcrypt:" },
    retention: { daily: 7, weekly: 4, manual: 3, hourly: 48 },
    ...over,
  });
  const dienTap = { schema: 1, kind: "restore-drill", database: "erp_org_alpha", result: "OK", finishedAt: truoc(30), tables: [] };
  const rpo = (h: ReturnType<typeof evaluateBackupHealth>) => h.issues.filter((i) => /RPO mục tiêu ≤ 1 giờ/.test(i.text));

  const moi = evaluateBackupHealth({ dirReadable: true, lastSuccess: ban(1), lastHourly: ban(1), lastDrill: dienTap }, BAY_GIO, A);
  assert.equal(moi.state, "HEALTHY", `bản giờ 1 giờ tuổi + diễn tập ⇒ khoẻ: ${moi.issues.map((i) => i.text).join(" | ")}`);
  assert.equal(moi.lastSuccess?.retention.hourly, 48);
  assert.deepEqual(rpo(evaluateBackupHealth({ dirReadable: true, lastSuccess: ban(ORG_BACKUP_RPO_ALERT_HOURS), lastDrill: dienTap }, BAY_GIO, A)), [], "đúng ngưỡng chưa phải quá ngưỡng");
  const cham = evaluateBackupHealth({ dirReadable: true, lastSuccess: ban(ORG_BACKUP_RPO_ALERT_HOURS + 1), lastDrill: dienTap }, BAY_GIO, A);
  assert.equal(rpo(cham).length, 1, "quá ngưỡng ⇒ vế RPO");
  assert.equal(cham.state, "DEGRADED", "lỡ vài lượt giờ là VÀNG — bản đêm vẫn còn, không phải mất sao lưu");
  assert.equal(evaluateBackupHealth({ dirReadable: true, lastSuccess: ban(BACKUP_MAX_AGE_HOURS + 1), lastDrill: dienTap }, BAY_GIO, A).state, "DOWN", "quá ngưỡng ngày ⇒ vẫn ĐỎ như trước");
  // NHÀ không bị chấm theo mục tiêu giờ — RPO của nhà vẫn ≤ 1 ngày cho tới khi có PITR.
  const nha = { ...ban(20), kind: "backup", database: undefined, trigger: "cron", chatbot: { state: "OK" } };
  const theNha = evaluateBackupHealth({ dirReadable: true, lastRun: nha, lastSuccess: nha, lastDrill: { ...dienTap, database: undefined }, lastHourly: ban(0) }, BAY_GIO);
  assert.equal(theNha.state, "HEALTHY", `nhà: bản đêm 20 giờ tuổi vẫn khoẻ, lượt giờ của tổ chức không bao giờ chạm thẻ của nhà: ${theNha.issues.map((i) => i.text).join(" | ")}`);
  assert.equal(theNha.lastHourly, null);
  // Lượt giờ hỏng SAU bản thành công ⇒ vàng, nêu lý do; lượt giờ của CSDL khác ⇒ không dùng, nói ra.
  const hong = evaluateBackupHealth({ dirReadable: true, lastSuccess: ban(1), lastHourly: ban(0, { result: "FAILED", reason: "ổ đầy giả" }), lastDrill: dienTap }, BAY_GIO, A);
  assert.ok(hong.issues.some((i) => i.state === "DEGRADED" && /Lượt sao lưu mỗi giờ gần nhất THẤT BẠI: ổ đầy giả/.test(i.text)));
  assert.equal(evaluateBackupHealth({ dirReadable: true, lastSuccess: ban(0), lastHourly: ban(1, { result: "FAILED" }), lastDrill: dienTap }, BAY_GIO, A).state, "HEALTHY", "lượt hỏng CŨ hơn bản thành công đã tự lành");
  const khac = evaluateBackupHealth({ dirReadable: true, lastSuccess: ban(1), lastHourly: ban(0, { database: "erp_org_beta", result: "FAILED" }), lastDrill: dienTap }, BAY_GIO, A);
  assert.equal(khac.lastHourly, null, "lượt giờ của erp_org_beta không phải của erp_org_alpha");
  assert.ok(khac.issues.some((i) => /CSDL KHÁC/.test(i.text)));
  assert.equal(evaluateBackupHealth({ dirReadable: true, lastSuccess: ban(1), lastHourly: UNPARSABLE, lastDrill: dienTap }, BAY_GIO, A).state, "UNKNOWN", "tệp giờ hỏng ⇒ CHƯA BIẾT, không phải khoẻ");

  // Đọc đĩa thật: tổ chức đọc last-hourly.json của CHÍNH nó; nhà không đọc.
  const dir = mkdtempSync(path.join(tmpdir(), "trang-thai-gio-"));
  try {
    mkdirSync(path.join(dir, "orgs", "erp_org_alpha"), { recursive: true });
    writeFileSync(path.join(dir, "orgs", "erp_org_alpha", "last-hourly.json"), JSON.stringify(ban(0)));
    writeFileSync(path.join(dir, "last-hourly.json"), JSON.stringify(ban(0)));
    assert.equal(parseBackupRun((await readBackupStatusFiles(dir, A)).lastHourly)?.trigger, "hourly");
    assert.equal((await readBackupStatusFiles(dir)).lastHourly, undefined, "nhà không đọc tệp lượt giờ");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`✓ Thẻ sao lưu · RPO giờ: tổ chức quá ${ORG_BACKUP_RPO_ALERT_HOURS} giờ ⇒ vàng (quá ${BACKUP_MAX_AGE_HOURS} giờ vẫn đỏ) · nhà không bị chấm theo giờ và không bao giờ đọc lượt giờ · lượt giờ hỏng sau bản tốt ⇒ vàng, hỏng cũ đã tự lành · lượt giờ của CSDL khác / tệp hỏng không làm căn cứ`);
}

/* ═════════════ 13 · THÙNG RÁC GOOGLE DRIVE — sự cố 403 storageQuotaExceeded (08/10/2026) ═════════════ */

/**
 * Ops `backup` 08/10/2026 18:20: dump nhà + 8 CSDL tổ chức ĐẠT trên VPS, PITR chạy, nhưng `rclone copyto` lên Drive lỗi
 * «Error 403: The user's Drive storage quota has been exceeded» ⇒ bản ngoài máy hỏng. rclone với Google Drive mặc định
 * `--drive-use-trash=true`: mỗi lệnh xoay vòng theo tuổi chỉ đưa tệp vào THÙNG RÁC, và thùng rác VẪN tính vào hạn mức
 * tới 30 ngày — bản giờ của từng CSDL tổ chức, bản nền + WAL của PITR rơi vào đó mỗi giờ / mỗi 15 phút.
 *
 * Mỗi lời khẳng định dưới đây được CHẠY (rclone giả qua PATH — không một lời gọi nào tới Drive thật):
 *  1. mọi `rclone delete` phía ngoài máy — nhà, CSDL tổ chức, PITR — xoá HẲN qua MỘT hằng số `CO_KHONG_THUNG_RAC`;
 *  2. lượt `run` dọn thùng rác TRƯỚC bước đẩy, CHỈ dưới đúng thư mục mà crypt bọc; không đâu có `rclone cleanup` /
 *     `rclone purge` (Drive CÁ NHÂN của chủ shop — thùng rác chung có thể chứa tệp riêng của họ);
 *  3. lá chắn: tên rỗng / lạ, cấu hình lệch ⇒ 0 lời gọi Drive, nói rõ vì sao;
 *  4. đẩy hỏng ⇒ 0 lệnh xoay vòng phía Drive (nhà, tổ chức, PITR) — bản cũ ngoài máy còn nguyên;
 *  5. `status` đo Total · Used · Trashed · Other · Free + thư mục sao lưu (sống / thùng rác): có trần thời gian, CHỈ
 *     ĐỌC, không in ID thư mục / token / mật khẩu, lỗi không làm hỏng phần còn lại.
 */
const GIB = 1024 ** 3;
/** `rclone size --json` in MỘT dòng `{"count":…,"bytes":…,"sizeless":…}` — đúng hình dạng đo trên rclone v1.75.1. */
const kichThuocJson = (count: number, bytes: number) => JSON.stringify({ count, bytes, sizeless: 0 });
/** `rclone about --json` in nhiều dòng thụt TAB (đo trên rclone v1.75.1). Thiếu khoá = Google không trả số. */
const aboutJson = (o: Partial<Record<"total" | "used" | "trashed" | "other" | "free", number>>) => JSON.stringify(o, null, "\t");

/** Tên remote / thư mục / cờ đọc từ CHÍNH hằng số của script (mục 65) — đích dọn và đường crypt bọc dựng từ cùng chỗ. */
function cauHinhDrive() {
  const remoteDrive = hangSoChuoi("REMOTE_DRIVE")[0];
  const remoteCrypt = hangSoChuoi("REMOTE_CRYPT")[0];
  const thuMuc = hangSoChuoi("THU_MUC_TREN_DRIVE")[0];
  return { remoteDrive, remoteCrypt, thuMuc, dich: `${remoteDrive}:${thuMuc}`, co: hangSoChuoi("CO_KHONG_THUNG_RAC")[0] };
}

/** Mã của một tệp bất kỳ (kể cả shell nhúng trong YAML), đã bỏ dòng chú thích, kết thúc dòng quy về LF. */
const maTep = (tep: string) => boChuThichShell(readFileSync(tep, "utf8").replace(/\r\n/g, "\n"));

/** Thân một hàm shell trong MỘT tệp bất kỳ, đã bỏ chú thích. */
function thanHamTrong(tep: string, ten: string): string {
  const code = readFileSync(tep, "utf8").replace(/\r\n/g, "\n");
  const i = code.indexOf(`\n${ten}() {`);
  assert.ok(i >= 0, `${tep} phải có hàm ${ten}`);
  return boChuThichShell(code.slice(i, code.indexOf("\n}\n", i)));
}

/** Mọi tệp có thể mang lệnh rclone chạy trên máy chủ: shell ở scripts/ + deploy/, và shell nhúng trong workflow. */
function tepCoLenhRclone(): string[] {
  const ra: string[] = [];
  const di = (d: string, hop: (ten: string) => boolean) => {
    for (const m of readdirSync(d, { withFileTypes: true })) {
      const con = `${d}/${m.name}`;
      if (m.isDirectory()) di(con, hop);
      else if (hop(m.name)) ra.push(con);
    }
  };
  di("scripts", (t) => t.endsWith(".sh"));
  di("deploy", (t) => t.endsWith(".sh"));
  di(".github/workflows", (t) => /\.ya?ml$/.test(t));
  return ra;
}

/** Biến môi trường của khung Drive: giá trị bí mật (token, mật khẩu, ID thư mục) đi qua MÔI TRƯỜNG như Actions truyền. */
function moiTruongDrive(over: Record<string, string> = {}): Record<string, string> {
  return {
    STUB_THU_MUC: THU_MUC_MAU,
    STUB_TOKEN: TOKEN_MAU,
    STUB_MK: MK_MAU,
    STUB_RAC: kichThuocJson(3, 3 * GIB),
    STUB_SONG: kichThuocJson(812, 3_447_095_132),
    STUB_ABOUT: aboutJson({ total: 15 * GIB, used: 14.5 * GIB, trashed: 9 * GIB, other: GIB, free: -0.5 * GIB }),
    RAC_RONG: kichThuocJson(0, 0),
    ...over,
  };
}

/**
 * Khung chạy với cấu hình Google Drive ĐÚNG bộ biến configure-offsite dựng (testNgoaiMayGoogleDrive khoá bộ đó) và một
 * `rclone` GIẢ hiểu `about` / `size` / `delete --drive-trashed-only`: thùng rác của thư mục sao lưu là MỘT tệp JSON, lệnh
 * dọn làm rỗng nó. `docker` / `df` giả như khungChay (nhà có orders/shipments, không CSDL tổ chức nào).
 */
function khungDrive(lenh: string, truoc = ""): string {
  const { remoteDrive, remoteCrypt, dich } = cauHinhDrive();
  const D = `RCLONE_CONFIG_${remoteDrive.toUpperCase()}`;
  const C = `RCLONE_CONFIG_${remoteCrypt.toUpperCase()}`;
  return [
    "#!/usr/bin/env bash",
    "set -uo pipefail",
    "unset BACKUP_OFFSITE_REMOTE $(compgen -v RCLONE_CONFIG_ || true)",
    'T="$(mktemp -d)"',
    'mkdir -p "$T/bin" "$T/erp" "$T/bot" "$T/remote"',
    'echo "khoa-bot-gia" > "$T/bot/bot.env"',
    "cat > \"$T/bin/docker\" <<'EOF'",
    "#!/usr/bin/env bash",
    'echo "$*" >> "$DOCKER_LOG"',
    'case "$1" in',
    "  inspect)",
    '    case "$*" in',
    "      *State.Running*) echo true ;;",
    "      *Destination*) echo erp_chatbot_data ;;",
    "      *Config.Image*) echo postgres:16-alpine ;;",
    "    esac ;;",
    "  exec)",
    '    case "$*" in',
    '      *pg_dump*) printf "PGDMP-ban-gia-%0300d" 7 ;;',
    '      *"pg_restore --list"*) cat > /dev/null; printf "1; 0 0 TABLE DATA public users erp\\n2; 0 0 TABLE DATA public shipments erp\\n3; 0 0 TABLE DATA public orders erp\\n" ;;',
    "    esac ;;",
    '  run) cd "$BOT_DATA" && tar --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - . | gzip -n ;;',
    "esac",
    "EOF",
    "cat > \"$T/bin/df\" <<'EOF'",
    "#!/usr/bin/env bash",
    'echo "Filesystem 1048576-blocks Used Available Capacity Mounted"',
    'echo "/dev/gia 40000 1 999999 1% /"',
    "EOF",
    "cat > \"$T/bin/rclone\" <<'EOF'",
    "#!/usr/bin/env bash",
    'echo "rclone $*" >> "$DOCKER_LOG"',
    'rac=0; for a in "$@"; do [ "$a" = "--drive-trashed-only" ] && rac=1; done',
    'dich() { printf "%s" "$REMOTE_DIR/${1#*:}"; }',
    'hong() { [ -n "${1:-}" ] || return 0; echo "${2:-loi gia}" >&2; exit "$1"; }',
    'case "$1" in',
    '  version) echo "rclone v1.53.3" ;;',
    '  about) hong "${STUB_ABOUT_MA:-}" "${STUB_ABOUT_LOI:-}"; printf "%s\\n" "$STUB_ABOUT" ;;',
    '  size) if [ "$rac" = 1 ]; then hong "${STUB_RAC_MA:-}" "${STUB_RAC_LOI:-}"; cat "$RAC_TEP"; echo; else hong "${STUB_SONG_MA:-}" "${STUB_SONG_LOI:-}"; printf "%s\\n" "$STUB_SONG"; fi ;;',
    '  delete) if [ "$rac" = 1 ]; then printf "%s" "$RAC_RONG" > "$RAC_TEP"; fi ;;',
    '  copyto) hong "${STUB_COPY_MA:-}" "${STUB_COPY_LOI:-}"; shift; while [ "${1#--}" != "$1" ]; do shift; [ "$1" = 3 ] && shift; done; mkdir -p "$(dirname "$(dich "$2")")"; cp "$1" "$(dich "$2")" ;;',
    '  lsf) f="$(dich "${!#}")"; [ -f "$f" ] || { echo "directory not found" >&2; exit 3; }; stat -c %s "$f" ;;',
    "esac",
    "EOF",
    'chmod +x "$T/bin/docker" "$T/bin/df" "$T/bin/rclone"',
    'export PATH="$T/bin:$PATH" DOCKER_LOG="$T/docker.log" BOT_DATA="$T/bot" REMOTE_DIR="$T/remote" RAC_TEP="$T/rac.json"',
    'export ERP_BACKUP_DIR="$T/backups" ERP_DIR="$T/erp" ERP_LOCK_DIR="$T/locks" ERP_CRON_FILE="$T/cron" ERP_BACKUP_OFFSITE_ENV="$T/khong-co.env"',
    `export BACKUP_OFFSITE_REMOTE=${remoteCrypt}: ${D}_TYPE=drive ${D}_SCOPE=drive ${C}_TYPE=crypt ${C}_REMOTE=${dich} ${C}_FILENAME_ENCRYPTION=standard`,
    `export ${D}_ROOT_FOLDER_ID="\${STUB_THU_MUC:-}" ${D}_TOKEN="\${STUB_TOKEN:-}" ${C}_PASSWORD="\${STUB_MK:-}"`,
    'printf "%s" "$STUB_RAC" > "$RAC_TEP"',
    ': > "$DOCKER_LOG"',
    `source "${bashPath(SCRIPT)}"`,
    "set +e",
    "khoa_chong_chong() { return 0; }   # khoá: đo riêng bằng flock THẬT",
    "giu_khoa() { return 0; }",
    truoc,
    `( set -e; ${lenh} ) > "$T/out" 2>&1; rc=$?`, // set -e: ĐÚNG cờ của script khi chạy thật
    'echo "@@EXIT"; echo "$rc"',
    'echo "@@OUT"; cat "$T/out"',
    'echo "@@RUN"; cat "$T/backups/status/last-run.json" 2>/dev/null',
    'echo "@@RAC"; cat "$RAC_TEP"; echo',
    'echo "@@LOG"; grep "^rclone " "$DOCKER_LOG" || true',
    'echo "@@HET"',
    'rm -rf "$T"',
    "",
  ].join("\n");
}

export function testThungRacDriveMaNguon() {
  const { remoteDrive, remoteCrypt, thuMuc, co } = cauHinhDrive();
  assert.equal(co, "--drive-use-trash=false", "cờ xoá hẳn: --drive-use-trash=false (rclone mặc định true = vào thùng rác, vẫn tính dung lượng)");
  assert.ok(remoteDrive && remoteCrypt && thuMuc, "tên remote / thư mục sao lưu trên Drive không được rỗng");

  // ───────── MỌI `rclone delete` CHẠY TRÊN MÁY CHỦ: xoá HẲN qua hằng chung · không cleanup / purge ─────────
  const tepQuet = tepCoLenhRclone();
  assert.ok(tepQuet.includes(SCRIPT) && tepQuet.includes("scripts/erp-pitr.sh") && tepQuet.length > 5, `phải quét được các tệp có thể mang lệnh rclone (thấy ${tepQuet.length})`);
  const xoaKhongCo: string[] = [];
  const donCaDrive: string[] = [];
  const coGoLai: string[] = [];
  const soXoa: Record<string, number> = {};
  for (const tep of tepQuet) {
    for (const dong of maTep(tep).split("\n")) {
      if (/\brclone\s+(cleanup|purge)\b/.test(dong)) donCaDrive.push(`${tep}: ${dong.trim()}`);
      if (/\brclone\s+delete\b/.test(dong)) {
        soXoa[tep] = (soXoa[tep] ?? 0) + 1;
        if (!dong.includes('"$CO_KHONG_THUNG_RAC"')) xoaKhongCo.push(`${tep}: ${dong.trim()}`);
      }
      if (dong.includes("--drive-use-trash") && !(tep === SCRIPT && dong === `CO_KHONG_THUNG_RAC="${co}"`)) coGoLai.push(`${tep}: ${dong.trim()}`);
    }
  }
  assert.deepEqual(donCaDrive, [], "KHÔNG BAO GIỜ `rclone cleanup` / `rclone purge`: Drive cá nhân của chủ shop — thùng rác chung có thể chứa tệp riêng của họ");
  assert.deepEqual(xoaKhongCo, [], 'mọi `rclone delete` phía ngoài máy phải mang "$CO_KHONG_THUNG_RAC" — thiếu là bản quá hạn lại nằm trong thùng rác Drive 30 ngày');
  assert.deepEqual(coGoLai, [], "cờ --drive-use-trash khai ĐÚNG MỘT chỗ (hằng CO_KHONG_THUNG_RAC) — không gõ lại ở từng dòng");
  assert.ok((soXoa[SCRIPT] ?? 0) >= 8, `erp-backup.sh: 3 lệnh dọn của nhà + 4 của tổ chức + 1 dọn thùng rác (thấy ${soXoa[SCRIPT] ?? 0}) — không được xanh vì quét trượt`);
  assert.ok((soXoa["scripts/erp-pitr.sh"] ?? 0) >= 2, `erp-pitr.sh: dọn bản nền + dọn WAL trên Drive (thấy ${soXoa["scripts/erp-pitr.sh"] ?? 0})`);

  // ───────── DỌN THÙNG RÁC: một lệnh, đích là đường lá chắn dựng, chỉ thấy tệp trong thùng rác ─────────
  const code = boChuThichShell(src().replace(/\r\n/g, "\n"));
  const dongRac = code.split("\n").filter((d) => d.includes("--drive-trashed-only"));
  assert.ok(dongRac.length >= 3, `phải thấy lệnh dọn + phép đo thùng rác (thấy ${dongRac.length})`);
  for (const d of dongRac) assert.ok(d.includes('"$DRIVE_SAO_LUU"'), `mọi lệnh chạm thùng rác chỉ nhắm "$DRIVE_SAO_LUU" (đường lá chắn dựng): ${d.trim()}`);
  const lenhDon = dongRac.filter((d) => /\brclone\s+delete\b/.test(d));
  assert.equal(lenhDon.length, 1, "đúng MỘT lệnh dọn thùng rác");
  assert.match(lenhDon[0], /rclone delete "\$DRIVE_SAO_LUU" --drive-trashed-only "\$CO_KHONG_THUNG_RAC"/, "lệnh dọn: chỉ tệp trong thùng rác, xoá hẳn, đích = thư mục sao lưu");
  assert.ok(!maTep("scripts/erp-pitr.sh").includes("--drive-trashed-only"), "PITR không tự dọn thùng rác — một chỗ dọn, ở lượt run");
  // Đích dọn và thư mục crypt bọc dựng từ CÙNG một biểu thức ⇒ thứ được dọn chính là thứ chứa bản sao lưu.
  const chan = thanHam("xac_dinh_drive_sao_luu");
  assert.match(chan, /goc="\$REMOTE_DRIVE:\$THU_MUC_TREN_DRIVE"/, "đích dọn = $REMOTE_DRIVE:$THU_MUC_TREN_DRIVE");
  assert.match(thanHam("cmd_configure_offsite"), /RCLONE_CONFIG_\$\{REMOTE_CRYPT\^\^\}_REMOTE=\$REMOTE_DRIVE:\$THU_MUC_TREN_DRIVE/, "crypt bọc ĐÚNG $REMOTE_DRIVE:$THU_MUC_TREN_DRIVE");
  assert.deepEqual([...code.matchAll(/DRIVE_SAO_LUU="([^"]+)"/g)].map((m) => m[1]), ["$goc"], "DRIVE_SAO_LUU chỉ được gán khác rỗng ở ĐÚNG MỘT chỗ — cuối lá chắn, sau mọi phép kiểm");
  const iRong = chan.indexOf('[ -z "$THU_MUC_TREN_DRIVE" ]');
  assert.ok(iRong > 0 && iRong < chan.indexOf("${!"), "chuỗi rỗng kiểm TRƯỚC mọi phép thế gián tiếp — đường rỗng là gốc Drive");
  // Một chỗ gọi: lượt run (cron đêm / ops backup), TRƯỚC bước đẩy. Không mỗi giờ, không trong status.
  const goi = code.split("\n").filter((d) => /\bdon_thung_rac_drive\b/.test(d) && !/^don_thung_rac_drive\(\) \{/.test(d));
  assert.deepEqual(goi.map((d) => d.trim()), ["don_thung_rac_drive || true"], "dọn thùng rác gọi ĐÚNG MỘT chỗ, và hỏng không làm đổ lượt sao lưu");
  const run = thanHam("cmd_run");
  assert.ok(run.indexOf("don_thung_rac_drive") > 0 && run.indexOf("don_thung_rac_drive") < run.indexOf('day_ngoai_may "$(basename "$thu_muc")"'), "dọn thùng rác TRƯỚC bước đẩy — giải phóng chỗ cho bản mới");
  assert.ok(!/delete|don_thung_rac/.test(thanHam("trang_thai_dung_luong_drive")), "phần Drive của status CHỈ ĐỌC — không một lệnh xoá");
  assert.match(thanHam("cmd_status"), /trang_thai_dung_luong_drive \|\| true/, "status đo dung lượng Drive, lỗi không làm hỏng phần còn lại");

  // ───────── XOAY VÒNG PHÍA DRIVE CHỈ SAU LƯỢT ĐẨY THÀNH CÔNG (hai script) ─────────
  for (const [tep, ham, dauOk] of [
    [SCRIPT, "day_ngoai_may", 'OFFSITE_STATE="OK"'],
    [SCRIPT, "day_ngoai_may_to_chuc", 'ORG_OFFSITE_STATE="OK"'],
    ["scripts/erp-pitr.sh", "day_ban_nen_ngoai_may", 'PITR_OFFSITE_STATE="OK"'],
    ["scripts/erp-pitr.sh", "cmd_push_wal", "ghi_trang_thai_ngoai_may OK"],
  ] as const) {
    const than = thanHamTrong(tep, ham);
    const iOk = than.indexOf(dauOk);
    assert.ok(iOk > 0 && than.indexOf("rclone delete") > iOk, `${ham}: xoay vòng phía Drive chỉ được đứng SAU mốc đẩy thành công`);
    assert.ok(!/rclone copy/.test(than.slice(iOk)), `${ham}: sau mốc thành công không còn lệnh đẩy nào`);
  }

  console.log(`✓ Thùng rác Drive (mã nguồn): ${Object.values(soXoa).reduce((a, b) => a + b, 0)} lệnh rclone delete trên ${tepQuet.length} tệp đều mang "${co}" qua MỘT hằng · 0 cleanup / purge · một lệnh dọn --drive-trashed-only, đích ${remoteDrive}:${thuMuc} = đúng thứ crypt bọc, rỗng kiểm trước · gọi một chỗ, trong run, trước bước đẩy · status chỉ đọc · xoay vòng (nhà, tổ chức, bản nền, WAL) chỉ sau mốc đẩy thành công`);
}

export function testThungRacDriveChayThat() {
  const { dich, co, remoteDrive, remoteCrypt } = cauHinhDrive();
  const D = `RCLONE_CONFIG_${remoteDrive.toUpperCase()}`;
  const C = `RCLONE_CONFIG_${remoteCrypt.toUpperCase()}`;
  const dongLog = (ra: string) => phan(ra, "LOG").split("\n").filter(Boolean);
  const xoa = (ra: string) => dongLog(ra).filter((l) => l.startsWith("rclone delete "));
  const LENH_DON = `rclone delete ${dich} --drive-trashed-only ${co}`;
  const DO_RAC = `rclone size --json --drive-trashed-only ${dich}`;
  const ngay = hangSo("GIU_BAN_NGAY");
  const tuan = hangSo("GIU_BAN_TUAN");
  // TRIGGER=ops (đúng ops `backup`): không phụ thuộc hôm nay có phải Chủ nhật hay không (mục 50 · 65).
  const LUOT = "TRIGGER=ops; cmd_run";

  // ───────── LƯỢT run: đo thùng rác → dọn (chỉ thư mục sao lưu) → đẩy → xoay vòng xoá HẲN ─────────
  const dat = chayBash(khungDrive(LUOT), moiTruongDrive());
  assert.equal(phan(dat.ra, "EXIT"), "0", `lượt run với Drive đủ cấu hình phải đạt:\n${dat.ra}`);
  const run = parseBackupRun(JSON.parse(phan(dat.ra, "RUN")));
  assert.equal(run?.result, "OK");
  assert.equal(run?.offsite.state, "OK");
  const log = dongLog(dat.ra);
  const iDo = log.indexOf(DO_RAC);
  const iDon = log.indexOf(LENH_DON);
  const iDay = log.findIndex((l) => l.startsWith("rclone copyto "));
  assert.ok(iDo >= 0 && iDon > iDo && iDay > iDon, `thứ tự phải là đo thùng rác → dọn → đẩy (đang ${iDo} · ${iDon} · ${iDay}):\n${log.join("\n")}`);
  assert.deepEqual(xoa(dat.ra).filter((l) => l.includes("--drive-trashed-only")), [LENH_DON], `đúng MỘT lệnh dọn thùng rác, đích ĐÚNG ${dich} — không gốc Drive, không remote crypt`);
  for (const l of xoa(dat.ra)) assert.ok(l.endsWith(` ${co}`), `mọi lệnh xoá phía Drive phải xoá HẲN: ${l}`);
  assert.deepEqual(
    xoa(dat.ra).filter((l) => !l.includes("--drive-trashed-only")),
    [
      `rclone delete ${remoteCrypt}:daily --min-age ${ngay + 1}d ${co}`,
      `rclone delete ${remoteCrypt}:weekly --min-age ${tuan * 7 + 1}d ${co}`,
      `rclone delete ${remoteCrypt}:manual --min-age ${ngay + 1}d ${co}`,
    ],
    "xoay vòng: CÙNG ba thư mục, CÙNG --min-age suy từ GIU_BAN_* — chỉ đổi «vào thùng rác» thành «xoá hẳn»",
  );
  assert.ok(!log.some((l) => /^rclone (cleanup|purge)\b/.test(l)), "không bao giờ cleanup / purge");
  assert.equal((JSON.parse(phan(dat.ra, "RAC")) as { count: number }).count, 0, "thùng rác của thư mục sao lưu đã rỗng");
  assert.ok(phan(dat.ra, "OUT").includes(`đã xoá hẳn 3 tệp · 3,00 GB khỏi thùng rác của ${dich}`), `log phải nói số tệp + dung lượng đã dọn:\n${phan(dat.ra, "OUT")}`);

  // ───────── ĐẨY HỎNG (đúng lỗi 403 của 08/10) ⇒ 0 lệnh xoay vòng phía Drive: bản cũ ngoài máy còn nguyên ─────────
  const hong = chayBash(khungDrive(LUOT), moiTruongDrive({ STUB_COPY_MA: "1", STUB_COPY_LOI: "Error 403: The user's Drive storage quota has been exceeded., storageQuotaExceeded" }));
  const runHong = parseBackupRun(JSON.parse(phan(hong.ra, "RUN")));
  assert.equal(runHong?.offsite.state, "FAILED");
  assert.equal(runHong?.result, "PARTIAL", "CSDL dùng được, ngoài máy hỏng ⇒ MỘT PHẦN");
  assert.match(runHong?.offsite.reason ?? "", /storage quota has been exceeded/, "lý do ngoài máy mang nguyên văn lỗi của Drive");
  assert.notEqual(phan(hong.ra, "EXIT"), "0", "lượt một phần phải thoát khác 0 để ops đỏ");
  assert.deepEqual(xoa(hong.ra).filter((l) => !l.includes("--drive-trashed-only")), [], "đẩy hỏng ⇒ KHÔNG một lệnh xoay vòng phía Drive — xoá bản cũ khi bản mới không lên được là để ngoài máy rỗng");
  assert.ok(dongLog(hong.ra).includes(LENH_DON), "thùng rác vẫn được dọn TRƯỚC lượt đẩy — tệp trong đó đã quá hạn giữ, không phải bản đang sống");

  // ───────── THÙNG RÁC RỖNG ⇒ không lệnh dọn · ĐO HỎNG ⇒ vẫn dọn, lỗi in ra đã che ID thư mục gốc ─────────
  const rong = chayBash(khungDrive(LUOT), moiTruongDrive({ STUB_RAC: kichThuocJson(0, 0) }));
  assert.equal(phan(rong.ra, "EXIT"), "0");
  assert.ok(!dongLog(rong.ra).includes(LENH_DON), "thùng rác rỗng ⇒ không gọi lệnh dọn");
  assert.match(phan(rong.ra, "OUT"), /không có tệp nào trong thùng rác — không có gì để dọn/);
  assert.equal(xoa(rong.ra).length, 3, "xoay vòng vẫn chạy như thường");
  const chuaCo = chayBash(khungDrive(LUOT), moiTruongDrive({ STUB_RAC_MA: "3", STUB_RAC_LOI: "Failed to size: directory not found" }));
  assert.ok(!dongLog(chuaCo.ra).includes(LENH_DON) && !/::warning::/.test(phan(chuaCo.ra, "OUT")), "lượt đầu tiên (thư mục sao lưu chưa có trên Drive) ⇒ không dọn, không cảnh báo nhầm");
  assert.match(phan(chuaCo.ra, "OUT"), /chưa có trên Drive \(tạo ở lượt đẩy đầu tiên\) — không có gì để dọn/);
  const doHong = chayBash(khungDrive(LUOT), moiTruongDrive({ STUB_RAC_MA: "1", STUB_RAC_LOI: `googleapi: Error 404: File not found: ${THU_MUC_MAU}., notFound` }));
  assert.ok(dongLog(doHong.ra).includes(LENH_DON), "đo thùng rác hỏng KHÔNG chặn lệnh dọn — đích đã qua lá chắn, lệnh chỉ thấy tệp trong thùng rác");
  assert.match(phan(doHong.ra, "OUT"), /trước: chưa đo được · sau: chưa đo được/, "không đo được thì nói CHƯA ĐO ĐƯỢC, không in 0 tệp");
  assert.ok(phan(doHong.ra, "OUT").includes("<thư mục gốc>") && !doHong.ra.includes(THU_MUC_MAU), "lỗi 404 của Google in nguyên ID thư mục — phải được che trước khi vào log công khai");

  // ───────── LÁ CHẮN: cấu hình rỗng / lạ / lệch ⇒ 0 lời gọi Drive, nói rõ vì sao ─────────
  const chan: [string, string][] = [
    ["thư mục sao lưu RỖNG (đích sẽ là GỐC Drive)", 'THU_MUC_TREN_DRIVE=""'],
    ["remote Drive rỗng", 'REMOTE_DRIVE=""'],
    ["thư mục có ..", 'THU_MUC_TREN_DRIVE="../erp-backup"'],
    ["thư mục có /", 'THU_MUC_TREN_DRIVE="erp-backup/orgs"'],
    ["thư mục có dấu cách", 'THU_MUC_TREN_DRIVE="erp backup"'],
    ["crypt bọc GỐC Drive", `export ${C}_REMOTE=${remoteDrive}:`],
    ["crypt bọc thư mục khác", `export ${C}_REMOTE=${remoteDrive}:thu-muc-khac`],
    ["chưa khai nơi lưu ngoài máy", "unset BACKUP_OFFSITE_REMOTE"],
    ["nơi lưu ngoài máy không phải crypt Drive", "export BACKUP_OFFSITE_REMOTE=b2:kho/erp"],
    ["remote không phải Drive", `export ${D}_TYPE=s3`],
    ["chưa khai thư mục gốc", `unset ${D}_ROOT_FOLDER_ID`],
  ];
  // Mỗi ca một tiến trình con riêng (biến đổi không rò sang ca sau); ca cuối là ĐỐI CHỨNG đủ cấu hình — chứng minh
  // khung thật sự gọi được rclone, để "0 lời gọi" ở các ca trên không xanh vì khung hỏng.
  const ca = [...chan, ["ĐỐI CHỨNG: cấu hình đúng", ":"] as [string, string]];
  const chanRa = chayBash(
    khungDrive(ca.map(([, truoc], i) => `echo "@@C${i}"; ( ${truoc}; don_thung_rac_drive ) 2>&1; grep -c "^rclone " "$DOCKER_LOG" || true; : > "$DOCKER_LOG"`).join("\n")),
    moiTruongDrive(),
  );
  assert.equal(phan(chanRa.ra, "EXIT"), "0", `lá chắn không làm đổ lượt sao lưu:\n${chanRa.ra}`);
  ca.forEach(([ten], i) => {
    const dong = phan(chanRa.ra, `C${i}`).split("\n");
    const soGoi = dong.at(-1);
    if (i < chan.length) {
      assert.equal(soGoi, "0", `${ten}: KHÔNG một lời gọi Drive nào:\n${dong.join("\n")}`);
      assert.match(dong.join("\n"), /thùng rác Drive: KHÔNG dọn — /, `${ten}: phải nói rõ vì sao không dọn`);
    } else {
      assert.equal(soGoi, "3", `${ten}: đo → dọn → đo lại (3 lời gọi) — khung gọi được rclone thật sự:\n${dong.join("\n")}`);
    }
  });

  // ───────── CSDL TỔ CHỨC: xoay vòng phía Drive cũng xoá hẳn; đẩy hỏng ⇒ 0 lệnh xoay vòng (nhà lẫn tổ chức) ─────────
  const toChuc = chayBash(khungToChuc(), { STUB_ORGS: "erp_org_alpha\n" });
  const xoaToChuc = phan(toChuc.ra, "DOCKER").split("\n").filter((l) => l.startsWith("rclone delete "));
  assert.ok(xoaToChuc.filter((l) => l.includes(" gia:orgs/erp_org_alpha/")).length >= 3, `phải thấy xoay vòng phía Drive của tổ chức:\n${xoaToChuc.join("\n")}`);
  for (const l of xoaToChuc) assert.ok(l.endsWith(` ${co}`), `xoay vòng phía Drive (nhà lẫn tổ chức) phải xoá HẲN: ${l}`);
  const toChucHong = chayBash(khungToChuc(), { STUB_ORGS: "erp_org_alpha\n", STUB_RCLONE_LOI: "1" });
  assert.deepEqual(phan(toChucHong.ra, "DOCKER").split("\n").filter((l) => l.startsWith("rclone delete ")), [], "đẩy hỏng ⇒ 0 lệnh xoay vòng phía Drive, của nhà lẫn của tổ chức");

  console.log(`✓ Thùng rác Drive (cmd_run chạy thật, rclone giả): đo → dọn ${dich} --drive-trashed-only → đẩy, nói "đã xoá hẳn 3 tệp · 3,00 GB" · xoay vòng cùng ba thư mục, cùng --min-age, đuôi ${co} · đẩy lỗi 403 ⇒ PARTIAL + 0 lệnh xoay vòng (nhà lẫn tổ chức) · thùng rác rỗng ⇒ không dọn · đo hỏng ⇒ vẫn dọn, nói CHƯA ĐO ĐƯỢC, ID thư mục bị che · ${chan.length} ca lá chắn ⇒ 0 lời gọi Drive (đối chứng đủ cấu hình ⇒ 3)`);
}

/** Khung chạy hai hàm đẩy của PITR (`day_ban_nen_ngoai_may`, `cmd_push_wal`) với rclone giả — `flock` giả (đo ở pitr.test). */
function khungPitrNgoaiMay(dong: string[]): string {
  return [
    "#!/usr/bin/env bash",
    "set -uo pipefail",
    "unset BACKUP_OFFSITE_REMOTE $(compgen -v RCLONE_CONFIG_ || true)",
    'T="$(mktemp -d)"; mkdir -p "$T/bin" "$T/remote"',
    "cat > \"$T/bin/rclone\" <<'EOF'",
    "#!/usr/bin/env bash",
    'echo "rclone $*" >> "$RLOG"',
    'dich() { printf "%s" "$REMOTE_DIR/${1#*:}"; }',
    'case "$1" in',
    '  copyto) [ "${STUB_LOI:-0}" = 1 ] && { echo "Error 403: storage quota exceeded" >&2; exit 1; }; shift; while [ "${1#--}" != "$1" ]; do shift; [ "$1" = 3 ] && shift; done; mkdir -p "$(dirname "$(dich "$2")")"; cp "$1" "$(dich "$2")" ;;',
    '  copy) [ "${STUB_LOI:-0}" = 1 ] && { echo "Error 403: storage quota exceeded" >&2; exit 1; }; : ;;',
    '  lsf) f="$(dich "${!#}")"; [ -f "$f" ] || exit 1; stat -c %s "$f" ;;',
    "esac",
    "EOF",
    'chmod +x "$T/bin/rclone"',
    'export PATH="$T/bin:$PATH" RLOG="$T/rlog" REMOTE_DIR="$T/remote"',
    'export ERP_BACKUP_DIR="$T/backups" ERP_DIR="$T/erp" ERP_LOCK_DIR="$T/locks" ERP_BACKUP_OFFSITE_ENV="$T/khong-co.env" BACKUP_OFFSITE_REMOTE=gia:',
    ': > "$RLOG"',
    `source "${bashPath("scripts/erp-pitr.sh")}"`,
    "set +e",
    "flock() { return 0; }   # khoá đẩy WAL: đo ở tests/pitr.test.ts",
    'mkdir -p "$PITR_WAL" "$PITR_BASE/base-20261008-0227" "$STATUS_DIR"',
    'echo x > "$PITR_WAL/000000010000000000000021.gz"; echo y > "$PITR_BASE/base-20261008-0227/base.tar.gz"',
    ...dong,
    'echo "@@HET"; rm -rf "$T"',
    "",
  ].join("\n");
}

export function testThungRacDrivePitr() {
  const { co } = cauHinhDrive();
  const giu = Number(/^PITR_GIU_BAN_NEN=(\d+)/m.exec(readFileSync("scripts/erp-pitr.sh", "utf8"))?.[1]);
  assert.ok(giu >= 1, "erp-pitr.sh phải khai PITR_GIU_BAN_NEN");
  const r = chayBash(
    khungPitrNgoaiMay([
      '( cmd_push_wal ) > /dev/null 2>&1; echo "@@WAL"; grep "^rclone delete" "$RLOG" || true; : > "$RLOG"',
      '( STUB_LOI=1 cmd_push_wal ) > /dev/null 2>&1; echo "@@WALHONG"; grep -c "^rclone copy " "$RLOG" || true; grep "^rclone delete" "$RLOG" || true; : > "$RLOG"',
      '( day_ban_nen_ngoai_may base-20261008-0227 ) > /dev/null 2>&1; echo "@@NEN"; grep "^rclone delete" "$RLOG" || true; : > "$RLOG"',
      '( STUB_LOI=1 day_ban_nen_ngoai_may base-20261008-0227 ) > /dev/null 2>&1; echo "@@NENHONG"; grep -c "^rclone copyto " "$RLOG" || true; grep "^rclone delete" "$RLOG" || true; : > "$RLOG"',
    ]),
  );
  assert.deepEqual(phan(r.ra, "WAL").split("\n"), [`rclone delete gia:pitr/wal --min-age ${giu + 2}d ${co}`], `PITR đẩy WAL xong ⇒ dọn WAL cũ trên Drive bằng xoá HẲN:\n${r.ra}`);
  assert.deepEqual(phan(r.ra, "WALHONG").split("\n"), ["1"], "PITR đẩy WAL hỏng (đã thử đẩy đúng một lần) ⇒ KHÔNG dọn WAL cũ trên Drive");
  assert.deepEqual(phan(r.ra, "NEN").split("\n"), [`rclone delete gia:pitr/base --min-age ${giu + 2}d ${co}`], "PITR đẩy bản nền xong ⇒ dọn bản nền cũ bằng xoá HẲN");
  assert.deepEqual(phan(r.ra, "NENHONG").split("\n"), ["1"], "PITR đẩy bản nền hỏng ⇒ KHÔNG dọn bản nền cũ trên Drive");
  console.log(`✓ Thùng rác Drive · PITR (chạy thật): đẩy WAL / bản nền xong ⇒ dọn --min-age ${giu + 2}d xoá HẲN (${co}) · đẩy hỏng ⇒ 0 lệnh dọn`);
}

export function testTrangThaiDungLuongDrive() {
  const { dich, remoteDrive } = cauHinhDrive();
  const tran = hangSo("TRAN_DO_DRIVE_GIAY");
  const doc = (env: Record<string, string> = {}, truoc = "") => chayBash(khungDrive("cmd_status", truoc), moiTruongDrive(env));
  const doDrive = (ra: string) => phan(ra, "LOG").split("\n").filter((l) => /^rclone (about|size|delete|cleanup|purge)\b/.test(l));

  // ───────── ĐỦ CẤU HÌNH: năm số của tài khoản + thư mục sao lưu (sống / thùng rác), quy ra MB / GB ─────────
  const r = doc({ STUB_RAC: kichThuocJson(5400, 9_556_302_233) });
  assert.equal(phan(r.ra, "EXIT"), "0", `status phải thoát 0:\n${r.ra}`);
  const out = phan(r.ra, "OUT");
  assert.ok(out.includes(`Cả tài khoản Google (rclone about ${remoteDrive}:): Total 15,00 GB · Used 14,50 GB · Trashed 9,00 GB · Other 1,00 GB · Free -512 MB`), `about phải quy ra MB/GB đủ năm số:\n${out}`);
  assert.match(out, /Drive HẾT CHỖ \(Free ≤ 0\)/, "Free ≤ 0 ⇒ nói thẳng mọi lượt đẩy sẽ lỗi 403");
  assert.ok(out.includes(`Thư mục sao lưu ${dich} (tên đã mã hoá) · đang sống: 812 tệp · 3,21 GB`), "phần đang sống của thư mục sao lưu");
  assert.ok(out.includes(`Thư mục sao lưu ${dich} · trong thùng rác: 5400 tệp · 8,90 GB`), "phần trong thùng rác của thư mục sao lưu");
  assert.deepEqual(doDrive(r.ra), [`rclone about --json ${remoteDrive}:`, `rclone size --json ${dich}`, `rclone size --json --drive-trashed-only ${dich}`], "status đo đúng ba phép — CHỈ ĐỌC, không một lệnh xoá");
  assert.ok(out.indexOf("── Dung lượng Google Drive") > 0 && out.indexOf("── Dung lượng Google Drive") < out.indexOf("── CSDL tổ chức khác nhà"), "phần còn lại của status vẫn chạy sau phần Drive");
  khongLoBiMat(r.ra, "status");
  assert.ok(!r.ra.includes(THU_MUC_MAU), "status KHÔNG in ID thư mục Drive — log ops của kho PUBLIC");
  assert.ok(out.includes(`thư mục gốc …${THU_MUC_MAU.slice(-4)} (${THU_MUC_MAU.length} ký tự)`), "ID thư mục in ở dạng ĐÃ CHE — đủ để đối chiếu với Variable");

  // ───────── HỎNG TỪNG PHÉP: about quá giờ, đo thư mục lỗi (Google in nguyên ID) ⇒ nói ra, che ID, status chạy hết ─────────
  const hong = doc({ STUB_ABOUT_MA: "124", STUB_SONG_MA: "1", STUB_SONG_LOI: `googleapi: Error 404: File not found: ${THU_MUC_MAU}., notFound` });
  assert.equal(phan(hong.ra, "EXIT"), "0", `lỗi đo Drive không làm status thất bại:\n${hong.ra}`);
  const outHong = phan(hong.ra, "OUT");
  assert.ok(outHong.includes(`KHÔNG ĐỌC ĐƯỢC — quá ${tran} giây — CHƯA ĐO ĐƯỢC`), `quá trần thời gian ⇒ CHƯA ĐO ĐƯỢC, không treo:\n${outHong}`);
  assert.ok(outHong.includes("đang sống: KHÔNG ĐỌC ĐƯỢC — googleapi: Error 404: File not found: <thư mục gốc>"), "dòng lỗi được in, ID thư mục bị che");
  assert.ok(!hong.ra.includes(THU_MUC_MAU), "không lọt ID thư mục qua dòng lỗi");
  assert.ok(outHong.includes(`trong thùng rác: 3 tệp · 3,00 GB — lượt backup`), "một phép đo hỏng không kéo theo phép đo khác");
  assert.ok(outHong.indexOf("── CSDL tổ chức khác nhà") > outHong.indexOf("── Dung lượng Google Drive"), "lỗi Drive không làm hỏng phần còn lại của status");

  // ───────── Google không trả hạn mức (tài khoản không giới hạn) ⇒ «—», không in thành 0, không kết luận hết chỗ ─────────
  const voHan = doc({ STUB_ABOUT: aboutJson({ used: 2 * GIB, trashed: 0, other: 0 }) });
  assert.ok(phan(voHan.ra, "OUT").includes("Total — · Used 2,00 GB · Trashed 0 MB · Other 0 MB · Free —"), `thiếu số ⇒ «—» (CHƯA BIẾT, mục 42):\n${phan(voHan.ra, "OUT")}`);
  assert.ok(!/HẾT CHỖ/.test(phan(voHan.ra, "OUT")), "không có số Free thì không kết luận hết chỗ");

  // ───────── Nơi lưu không phải crypt Drive ⇒ không đo, nói vì sao, 0 lời gọi about / size ─────────
  const b2 = doc({}, "export BACKUP_OFFSITE_REMOTE=b2:kho/erp");
  assert.match(phan(b2.ra, "OUT"), /── Dung lượng Google Drive[^\n]*\nKhông đo: nơi lưu ngoài máy không phải /, "cấu hình khác ⇒ nói rõ không đo và vì sao");
  assert.deepEqual(doDrive(b2.ra), [], "không phải Drive do deploy dựng ⇒ 0 phép đo Drive");
  assert.equal(phan(b2.ra, "EXIT"), "0");

  console.log(`✓ Trạng thái Drive (status chạy thật): Total 15,00 GB · Used 14,50 GB · Trashed 9,00 GB · Other 1,00 GB · Free -512 MB ⇒ HẾT CHỖ · thư mục sao lưu sống 812 tệp / thùng rác 5400 tệp · đúng ba phép đo, 0 lệnh xoá · ID thư mục / token / mật khẩu không lọt (ID in dạng che) · quá ${tran}s ⇒ CHƯA ĐO ĐƯỢC, lỗi 404 bị che ID, status vẫn chạy hết · không giới hạn ⇒ «—» · không phải Drive ⇒ không đo`);
}

export async function testSaoLuu() {
  testLichSaoLuuDuocCai();
  testXoayVongMotChoKhai();
  testKiemODiaVaToanVen();
  testKhoaSaoLuuChayThat();
  testCongTacGhiFailClosed();
  testOpsSaoLuu();
  testMountTrangThaiChiDoc();
  testChamSaoLuu();
  testNgoaiMayGoogleDrive();
  testToChucPhanNhaKhongDoi();
  testToChucHamThuan();
  testToChucChayThat();
  await testChamSaoLuuToChuc();
  testDienTapToChucMaNguon();
  testDienTapToChucChayThat();
  testLuotGioToChucMaNguon();
  testLuotGioToChucChayThat();
  testDienTapTuanToChucChayThat();
  testLichToChucMoi();
  await testChamRpoGio();
  testThungRacDriveMaNguon();
  testThungRacDriveChayThat();
  testThungRacDrivePitr();
  testTrangThaiDungLuongDrive();
}

