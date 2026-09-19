import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * ═══════════ KHOÁ ĐỒNG THỜI CỦA GITHUB ACTIONS LÀ MỘT LUẬT NGHIỆP VỤ ═══════════
 *
 * NGUYÊN NHÂN GỐC CỦA BÀI KIỂM NÀY. Tới 19/09/2026 cả `deploy-vps.yml` lẫn `ops-vps.yml` khai
 * `concurrency: vps-operations` ở MỨC WORKFLOW. Nhóm ấy gộp ba thứ hoàn toàn khác nhau vào một
 * hàng đợi:
 *
 *   · cổng chất lượng + dựng ảnh Docker — chạy trên máy của GitHub, KHÔNG chạm VPS (~20 phút);
 *   · một câu `db-query` chỉ đọc (~10 giây);
 *   · một lệnh nhập bảng kê đang GHI tiền vào sổ.
 *
 * Hậu quả: mọi phiên làm việc song song (AGENTS.md mục 9) đứng chờ nhau để hỏi một câu chỉ đọc,
 * trong khi thứ THẬT SỰ cần xếp hàng — hai lượt ghi — chỉ là một phần nhỏ của hàng đợi đó.
 *
 * VÌ SAO PHẢI CÓ BÀI KIỂM, KHÔNG PHẢI MỘT DÒNG CHÚ THÍCH: `tsc` và `eslint` không đọc YAML, và
 * `vps-operations` là thứ rất dễ quay lại — nó ngắn hơn, nó "an toàn hơn" khi đọc lướt, và người
 * thêm một thao tác mới sẽ chép đúng khối concurrency của tệp bên cạnh. Một lần quay lại là cả
 * kho mất lại toàn bộ phần tăng tốc mà không ai thấy: CI vẫn xanh, chỉ chậm đi.
 *
 * BỐN ĐIỀU BÀI NÀY KHOÁ:
 *
 *   1. `vps-operations` không còn tồn tại ở bất kỳ workflow nào.
 *   2. `ops-vps.yml` phân loại thao tác theo TÁC ĐỘNG, và MẶC ĐỊNH LÀ GHI — thao tác mới quên
 *      phân loại phải rơi vào `vps-mutating`, không phải một làn đọc.
 *   3. Cờ `--apply` / `--write` / `--fix` đè lên mọi phân loại theo tên.
 *   4. `deploy-vps.yml` chỉ khoá ở job `release`; `gates` và `build_image` không giữ khoá nào,
 *      nhưng `release` vẫn `needs` CẢ HAI — nhanh hơn không được đổi bằng bỏ cổng.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/ops-concurrency.test.ts
 */

const THU_MUC = ".github/workflows";

function doc(ten: string): string {
  return readFileSync(path.join(THU_MUC, ten), "utf8");
}

/**
 * Bỏ các dòng CHÚ THÍCH trước khi quét.
 *
 * Lý do rất cụ thể: chú thích của `deploy-vps.yml` và `ops-vps.yml` KỂ LẠI rằng nhóm
 * `vps-operations` từng tồn tại và vì sao nó bị bỏ — đó là phần có giá trị nhất của bản sửa, và
 * một bài kiểm cấm nhắc tới cái tên ấy sẽ buộc người sau xoá đúng lời giải thích khiến họ không
 * lặp lại lỗi cũ. Thứ phải cấm là KHAI BÁO trong YAML, không phải câu chữ trong chú thích.
 */
