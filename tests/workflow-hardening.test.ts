/**
 * ═══════ CHUỖI CUNG ỨNG CI/CD: DEPLOY CHỈ TỪ `main`, MÃ AGENT KHÔNG CẦM TOKEN GHI ═══════
 *
 * Nguồn: Team Premium F7 + F8 (10/10/2026).
 *
 * F7 — `deploy-vps.yml` chỉ có `workflow_dispatch`, mà dispatch chọn được BẤT KỲ nhánh nào. Job
 *      `release` (SSH vào VPS) trước đây không hỏi ref: nhánh nào qua cổng là lên production, kể cả
 *      mã chưa từng qua PR/ruleset. Nay `release` đòi `github.ref == 'refs/heads/main'` ở MỨC JOB và
 *      đứng trong Environment `production` — chỗ để người đặt luật bảo vệ trên GitHub.
 *
 * F8 — `agent-run.yml` chạy mã DO AGENT VIẾT (cổng typecheck/lint/test/build) trong một bản checkout
 *      còn giữ credential `contents: write` ở `.git/config`. Bốn workflow agent khác đã có
 *      `persist-credentials: false`; tệp này thì chưa. Và mã việc (đầu ra của bước trước) được dán
 *      thẳng `${{ }}` vào lệnh shell — nội suy chạy TRƯỚC khi shell đọc script.
 *
 * Bài kiểm đọc MÃ NGUỒN workflow (mục 65: đo hợp đồng, không đo máy). Không gọi mạng, không đọc biến
 * môi trường. Kỳ vọng về hình dạng mã việc dựng TỪ CÙNG NGUỒN với hàm thực thi (`MA_VIEC_DISPATCH`).
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { MA_VIEC_DISPATCH } from "@/lib/constants/agent-dispatch";

const goc = path.resolve(__dirname, "..");
const THU_MUC = path.join(goc, ".github/workflows");
const doc = (t: string) => readFileSync(path.join(THU_MUC, t), "utf8").replace(/\r\n/g, "\n");
/** Bỏ dòng chú thích: một câu GIẢI THÍCH về `persist-credentials: false` không phải là nó. */
const boChuThich = (src: string) =>
  src
    .split("\n")
    .filter((d) => !/^\s*#/.test(d))
    .join("\n");

/** Tách khối `jobs:` thành từng job (thụt 2 dấu cách). */
function tachJob(src: string): Map<string, string> {
  const kq = new Map<string, string>();
  const iJobs = src.search(/^jobs:\s*$/m);
  assert.ok(iJobs >= 0, "workflow phải có khối jobs:");
  const dong = src.slice(iJobs).split("\n").slice(1);
  let ten: string | null = null;
  let than: string[] = [];
  for (const d of dong) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(d);
    if (m) {
      if (ten) kq.set(ten, than.join("\n"));
      ten = m[1]!;
      than = [];
      continue;
    }
    if (/^\S/.test(d)) break;
    if (ten) than.push(d);
  }
  if (ten) kq.set(ten, than.join("\n"));
  return kq;
}

/** Tách các bước của một job (mỗi bước bắt đầu bằng `      - `). */
function tachBuoc(job: string): string[] {
  const kq: string[] = [];
  let cur: string[] | null = null;
  for (const d of job.split("\n")) {
    if (/^ {6}- /.test(d)) {
      if (cur) kq.push(cur.join("\n"));
      cur = [d];
      continue;
    }
    if (cur && d.trim() && d.length - d.trimStart().length <= 4) {
      kq.push(cur.join("\n"));
      cur = null;
      continue;
    }
    if (cur) cur.push(d);
  }
  if (cur) kq.push(cur.join("\n"));
  return kq;
}

/** Thân các khối `run:` (một dòng hoặc `|`/`>`). */
function khoiRun(src: string): string[] {
  const d = src.split("\n");
  const kq: string[] = [];
  for (let i = 0; i < d.length; i += 1) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(d[i]!);
    if (!m) continue;
    if (!/^[|>]/.test(m[2]!)) {
      kq.push(m[2]!);
      continue;
    }
    const thut = m[1]!.length;
    const than: string[] = [];
    for (let k = i + 1; k < d.length; k += 1) {
      const x = d[k]!;
      if (x.trim() && x.length - x.trimStart().length <= thut) break;
      than.push(x);
    }
    kq.push(than.join("\n"));
  }
  return kq;
}

