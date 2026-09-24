import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * ═══════════ HÀNG ĐỢI THAO TÁC VPS NẰM TRÊN MÁY CHỦ, KHÔNG NẰM Ở GITHUB ═══════════
 *
 * HAI SỰ VIỆC ĐO ĐƯỢC TRÊN PRODUCTION NGÀY 19/09/2026 sinh ra bài kiểm này.
 *
 * A. LƯỢT ĐỌC BỊ DEPLOY GIẾT GIỮA CHỪNG. `explain-stock` (lượt ops 1406) khởi động 13:41:25, job
 *    `release` của deploy #354 bắt đầu 13:41:29, và 13:44:11 lượt đọc chết với
 *    `container ... is not running`. Nhóm `concurrency` của GitHub cho hai bên chạy song song —
 *    đó là điều PR #15 muốn — nhưng không có gì nói cho lượt đọc biết container dưới chân nó sắp
 *    bị dựng lại.
 *
 * B. `concurrency` CỦA GITHUB KHÔNG PHẢI MỘT HÀNG ĐỢI. Một nhóm giữ tối đa MỘT lượt đang chạy và
 *    MỘT lượt đang chờ; lượt thứ ba tới HUỶ lượt đang chờ. Đo thật: lượt 1395 và 1416 bị huỷ đúng
 *    như vậy. Với một nhóm GHI thì điều đó nghĩa là **một lệnh ghi đã gửi có thể biến mất thay vì
 *    chờ tới lượt** — im lặng, người gửi chỉ thấy chữ "cancelled".
 *
 * NÊN: GitHub chỉ còn cho job KHỞI ĐỘNG; việc chờ tài nguyên do `flock` trên VPS quyết.
 *
 * VÌ SAO BÀI KIỂM NÀY CHẠY SHELL THẬT VỚI `flock` THẬT: `tsc` và `eslint` không đọc YAML lẫn
 * shell, và một lỗi khoá không hiện ra ở đâu cả cho tới khi hai lượt chạy thật gặp nhau trên máy
 * chủ — lúc ấy triệu chứng là "container biến mất giữa một phép đo", đúng thứ vừa tốn một buổi
 * chiều để truy. Khẳng định bằng lời rằng "thứ tự khoá không bế tắc" thì không chặn được gì.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/ops-concurrency.test.ts
 */

const THU_MUC = ".github/workflows";
const doc = (t: string) => readFileSync(path.join(THU_MUC, t), "utf8");

/**
 * Bỏ dòng CHÚ THÍCH trước khi quét tên nhóm khoá cũ.
 *
 * Chú thích của hai workflow KỂ LẠI vì sao `vps-mutating` bị bỏ — đó là phần có giá trị nhất của
 * bản sửa. Cấm nhắc tới cái tên ấy sẽ buộc người sau xoá đúng lời giải thích khiến họ không lặp
 * lại lỗi cũ. Thứ phải cấm là KHAI BÁO trong YAML.
 */
const boChuThich = (src: string) => src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

function khoaMucWorkflow(src: string): string | null {
  const m = /^concurrency:\n((?:[ \t].*\n?)*)/m.exec(src);
  return m ? m[1] : null;
}

function khoaCuaJob(src: string, job: string): string | null {
  const i = src.indexOf(`\n  ${job}:\n`);
  if (i < 0) return null;
  const sau = src.slice(i + 1);
  const m = /\n {2}[a-z_]+:\n/.exec(sau.slice(1));
  const than = m ? sau.slice(0, m.index + 1) : sau;
  const k = /^ {4}concurrency:\n((?: {6}.*\n?)*)/m.exec(than);
  return k ? k[1] : null;
}

/* ═════════ 1 · KHÔNG CÒN NHÓM CONCURRENCY NÀO LÀM HÀNG ĐỢI CHO THAO TÁC VPS ═════════ */

export function testKhongDungConcurrencyLamHangDoi() {
  const tep = readdirSync(THU_MUC).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  assert.ok(tep.length >= 6, "phải đọc được đủ workflow của kho");

  for (const f of tep) {
    const src = boChuThich(doc(f));
    for (const ten of ["vps-operations", "vps-mutating", "vps-readonly"]) {
      assert.ok(
        !src.includes(ten),
        `${f}: \`${ten}\` là nhóm concurrency của GitHub dùng làm hàng đợi thao tác VPS. ` +
          `GitHub giữ tối đa MỘT lượt chờ và HUỶ nó khi lượt thứ ba tới (đo thật: ops 1395, 1416), ` +
          `nên một lệnh ghi đã gửi có thể biến mất. Hàng đợi phải là \`flock\` trên máy chủ.`,
      );
    }
  }

  for (const f of ["deploy-vps.yml", "ops-vps.yml"]) {
    assert.equal(khoaMucWorkflow(boChuThich(doc(f))), null, `${f}: không được khai \`concurrency\` ở mức workflow`);
  }
  assert.equal(khoaCuaJob(doc("ops-vps.yml"), "ops"), null, "job `ops` không được có `concurrency`: nó phải KHỞI ĐỘNG rồi chờ bằng flock");
  for (const job of ["gates", "build_image", "release"]) {
    assert.equal(
      khoaCuaJob(doc("deploy-vps.yml"), job),
      null,
      `job \`${job}\` không được có \`concurrency\` — kể cả \`release\`: một lượt deploy bị huỷ trong ` +
        `lúc xếp hàng là một bản sửa im lặng không bao giờ tới máy chủ`,
    );
  }

  /*
    CI VẪN ĐƯỢC GIỮ `concurrency`, và đây là chỗ phải nói rõ vì sao nó KHÔNG rơi vào lỗi B:
    nhóm của `ci.yml` chỉ chứa lượt chạy ĐỌC MÃ NGUỒN trên máy của GitHub. Huỷ một lượt CI của
    commit đã bị thay thế là việc CỐ Ý và không đánh mất thao tác VPS nào — nó không SSH đi đâu cả.
  */
  const ci = doc("ci.yml");
  assert.ok(khoaMucWorkflow(ci), "ci.yml vẫn phải có khoá theo nhánh");
  assert.ok(!boChuThich(ci).includes("vps-"), "…nhưng không bao giờ dùng chung nhóm với thao tác production");
  assert.ok(!ci.includes("appleboy/ssh-action"), "ci.yml không được SSH vào máy chủ — đó là điều khiến khoá của nó vô hại");

  console.log("✓ Không nhóm concurrency nào làm hàng đợi VPS · ops/release khởi động ngay · khoá của CI vô hại (không SSH)");
}