function boChuThich(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

/** Khối `concurrency:` ở MỨC WORKFLOW = cột 0. Khối của job thì luôn thụt vào. */
function khoaMucWorkflow(src: string): string | null {
  const m = /^concurrency:\n((?:[ \t].*\n?)*)/m.exec(src);
  return m ? m[1] : null;
}

/** Khối `concurrency:` của MỘT job, tìm theo tên job. */
function khoaCuaJob(src: string, job: string): string | null {
  const i = src.indexOf(`\n  ${job}:\n`);
  if (i < 0) return null;
  // Job kế tiếp bắt đầu bằng đúng hai dấu cách; lấy trọn thân job hiện tại.
  const sau = src.slice(i + 1);
  const m = /\n {2}[a-z_]+:\n/.exec(sau.slice(1));
  const than = m ? sau.slice(0, m.index + 1) : sau;
  const k = /^ {4}concurrency:\n((?: {6}.*\n?)*)/m.exec(than);
  return k ? k[1] : null;
}

/* ═════════════════ 1 · `vps-operations` KHÔNG ĐƯỢC QUAY LẠI ═════════════════ */

export function testKhongConNhomVpsOperations() {
  const tep = readdirSync(THU_MUC).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  assert.ok(tep.length >= 6, "phải đọc được đủ workflow của kho");

  for (const f of tep) {
    const src = boChuThich(doc(f));
    assert.ok(
      !src.includes("vps-operations"),
      `${f}: nhóm khoá \`vps-operations\` đã bị bỏ — nó gộp cổng chất lượng, thao tác chỉ đọc và ` +
        `thao tác ghi vào MỘT hàng đợi. Dùng \`vps-mutating\` cho thứ GHI, và một làn đọc riêng ` +
        `cho thứ CHỈ ĐỌC (xem chú thích đầu .github/workflows/ops-vps.yml).`,
    );
  }

  // Không workflow nào được đặt khoá production ở MỨC WORKFLOW: mức workflow giữ khoá từ giây
  // đầu tiên, tức là giữ luôn trong suốt phần chạy trên máy của GitHub.
  for (const f of ["deploy-vps.yml", "ops-vps.yml"]) {
    const muc = khoaMucWorkflow(boChuThich(doc(f)));
    assert.equal(
      muc,
      null,
      `${f}: không được khai \`concurrency\` ở mức workflow. Khoá phải nằm ở JOB thật sự chạm VPS, ` +
        `nếu không cổng và bước dựng ảnh cũng giữ khoá production suốt thời gian chúng chạy.`,
    );
  }

  console.log("✓ `vps-operations` không còn ở workflow nào · deploy/ops không khoá ở mức workflow");
}

/* ═════════════════ 2 · BẢNG PHÂN LOẠI CỦA `ops-vps.yml` ═════════════════ */

/** Danh sách thao tác lấy từ chính ô `options:` — không chép tay sang đây. */
function danhSachThaoTac(src: string): string[] {
  const i = src.indexOf("        options:\n");
  assert.ok(i > 0, "không tìm thấy danh sách `options:` trong ops-vps.yml");
  const j = src.indexOf("      days:", i);
  assert.ok(j > i, "không tìm thấy mốc kết thúc danh sách `options:`");
  const ds = [...src.slice(i, j).matchAll(/^ {10}- ([a-z0-9-]+)/gm)].map((m) => m[1]);
  assert.ok(ds.length > 50, `danh sách thao tác đọc được quá ngắn (${ds.length})`);
  return ds;
}

/** Ba mảng JSON nằm trong biểu thức `concurrency.group` của job `ops`, theo đúng thứ tự. */
function cacLanDoc(bieuThuc: string): string[][] {
  const ms = [...bieuThuc.matchAll(/fromJSON\('(\[[^']*\])'\)/g)];
  assert.equal(ms.length, 3, "biểu thức phải có đúng ba làn đọc: shell · probe · db");
  return ms.map((m) => JSON.parse(m[1]) as string[]);
}

/**
 * BẢN SAO TIẾNG TYPESCRIPT CỦA BIỂU THỨC GITHUB — nhưng danh sách thì ĐỌC TỪ YAML.
 *
 * Nếu viết lại cả danh sách ở đây thì bài kiểm chỉ so một bản chép với một bản chép: sửa YAML mà
 * quên sửa bài kiểm sẽ làm bài đỏ ở chỗ vô nghĩa, còn sửa cả hai theo cùng một hiểu nhầm thì vẫn
 * xanh. Nên chỉ LUẬT được viết lại, còn DỮ LIỆU lấy thẳng từ tệp sẽ chạy thật.
 */
function nhomKhoa(lan: string[][], action: string, arg: string): string {
  if (arg.includes("--apply") || arg.includes("--write") || arg.includes("--fix")) return "vps-mutating";
  if (lan[0].includes(action)) return "vps-readonly-shell";
  if (lan[1].includes(action)) return "vps-readonly-probe";
  if (lan[2].includes(action)) return "vps-readonly-db";
  return "vps-mutating";
}

/**
 * NHỮNG THAO TÁC KHÔNG BAO GIỜ ĐƯỢC COI LÀ CHỈ ĐỌC — kể cả khi ô "arg" để trống.
 *
 * Đây là danh sách viết tay CÓ CHỦ Ý: nó là lời khai độc lập với YAML, nên nó bắt được đúng cái
 * mà "mặc định là ghi" không bắt được — ai đó CHỦ ĐỘNG thêm `restart` vào một làn đọc.
 */
const PHAI_LA_GHI = [
  // Khởi động lại / đổi cấu hình máy chủ.
  "restart", "rotate-webhook-secrets", "apply-ai-env", "apply-sepay-env", "apply-tech-github-env",
  "sepay-schedule", "docker-prune", "backup", "set-setting", "run-job",
  // Ghi dữ liệu nghiệp vụ, không có chế độ chạy thử.
  "sync-pancake-all", "sync-pancake-orders", "sync-vtp-tracking", "sync-vtp-import",
  "sync-facebook-ads", "seed-employees", "import-bank-ledger", "import-vtp-statements",
  "bank-ledger-prune", "vtp-statements-autolink", "vtp-retry-webhooks", "cs-cleanup",
  // Ghi ÍT vẫn là ghi: một dòng `vtp_import_batches` (AGENTS.md mục 49) / một gói tin phát lại.
  "vtp-import-preview", "sepay-verify",
];

export function testPhanLoaiThaoTacOps() {
  const src = doc("ops-vps.yml");

  const khoi = khoaCuaJob(src, "ops");
  assert.ok(khoi, "job `ops` phải có khối `concurrency` của riêng nó");
  assert.match(
    khoi,
    /cancel-in-progress: false/,
    "`cancel-in-progress` phải là false: cắt ngang một lệnh đang ghi dữ liệu nguy hiểm hơn phải chờ",
  );

  // Biểu thức nằm trong một block scalar `>-` nhiều dòng; gộp lại thành một dòng đúng như GitHub
  // sẽ làm trước khi tính, rồi cắt ở dấu `}}` để không dính dòng `cancel-in-progress` phía dưới.
  const bieuThuc = khoi
    .slice(khoi.indexOf("${{"), khoi.indexOf("}}") + 2)
    .split("\n")
    .map((l) => l.trim())
    .join(" ");
  const lan = cacLanDoc(bieuThuc);
  const [shell, probe, db] = lan;
  const thaoTac = danhSachThaoTac(src);

  // ───────── MẶC ĐỊNH PHẢI LÀ GHI ─────────
  // Nhánh cuối cùng của một chuỗi `a && x || b && y || z` là `z`. Nó phải là `vps-mutating`.
  assert.ok(
    /\|\|\s*'vps-mutating'\s*\}\}$/.test(bieuThuc.trim()),
    "nhánh CUỐI của biểu thức phải là 'vps-mutating' — thao tác mới quên phân loại phải rơi về làn " +
      "an toàn nhất, không phải một làn đọc (AGENTS.md mục 31: mọi nhánh lỗi rơi về phía HẸP HƠN)",
  );
  assert.equal(
    nhomKhoa(lan, "thao-tac-chua-ton-tai", ""),
    "vps-mutating",
    "một thao tác chưa có trong bảng phân loại phải ra `vps-mutating`",
  );

  // ───────── CỜ GHI ĐÈ LÊN MỌI PHÂN LOẠI THEO TÊN ─────────
  // Hơn một nửa thao tác "chỉ đọc" ở đây CHẠY THỬ theo mặc định và GHI THẬT khi có cờ.
  const dauTien = bieuThuc.indexOf("'vps-mutating'");
  const lanDauTien = bieuThuc.indexOf("fromJSON(");
  assert.ok(
    dauTien > 0 && dauTien < lanDauTien,
    "vế `--apply/--write/--fix` phải đứng TRƯỚC mọi phân loại theo tên, nếu không một lượt ghi thật " +
      "vẫn rơi vào làn đọc",
  );
  for (const co of ["--apply", "--write", "--fix"]) {
    assert.ok(bieuThuc.includes(`contains(inputs.arg, '${co}')`), `phải chặn cờ ${co}`);
  }
  for (const a of [...shell, ...probe, ...db]) {
    assert.equal(nhomKhoa(lan, a, "--apply"), "vps-mutating", `${a} --apply phải ra làn GHI`);
  }
  assert.equal(nhomKhoa(lan, "ai-check", "--write"), "vps-mutating", "ai-check --write phải ra làn GHI");
  assert.equal(
    nhomKhoa(lan, "outcome-parity", "--from=2026-09-01 --apply"),
    "vps-mutating",
    "cờ nằm giữa các tham số khác vẫn phải bắt được",
  );

  // ───────── BA LÀN ĐỌC KHÔNG ĐƯỢC GIAO NHAU, VÀ CHỈ CHỨA THAO TÁC CÓ THẬT ─────────
  const dem = new Map<string, number>();
  for (const a of [...shell, ...probe, ...db]) dem.set(a, (dem.get(a) ?? 0) + 1);
  for (const [a, n] of dem) {
    assert.equal(n, 1, `${a} nằm ở ${n} làn đọc — một thao tác chỉ thuộc đúng một làn`);
    assert.ok(thaoTac.includes(a), `${a} được phân làn nhưng KHÔNG có trong danh sách \`options:\``);
  }

  // ───────── THAO TÁC GHI KHÔNG ĐƯỢC LỌT VÀO LÀN ĐỌC ─────────
  for (const a of PHAI_LA_GHI) {
    assert.ok(thaoTac.includes(a), `danh sách PHẢI_LÀ_GHI nhắc tới \`${a}\` nhưng ops-vps.yml không còn thao tác đó`);
    assert.equal(
      nhomKhoa(lan, a, ""),
      "vps-mutating",
      `\`${a}\` đổi trạng thái production (ghi CSDL · sửa .env · khởi động lại dịch vụ) nên KHÔNG ` +
        `bao giờ được xếp vào làn đọc, kể cả khi ô "arg" để trống`,
    );
  }

  // ───────── LÀN "SHELL" PHẢI THẬT SỰ KHÔNG DỰNG TIẾN TRÌNH NÀO TRONG CONTAINER ─────────
  // Đây là làn DUY NHẤT chạy song song không giới hạn, nên nó là làn duy nhất có thể làm cạn RAM
  // của một VPS ~1,9 GB đang phục vụ người dùng thật. "Chỉ đọc" nói về DỮ LIỆU, không nói về BỘ NHỚ.
  for (const a of shell) {
    const i = src.indexOf(`\n              ${a})\n`);
    assert.ok(i > 0, `không tìm thấy khối lệnh của thao tác \`${a}\``);
    const than = src.slice(i, src.indexOf(";;", i));
    assert.ok(
      !than.includes("npx tsx"),
      `\`${a}\` ở làn chạy-song-song-không-giới-hạn nhưng lại dựng một tiến trình \`npx tsx\` trong ` +
        `container. Mỗi tiến trình như vậy tốn vài trăm MB — chuyển nó sang \`vps-readonly-db\`.`,
    );
  }

  // ───────── BẢNG CHÂN LÝ ─────────
  const bang: [string, string, string][] = [
    ["db-query", "", "vps-readonly-shell"],
    ["status", "", "vps-readonly-shell"],
    ["logs", "", "vps-readonly-shell"],
    ["vtp-probe", "VTP123", "vps-readonly-probe"],
    ["smoke", "", "vps-readonly-db"],
    ["verify", "", "vps-readonly-db"],
    ["payroll-reconcile", "--from 2026-08-01", "vps-readonly-db"],
    ["cod-rebuild", "", "vps-readonly-db"],
    ["cod-rebuild", "--apply", "vps-mutating"],
    ["restart", "", "vps-mutating"],
    ["import-vtp-statements", "", "vps-mutating"],
  ];
  for (const [a, arg, mong] of bang) {
    assert.equal(nhomKhoa(lan, a, arg), mong, `thao tác ${a} (arg="${arg}") phải vào nhóm ${mong}`);
  }

  // Làn shell mang mã lượt chạy nên KHÔNG BAO GIỜ xếp hàng — đó là cả mục đích của nó.
  assert.ok(
    bieuThuc.includes("format('vps-readonly-shell-{0}', github.run_id)"),
    "làn đọc nhẹ phải mang `github.run_id` để mỗi lượt có nhóm riêng — chung một tên là xếp hàng lại",
  );

  const chuaPhan = thaoTac.filter((a) => nhomKhoa(lan, a, "") === "vps-mutating" && !PHAI_LA_GHI.includes(a));
  console.log(
    `✓ ops-vps: ${thaoTac.length} thao tác · ${shell.length} shell (song song không giới hạn) · ` +
      `${probe.length} probe · ${db.length} đọc nặng · ${PHAI_LA_GHI.length + chuaPhan.length} ghi` +
      (chuaPhan.length ? ` (trong đó ${chuaPhan.length} rơi về mặc định: ${chuaPhan.join(", ")})` : "") +
      " · cờ --apply/--write/--fix đè lên tất cả · mặc định là GHI",
  );
}