/** Có `||` nào nằm NGOÀI mọi cặp ngoặc (bỏ qua chuỗi trong nháy đơn) không. */
function coOrNgoaiCung(expr: string): boolean {
  let sau = 0;
  let trongChuoi = false;
  for (let i = 0; i < expr.length; i += 1) {
    const c = expr[i]!;
    if (c === "'") trongChuoi = !trongChuoi;
    if (trongChuoi) continue;
    if (c === "(") sau += 1;
    else if (c === ")") sau -= 1;
    else if (sau === 0 && c === "|" && expr[i + 1] === "|") return true;
  }
  return false;
}

/* ───── F7 · deploy: chỉ `main` chạm được VPS, và đứng trong Environment ───── */
function testDeployChiTuMain() {
  const src = boChuThich(doc("deploy-vps.yml"));
  const jobs = tachJob(src);
  const release = jobs.get("release");
  assert.ok(release, "deploy-vps.yml phải có job `release`");

  const DIEU_KIEN_MAIN = "github.ref == 'refs/heads/main' && ";
  let soJobChamVps = 0;
  for (const [ten, than] of jobs) {
    // Job chạm máy chủ = cầm bước SSH hoặc secret của VPS.
    if (!/appleboy\/ssh-action|secrets\.VPS_/.test(than)) continue;
    soJobChamVps += 1;
    const iff = /^ {4}if: \$\{\{ (.+) \}\}$/m.exec(than)?.[1] ?? "";
    // Vế đầu của phép AND ở MỨC NGOÀI CÙNG ⇒ sai là toàn biểu thức sai, không vế nào cứu được.
    assert.ok(iff.startsWith(DIEU_KIEN_MAIN), `job \`${ten}\` chạm VPS phải mở đầu \`if:\` bằng \`${DIEU_KIEN_MAIN.trim()}\` — thấy: ${iff || "(không có if)"}`);
    // `&&` gắn chặt hơn `||`: một `||` ở mức ngoài cùng biến `ref && A || B` thành `(ref && A) || B` — B đi vòng qua ref.
    assert.ok(!coOrNgoaiCung(iff), `job \`${ten}\`: \`if:\` không được có \`||\` ở mức ngoài cùng — nó đi vòng qua điều kiện ref`);
    assert.match(than, /^ {4}environment: production\s*$/m, `job \`${ten}\` chạm VPS phải khai \`environment: production\` ở MỨC JOB`);
  }
  assert.ok(soJobChamVps >= 1, "phải thấy ít nhất một job chạm VPS (release) — nếu 0 thì bộ nhận diện đã mù");

  // Cổng vẫn chạy với mọi ref: điều kiện main KHÔNG được lan sang job không chạm máy chủ.
  for (const ten of ["bang_chung", "gates", "build_image"]) {
    const than = jobs.get(ten);
    assert.ok(than, `deploy-vps.yml phải giữ job \`${ten}\``);
    assert.ok(!/^ {4}if: .*refs\/heads\/main/m.test(than), `job \`${ten}\` không chạm VPS — ref khác main vẫn phải chạy lại cổng như cũ`);
  }
}