/* ═════════════════ 2 · BA Ổ KHOÁ, THỨ TỰ CỐ ĐỊNH ═════════════════ */

const KHOA_VONG_DOI = "/var/lock/erp-lifecycle.lock";
const KHOA_DB = "/var/lock/erp-readonly-db.lock";
const KHOA_PROBE = "/var/lock/erp-readonly-probe.lock";

/** Khối khoá nằm ở đầu script SSH của `ops-vps.yml`, trước `case "$ACTION" in`. */
function khoiKhoaOps(): string {
  const src = doc("ops-vps.yml");
  const i = src.indexOf("            # ═════════════════ KHOÁ TRÊN MÁY CHỦ");
  assert.ok(i > 0, "không tìm thấy khối khoá trong ops-vps.yml");
  const j = src.indexOf('            case "$ACTION" in', i);
  assert.ok(j > i, "không tìm thấy mốc kết thúc khối khoá");
  return src.slice(i, j).split("\n").map((l) => l.replace(/^ {12}/, "")).join("\n");
}

function danhSachThaoTac(): string[] {
  const src = doc("ops-vps.yml");
  const i = src.indexOf("        options:\n");
  const j = src.indexOf("      days:", i);
  const ds = [...src.slice(i, j).matchAll(/^ {10}- ([a-z0-9-]+)/gm)].map((m) => m[1]);
  assert.ok(ds.length > 50, `danh sách thao tác đọc được quá ngắn (${ds.length})`);
  return ds;
}

/** Ba danh sách phân loại — ĐỌC TỪ SHELL SẼ CHẠY THẬT, không chép tay sang đây. */
function cacLop(khoi: string): Record<"DOC_NHE" | "DOC_PROBE" | "DOC_NANG", string[]> {
  const lay = (ten: string) => {
    const m = new RegExp(`^${ten}="([^"]*)"`, "m").exec(khoi);
    assert.ok(m, `không tìm thấy danh sách ${ten} trong khối khoá`);
    return m[1].trim().split(/\s+/);
  };
  return { DOC_NHE: lay("DOC_NHE"), DOC_PROBE: lay("DOC_PROBE"), DOC_NANG: lay("DOC_NANG") };
}

const PHAI_LA_GHI = [
  "restart", "rotate-webhook-secrets", "apply-ai-env", "apply-sepay-env", "apply-tech-github-env",
  // `backup` RỜI danh sách này ngày 24/09/2026, CÓ CHỦ Ý: nó không đổi trạng thái production nào
  // (pg_dump đọc một ảnh chụp MVCC, chỉ ghi tệp vào /root/backups) nhưng là phép ĐỌC NẶNG nhất ERP
  // có — nên nó ở làn DOC_NANG, cùng cặp khoá 8 → 9 với lượt cron của scripts/erp-backup.sh.
  // Để nó ở làn GHI (khoá vòng đời ĐỘC QUYỀN) thì mỗi lượt sao lưu chặn MỌI lượt đọc vài phút, và
  // script — vốn cần FD 8 — sẽ phải xin FD 8 SAU FD 9: đúng thứ tự ngược mà khối khoá cấm.
  // tests/backup.test.ts khoá làn của nó.
  "sepay-schedule", "docker-prune", "set-setting", "run-job",
  "sync-pancake-all", "sync-pancake-orders", "sync-vtp-tracking", "sync-vtp-import",
  "sync-facebook-ads", "seed-employees", "import-bank-ledger", "import-vtp-statements",
  "bank-ledger-prune", "vtp-statements-autolink", "vtp-retry-webhooks", "cs-cleanup",
  "vtp-import-preview", "sepay-verify",
];