/* ═════════════════ 3 · `deploy-vps.yml`: KHOÁ CHỈ Ở `release` ═════════════════ */

export function testDeployTachJob() {
  const src = doc("deploy-vps.yml");

  for (const job of ["gates", "build_image"]) {
    assert.equal(
      khoaCuaJob(src, job),
      null,
      `job \`${job}\` chạy trên máy của GitHub và không chạm VPS — nó KHÔNG được giữ khoá production. ` +
        `Giữ khoá ở đây là trả lại đúng nút thắt mà bản này gỡ ra.`,
    );
  }

  const khoi = khoaCuaJob(src, "release");
  assert.ok(khoi, "job `release` PHẢI có khoá: nó là job duy nhất SSH vào VPS");
  assert.match(khoi, /group: vps-mutating/, "`release` phải dùng chung nhóm ghi với ops-vps.yml");
  assert.match(khoi, /cancel-in-progress: false/, "không bao giờ cắt ngang một lượt deploy đang chạy migration");

  // ───────── NHANH HƠN KHÔNG ĐƯỢC ĐỔI BẰNG BỎ CỔNG ─────────
  assert.match(
    src,
    /^ {2}release:\n {4}needs: \[gates, build_image\]$/m,
    "`release` phải `needs` CẢ `gates` LẪN `build_image` — bỏ `gates` là deploy một bản chưa qua cổng",
  );
  assert.match(src, /^ {2}gates:\n {4}uses: \.\/\.github\/workflows\/gates\.yml$/m, "cổng vẫn phải là bộ dùng chung với PR");

  // ───────── RELEASE PHẢI TRIỂN KHAI ĐÚNG BẢN ĐÃ QUA CỔNG ─────────
  assert.ok(src.includes("needs.gates.outputs.sha"), "release phải đọc SHA mà cổng THẬT SỰ đã kiểm");
  assert.ok(src.includes("needs.build_image.outputs.image"), "release phải dùng ảnh do build_image đẩy lên");
  assert.ok(
    src.includes('if [ "$GATES_SHA" != "$ERP_DEPLOY_SHA" ]') &&
      src.includes('if [ "$BUILD_SHA" != "$ERP_DEPLOY_SHA" ]'),
    "release phải SO ba SHA và dừng khi lệch — `gates` và `build_image` là hai lượt checkout riêng",
  );
  // Ảnh là thứ VPS kéo về, nên nhãn của nó mới quyết định mã nào thật sự chạy.
  assert.ok(src.includes('"${ERP_IMAGE##*:}" != "$ERP_DEPLOY_SHA"'), "release phải kiểm cả NHÃN của ảnh");

  console.log("✓ deploy-vps: gates/build_image không khoá · release khoá vps-mutating (không cắt ngang) · ba SHA phải trùng");
}

