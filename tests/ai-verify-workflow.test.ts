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

export function testAiVerifyWorkflow() {
  // Kích hoạt: chỉ tay người / Lead bấm.
  const on = /^on:\n([\s\S]*?)\n(?=\S)/m.exec(MA)?.[1] ?? "";
  assert.match(on, /^\s{2}workflow_dispatch:/m, "ai-verify.yml phải chạy bằng workflow_dispatch");
  assert.ok(!/^\s{2}(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch):/m.test(on), "ai-verify.yml chỉ được có workflow_dispatch");

  // Quyền: đúng hai dòng, không hơn.
  const quyen = /^permissions:\n((?:\s{2}.+\n)+)/m.exec(MA)?.[1] ?? "";
  assert.deepEqual(
    quyen.trim().split("\n").map((d) => d.trim()).sort(),
    ["actions: read", "contents: write"],
    "ai-verify.yml: quyền phải đúng contents: write (đẩy sổ) + actions: read (đọc lượt deploy)",
  );

  // Job chỉ chạy trên main.
  assert.match(MA, /^ {4}if: github\.ref == 'refs\/heads\/main'\s*$/m, "job verify phải đòi github.ref == 'refs/heads/main' ở mức job");

  // Không chạm VPS, không secret nào ngoài github.token.
  assert.ok(!/secrets\./.test(MA), "ai-verify.yml không được đọc secret nào — chỉ github.token");
  assert.ok(!/appleboy|ssh-action|\bssh\b|VPS_/i.test(MA), "ai-verify.yml không được SSH / chạm VPS");
  assert.match(MA, /persist-credentials:\s*false/, "checkout phải khai persist-credentials: false");

  const runs = khoiRun(MA);
  assert.ok(runs.length >= 2, "phải thấy ít nhất hai khối run (kiểm đầu vào + verify)");
  for (const r of runs) {
    assert.ok(!/\$\{\{/.test(r), `không nội suy \${{ }} thẳng vào shell — đưa qua env: rồi dùng "$VAR". Thấy: ${r.slice(0, 80)}`);
    assert.ok(!/\bgit\s+push\b/.test(r), "không `git push` tự viết — đường ghi duy nhất là pushControlCommit của ai-tech.ts");
    assert.ok(!/\|\|\s*true\b/.test(r) || !/ai-tech\.ts/.test(r), "verify KHÔNG ĐẠT phải làm job đỏ — không `|| true`");
  }

  // Chỉ lệnh `verify` của công cụ.
  const lenh = [...MA.matchAll(/node scripts\/ai-tech\.ts\s+([a-z-]+)/g)].map((m) => m[1]);
  assert.ok(lenh.length >= 1, "phải gọi node scripts/ai-tech.ts verify");
  assert.deepEqual([...new Set(lenh)], ["verify"], `ai-verify.yml chỉ được gọi lệnh verify, thấy: ${lenh.join(", ")}`);
  assert.match(MA, /verify --sha="\$SHA_VAO" --record --mission="\$m"/, "ghi sổ phải qua verify --record --mission");

  // Mẫu mã sứ mệnh ở bước kiểm = SLUG_RE của công cụ (một nguồn, không gõ lại).
  assert.ok(MA.includes(`grep -Pq '${SLUG_RE.source}'`), `mẫu mã sứ mệnh trong workflow phải là SLUG_RE.source (${SLUG_RE.source})`);
  console.log("✓ ai-verify.yml: dispatch-only · chỉ main · không VPS/secret · chỉ lệnh verify · đỏ khi KHÔNG ĐẠT");
}