/* ───── F8 · mã do agent/người khác viết không chạy cạnh credential GHI ───── */
function testCheckoutKhongGiuCredential() {
  const tep = readdirSync(THU_MUC).filter((f) => f.endsWith(".yml"));
  const workflowAgent = tep.filter((f) => /^agent-/.test(f));
  assert.ok(workflowAgent.includes("agent-run.yml") && workflowAgent.length >= 4, `phải thấy các workflow agent, thấy: ${workflowAgent.join(", ")}`);

  const pham: string[] = [];
  let soCheckout = 0;
  for (const t of tep) {
    const src = boChuThich(doc(t));
    // Workflow agent (chạy mã agent viết / cầm danh tính App) HOẶC bất kỳ workflow nào xin `contents: write`.
    const coQuyenGhi = /^\s*contents:\s*write\s*$/m.test(src);
    if (!workflowAgent.includes(t) && !coQuyenGhi) continue;
    for (const [ten, job] of tachJob(src)) {
      for (const buoc of tachBuoc(job)) {
        if (!/uses:\s*actions\/checkout@/.test(buoc)) continue;
        soCheckout += 1;
        if (!/^\s*persist-credentials:\s*false\s*$/m.test(buoc)) pham.push(`${t}#${ten}`);
      }
    }
  }
  assert.ok(soCheckout >= 4, `phải quét được ít nhất 4 bước checkout của workflow agent, thấy ${soCheckout}`);
  assert.deepEqual(pham, [], "checkout trong workflow chạy mã agent / có quyền GHI phải khai `persist-credentials: false`");
}

/* ───── F8 · agent-run.yml: đầu ra của bước trước đi qua env, token GHI chỉ ở bước đẩy ───── */
function testAgentRunKhongDanDauRa() {
  const src = boChuThich(doc("agent-run.yml"));
  const dan = khoiRun(src).filter((r) => /\$\{\{\s*(steps|needs)\.[^}]*\.outputs\./.test(r));
  assert.deepEqual(dan, [], "agent-run.yml: không `${{ steps.*.outputs.* }}` / `${{ needs.*.outputs.* }}` dán thẳng trong run: — đưa vào env: rồi dùng \"$VAR\"");

  const agent = tachJob(src).get("agent");
  assert.ok(agent, "agent-run.yml phải có job `agent`");
  const buoc = tachBuoc(agent);

  // Mã việc kiểm hình dạng ĐÓNG ngay tại bước sinh ra nó, bằng ĐÚNG mẫu của hàm thực thi.
  const setup = buoc.find((b) => /^\s*id: setup\s*$/m.test(b));
  assert.ok(setup, "phải có bước `id: setup`");
  const kiemDang = `[[ "$TASK_CODE" =~ ${MA_VIEC_DISPATCH.source} ]]`;
  const iKiem = setup.indexOf(kiemDang);
  const iXuat = setup.indexOf('echo "task_code=$TASK_CODE" >> "$GITHUB_OUTPUT"');
  assert.ok(iKiem > 0, `bước setup phải kiểm \`${kiemDang}\` (cùng mẫu MA_VIEC_DISPATCH)`);
  assert.ok(iXuat > iKiem, "kiểm hình dạng phải đứng TRƯỚC lúc xuất task_code cho các bước sau");

  // Token GHI: chỉ bước đẩy nhánh nhắc tới, và lệnh push tắt hooks (mã agent đã chạy trên cây này).
  const coToken = buoc.filter((b) => /github\.token|secrets\.GITHUB_TOKEN/.test(b));
  assert.equal(coToken.length, 1, `chỉ MỘT bước của job agent được cầm token GHI, thấy ${coToken.length}`);
  assert.match(coToken[0]!, /^\s*id: day\s*$/m, "bước cầm token phải là bước đẩy nhánh (`id: day`)");
  assert.match(coToken[0]!, /GIT_CONFIG_KEY_\d="core\.hooksPath" GIT_CONFIG_VALUE_\d="\/dev\/null"/, "lệnh push phải tắt hooks");
  assert.ok(!/git config\b/.test(coToken[0]!), "token không được ghi vào `.git/config` (`git config`) — chỉ sống trong một tiến trình push");
  assert.match(coToken[0]!, /echo "::add-mask::\$AUTH"/, "dạng base64 của token phải được che khỏi log");
}

export function testWorkflowHardening() {
  testDeployChiTuMain();
  testCheckoutKhongGiuCredential();
  testAgentRunKhongDanDauRa();
  console.log(
    "✓ Chuỗi cung ứng CI/CD (Team Premium F7/F8): job chạm VPS chỉ chạy từ main + Environment production · cổng vẫn chạy mọi ref · checkout của workflow agent / có quyền GHI không giữ credential · agent-run không dán đầu ra bước vào shell, mã việc kiểm dạng đóng, token GHI chỉ ở bước đẩy (tắt hooks)",
  );
}