/* ═════════════════ 4 · CI CHẠY SONG SONG, VÀ TÊN CHECK BẮT BUỘC KHÔNG ĐƯỢC ĐỔI ═════════════════ */

export function testCiSongSong() {
  const src = doc("ci.yml");
  const khoi = khoaMucWorkflow(src);
  assert.ok(khoi, "ci.yml phải có khoá theo nhánh để commit mới huỷ lượt cũ của CHÍNH nhánh đó");
  assert.ok(!khoi.includes("vps-"), "CI không bao giờ được dùng chung khoá với thao tác production");
  assert.ok(
    khoi.includes("github.ref"),
    "khoá của CI phải tính theo `github.ref` — nếu không thì hai nhánh khác nhau chặn lẫn nhau",
  );
  // Huỷ lượt cũ CHỈ cho pull request: trên `main` mỗi commit phải giữ được lượt kiểm của chính nó.
  assert.match(
    src,
    /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/,
    "`cancel-in-progress` chỉ được bật cho pull request",
  );

  /*
    TÊN CHECK BẮT BUỘC LÀ `gates / gates` (docs/main-protection.md mục 3, và
    .github/rulesets/main-protection.json). Đổi tên một trong hai job là GỠ KHOÁ `main` mà không
    ai nhận ra: ruleset vẫn đòi một check không bao giờ xuất hiện nữa — hoặc PR treo vô hạn, hoặc
    (tệ hơn) khoá được gỡ để "chữa" nó.
  */
  assert.match(src, /^jobs:\n {2}gates:\n/m, "job của ci.yml phải giữ tên `gates`");
  assert.match(doc("gates.yml"), /^jobs:\n {2}gates:\n/m, "job của gates.yml phải giữ tên `gates`");
  const ruleset = readFileSync(".github/rulesets/main-protection.json", "utf8");
  assert.ok(ruleset.includes('"gates / gates"'), "ruleset vẫn phải đòi đúng check `gates / gates`");

  console.log("✓ ci.yml: khoá theo nhánh, không đụng khoá production · huỷ lượt cũ chỉ trên PR · tên check `gates / gates` còn nguyên");
}

