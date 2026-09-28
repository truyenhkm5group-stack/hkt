import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BACKUP_DRILL_MAX_AGE_DAYS,
  BACKUP_MAX_AGE_HOURS,
  BACKUP_STATUS_DIR_DEFAULT,
  ORG_BACKUP_DATABASE_PATTERN,
  UNPARSABLE,
  evaluateBackupHealth,
  formatBackupSize,
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
    '  run) cd "$BOT_DATA" && tar czf - . ;;',
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
 * CHỨC KHÁC NHÀ` — tức đúng bản trước Phase 11 (origin/main 64cd4732). Đây là lời khẳng định "phần của
 * nhà KHÔNG đổi một byte" ở dạng máy kiểm được.
 *
 * Đỏ ở đây nghĩa là ai đó đã sửa đường sao lưu của CSDL NHÀ (VNX). Nếu việc đó là CỐ Ý: cập nhật băm
 * CÙNG commit và nói trong commit vì sao đường của nhà đổi. Nếu không cố ý: phần tổ chức đã rò ra ngoài
 * khối có dấu — đưa nó về trong khối.
 */
const BAM_PHAN_NHA = "57d9b50d8667042817dac3c830bc9253fafd4186bcb7a4ec15725ca0b27892b1";
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
  assert.equal(bam, BAM_PHAN_NHA, "gỡ các khối TỔ CHỨC KHÁC NHÀ ra phải được NGUYÊN VĂN bản sao lưu của nhà trước Phase 11 — xem chú thích BAM_PHAN_NHA");
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

  console.log(`✓ Tổ chức khác nhà (mã nguồn): gỡ khối có dấu ⇒ đúng băm bản trước Phase 11 · lệnh then chốt của nhà còn nguyên · khối tổ chức không exit / that_bai / set -e, không ghi biến của nhà, không đòi orders · gọi SAU trạng thái của nhà trong ngữ cảnh || true · mẫu tên ${mau} chung với ERP · xoay vòng riêng theo tiền tố`);
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
function khungToChuc(truoc = ""): string {
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
    '  run) cd "$BOT_DATA" && tar czf - . ;;',
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
    '  copyto) shift; while [ "${1#--}" != "$1" ]; do shift; [ "$1" = 3 ] && shift; done; mkdir -p "$(dirname "$(dich "$2")")"; cp "$1" "$(dich "$2")" ;;',
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
    '( set -e; TRIGGER=cron; cmd_run ) > "$T/out" 2>&1; rc=$?', // set -e: ĐÚNG cờ của script khi chạy thật
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
}

