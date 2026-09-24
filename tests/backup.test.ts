import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BACKUP_DRILL_MAX_AGE_DAYS,
  BACKUP_MAX_AGE_HOURS,
  BACKUP_STATUS_DIR_DEFAULT,
  UNPARSABLE,
  evaluateBackupHealth,
  formatBackupSize,
  parseBackupRun,
} from "@/lib/constants/backup";

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
/** Chạy một kịch bản bash (ghi vào tệp tạm của Node), trả mã thoát + toàn bộ đầu ra. */
function chayBash(noiDung: string): Ra {
  const tmp = mkdtempSync(path.join(tmpdir(), "backup-kiem-"));
  const kich = path.join(tmp, "run.sh");
  writeFileSync(kich, noiDung);
  try {
    const ra = execFileSync("bash", [kich], { stdio: "pipe", encoding: "utf8", maxBuffer: 1 << 24 });
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
      'timeout 20 bash -c \'source "$0"; set +e; giu_khoa 8 "$KHOA_DOC_DB" -x 2 >/dev/null && echo ok8; giu_khoa 9 "$KHOA_VONG_DOI" -s 2 >/dev/null && echo ok9\' "$S"',
      'exec 8>&- 9>&-',
      // Một tiến trình KHÁC cầm khoá đọc nặng ⇒ phải HẾT GIỜ, không lách qua.
      '( flock -x "$T/that/erp-readonly-db.lock" sleep 6 ) & sleep 1',
      'echo "@@HETGIO"',
      'timeout 20 bash -c \'source "$0"; set +e; giu_khoa 8 "$KHOA_DOC_DB" -x 1 >/dev/null; echo $?\' "$S"',
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
  const bienGhi = [...deploy.matchAll(/^\s+([A-Z0-9_]+): \$\{\{ vars\.\1 \}\}$/gm)].map((m) => m[1]).filter((k) => /WRITE|SPEND|LOOP|APPLY|BUDGET/.test(k));
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

export function testSaoLuu() {
  testLichSaoLuuDuocCai();
  testXoayVongMotChoKhai();
  testKiemODiaVaToanVen();
  testKhoaSaoLuuChayThat();
  testCongTacGhiFailClosed();
  testOpsSaoLuu();
  testMountTrangThaiChiDoc();
  testChamSaoLuu();
}