/* ═════════════════ 5 · THAO TÁC `verify` PHẢI CHẠY THẬT, VÀ PHẢI ĐỎ ĐƯỢC ═════════════════ */

/**
 * Cùng lý do với `tests/deploy-script.test.ts`: `bash -n` xanh với mọi khối shell hợp lệ,
 * `tsc`/`eslint` không đọc shell, và khối này chỉ chạy trên máy chủ thật. Deploy #244 đã dạy đúng
 * bài đó một lần — một khối dọn ảnh tự giết mình vì KHÔNG CÓ GÌ ĐỂ DỌN (`grep` không khớp ⇒ mã 1).
 * `verify` có đúng cái bẫy ấy ở phần lọc lỗi trong log, và ca thường gặp nhất của nó là ca "không
 * có lỗi nào".
 *
 * Nên trích đúng khối ra rồi CHẠY THẬT dưới `bash -e` (đúng cờ workflow đặt) với `docker` giả.
 */
function khoiVerify(): string {
  const src = doc("ops-vps.yml");
  const i = src.indexOf("              verify)");
  assert.ok(i > 0, "không tìm thấy thao tác `verify` trong ops-vps.yml");
  const j = src.indexOf("              kpi-snapshot)", i);
  assert.ok(j > i, "không tìm thấy mốc kết thúc khối `verify`");
  const raw = src.slice(i, j).split("\n").map((l) => l.replace(/^ {14}/, "")).join("\n");
  return raw.replace(/^verify\)\n/, "").replace(/;;\s*$/, "");
}