export function testKhoiKhoaOps() {
  const khoi = khoiKhoaOps();

  for (const [ten, p] of [["vòng đời", KHOA_VONG_DOI], ["đọc nặng", KHOA_DB], ["dò API", KHOA_PROBE]] as const) {
    assert.ok(khoi.includes(p), `phải khai ổ khoá ${ten} tại ${p}`);
  }

  // ───────── KHOÁ PHẢI GẮN VÀO FILE DESCRIPTOR, KHÔNG PHẢI "TẠO FILE RỒI XOÁ" ─────────
  // Khoá tự chế bằng sự tồn tại của một tệp để lại khoá MA vĩnh viễn mỗi lần một lượt chạy bị
  // huỷ giữa chừng — và lượt chạy ở đây BỊ HUỶ THẬT (người bấm Cancel, hết giờ job).
  assert.match(khoi, /flock /, "phải dùng `flock` của nhân Linux");
  assert.match(khoi, /exec \$1>/, "khoá phải gắn vào một file descriptor để nhân tự nhả khi tiến trình chết");
  assert.ok(!/rm -f .*\.lock/.test(khoi), "không được tự chế khoá bằng cách xoá tệp");

  // ───────── THỨ TỰ CỐ ĐỊNH: (1) tài nguyên FD 8 → (2) vòng đời FD 9 ─────────
  // Đây là toàn bộ phần chứng minh không bế tắc. Không đường nào được lấy 9 rồi mới xin 8.
  const nhanh = (ten: string) => {
    const m = new RegExp(`^ {2}${ten}\\)\\n([\\s\\S]*?);;`, "m").exec(khoi);
    assert.ok(m, `không tìm thấy nhánh ${ten} trong khối khoá`);
    return m[1];
  };
  for (const ten of ["DOC_NANG", "DOC_PROBE"]) {
    const than = nhanh(ten);
    const i8 = than.indexOf("xin_khoa 8");
    const i9 = than.indexOf("xin_khoa 9");
    assert.ok(i8 >= 0 && i9 >= 0, `${ten} phải lấy CẢ khoá tài nguyên (8) lẫn khoá vòng đời (9)`);
    assert.ok(
      i8 < i9,
      `${ten}: phải lấy khoá tài nguyên (FD 8) TRƯỚC khoá vòng đời (FD 9). Ngược lại thì một lượt ` +
        `đọc đang xếp hàng sẽ cầm khoá vòng đời và chặn deploy trong lúc chính nó đang chờ — và ` +
        `hai thứ tự khác nhau ở hai nhánh là một chu trình chờ, tức bế tắc.`,
    );
    assert.match(than, /xin_khoa 9 "\$KHOA_VONG_DOI" -s/, `${ten} phải lấy khoá vòng đời ở chế độ CHIA SẺ`);
  }
  const ghi = nhanh("GHI");
  assert.ok(!ghi.includes("xin_khoa 8"), "nhánh GHI KHÔNG được đụng FD 8 — nó là vế giữ cho đồ thị chờ không có chu trình");
  assert.match(ghi, /xin_khoa 9 "\$KHOA_VONG_DOI" -x/, "nhánh GHI phải lấy khoá vòng đời ĐỘC QUYỀN");
  assert.match(nhanh("DOC_NHE"), /xin_khoa 9 "\$KHOA_VONG_DOI" -s/,
    "đọc nhẹ VẪN phải cầm khoá vòng đời chia sẻ — đó chính là thứ chặn lỗi `container is not running`");

  // ───────── HẾT GIỜ PHẢI DỪNG HẲN, KHÔNG ÂM THẦM CHẠY TIẾP ─────────
  assert.match(khoi, /-w "\$4"/, "flock phải có trần chờ HỮU HẠN");
  assert.match(khoi, /::error::\[khoá\] HẾT GIỜ CHỜ/, "hết giờ phải in ::error:: để GitHub làm nổi lên");
  assert.match(khoi, /exit 75/, "hết giờ phải THOÁT với mã lỗi, không chạy thao tác");

  // ───────── NHẬT KÝ PHẢI TRUY NGƯỢC ĐƯỢC ─────────
  for (const [truong, re] of [
    ["mã lượt chạy", /run=\$RUN_ID/],
    ["tên thao tác", /action=\$ACTION/],
    ["lúc bắt đầu chờ", /xin \$_kieu \$2 .*lúc \$\(date/],
    ["lúc lấy được", /ĐÃ LẤY ĐƯỢC \$2 lúc \$\(date/],
    ["số giây đã chờ", /chờ \$\(\(_t1-_t0\)\)s/],
  ] as const) {
    assert.match(khoi, re, `nhật ký khoá phải ghi ${truong}`);
  }

  // ───────── PHÂN LOẠI ─────────
  const lop = cacLop(khoi);
  const thaoTac = danhSachThaoTac();
  const dem = new Map<string, number>();
  for (const a of [...lop.DOC_NHE, ...lop.DOC_PROBE, ...lop.DOC_NANG]) dem.set(a, (dem.get(a) ?? 0) + 1);
  for (const [a, n] of dem) {
    assert.equal(n, 1, `${a} nằm ở ${n} làn đọc — một thao tác chỉ thuộc đúng một làn`);
    assert.ok(thaoTac.includes(a), `${a} được phân làn nhưng KHÔNG có trong danh sách \`options:\``);
  }
  for (const a of PHAI_LA_GHI) {
    assert.ok(thaoTac.includes(a), `PHẢI_LÀ_GHI nhắc \`${a}\` nhưng ops-vps.yml không còn thao tác đó`);
    for (const [ten, ds] of Object.entries(lop)) {
      assert.ok(!ds.includes(a), `\`${a}\` đổi trạng thái production — không được nằm ở làn đọc ${ten}`);
    }
  }
  // Làn đọc nhẹ chạy song song KHÔNG giới hạn, nên nó là làn duy nhất có thể làm cạn RAM của một
  // VPS ~1,9 GB đang phục vụ người dùng thật. "Chỉ đọc" nói về DỮ LIỆU, không nói về BỘ NHỚ.
  const src = doc("ops-vps.yml");
  for (const a of lop.DOC_NHE) {
    const i = src.indexOf(`\n              ${a})\n`);
    assert.ok(i > 0, `không tìm thấy khối lệnh của \`${a}\``);
    assert.ok(
      !src.slice(i, src.indexOf(";;", i)).includes("npx tsx"),
      `\`${a}\` ở làn chạy-song-song-không-giới-hạn nhưng dựng một tiến trình \`npx tsx\` trong container`,
    );
  }

  console.log(
    `✓ Khối khoá ops: 3 ổ khoá · thứ tự CỐ ĐỊNH 8→9 (GHI không đụng 8) · hết giờ thoát 75 · ` +
      `nhật ký đủ 5 trường · ${lop.DOC_NHE.length} nhẹ / ${lop.DOC_PROBE.length} probe / ` +
      `${lop.DOC_NANG.length} nặng / ${PHAI_LA_GHI.length}+ ghi`,
  );
}

/* ═════════════════ 3 · `release` CỦA DEPLOY DÙNG ĐÚNG Ổ KHOÁ ẤY ═════════════════ */

export function testKhoaCuaRelease() {
  const src = doc("deploy-vps.yml");
  const i = src.indexOf("KHOÁ VÒNG ĐỜI — ĐỘC QUYỀN");
  assert.ok(i > 0, "job `release` phải lấy khoá vòng đời trước khi chạm máy chủ");
  const than = src.slice(i, src.indexOf("curl -fsSL", i));

  assert.ok(than.includes(KHOA_VONG_DOI), `release phải dùng ĐÚNG ổ khoá ${KHOA_VONG_DOI} mà thao tác GHI của ops dùng`);
  assert.match(than, /flock -x -w "\$LOCK_WAIT_WRITE" 9/, "release phải lấy ĐỘC QUYỀN với trần chờ hữu hạn");
  assert.match(than, /exec 9>"\$KHOA_VONG_DOI"/, "khoá phải gắn vào FD để nhân tự nhả khi SSH đứt");
  assert.match(than, /::error::\[khoá\] HẾT GIỜ CHỜ/, "hết giờ phải in ::error::");
  assert.match(than, /exit 75/, "hết giờ thì DEPLOY DỪNG — không được chạy đè một lệnh ghi khác");

  // Khoá phải lấy TRƯỚC mọi thứ chạm máy chủ. `bootstrap.sh` là thứ pull ảnh, chạy migration và
  // dựng lại container; lấy khoá sau nó thì khoá chẳng bảo vệ gì.
  assert.ok(
    src.indexOf("flock -x", i) < src.indexOf("bootstrap.sh", i),
    "phải lấy khoá TRƯỚC khi chạy bootstrap.sh",
  );
  // Trần chờ phải nằm gọn trong giới hạn của bước SSH và của job, nếu không lượt chạy bị cắt
  // ngang ở một chỗ tuỳ tiện thay vì đỏ với một lời báo đọc được.
  const tran = Number(/LOCK_WAIT_WRITE: "(\d+)"/.exec(src)?.[1]);
  assert.ok(Number.isFinite(tran) && tran > 0, "release phải khai LOCK_WAIT_WRITE");
  const sshPhut = Number(/command_timeout: (\d+)m/.exec(src)?.[1]);
  const jobPhut = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(src.slice(src.indexOf("  release:")))?.[1]);
  assert.ok(tran / 60 < sshPhut, `trần chờ ${tran}s phải NHỎ HƠN command_timeout ${sshPhut}m`);
  assert.ok(tran / 60 < jobPhut, `trần chờ ${tran}s phải NHỎ HƠN timeout-minutes ${jobPhut}m của job`);

  assert.match(src, /^ {2}release:\n {4}needs: \[gates, build_image\]$/m, "release vẫn phải cần CẢ hai cổng");
  console.log(`✓ release: flock -x trên cùng ổ khoá vòng đời, lấy trước bootstrap.sh, trần ${tran}s < SSH ${sshPhut}m và job ${jobPhut}m`);
}

/* ═════════ 4 · CHẠY THẬT KHỐI KHOÁ, VỚI `flock` THẬT ═════════ */

/**
 * Trích khối khoá ra, đổi `/var/lock` thành một thư mục tạm, rồi CHẠY. Không mô phỏng bằng lời:
 * ngữ nghĩa chia sẻ/độc quyền, thứ tự hàng đợi và hành vi lúc hết giờ đều là của nhân Linux, và
 * chỉ có chạy thật mới nói đúng chúng.
 */
function kichBan(tmp: string): string {
  const khoi = khoiKhoaOps().split("/var/lock").join(path.join(tmp, "locks"));
  return [
    "#!/usr/bin/env bash",
    "set -e", // ĐÚNG cờ workflow đặt
    'ACTION="$1"; ARG="$2"; GIU="$3"',
    'RUN_ID="kiem-$$"',
    'LOCK_WAIT_READ="${LOCK_WAIT_READ:-6}"; LOCK_WAIT_WRITE="${LOCK_WAIT_WRITE:-6}"',
    khoi,
    // Mốc in ra QUANH VÙNG ĐÃ CẦM KHOÁ. Đo bằng mốc của tiến trình thì sai: khoảng đó bao gồm
    // cả thời gian ĐỨNG CHỜ khoá, nên hai lượt nối tiếp hoàn hảo vẫn "chồng nhau" trên giấy.
    'echo "CHAY $ACTION $(date +%s%N)"',
    'sleep "$GIU"',
    'echo "XONG $ACTION $(date +%s%N)"',
    "",
  ].join("\n");
}

type KetQua = { ma: number; ra: string; lop: string; batDau: number; ketThuc: number };

/** Vùng TỚI HẠN (đã cầm khoá) tính bằng mili-giây, đọc từ mốc script tự in ra. */
function vungToiHan(r: KetQua): { vao: number; ra: number } {
  const v = /CHAY \S+ (\d+)/.exec(r.ra);
  const x = /XONG \S+ (\d+)/.exec(r.ra);
  assert.ok(v && x, `không đọc được mốc vùng tới hạn:\n${r.ra}`);
  return { vao: Number(v[1]) / 1e6, ra: Number(x[1]) / 1e6 };
}

function chay(kich: string, action: string, arg: string, giu: number, moi: Record<string, string> = {}): KetQua {
  const batDau = Date.now();
  let ma = 0;
  let ra = "";
  try {
    ra = execFileSync("bash", [kich, action, arg, String(giu)], {
      stdio: "pipe", encoding: "utf8", env: { ...process.env, ...moi },
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    ma = err.status ?? 1;
    ra = String(err.stdout ?? "") + String(err.stderr ?? "");
  }
  const lop = /⇒ (\w+)/.exec(ra)?.[1] ?? "";
  return { ma, ra, lop, batDau, ketThuc: Date.now() };
}

/** Chạy nhiều lệnh song song thật (mỗi lệnh một tiến trình) và trả về mốc thời gian của từng lệnh. */
function chaySongSong(kich: string, ds: { action: string; arg?: string; giu: number; tre?: number }[]): KetQua[] {
  const cha = ds
    .map((d, i) =>
      `( sleep ${(d.tre ?? 0) / 1000}; s=$(date +%s%N); out=$(bash ${JSON.stringify(kich)} ${JSON.stringify(d.action)} ${JSON.stringify(d.arg ?? "")} ${d.giu} 2>&1); ma=$?; e=$(date +%s%N); ` +
      `printf '%s\\u0001%s\\u0001%s\\u0001%s\\u0002' ${i} "$ma" "$s $e" "$out" ) &`,
    )
    .join("\n");
  const raw = execFileSync("bash", ["-c", `${cha}\nwait`], { stdio: "pipe", encoding: "utf8", maxBuffer: 1 << 24 });
  const kq: KetQua[] = new Array(ds.length);
  for (const phan of raw.split("\u0002")) {
    if (!phan.trim()) continue;
    const [i, ma, moc, out] = phan.split("\u0001");
    const [s, e] = moc.trim().split(" ").map((x) => Number(x) / 1e6);
    kq[Number(i)] = { ma: Number(ma), ra: out, lop: /⇒ (\w+)/.exec(out)?.[1] ?? "", batDau: s, ketThuc: e };
  }
  return kq;
}

/**
 * ═══════════ CÔNG CỤ POSIX PHẢI CÓ — VÀ THIẾU THÌ NÓI THẲNG ═══════════
 *
 * Bài kiểm dưới đây chạy `ops-vps.yml` THẬT dưới `bash` với `flock` thật: đó là điểm của nó, vì
 * một ổ khoá "đúng theo lời kể" đã từng để hai lệnh ghi cùng chạy trên VPS.
 *
 * `flock` KHÔNG có trong Git Bash trên Windows (đo 20/09/2026). Hai lối sai:
 *
 *  · Mô phỏng bằng lời ⇒ bài kiểm xanh mà không đo gì.
 *  · Lặng lẽ bỏ qua    ⇒ ngày CI mất `flock` thì cũng xanh, đúng lúc cần đỏ nhất.
 *
 * Nên: thiếu `flock` trên LINUX (nơi script này thật sự chạy, gồm cả CI) là ĐỎ. Trên nền mà script
 * không bao giờ chạy, in ra "CHƯA ĐO ĐƯỢC" — một câu trung thực, khác hẳn một dấu ✓.
 */
function coFlock(): boolean {
  try {
    execFileSync("flock", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function testKhoaChayThat() {
  if (!coFlock()) {
    assert.notEqual(process.platform, "linux", "Linux PHẢI có flock — thiếu nó thì ổ khoá vòng đời không được đo, và đó là lỗi hạ tầng CI chứ không phải chuyện bỏ qua được");
    console.log(`⚠ Ổ khoá ops: CHƯA ĐO ĐƯỢC trên ${process.platform} (không có flock). Bài này đo bash+flock thật; nó vẫn chạy đủ trên Linux/CI.`);
    return;
  }
  const tmp = mkdtempSync(path.join(tmpdir(), "ops-khoa-"));
  const kich = path.join(tmp, "run.sh");
  writeFileSync(kich, kichBan(tmp));
  execFileSync("mkdir", ["-p", path.join(tmp, "locks")]);

  try {
    // ───────── PHÂN LOẠI: mặc định GHI, và cờ đè lên tên ─────────
    const bang: [string, string, string][] = [
      ["status", "", "DOC_NHE"],
      ["db-query", "", "DOC_NHE"],
      ["vtp-probe", "VTP123", "DOC_PROBE"],
      ["kpi-snapshot", "", "DOC_NANG"],
      ["verify", "", "DOC_NANG"],
      ["restart", "", "GHI"],
      ["vtp-import-preview", "", "GHI"],
      ["thao-tac-chua-ton-tai", "", "GHI"],     // MẶC ĐỊNH LÀ GHI
      ["status", "--apply", "GHI"],             // cờ đè lên tên
      ["kpi-snapshot", "--apply", "GHI"],
      ["ai-check", "--write", "GHI"],
      ["outcome-parity", "--from=2026-09-01 --apply", "GHI"],
      ["cod-rebuild", "--fix", "GHI"],
    ];
    for (const [a, arg, mong] of bang) {
      const r = chay(kich, a, arg, 0);
      assert.equal(r.lop, mong, `action=${a} arg="${arg}" phải vào lớp ${mong}, nhận "${r.lop}"\n${r.ra}`);
    }

    // ───────── HAI LƯỢT ĐỌC NẶNG KHÔNG ĐƯỢC CHỒNG NHAU ─────────
    {
      const [a, b] = chaySongSong(kich, [
        { action: "kpi-snapshot", giu: 2 },
        { action: "explain-stock", giu: 0, tre: 300 },
      ]);
      assert.equal(a.ma, 0, `kpi-snapshot phải chạy trót lọt:\n${a.ra}`);
      assert.equal(b.ma, 0, `explain-stock phải chạy trót lọt:\n${b.ra}`);
      assert.ok(
        b.batDau < a.ketThuc,
        "bài kiểm phải THẬT SỰ chồng thời gian, nếu không nó không kiểm gì cả",
      );
      assert.ok(/\[khoá\] ĐÃ LẤY ĐƯỢC.*erp-readonly-db/.test(b.ra), "lượt thứ hai phải đi qua ổ khoá đọc nặng");
      // ĐO THỨ TỰ VÙNG TỚI HẠN, KHÔNG ĐỌC SỐ GIÂY TRONG LOG. Nhật ký làm tròn xuống giây
      // (`$((_t1-_t0))`), nên một lượt chờ thật 0,6 giây in ra "chờ 0s" — bám vào chuỗi đó là
      // dựng một bài kiểm đỏ ngẫu nhiên theo tốc độ máy. Tính chất cần chứng minh vốn là THỨ TỰ,
      // và thứ tự thì đo được chính xác.
      const va = vungToiHan(a);
      const vb = vungToiHan(b);
      assert.ok(
        vb.vao >= va.ra - 50,
        `lượt đọc nặng thứ hai vào vùng tới hạn lúc ${vb.vao} nhưng lượt đầu mới ra lúc ${va.ra} — hai lượt đã chồng nhau`,
      );
    }

    // ───────── HAI LƯỢT ĐỌC NHẸ PHẢI CHỒNG NHAU ĐƯỢC ─────────
    // Khoá chia sẻ: nhiều lượt đọc cùng lúc là ĐÚNG. Nếu chúng nối đuôi nhau thì làn nhẹ đã mất
    // đúng tính chất khiến nó tồn tại.
    {
      const [a, b] = chaySongSong(kich, [
        { action: "status", giu: 2 },
        { action: "logs", giu: 2, tre: 200 },
      ]);
      assert.equal(a.ma, 0);
      assert.equal(b.ma, 0);
      const va = vungToiHan(a);
      const vb = vungToiHan(b);
      const chong = Math.min(va.ra, vb.ra) - Math.max(va.vao, vb.vao);
      assert.ok(chong > 1000, `hai lượt đọc nhẹ phải chồng nhau trong vùng tới hạn (chồng ${Math.round(chong)}ms) — khoá CHIA SẺ`);
    }

    // ───────── LƯỢT GHI PHẢI CHỜ LƯỢT ĐỌC XONG (ĐÂY LÀ BẢN VÁ CHO LỖI A) ─────────
    // Đúng tình huống đã giết `explain-stock` 1406: deploy dựng lại container dưới chân một phép
    // đọc đang chạy. Nay deploy phải chờ.
    {
      const [doc_, ghi] = chaySongSong(kich, [
        { action: "verify", giu: 2 },
        { action: "restart", giu: 0, tre: 300 },
      ]);
      assert.equal(doc_.ma, 0, `lượt đọc phải chạy trót lọt:\n${doc_.ra}`);
      assert.equal(ghi.ma, 0, `lượt ghi phải chạy trót lọt (sau khi chờ):\n${ghi.ra}`);
      // Vùng tới hạn của lượt GHI phải bắt đầu SAU khi vùng tới hạn của lượt ĐỌC kết thúc.
      const vd = vungToiHan(doc_);
      const vg = vungToiHan(ghi);
      assert.ok(
        vg.vao >= vd.ra - 50,
        `lượt ghi vào vùng tới hạn lúc ${vg.vao} nhưng lượt đọc mới ra lúc ${vd.ra} — deploy đã dựng ` +
          `lại container dưới chân một phép đọc đang chạy, đúng lỗi phải vá`,
      );
    }

    // ───────── BA LỆNH GHI LIÊN TIẾP: KHÔNG LỆNH NÀO ĐƯỢC BIẾN MẤT ─────────
    // Đây là bản vá cho lỗi B. Với `concurrency` của GitHub, lệnh thứ hai bị lệnh thứ ba HUỶ.
    // Với `flock`, cả ba phải lần lượt lấy được khoá.
    {
      const kq = chaySongSong(kich, [
        { action: "restart", giu: 1 },
        // `backup` từng đứng ở đây; nó đã sang làn DOC_NANG (24/09/2026) nên không còn là lệnh ghi.
        { action: "docker-prune", giu: 1, tre: 200 },
        { action: "set-setting", giu: 1, tre: 400 },
      ]);
      for (const [i, r] of kq.entries()) {
        assert.equal(r.ma, 0, `lệnh ghi thứ ${i + 1} phải CHỜ RỒI CHẠY, không được biến mất:\n${r.ra}`);
        assert.match(r.ra, /CHAY /, `lệnh ghi thứ ${i + 1} phải thật sự chạy`);
      }
      // …và VÙNG TỚI HẠN của chúng không được chồng nhau. (Tiến trình thì chồng — cả ba cùng
      // sống và cùng đứng chờ; đó chính là điều đang muốn: chờ, chứ không biến mất.)
      const moc = kq.map(vungToiHan).sort((x, y) => x.vao - y.vao);
      for (let i = 1; i < moc.length; i++) {
        assert.ok(
          moc[i].vao >= moc[i - 1].ra - 50,
          `hai lệnh ghi chồng vùng tới hạn (${moc[i - 1].vao}→${moc[i - 1].ra} và ${moc[i].vao}→${moc[i].ra}) ` +
            `— khoá độc quyền không giữ được điều nó hứa`,
        );
      }
      /*
        VÀ HÀNG ĐỢI PHẢI THẬT SỰ ĐƯỢC CHẠM TỚI — nếu không bài kiểm chỉ chạy ba lệnh nối đuôi một
        cách tình cờ và chẳng chứng minh gì.

        Bản đầu hỏi "có ít nhất hai lượt ghi nhận số giây chờ > 0 không" và nó ĐỎ NGẪU NHIÊN
        1/12 lượt: nhật ký làm tròn xuống giây, nên một lượt chờ thật 0,6 giây in ra "chờ 0s".
        Một bài kiểm đỏ vì máy hôm nay nhanh hơn thì sau ba lần không ai đọc thông điệp của nó
        nữa — họ chỉ đi chạy lại.

        Thay bằng một phép đo KHÔNG phụ thuộc làm tròn: ba lượt, mỗi lượt giữ khoá GIU giây, mà
        không được chồng nhau ⇒ khoảng từ lúc lượt đầu VÀO tới lúc lượt cuối RA phải ≥ 3×GIU.
        Nếu khoá hỏng và ba lượt chạy song song thì khoảng ấy chỉ ~1×GIU — hai con số cách nhau
        gấp ba, không có vùng xám.
      */
      const vao = Math.min(...moc.map((m) => m.vao));
      const raCuoi = Math.max(...moc.map((m) => m.ra));
      const nhip = raCuoi - vao;
      assert.ok(
        nhip >= 2500,
        `ba lệnh ghi mỗi lệnh giữ khoá 1s phải trải ra ≥ 3s nếu chúng thật sự nối tiếp; đo được ` +
          `${Math.round(nhip)}ms — khoá độc quyền không giữ được điều nó hứa`,
      );
    }

    // ───────── HẾT GIỜ: DỪNG HẲN, ỒN ÀO, KHÔNG CHẠY THAO TÁC ─────────
    // "Chờ không được thì thôi chạy luôn" là cách một bản vá khoá tự vô hiệu hoá chính nó.
    {
      // Giữ khoá bằng một tiến trình nền rồi xin với trần 1 giây. Thao tác phải là lệnh GHI (trần
      // LOCK_WAIT_WRITE): `backup` từng đứng ở đây, nhưng nó đã sang làn DOC_NANG nên trần của nó là
      // LOCK_WAIT_READ, khoá chia sẻ tới sau 3–4 giây và lệnh CHẠY — bài đỏ trên Linux, và chỉ ở đó.
      const nen = path.join(tmp, "giu.sh");
      writeFileSync(nen, `#!/usr/bin/env bash\nexec 9>${JSON.stringify(path.join(tmp, "locks", "erp-lifecycle.lock"))}\nflock -x 9\nsleep 4\n`);
      const raw = execFileSync("bash", ["-c",
        `bash ${JSON.stringify(nen)} & sleep 0.5; ` +
        `LOCK_WAIT_WRITE=1 bash ${JSON.stringify(kich)} restart "" 0 2>&1; echo "MA=$?"; wait`,
      ], { stdio: "pipe", encoding: "utf8" });
      assert.match(raw, /MA=75/, `hết giờ phải thoát 75:\n${raw}`);
      assert.match(raw, /::error::\[khoá\] HẾT GIỜ CHỜ/, "…và in ::error:: để GitHub làm nổi lên");
      assert.ok(!raw.includes("CHAY restart"), "…và TUYỆT ĐỐI không chạy thao tác khi không có khoá");
    }

    // ───────── LƯỢT ĐỌC NẶNG ĐANG XẾP HÀNG KHÔNG ĐƯỢC CẦM KHOÁ VÒNG ĐỜI ─────────
    // Nếu nó cầm, một hàng dài lượt đọc sẽ chặn deploy trong lúc chính chúng đang chờ nhau.
    {
      const kq = chaySongSong(kich, [
        { action: "kpi-snapshot", giu: 3 },                  // giữ khoá đọc nặng + vòng đời chia sẻ
        { action: "explain-stock", giu: 0, tre: 200 },        // xếp hàng ở khoá đọc nặng
        { action: "restart", giu: 0, tre: 600 },              // xin vòng đời ĐỘC QUYỀN
      ]);
      for (const r of kq) assert.equal(r.ma, 0, `tất cả phải chạy được:\n${r.ra}`);
      // `restart` chỉ cần chờ lượt ĐANG CHẠY nhả, không phải chờ cả hàng đọc — nhưng quan trọng
      // hơn: không có bế tắc, cả ba đều kết thúc.
      assert.ok(kq.every((r) => /XONG /.test(r.ra)), "không được bế tắc — cả ba phải chạy xong");
    }

    console.log("✓ flock THẬT: đọc nặng nối tiếp · đọc nhẹ chồng nhau · GHI chờ ĐỌC (vá lỗi A) · 3 lệnh ghi không lệnh nào biến mất (vá lỗi B) · hết giờ thoát 75 và không chạy · không bế tắc");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* ═════════════════ 5 · TÊN CHECK BẮT BUỘC KHÔNG ĐƯỢC ĐỔI ═════════════════ */

export function testTenCheckBatBuoc() {
  assert.match(doc("ci.yml"), /^jobs:\n {2}gates:\n/m, "job của ci.yml phải giữ tên `gates`");
  assert.match(doc("gates.yml"), /^jobs:\n {2}gates:\n/m, "job của gates.yml phải giữ tên `gates`");
  assert.ok(
    readFileSync(".github/rulesets/main-protection.json", "utf8").includes('"gates / gates"'),
    "ruleset vẫn phải đòi đúng check `gates / gates` — đổi tên job là gỡ khoá `main` mà không ai thấy",
  );
  assert.match(
    doc("ci.yml"),
    /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/,
    "`cancel-in-progress` chỉ được bật cho pull request",
  );
  console.log("✓ Tên check bắt buộc `gates / gates` còn nguyên · CI chỉ huỷ lượt cũ trên PR");
}

/**
 * ═══════════ BIẾN KHAI Ở `env:` MÀ QUÊN Ở `envs:` THÌ TRÊN MÁY CHỦ NÓ RỖNG ═══════════
 *
 * `appleboy/ssh-action` CHỈ chuyển xuống shell từ xa những biến có tên trong `with.envs`. Khai ở
 * `env:` của bước là điều kiện CẦN, không phải điều kiện ĐỦ — và khi thiếu vế thứ hai thì không
 * có lỗi nào cả: biến chỉ đơn giản rỗng ở đầu kia.
 *
 * ĐÃ TỐN MỘT LƯỢT THẬT (ops #1465, 19/09/2026). Ba biến `ERP_AGENT_GITHUB_*` có đủ ở `env:`,
 * thiếu ở `envs:`, nên `apply-agent-env` in ra:
 *
 *     Thiếu Secret: ERP_AGENT_GITHUB_APP_ID ERP_AGENT_GITHUB_INSTALLATION_ID ERP_AGENT_GITHUB_PRIVATE_KEY
 *
 * trong khi cả ba Secret ĐỀU CÓ trong kho. Đó là kiểu hỏng tệ nhất: thông điệp lỗi **đúng ngữ
 * pháp và sai địa chỉ** — nó gửi người đọc đi nhập lại secret, đúng chỗ không hỏng, và cái hỏng
 * thật thì không ai nhìn.
 *
 * VÌ SAO KIỂM CẢ LỚP CHỨ KHÔNG KIỂM BA BIẾN ĐÓ: liệt kê đúng ba cái tên vừa hỏng là khoá lại
 * ĐÚNG lần hỏng đã xảy ra. Biến thứ tư thêm vào tháng sau vẫn rơi vào y hệt cái bẫy. Bất biến
 * đúng là: **mọi** khoá khai ở `env:` của bước SSH phải có mặt ở `envs:` — vì khối `env:` ấy tồn
 * tại không vì mục đích nào khác ngoài việc nuôi shell từ xa.
 */
export function testEnvsChuyenDuXuong() {
  const src = doc("ops-vps.yml");

  /* Mỗi bước `appleboy/ssh-action` là một cặp `env:` + `with.envs:`. Quét TẤT CẢ, không chỉ bước
     đầu: ba secret của agent đã dọn sang job `agent-env` riêng (Environment `agent-identity`), nên
     một bài kiểm ghim vào một bước duy nhất sẽ đỏ vì kiến trúc đổi, chứ không vì luật bị phá. */
  const dong = src.split("\n");
  const buoc: { ten: string; khaiBao: string[]; chuyenXuong: Set<string> }[] = [];
  for (let i = 0; i < dong.length; i += 1) {
    if (!/^ {8}env:\s*$/.test(dong[i]!)) continue;
    let k = i + 1;
    const khaiBao: string[] = [];
    for (; k < dong.length && !/^ {8}with:\s*$/.test(dong[k]!); k += 1) {
      const m = /^ {10}([A-Z][A-Z0-9_]*):/.exec(dong[k]!);
      if (m) khaiBao.push(m[1]!);
    }
    if (k >= dong.length) continue;
    let envs: string | null = null;
    for (let t = k; t < dong.length && !/^ {8}\w/.test(dong[t]!) || t === k; t += 1) {
      const m = /^ {10}envs: (.+)$/.exec(dong[t]!);
      if (m) {
        envs = m[1]!;
        break;
      }
      if (t > k + 40) break;
    }
    assert.ok(envs, `bước SSH ở dòng ${i + 1} phải có \`envs:\`; thiếu nó thì KHÔNG biến nào xuống được máy chủ`);
    const ten = [...dong.slice(Math.max(0, i - 60), i)].reverse().find((d) => /^ {2}[\w-]+:\s*$/.test(d))?.trim().replace(":", "") ?? `dòng ${i + 1}`;
    buoc.push({ ten, khaiBao, chuyenXuong: new Set(envs!.split(",").map((x) => x.trim()).filter(Boolean)) });
  }
  assert.ok(buoc.length >= 2, `phải thấy ít nhất 2 bước SSH (ops + agent-env), thấy ${buoc.length}`);

  for (const b of buoc) {
    assert.ok(b.khaiBao.length >= 3, `${b.ten}: đọc được ${b.khaiBao.length} biến ở env: — quá ít, bộ đọc hỏng chứ không phải workflow hỏng`);
    const thieu = b.khaiBao.filter((k) => !b.chuyenXuong.has(k));
    assert.deepEqual(thieu, [], `${b.ten}: khai ở env: nhưng THIẾU ở envs: ${thieu.join(", ")} — trên máy chủ chúng sẽ RỖNG, và thao tác sẽ báo "thiếu Secret" trong khi Secret có đủ`);
    const thua = [...b.chuyenXuong].filter((k) => !b.khaiBao.includes(k));
    assert.deepEqual(thua, [], `${b.ten}: có ở envs: nhưng KHÔNG khai ở env: ${thua.join(", ")} — tên thừa làm danh sách trông đầy đủ hơn sự thật`);
  }

  /* Ba biến danh tính agent: nay thuộc bước SSH của job `agent-env`, và PHẢI đủ cả hai vế ở ĐÓ —
     đây đúng là lỗi đã làm ops #1465 đỏ, chỉ khác chỗ ở. */
  const agent = buoc.find((b) => b.khaiBao.includes("ERP_AGENT_GITHUB_APP_ID"));
  assert.ok(agent, "phải có một bước SSH khai ba biến danh tính agent (job `agent-env`)");
  for (const k of ["ERP_AGENT_GITHUB_APP_ID", "ERP_AGENT_GITHUB_INSTALLATION_ID", "ERP_AGENT_GITHUB_PRIVATE_KEY"]) {
    assert.ok(agent!.khaiBao.includes(k), `${k} phải được khai ở env: của bước SSH job agent-env`);
    assert.ok(agent!.chuyenXuong.has(k), `${k} phải có ở envs: — đây đúng là lỗi đã làm ops #1465 đỏ`);
  }
  // Và chúng KHÔNG được quay lại bước SSH của job `ops`: ở đó chúng kéo theo cả Environment.
  const ops = buoc.find((b) => b.ten === "ops");
  assert.ok(ops, "phải thấy bước SSH của job `ops`");
  assert.ok(!ops!.khaiBao.some((k) => k.startsWith("ERP_AGENT_GITHUB_")), "job `ops` không được khai lại ba biến danh tính agent — chúng đã dọn sang job riêng có Environment");

  // KHOÁ RIÊNG KHÔNG BAO GIỜ ĐƯỢC IN. Kho này PUBLIC, log Actions ai cũng đọc.
  const iAgent = src.indexOf("agent-env:");
  assert.ok(iAgent > 0, "không tìm thấy job agent-env");
  const than = src.slice(iAgent);
  assert.ok(!/echo[^\n]*"\$ERP_AGENT_GITHUB_PRIVATE_KEY"/.test(than), "job agent-env không được in GIÁ TRỊ khoá riêng");
  assert.ok(/\$\{#ERP_AGENT_GITHUB_PRIVATE_KEY\}/.test(than), "job agent-env phải in ĐỘ DÀI khoá riêng — đủ để biết đã ghi được, không đủ để dùng lại");

  console.log(
    `✓ Biến xuống được máy chủ: ${buoc.length} bước SSH, mỗi bước mọi khoá ở env: đều có ở envs: (và ngược lại) · ba biến danh tính agent nằm ở job agent-env và KHÔNG còn ở job ops · khoá riêng chỉ in độ dài`,
  );
}

/**
 * ═══════════ MỘT THAO TÁC ops CHỈ ĐƯỢC CÓ MỘT NHÁNH `case` ═══════════
 *
 * SỰ CỐ THẬT 22/09/2026: `sync-facebook-ads` có **hai** nhánh giống hệt nhau. Nhánh thứ hai không
 * bao giờ chạy — `case` trong shell dừng ở nhánh khớp đầu tiên.
 *
 * Bản sao giống hệt thì vô hại. Điều nguy hiểm là ngày có người **sửa nhánh thứ hai**: họ đọc mã,
 * thấy đúng dòng mình cần đổi, sửa nó, chạy thử, và thao tác vẫn hành xử y như cũ. Không gì đỏ,
 * không gì báo — chỉ có một bản vá không bao giờ có hiệu lực. Đó là lớp lỗi đắt nhất trong tệp này
 * vì nó tiêu thời gian của người sửa chứ không tiêu thời gian của máy.
 *
 * Danh sách thao tác ở đầu tệp (`options:`) cũng phải không trùng: hai mục cùng tên trong một
 * `choice` là hai dòng giống nhau trong danh sách sổ xuống, và người bấm không biết chọn cái nào.
 */
export function testOpsKhongTrungNhanh() {
  const yml = readFileSync(".github/workflows/ops-vps.yml", "utf8");

  // Nhánh `case`: đúng 14 dấu cách rồi tên thao tác rồi `)`.
  const nhanh = [...yml.matchAll(/^ {14}([a-z0-9-]+)\)$/gm)].map((m) => m[1]);
  assert.ok(nhanh.length > 30, `đọc hụt nhánh case (chỉ thấy ${nhanh.length}) — biểu thức không còn khớp hình dạng tệp`);
  const trungNhanh = nhanh.filter((x, i) => nhanh.indexOf(x) !== i);
  assert.deepEqual(
    [...new Set(trungNhanh)],
    [],
    `Thao tác ops có HAI nhánh case: ${[...new Set(trungNhanh)].join(", ")}. Nhánh thứ hai không bao giờ chạy — người sửa nó sẽ mất buổi chiều để hiểu vì sao bản vá không có hiệu lực.`,
  );

  // Danh sách lựa chọn ở đầu tệp.
  const muc = [...yml.matchAll(/^ {10}- ([a-z0-9-]+)\b/gm)].map((m) => m[1]);
  assert.ok(muc.length > 30, `đọc hụt danh sách thao tác (chỉ thấy ${muc.length})`);
  const trungMuc = muc.filter((x, i) => muc.indexOf(x) !== i);
  assert.deepEqual([...new Set(trungMuc)], [], `Danh sách thao tác có mục trùng: ${[...new Set(trungMuc)].join(", ")}`);

  // Mọi nhánh phải có mặt trong danh sách — một nhánh không ai chọn được là mã chết.
  const khongChonDuoc = [...new Set(nhanh)].filter((n) => !muc.includes(n));
  assert.deepEqual(khongChonDuoc, [], `Nhánh case không có trong danh sách lựa chọn (không ai bấm tới được): ${khongChonDuoc.join(", ")}`);

  console.log(`✓ Thao tác ops: ${new Set(nhanh).size} nhánh case · không nhánh nào trùng · không mục nào trùng · mọi nhánh đều chọn được`);
}

export function testOpsConcurrency() {
  testKhongDungConcurrencyLamHangDoi();
  testKhoiKhoaOps();
  testKhoaCuaRelease();
  testKhoaChayThat();
  testTenCheckBatBuoc();
  testEnvsChuyenDuXuong();
  testOpsKhongTrungNhanh();
}

if (process.argv[1] && process.argv[1].endsWith("ops-concurrency.test.ts")) testOpsConcurrency();
