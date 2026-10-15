/**
 * ═══════ HẬU KIỂM PRODUCTION TRÊN MÁY ACTIONS (`.github/workflows/ai-verify.yml`) ═══════
 *
 * Workflow cầm token GHI (`contents: write`) để `verify --record` đẩy dấu PASS/FAIL lên `ai-control/registry`.
 * Thứ duy nhất làm nó an toàn là nó KHÔNG có phán quyết riêng và KHÔNG có đường ghi riêng: nó gọi đúng lệnh
 * `verify` của `scripts/ai-tech.ts` trên `main`, và lệnh ấy chỉ đẩy được đúng nhánh điều khiển. Bài kiểm khoá
 * những tính chất đó ở mức mã nguồn (mục 65: đo hợp đồng, không đo máy — không gọi mạng, không đọc env):
 *
 *   · chỉ `workflow_dispatch`, job chỉ chạy trên `refs/heads/main` (nhánh khác dispatch được thì tự viết `verify`);
 *   · không SSH / không secret VPS / không secret nào ngoài `github.token`;
 *   · không `git push` tự viết, không lệnh điều phối nào khác ngoài `verify` (không close / merge / deploy);
 *   · KHÔNG ĐẠT thì ĐỎ — không `|| true` nuốt mã thoát của verify;
 *   · đầu vào không nội suy thẳng `${{ }}` vào shell, và mẫu mã sứ mệnh dựng TỪ CÙNG NGUỒN `SLUG_RE`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SLUG_RE } from "../scripts/ai-tech";

const goc = path.resolve(__dirname, "..");
const SRC = readFileSync(path.join(goc, ".github/workflows/ai-verify.yml"), "utf8").replace(/\r\n/g, "\n");
/** Mã thật: bỏ dòng chú thích — câu GIẢI THÍCH về `git push` không phải là một lệnh `git push`. */
const MA = SRC.split("\n")
  .filter((d) => !/^\s*#/.test(d))
  .join("\n");

/** Các khối `run: |` (đủ thân, theo thụt lề). */
function khoiRun(src: string): string[] {
  const dong = src.split("\n");
  const kq: string[] = [];
  for (let i = 0; i < dong.length; i++) {
    const m = /^(\s*)run:\s*(.*)$/.exec(dong[i]!);
    if (!m) continue;
    if (m[2] !== "|") {
      kq.push(m[2]!);
      continue;
    }
    const lui = m[1]!.length;
    const than: string[] = [];
    for (let j = i + 1; j < dong.length; j++) {
      const d = dong[j]!;
      if (d.trim() !== "" && d.length - d.trimStart().length <= lui) break;
      than.push(d);
    }
    kq.push(than.join("\n"));
  }
  return kq;
}

/** Khối `jobs:` → từng job (thụt 2) → từng bước (`      - `). Cùng cách tách với tests/workflow-hardening.test.ts. */
function tachJob(src: string): Map<string, string> {
  const kq = new Map<string, string>();
  const dong = src.slice(src.search(/^jobs:\s*$/m)).split("\n").slice(1);
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
function tachBuoc(job: string): string[] {
  const kq: string[] = [];
  let cur: string[] | null = null;
  for (const d of job.split("\n")) {
    if (/^ {6}- /.test(d)) {
      if (cur) kq.push(cur.join("\n"));
      cur = [d];
    } else if (cur) cur.push(d);
  }
  if (cur) kq.push(cur.join("\n"));
  return kq;
}

export function testAiVerifyWorkflow() {
  // Kích hoạt: chỉ tay người / Lead bấm.
  const on = /^on:\n([\s\S]*?)\n(?=\S)/m.exec(MA)?.[1] ?? "";
  assert.match(on, /^\s{2}workflow_dispatch:/m, "ai-verify.yml phải chạy bằng workflow_dispatch");
  assert.ok(!/^\s{2}(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch|workflow_call):/m.test(on), "ai-verify.yml chỉ được có workflow_dispatch");

  // Quyền: đúng hai dòng ở mức workflow, không job nào tự nới.
  const quyen = /^permissions:\n((?:\s{2}.+\n)+)/m.exec(MA)?.[1] ?? "";
  assert.deepEqual(
    quyen.trim().split("\n").map((d) => d.trim()).sort(),
    ["actions: read", "contents: write"],
    "ai-verify.yml: quyền phải đúng contents: write (đẩy sổ) + actions: read (đọc lượt deploy)",
  );
  assert.ok(!/^ {4}permissions:/m.test(MA), "không job nào được khai permissions riêng");
  assert.ok(!/continue-on-error/.test(MA), "không continue-on-error — KHÔNG ĐẠT phải làm lượt đỏ");

  // MỌI job chỉ chạy trên main (job thứ hai không có điều kiện vẫn cầm token contents: write ở mức workflow).
  const jobs = tachJob(MA);
  assert.ok(jobs.size >= 1, "phải có ít nhất một job");
  for (const [ten, than] of jobs) {
    const iff = /^ {4}if:\s*(.+)$/m.exec(than)?.[1]?.trim() ?? "";
    assert.equal(iff, "github.ref == 'refs/heads/main'", `job \`${ten}\` phải có đúng if: github.ref == 'refs/heads/main' (thấy: ${iff || "không có"})`);
  }

  // Không chạm VPS, không secret nào ngoài github.token, chỉ action được phép.
  assert.ok(!/secrets\./.test(MA), "ai-verify.yml không được đọc secret nào — chỉ github.token");
  assert.ok(!/appleboy|ssh-action|\bssh\b|VPS_/i.test(MA), "ai-verify.yml không được SSH / chạm VPS");
  const uses = [...MA.matchAll(/uses:\s*([^@\s]+)@/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(uses)].sort(), ["actions/checkout", "actions/setup-node"], `chỉ actions/checkout + actions/setup-node, thấy: ${uses.join(", ")}`);

  const buoc = [...jobs.values()].flatMap(tachBuoc);
  for (const b of buoc.filter((x) => /uses:\s*actions\/checkout@/.test(x)))
    assert.match(b, /^\s*persist-credentials:\s*false\s*$/m, "checkout phải khai persist-credentials: false");

  // Token: đúng MỘT bước cầm github.token, và bước ấy che token, tắt hooks, không ghi vào .git/config.
  const coToken = buoc.filter((b) => /github\.token/.test(b));
  assert.equal(coToken.length, 1, `chỉ MỘT bước được cầm github.token, thấy ${coToken.length}`);
  const bt = coToken[0]!;
  assert.match(bt, /echo "::add-mask::\$AUTH"/, "dạng base64 của token phải được che khỏi log");
  assert.match(bt, /GIT_CONFIG_KEY_\d="core\.hooksPath" GIT_CONFIG_VALUE_\d="\/dev\/null"/, "bước cầm token phải tắt hooks");
  assert.ok(!/\bgit config\b/.test(bt), "token không được ghi vào .git/config");
  assert.match(bt, /set -f -o pipefail/, "bước verify phải bật pipefail (mã thoát đi qua tee) và tắt glob");

  const runs = khoiRun(MA);
  assert.ok(runs.length >= 2, "phải thấy ít nhất hai khối run (kiểm đầu vào + verify)");
  for (const r of runs) {
    assert.ok(!/\$\{\{/.test(r), `không nội suy \${{ }} thẳng vào shell — đưa qua env: rồi dùng "$VAR". Thấy: ${r.slice(0, 80)}`);
    assert.ok(!/\bgit\b[^\n]*\bpush\b/.test(r), "không `git push` tự viết — đường ghi duy nhất là pushControlCommit của ai-tech.ts");
    assert.ok(!/\|\|\s*(true|:|exit 0)\b|\|\|\s*:|set \+e/.test(r), "KHÔNG ĐẠT phải làm job đỏ — không `|| true` / `|| :` / `|| exit 0` / `set +e`");
    assert.match(r, /^\s*set -f\b/m, "mọi khối run phải `set -f` — «*» trong ô mã sứ mệnh không được bung thành tên tệp");
  }

  // Chỉ lệnh `verify` của công cụ, dưới mọi dạng gọi.
  const goi = [...MA.matchAll(/(?:node\s+(?:\.\/)?scripts\/ai-tech\.ts|npm run ai --|npx tsx[^\n]*ai-tech)\s+(\S+)/g)].map((m) => m[1]);
  assert.ok(goi.length >= 1, "phải gọi node scripts/ai-tech.ts verify");
  assert.deepEqual([...new Set(goi)], ["verify"], `ai-verify.yml chỉ được gọi lệnh verify, thấy: ${goi.join(", ")}`);
  assert.ok(!/ai-tech\.ts\s+"?\$/.test(MA), "không gọi ai-tech.ts với lệnh lấy từ biến");
  assert.match(MA, /verify --sha="\$SHA_VAO" --record --mission="\$m"/, "ghi sổ phải qua verify --record --mission");
  // Không ghi được dấu ⇒ đỏ, kể cả khi production ĐẠT (công cụ trả 0 khi mã sứ mệnh chưa có trong sổ).
  assert.match(MA, /grep -q "✓ đã ghi " "\$OUT" \|\| \{[^}]*RC=1; \}/, "phải đòi dòng «✓ đã ghi» cho mỗi sứ mệnh, thiếu thì RC=1");
  assert.match(MA, /^\s*exit \$RC\s*$/m, "bước verify phải kết thúc bằng exit $RC");

  // Mẫu mã sứ mệnh ở bước kiểm = SLUG_RE của công cụ (một nguồn, không gõ lại).
  assert.ok(MA.includes(`grep -Pq '${SLUG_RE.source}'`), `mẫu mã sứ mệnh trong workflow phải là SLUG_RE.source (${SLUG_RE.source})`);
  console.log("✓ ai-verify.yml: dispatch-only · mọi job chỉ main · một bước cầm token (che · tắt hooks) · không VPS/secret · chỉ lệnh verify · đỏ khi KHÔNG ĐẠT hoặc không ghi được dấu");
}