/** `docker` / `docker compose` / `df` giả, đủ để khối chạy hết mà không cần máy chủ nào. */
function chayVerify(moi: Record<string, string>): { ma: number; ra: string } {
  const tmp = mkdtempSync(path.join(tmpdir(), "ops-verify-"));
  const kich = path.join(tmp, "run.sh");
  writeFileSync(
    kich,
    [
      "#!/usr/bin/env bash",
      // ĐÚNG cờ mà workflow đặt (`set -e`, KHÔNG có `-u`/`pipefail`).
      "set -e",
      'C="gia_compose"',
      "gia_compose() {",
      '  case "$*" in',
      '    ps) printf "NAME STATE\\nerp-app running\\n" ;;',
      '    *"--services --filter status=stopped"*) printf "%s" "${STOPPED:-}" ;;',
      '    *logs*) printf "%s\\n" "${LOGS:-moi thu deu on}" ;;',
      "    *) : ;;",
      "  esac",
      "}",
      "docker() {",
      '  case "$*" in',
      // `-` chứ KHÔNG phải `:-`: ca "ERP không phản hồi" là HEALTH RỖNG, và `:-` sẽ lặng lẽ thay
      // chuỗi rỗng bằng giá trị mặc định — tức là bài kiểm không bao giờ dựng được ca đó.
      '    *"/api/health"*) printf "%s" "${HEALTH-{\\"ok\\":true}}" ;;',
      '    *"cat > /app/scripts/smoke.ts"*) cat >/dev/null ;;',
      '    *smoke.ts*) echo "(smoke gia)"; return "${SMOKE_RC:-0}" ;;',
      '    *) echo "(docker gia: $1)" ;;',
      "  esac",
      "}",
      "nproc() { echo 2; }",
      'free() { echo "Mem: 1900 1200 700"; }',
      'uptime() { echo "up 3 days"; }',
      'df() { if [ "$1" = "-h" ]; then printf "Filesystem Size Used Avail Use%% Mounted\\n/dev/x 39G 16G 23G ${DFPCT:-42}%% /\\n";' +
        ' else printf "Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/x 40000 16000 24000 ${DFPCT:-42}%% /\\n"; fi; }',
      'fetch_script() { echo "// script gia"; }',
      khoiVerify(),
      "",
    ].join("\n"),
  );
  let ma = 0;
  let ra = "";
  try {
    ra = execFileSync("bash", [kich], { stdio: "pipe", encoding: "utf8", env: { ...process.env, ...moi } });
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    ma = err.status ?? 1;
    ra = String(err.stdout ?? "") + String(err.stderr ?? "");
  }
  rmSync(tmp, { recursive: true, force: true });
  return { ma, ra };
}

export function testThaoTacVerify() {
  // Nó phải là thao tác CHỈ ĐỌC — nằm trong một làn đọc, không phải `vps-mutating`.
  const src = doc("ops-vps.yml");
  assert.ok(danhSachThaoTac(src).includes("verify"), "`verify` phải có trong danh sách `options:`");
  const lan = cacLanDoc(khoaCuaJob(src, "ops")!);
  assert.equal(nhomKhoa(lan, "verify", ""), "vps-readonly-db", "`verify` là thao tác CHỈ ĐỌC");

  // ───────── CA THƯỜNG GẶP NHẤT: MỌI THỨ ĐỀU ỔN ─────────
  // Đây đúng là ca mà deploy #244 chết: không có gì để báo ⇒ `grep` trả 1 ⇒ `set -e` giết script.
  const ok = chayVerify({ LOGS: "khoi dong xong\nsan sang phuc vu" });
  assert.equal(ok.ma, 0, `máy chủ khoẻ thì verify phải xanh — đầu ra:\n${ok.ra}`);
  assert.ok(!ok.ra.includes("::error::"), "máy chủ khoẻ thì không được in dòng ::error:: nào");
  assert.ok(ok.ra.includes("VERIFY ĐẠT"), "phải in một KẾT LUẬN, không chỉ năm mảnh log");
  for (const phan of ["1/5", "2/5", "3/5", "4/5", "5/5"]) {
    assert.ok(ok.ra.includes(phan), `thiếu phần ${phan} — verify phải gom đủ năm lượt hỏi`);
  }

  // ───────── BỐN CÁCH HỎNG, BỐN LẦN ĐỎ ─────────
  // Một lượt kiểm không bao giờ đỏ được thì không phải một lượt kiểm.
  const hong: [string, Record<string, string>, string][] = [
    ["ERP không trả ok:true", { HEALTH: '{"ok":false}' }, "/api/health"],
    ["ERP không phản hồi", { HEALTH: "" }, "/api/health"],
    ["ổ đĩa gần đầy", { DFPCT: "95" }, "Ổ đĩa"],
    ["một dịch vụ đã dừng", { STOPPED: "scheduler" }, "scheduler"],
    ["smoke không đạt", { SMOKE_RC: "3" }, "smoke"],
  ];
  for (const [ten, moi, dau] of hong) {
    const r = chayVerify(moi);
    assert.equal(r.ma, 1, `${ten}: verify phải ĐỎ — đầu ra:\n${r.ra}`);
    assert.ok(r.ra.includes("::error::"), `${ten}: phải in ::error:: để GitHub làm nổi lên`);
    assert.ok(r.ra.includes(dau), `${ten}: lời báo phải nói ra ĐÚNG cái gì hỏng (chờ thấy "${dau}")`);
  }

  // ───────── DÒNG LOG CÓ LỖI KHÔNG TỰ LÀM ĐỎ, NHƯNG PHẢI HIỆN RA — VÀ PHẢI CHE SECRET ─────────
  // Log ứng dụng luôn có dòng lỗi lẻ; đỏ vì chuyện thường ngày thì sau ba lần không ai đọc nữa.
  const coLoi = chayVerify({ LOGS: "ERROR: token pk_0123456789abcdef0123456789abcdef roi\nbinh thuong" });
  assert.equal(coLoi.ma, 0, "một dòng ERROR trong log KHÔNG tự làm lượt kiểm đỏ");
  assert.ok(coLoi.ra.includes("Số dòng có dấu hiệu lỗi"), "…nhưng phải ĐẾM và in ra để người so với lần trước");
  assert.ok(
    !coLoi.ra.includes("pk_0123456789abcdef0123456789abcdef"),
    "kho mã này PUBLIC: secret lọt vào log ứng dụng phải bị che trước khi in ra log Actions",
  );
  assert.ok(coLoi.ra.includes("pk_••••••••"), "…che bằng đúng bộ lọc của thao tác `logs`");

  console.log("✓ verify: chạy thật dưới bash -e · xanh khi khoẻ (kể cả khi KHÔNG có lỗi nào để in) · đỏ ở 5 kiểu hỏng · che secret");
}

export function testOpsConcurrency() {
  testKhongConNhomVpsOperations();
  testPhanLoaiThaoTacOps();
  testDeployTachJob();
  testCiSongSong();
  testThaoTacVerify();
}

if (process.argv[1] && process.argv[1].endsWith("ops-concurrency.test.ts")) testOpsConcurrency();
