import assert from "node:assert/strict";
/** Lượt chạy kịch bản không gọi model nào — không tiền, và đó là con số ĐÚNG chứ không phải chỗ trống. */
const KHONG_TON = { soVong: 0, vao: 0, ra: 0, demDoc: 0, demGhi: 0, usd: 0 };
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  CHILD_ENV_ALLOWLIST,
  DOCUMENTATION_COMMANDS,
  SECRET_ENV_NAMES,
  checkCommand,
  checkReadPath,
  checkWritePath,
  sandboxEnv,
} from "@/lib/constants/agent-sandbox";
import { TECH_AGENT_TEMPLATES, techDeployStatusFromGithub, verifyDeployment } from "@/lib/constants/tech";
import { WORK_SOURCE_SPEC, authorityOf } from "@/lib/constants/work-sources";
import { __setGithubFetchForTests, githubConfig } from "@/lib/integrations/github/client";
import { syncGithubDeployments, verifyDeployments } from "@/lib/integrations/github/deployments";
import { adaptTechTasks } from "@/lib/queries/work-adapters";
import { createTechTask, decideTechApproval, overrideTechTaskRisk, recordTechDeployment, seedTechAgents, setTechAgentEnabled, setTechTaskStatus, startTechAgentRun, updateTechDeployment, type TechActor } from "@/lib/tech/service";

import { runAgentOnTask } from "@/lib/agents/runner";
import { classifyProviderError } from "@/scripts/agent-runner-check";
import { AGENT_TOOLS, AiAgentExecutor } from "@/lib/agents/executor";
import type { AgentExecutor, AgentJob, AgentOutcome } from "@/lib/agents/executor";
import type { AiProvider } from "@/lib/ai/provider";

/**
 * ═══════════ PHASE 2A — ĐỌC DEPLOY THẬT, CHIẾU VIỆC TECH, CHẠY AGENT ĐẦU TIÊN ═══════════
 *
 * Bốn khối, và khối thứ tư là khối quan trọng nhất: hàng rào của agent phải chặn bằng MÃ NGUỒN,
 * không phải bằng một câu dặn trong prompt. Mọi ca ở khối đó đều chạy hàm thật, không mô phỏng.
 *
 * Mốc thời gian đi theo ĐỒNG HỒ THẬT (AGENTS.md mục 50). Dữ liệu tự dọn bằng tiền tố `p2a-`.
 */

const goc = path.resolve(__dirname, "..");

/* ═════════════════ 1 · HÀNG RÀO CỦA AGENT (hàm thuần) ═════════════════ */

export function testAgentSandbox() {
  // ───────── 1.1 Lệnh được phép thì chạy, kèm tham số phụ đã khai ─────────
  assert.ok(checkCommand(["npm", "run", "typecheck"]).allowed, "typecheck phải được phép");
  assert.ok(checkCommand(["git", "diff", "--stat"]).allowed, "tham số phụ đã khai thì được phép");
  assert.ok(!checkCommand(["git", "diff", "--exec=rm"]).allowed, "tham số CHƯA khai thì không");

  /*
    ───────── 1.1b BỐN CỔNG PHẢI GỌI ĐƯỢC BẰNG DẠNG `npm run <tên>` ─────────

    ĐO THẬT ở lượt chạy agent đầu tiên (nhánh `ai/documentation/TECH-1-mu7ws71b`, 19/09/2026).
    Ba cổng khai `npm run typecheck|lint|build`, riêng test khai `npm test`. Agent đọc ba dòng
    trên rồi gọi `npm run test` — bị chặn, vì `checkCommand` so khớp CHÍNH XÁC.

    Rồi nó viết vào tài liệu bàn giao: *"runner chặn `npm run test` đối với vai tài liệu"*. Một
    SUY ĐOÁN trình bày như một LUẬT, và sai — vai tài liệu ĐƯỢC chạy test.

    Bài kiểm này khoá cả LỚP, không riêng ca test: mọi cổng phải gọi được bằng dạng `npm run`,
    vì đó là dạng người (và máy) suy ra từ những dòng bên cạnh.
  */
  for (const g of ["typecheck", "lint", "test", "build"]) {
    assert.ok(checkCommand(["npm", "run", g]).allowed, `\`npm run ${g}\` phải được phép — ba cổng kia dùng dạng này, nên đây là dạng ai cũng sẽ viết theo`);
  }
  assert.ok(checkCommand(["npm", "test"]).allowed, "`npm test` vẫn phải được phép — không thay dạng này bằng dạng kia, nhận CẢ HAI");

  /*
    ───────── 1.1c AGENT PHẢI ĐƯỢC CHO BIẾT BASE SHA VÀ TÊN NHÁNH ─────────

    Cùng lượt chạy ấy, đề bài đòi ghi base SHA và tên nhánh. Agent thử `git rev-parse` (không có
    trong danh sách cho phép) rồi thử đọc `.git/HEAD` (nằm trong `NEVER_READ`), bị chặn cả hai, và
    ghi "Chưa xác minh được" — xử lý ĐÚNG theo AGENTS.md mục 42.

    Cái sai là phía ta: runner có sẵn hai giá trị mà không truyền xuống. Một việc không thể hoàn
    thành đúng luật thì hoặc dạy agent lách luật, hoặc dạy người đọc rằng "chưa biết" là bình
    thường. Hai khẳng định dưới giữ hàng rào NGUYÊN VẸN và bắt `AgentJob` phải mang bối cảnh.
  */
  assert.ok(!checkCommand(["git", "rev-parse", "HEAD"]).allowed, "`git rev-parse` vẫn KHÔNG được phép — hàng rào giữ nguyên");
  assert.ok(!checkReadPath(".git/HEAD").allowed, "`.git/` vẫn KHÔNG đọc được — hàng rào giữ nguyên");
  {
    const src = readFileSync("lib/agents/executor.ts", "utf8");
    for (const f of ["baseCommit", "branch"]) {
      assert.ok(new RegExp(`^\\s*${f}:`, "m").test(src), `AgentJob phải mang \`${f}\` — agent bị hàng rào chặn mọi đường tự lấy`);
      assert.ok(src.includes(`job.${f}`), `prompt phải NÓI RA \`${f}\`, nếu không việc vẫn không hoàn thành được`);
    }
    const runner = readFileSync("lib/agents/runner.ts", "utf8");
    assert.ok(/baseCommit: opts\.baseCommit/.test(runner) && /^\s*branch,$/m.test(runner), "runner phải truyền cả hai xuống executor");
  }

  // ───────── 1.2 Danh sách CHO PHÉP: lệnh lạ bị chặn vì KHÔNG KHỚP, không vì có tên trong sổ cấm ─────────
  for (const argv of [["cat", "/etc/passwd"], ["node", "-e", "1"], ["bash", "-c", "ls"], ["npx", "tsx", "x.ts"]]) {
    assert.ok(!checkCommand(argv).allowed, `\`${argv.join(" ")}\` phải bị chặn`);
  }

  // ───────── 1.3 Mười ba nhóm lệnh nguy hiểm, mỗi nhóm nói được LÝ DO ─────────
  const camPhaiChan: [string[], string][] = [
    [["ssh", "root@vps"], "SSH"],
    [["docker", "ps"], "container"],
    [["psql", "$DATABASE_URL"], "CSDL"],
    [["gh", "secret", "list"], "secret"],
    [["printenv"], "biến môi trường"],
    [["git", "push", "origin", "main"], "kho chung"],
    [["git", "merge", "main"], "Gộp nhánh"],
    [["git", "reset", "--hard", "HEAD~1"], "mất việc"],
    [["rm", "-rf", "docs"], "Xoá đệ quy"],
    [["curl", "https://example.com"], "mạng"],
    [["npm", "install", "left-pad"], "Cài"],
    [["sudo", "reboot"], "Nâng quyền"],
  ];
  for (const [argv, manh] of camPhaiChan) {
    const v = checkCommand(argv);
    assert.ok(!v.allowed, `\`${argv.join(" ")}\` phải bị chặn`);
    assert.ok(!v.allowed && v.reason.includes(manh), `lời từ chối cho \`${argv.join(" ")}\` phải nói được vì sao (mong đợi chứa "${manh}", thực tế "${!v.allowed ? v.reason : ""}")`);
  }

  /*
    ───────── 1.4 KHÔNG NỐI ĐƯỢC LỆNH THỨ HAI ─────────
    Runner `spawn` với `shell: false`, nên `&&`/`;`/`|`/`$()` chỉ là ký tự trong MỘT tham số. Bài
    này khoá luôn ở tầng hàng rào: chuỗi đó không khớp bảng nào.
  */
  for (const argv of [["npm", "run", "typecheck && curl evil.com"], ["git", "status", "--short; rm -rf /"], ["npm", "test", "$(cat .env)"]]) {
    assert.ok(!checkCommand(argv).allowed, `\`${argv.join(" ")}\` không được coi là lệnh hợp lệ`);
  }

  // ───────── 1.5 Đường dẫn: ghi chỉ trong docs/, và không đi ngược ra ngoài ─────────
  assert.ok(checkWritePath("docs/abc.md").allowed, "ghi trong docs/ được");
  assert.ok(!checkWritePath("lib/queries/tech.ts").allowed, "KHÔNG ghi được mã nguồn");
  assert.ok(!checkWritePath("AGENTS.md").allowed, "KHÔNG ghi đè luật của kho mã");
  assert.ok(!checkWritePath(".env").allowed, "KHÔNG chạm .env");
  for (const p of ["../../../etc/passwd", "docs/../.env", "/etc/passwd", "~/.ssh/id_rsa", "docs/../../secret"]) {
    assert.ok(!checkWritePath(p).allowed, `\`${p}\` phải bị chặn — đi ngược ra ngoài cây làm việc`);
    assert.ok(!checkReadPath(p).allowed, `\`${p}\` phải bị chặn cả ở chiều đọc`);
  }
  // Đọc rộng hơn ghi, nhưng vẫn không chạm ba vùng cấm.
  assert.ok(checkReadPath("lib/constants/tech.ts").allowed, "đọc mã nguồn được — agent phải hiểu thứ nó mô tả");
  for (const p of [".env", ".git/config", "node_modules/x/index.js", "data/pglite/x"]) {
    assert.ok(!checkReadPath(p).allowed, `\`${p}\` không bao giờ được đọc`);
  }

  /*
    ───────── 1.6 BÍ MẬT KHÔNG LỌT XUỐNG TIẾN TRÌNH CON ─────────
    Đây là ca quan trọng nhất của cả khối: một tệp kiểm thử mà agent vừa sửa cũng chạy trong tiến
    trình con, nên nếu môi trường mang theo khoá API thì agent đọc được nó mà không cần lệnh nào.
  */
  const cha: Record<string, string> = { PATH: "/usr/bin", HOME: "/home/x", NODE_ENV: "test" };
  for (const k of SECRET_ENV_NAMES) cha[k] = `bi-mat-${k}`;
  const con = sandboxEnv(cha);
  for (const k of SECRET_ENV_NAMES) assert.ok(!(k in con), `${k} KHÔNG được đi vào tiến trình con của agent`);
  assert.equal(con.PATH, "/usr/bin", "PATH vẫn phải có, nếu không git/npm không chạy");
  assert.equal(con.ERP_READ_ONLY, "1", "tiến trình con phải bị ép CHỈ ĐỌC ở tầng CSDL");
  const chuoi = JSON.stringify(con);
  for (const k of SECRET_ENV_NAMES) assert.ok(!chuoi.includes(`bi-mat-${k}`), `giá trị của ${k} không được xuất hiện ở bất kỳ đâu trong môi trường con`);
  assert.ok(!CHILD_ENV_ALLOWLIST.includes("DATABASE_URL"), "DATABASE_URL cố ý KHÔNG nằm trong danh sách cho phép");

  console.log(`✓ Hàng rào agent: ${DOCUMENTATION_COMMANDS.length} lệnh cho phép · 12 nhóm lệnh nguy hiểm bị chặn kèm lý do · không nối được lệnh thứ hai · ghi chỉ trong docs/ · ${SECRET_ENV_NAMES.length} biến bí mật không lọt xuống tiến trình con`);
}

/* ═════════════════ 2 · ĐỌC DEPLOY TỪ GITHUB ═════════════════ */

/**
 * Một lượt chạy GitHub giả.
 *
 * `ageMinutes` BẮT BUỘC khác nhau giữa các lượt trong cùng một bộ dữ liệu: "lượt thành công MỚI
 * NHẤT" là thứ quyết định `MISMATCH` hay `SUPERSEDED`, và ba lượt cùng một mốc thời gian làm thứ
 * tự trở nên ngẫu nhiên — bài kiểm sẽ đỏ hoặc xanh tuỳ lần chạy. Mốc dựng từ ĐỒNG HỒ THẬT, cùng
 * nhịp với thứ nó đo (AGENTS.md mục 50).
 */
function ghRun(over: Partial<Record<string, unknown>> & { ageMinutes?: number } = {}) {
  const { ageMinutes = 60, ...rest } = over;
  const batDau = new Date(Date.now() - ageMinutes * 60_000);
  return {
    id: 1001,
    run_number: 1,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    head_sha: "a".repeat(40),
    head_branch: "main",
    event: "workflow_dispatch",
    html_url: "https://github.com/x/y/actions/runs/1001",
    created_at: batDau.toISOString(),
    run_started_at: batDau.toISOString(),
    updated_at: new Date(batDau.getTime() + 300_000).toISOString(),
    actor: { login: "owner" },
    ...rest,
  };
}

/** Header của lượt gọi gần nhất — để kiểm ERP CÓ/KHÔNG gửi `Authorization`, chứ không tin lời kể. */
let headerLanCuoi: Record<string, string> = {};

function fakeGithub(runs: unknown[]) {
  headerLanCuoi = {};
  __setGithubFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
    headerLanCuoi = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
    const u = String(url);
    if (u.includes("/runs?")) return new Response(JSON.stringify({ workflow_runs: runs }), { status: 200 });
    return new Response(JSON.stringify({ name: "Deploy", state: "active" }), { status: 200 });
  }) as typeof fetch);
}

/** GitHub hết hạn mức: 403 kèm `x-ratelimit-remaining: 0` — KHÔNG phải 429, và đó là cái bẫy. */
function fakeGithubHetHanMuc(sauBaoNhieuGiay = 900) {
  __setGithubFetchForTests((async () =>
    new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.round(Date.now() / 1000) + sauBaoNhieuGiay),
      },
    })) as typeof fetch);
}

export async function testGithubDeploymentSync() {
  const db = await getDb();
  process.env.ERP_GITHUB_TOKEN = "test-token-not-real";
  process.env.ERP_GITHUB_REPO = "owner/repo";

  // ───────── 2.1 Ánh xạ trạng thái: năm ca, mỗi ca một cách sửa khác nhau ─────────
  assert.equal(techDeployStatusFromGithub("completed", "success"), "SUCCEEDED");
  assert.equal(techDeployStatusFromGithub("completed", "failure"), "FAILED");
  assert.equal(techDeployStatusFromGithub("completed", "cancelled"), "FAILED");
  assert.equal(techDeployStatusFromGithub("completed", "timed_out"), "FAILED");
  assert.equal(techDeployStatusFromGithub("in_progress", null), "RUNNING", "đang chạy KHÔNG phải hỏng");
  assert.equal(techDeployStatusFromGithub("queued", null), "PENDING", "xếp hàng KHÔNG phải hỏng");

  // ───────── 2.2 Nạp lần đầu ─────────
  fakeGithub([
    ghRun({ id: 2003, status: "in_progress", conclusion: null, head_sha: "d".repeat(40), ageMinutes: 10 }),
    ghRun({ id: 2002, conclusion: "failure", head_sha: "c".repeat(40), ageMinutes: 60 }),
    ghRun({ id: 2001, head_sha: "b".repeat(40), ageMinutes: 120 }),
  ]);
  const lan1 = await syncGithubDeployments({ limit: 10 });
  assert.equal(lan1.scanned, 3);
  assert.equal(lan1.inserted, 3, "ba lượt chạy ⇒ ba dòng");
  assert.equal(lan1.errors, 0);

  // ───────── 2.3 IDEMPOTENT: chạy lại KHÔNG nhân đôi ─────────
  const lan2 = await syncGithubDeployments({ limit: 10 });
  assert.equal(lan2.inserted, 0, "chạy lại không được thêm dòng nào");
  assert.equal(lan2.unchanged, 3, "không đổi gì thì đếm là 'không đổi', không phải 'đã cập nhật'");
  const dem = await db.query.techDeployments.findMany({ where: eq(schema.techDeployments.provider, "GITHUB_ACTIONS") });
  assert.equal(dem.length, 3, "vẫn đúng ba dòng sau hai lượt đồng bộ");

  // ───────── 2.4 Lượt chạy XONG thì cập nhật, không tạo dòng mới ─────────
  fakeGithub([ghRun({ id: 2003, status: "completed", conclusion: "success", head_sha: "d".repeat(40), ageMinutes: 10 })]);
  const lan3 = await syncGithubDeployments({ limit: 10 });
  assert.equal(lan3.updated, 1, "lượt từ 'đang chạy' sang 'xong' phải là CẬP NHẬT");
  assert.equal(lan3.inserted, 0);
  const daXong = await db.query.techDeployments.findFirst({ where: eq(schema.techDeployments.externalRunId, "2003") });
  assert.equal(daXong?.status, "SUCCEEDED");
  assert.ok(daXong?.finishedAt, "lượt đã xong phải có mốc kết thúc");

  // ───────── 2.5 CHẠY LẠI workflow là một sự việc MỚI, không phải bản sao ─────────
  fakeGithub([ghRun({ id: 2002, run_attempt: 2, conclusion: "success", head_sha: "c".repeat(40), ageMinutes: 40 })]);
  const lan4 = await syncGithubDeployments({ limit: 10 });
  assert.equal(lan4.inserted, 1, "lần chạy lại (run_attempt=2) phải là một DÒNG RIÊNG — gộp là giấu mất đúng lần người ta quan tâm");

  // ───────── 2.6 Đối chiếu với bản đang chạy: bốn câu trả lời ─────────
  assert.equal(verifyDeployment({ status: "FAILED", commitSha: "a".repeat(40), productionCommit: "a".repeat(40), isLatestSuccess: true }), "UNKNOWN", "lượt hỏng không bao giờ lên máy chủ — không có gì để đối chiếu");
  assert.equal(verifyDeployment({ status: "SUCCEEDED", commitSha: "a".repeat(40), productionCommit: null, isLatestSuccess: true }), "UNKNOWN", "chưa biết production chạy gì ⇒ CHƯA BIẾT, không phải LỆCH");
  assert.equal(verifyDeployment({ status: "SUCCEEDED", commitSha: "a".repeat(40), productionCommit: "a".repeat(12), isLatestSuccess: true }), "VERIFIED", "khớp theo độ dài chung");
  assert.equal(verifyDeployment({ status: "SUCCEEDED", commitSha: "a".repeat(40), productionCommit: "z".repeat(12), isLatestSuccess: true }), "MISMATCH", "lượt mới nhất mà lệch ⇒ chuông báo");
  assert.equal(verifyDeployment({ status: "SUCCEEDED", commitSha: "a".repeat(40), productionCommit: "z".repeat(12), isLatestSuccess: false }), "SUPERSEDED", "lượt CŨ lệch là bình thường — tô đỏ nó là dạy người đọc bỏ qua màu đỏ");

  // ───────── 2.7 Đối chiếu thật trên dữ liệu vừa nạp ─────────
  process.env.ERP_COMMIT = "d".repeat(40);
  const dc = await verifyDeployments();
  assert.equal(dc.productionCommit, "d".repeat(40));
  assert.equal(dc.mismatched, 0, "commit đang chạy đúng bằng lượt thành công mới nhất ⇒ không có LỆCH nào");
  const moiNhat = await db.query.techDeployments.findFirst({ where: eq(schema.techDeployments.externalRunId, "2003") });
  assert.equal(moiNhat?.verification, "VERIFIED");
  assert.equal(moiNhat?.productionCommit, "d".repeat(40));

  // Và khi production chạy một bản KHÁC hẳn: đúng một lượt bị gắn LỆCH, phần còn lại là "đã bị thay".
  process.env.ERP_COMMIT = "f".repeat(40);
  const lech = await verifyDeployments();
  assert.equal(lech.mismatched, 1, "chỉ lượt THÀNH CÔNG MỚI NHẤT được gắn LỆCH");
  assert.ok(lech.superseded >= 1, "các lượt thành công cũ hơn là 'đã bị bản sau thay', không phải lỗi");

  /*
    ═══════════ 2.8 KHO PUBLIC: THIẾU TOKEN KHÔNG PHẢI "CHƯA CẤU HÌNH" ═══════════

    GitHub cho đọc workflow và lượt chạy của kho public mà không cần xác thực. Trả "chưa cấu hình"
    khi thiếu token là dán nhãn BLOCKED lên một đường đang chạy được — và trên màn hình, "chưa cấu
    hình" với "không có lượt deploy nào" trông giống hệt nhau.

    Phải xoá CẢ BA biến: `token()` có chuỗi dự phòng `ERP_GITHUB_TOKEN → GITHUB_TOKEN → GH_TOKEN`
    (cố ý, để máy CI đã có sẵn token dùng được ngay). Chỉ xoá biến đầu thì trên một máy có
    `GITHUB_TOKEN` bài kiểm sẽ đi nhánh khác — xanh ở chỗ này, đỏ ở máy khác.
  */
  const giuToken = { erp: process.env.ERP_GITHUB_TOKEN, gh: process.env.GITHUB_TOKEN, gh2: process.env.GH_TOKEN };
  delete process.env.ERP_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;

  const cfgAnDanh = githubConfig();
  assert.equal(cfgAnDanh.configured, true, "kho public + biết tên kho ⇒ ĐÃ cấu hình, dù không có token");
  assert.equal(cfgAnDanh.auth, "PUBLIC", "…và nói rõ đang gọi kiểu ẩn danh");
  assert.equal(cfgAnDanh.tokenMasked, null);

  await db.delete(schema.techDeployments).where(eq(schema.techDeployments.provider, "GITHUB_ACTIONS"));
  fakeGithub([ghRun({ id: 3001, head_sha: "e".repeat(40), ageMinutes: 30 })]);
  const anDanh = await syncGithubDeployments({ limit: 5 });
  assert.equal(anDanh.skippedReason, null, "KHÔNG được bỏ qua chỉ vì thiếu token");
  assert.equal(anDanh.scanned, 1, "vẫn quét được lượt chạy");
  assert.equal(anDanh.inserted, 1);
  // Kiểm HEADER THẬT, không tin lời kể: gửi `Authorization` rỗng hay `Bearer ` KHÔNG phải gọi ẩn
  // danh — GitHub trả 401 cho nó, và lỗi ấy sẽ trông y hệt "token sai".
  assert.ok(!("Authorization" in headerLanCuoi), "lượt gọi ẩn danh KHÔNG được gửi header Authorization");
  assert.equal(headerLanCuoi["User-Agent"], "vnxcommerce-erp", "…nhưng các header khác vẫn phải còn");

  // Có token trở lại ⇒ CÓ gửi Authorization. Hai chiều, không chỉ một.
  process.env.ERP_GITHUB_TOKEN = "test-token-not-real";
  fakeGithub([ghRun({ id: 3001, head_sha: "e".repeat(40), ageMinutes: 30 })]);
  await syncGithubDeployments({ limit: 5 });
  assert.equal(headerLanCuoi.Authorization, "Bearer test-token-not-real", "có token thì phải gửi kèm");
  assert.equal(githubConfig().auth, "TOKEN");

  /*
    ───────── 2.9 HẾT HẠN MỨC KHÔNG PHẢI LỖI CẤU HÌNH, VÀ KHÔNG PHẢI LỖI CỦA AI ─────────

    Cách sửa của nó là CHỜ. Xếp nó chung với "thiếu token" thì người vận hành đi tạo một PAT mới
    cho một thứ tự khỏi sau mười lăm phút; xếp chung với "token sai" thì họ đi xoá token đang đúng.
    GitHub báo hết hạn mức bằng **403** kèm `x-ratelimit-remaining: 0`, không phải 429 — một bộ dò
    chỉ nhìn mã trạng thái sẽ gọi nhầm nó là "thiếu quyền".
  */
  fakeGithubHetHanMuc(900);
  const hetHanMuc = await syncGithubDeployments({ limit: 5 });
  assert.equal(hetHanMuc.skippedKind, "RATE_LIMITED", "403 + remaining 0 là HẾT HẠN MỨC, không phải thiếu quyền");
  assert.equal(hetHanMuc.scanned, 0);
  assert.equal(hetHanMuc.errors, 0, "hết hạn mức KHÔNG tính là lỗi đọc — lượt sau tự chạy lại được");
  assert.ok(hetHanMuc.skippedReason?.includes("phút"), "phải nói phải chờ bao lâu, không bắt người đoán");

  // ───────── 2.10 Token SAI ⇒ AUTH_FAILED, và lời sửa phải nhắc rằng kho public không cần token ─────────
  __setGithubFetchForTests((async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })) as typeof fetch);
  const tokenSai = await syncGithubDeployments({ limit: 5 });
  assert.equal(tokenSai.skippedKind, "AUTH_FAILED");
  assert.ok(tokenSai.skippedReason?.includes("KHÔNG cần token"), "với kho public, XOÁ token cũng là một cách sửa — phải nói ra");

  // ───────── 2.11 KHÔNG biết tên kho mới thật sự là CHƯA CẤU HÌNH ─────────
  const giuRepo = process.env.ERP_GITHUB_REPO;
  delete process.env.ERP_GITHUB_REPO;
  delete process.env.GITHUB_REPOSITORY;
  const khongBietKho = await syncGithubDeployments({ limit: 5 });
  assert.equal(khongBietKho.skippedKind, "NOT_CONFIGURED");
  assert.ok(khongBietKho.skippedReason?.includes("ERP_GITHUB_REPO"), "phải nói THIẾU ĐÚNG CÁI GÌ");
  assert.equal(khongBietKho.errors, 0, "chưa biết kho KHÔNG phải lỗi");
  if (giuRepo) process.env.ERP_GITHUB_REPO = giuRepo;

  // Trả lại môi trường đúng như lúc mượn — bài kiểm sau có thể cần token thật.
  delete process.env.ERP_GITHUB_TOKEN;
  if (giuToken.erp) process.env.ERP_GITHUB_TOKEN = giuToken.erp;
  if (giuToken.gh) process.env.GITHUB_TOKEN = giuToken.gh;
  if (giuToken.gh2) process.env.GH_TOKEN = giuToken.gh2;
  __setGithubFetchForTests(null);
  delete process.env.ERP_GITHUB_REPO;
  delete process.env.ERP_COMMIT;
  await db.delete(schema.techDeployments).where(eq(schema.techDeployments.provider, "GITHUB_ACTIONS"));
  console.log("✓ Đọc deploy từ GitHub: 6 ca ánh xạ · idempotent · chạy lại workflow là dòng riêng · bốn câu trả lời đối chiếu · KHO PUBLIC đọc được không cần token (không gửi header Authorization) · hết hạn mức / token sai / chưa biết kho là BA câu trả lời khác nhau");
}

/* ═════════════════ 3 · PHÉP CHIẾU VIỆC TECH LÊN /work ═════════════════ */

export async function testTechWorkProjection() {
  const db = await getDb();

  // ───────── 3.1 Khai báo thẩm quyền: nguồn giữ trạng thái, KHÔNG phải work_items ─────────
  assert.equal(authorityOf("TECH_TASK"), "SOURCE", "tech_tasks giữ trạng thái — work_items chỉ là lớp ghi chú");
  assert.equal(WORK_SOURCE_SPEC.TECH_TASK.assigneeAuthority, "SOURCE", "người/agent phụ trách nằm ở miền Tech");
  assert.equal(WORK_SOURCE_SPEC.TECH_TASK.department, "MANAGEMENT");
  assert.deepEqual(WORK_SOURCE_SPEC.TECH_TASK.actions, ["OPEN_SOURCE"], "chỉ có nút MỞ — một nút 'Xong' ở hàng đợi chung sẽ là nút giả");

  const nguoi: TechActor = { kind: "HUMAN", id: null, name: "p2a-chu-shop" };
  const t1 = await createTechTask({ title: "p2a-chiếu: sửa một truy vấn chậm", taskType: "PERFORMANCE", module: "PLATFORM", priority: "P1", source: "OWNER" }, nguoi);
  assert.ok("ok" in t1);
  const id1 = "ok" in t1 ? t1.id : "";
  const t2 = await createTechTask({ title: "p2a-chiếu: việc chạm lương cần duyệt", taskType: "BUGFIX", module: "PAYROLL", priority: "P0", source: "OWNER" }, nguoi);
  const id2 = "ok" in t2 ? t2.id : "";

  // ───────── 3.2 Chiếu ra đúng hình dạng WorkItem ─────────
  const items = await adaptTechTasks(new Date());
  const m1 = items.find((i) => i.sourceKey === id1);
  const m2 = items.find((i) => i.sourceKey === id2);
  assert.ok(m1 && m2, "cả hai việc phải hiện trong phép chiếu");
  assert.equal(m1.statusAuthority, "SOURCE");
  assert.equal(m1.priority, "HIGH", "P1 của miền Tech → HIGH của hàng đợi chung");
  assert.equal(m2.priority, "URGENT", "P0 → URGENT");
  assert.equal(m1.department, "MANAGEMENT");
  assert.ok(m1.sourceUrl.startsWith("/tech/tasks/"), "mở việc phải quay về miền Tech");
  assert.equal(m1.money.confidence, "UNKNOWN", "việc kỹ thuật KHÔNG khai tiền — 0 sẽ là một lời khẳng định sai");

  // ───────── 3.3 Việc chờ duyệt phải NÓI RA điều đó ─────────
  assert.ok(m2.tags.includes("cho-chu-shop-duyet"), "việc R2 đang chờ ký phải mang nhãn");
  assert.ok(m2.summary.includes("PHÊ DUYỆT"), "và phải nói thẳng trong câu tóm tắt");

  // ───────── 3.4 KHÔNG BAO GIỜ gán agent vào ô người phụ trách ─────────
  // AGENTS.md mục 36: gộp máy vào người thì thẻ điểm nhân sự đếm việc của máy thành việc của người.
  assert.equal(m1.assignee, null, "ô người phụ trách của việc Tech luôn rỗng ở hàng đợi chung");

  // ───────── 3.5 Không đếm hai lần ─────────
  const khoa = new Set<string>();
  for (const i of items) {
    assert.ok(!khoa.has(i.key), `khoá ${i.key} xuất hiện hai lần trong phép chiếu`);
    khoa.add(i.key);
  }
  // Và khoá của nguồn này không đụng nguồn nào khác vì nó mang tiền tố riêng.
  assert.ok(items.every((i) => i.key.startsWith("TECH_TASK:")), "mọi khoá phải mang tiền tố nguồn");

  // ───────── 3.6 Việc ĐÃ XONG rơi khỏi hàng đợi mà không ai phải đóng hộ ─────────
  await db.update(schema.techTasks).set({ status: "DONE", completedAt: new Date() }).where(eq(schema.techTasks.id, id1));
  const sau = await adaptTechTasks(new Date());
  assert.ok(!sau.some((i) => i.sourceKey === id1), "việc đóng ở miền Tech thì TỰ rời hàng đợi — không job nào phải đóng hộ");

  await db.delete(schema.techTasks).where(eq(schema.techTasks.id, id1));
  await db.delete(schema.techTasks).where(eq(schema.techTasks.id, id2));
  console.log("✓ Chiếu việc Tech lên /work: thẩm quyền SOURCE · P0–P3 → bốn mức chung · agent KHÔNG vào ô người · không khoá trùng · việc đóng tự rời hàng đợi");
}

/* ═════════════════ 4 · RUNNER (chạy thật, không mô phỏng) ═════════════════ */

/** Executor kịch bản — CHỈ dùng trong bài kiểm, để chạy trọn vòng runner mà không cần khoá API. */
class ScriptedExecutor implements AgentExecutor {
  readonly key = "scripted";
  constructor(private readonly script: (job: AgentJob) => Promise<AgentOutcome>, private readonly ready = true) {}
  available() {
    return this.ready ? { ok: true, reason: null } : { ok: false, reason: "Chưa cấu hình nhà cung cấp AI (bài kiểm cố ý tắt)." };
  }
  run(job: AgentJob) {
    return this.script(job);
  }
}

/** Kho git tạm, có một commit thật — runner đòi base SHA đã vào kho. */
function repoTam(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "p2a-repo-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.local");
  git("config", "user.name", "T");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { typecheck: "node -e \"process.exit(0)\"", lint: "node -e \"process.exit(0)\"" } }, null, 2));
  execFileSync("mkdir", ["-p", path.join(dir, "docs")]);
  writeFileSync(path.join(dir, "docs", "seed.md"), "# seed\n");
  writeFileSync(path.join(dir, ".env"), "SECRET=khong-duoc-doc\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return dir;
}

export async function testAgentRunner() {
  const db = await getDb();
  const nguoi: TechActor = { kind: "HUMAN", id: null, name: "p2a-chu-shop" };
  const may: TechActor = { kind: "AI_AGENT", id: null, name: "agent:documentation" };

  await seedTechAgents(nguoi);
  const agents = await db.query.techAgents.findMany();
  const doc = agents.find((a) => a.key === "documentation");
  assert.ok(doc, "bản khai phải có agent tài liệu");

  // ───────── 4.1 BẬT MẶC ĐỊNH LÀ TẮT, và bootstrap idempotent ─────────
  assert.equal(agents.filter((a) => a.enabled).length, 0, "mọi agent sinh ra ở trạng thái TẮT");
  assert.equal(agents.length, TECH_AGENT_TEMPLATES.length, "đủ 12 vai");
  const lai = await seedTechAgents(nguoi);
  assert.ok("ok" in lai && lai.created === 0, "bấm lại không nhân đôi sổ");

  const repo = repoTam();
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const taoViec = async (title: string, module: Parameters<typeof createTechTask>[0]["module"] = "TECH") => {
    const r = await createTechTask({ title, description: "p2a", taskType: "DOCS", module, priority: "P3", source: "OWNER" }, nguoi);
    assert.ok("ok" in r, "tạo được việc");
    return "ok" in r ? r.id : "";
  };
  const ghiDoc = new ScriptedExecutor(async (job) => {
    job.workspace.writeFile("docs/p2a-agent.md", "# Tài liệu do agent viết\n\nMột dòng.\n");
    return { summary: "Đã ghi docs/p2a-agent.md.", steps: [], finished: true, khongLamDuoc: null, error: null, chiPhi: KHONG_TON };
  });

  // ───────── 4.2 AGENT ĐANG TẮT thì KHÔNG chạy ─────────
  const idTat = await taoViec("p2a-runner: agent đang tắt");
  const rTat = await runAgentOnTask({ taskId: idTat, agentKey: "documentation", executor: ghiDoc, repoRoot: repo, baseCommit: base, actor: may });
  assert.equal(rTat.status, "BLOCKED");
  assert.ok(rTat.reason?.includes("TẮT"), "phải nói rõ là agent chưa được bật");
  assert.equal(rTat.runId, null, "bị chặn TRƯỚC khi mở lượt chạy — không để lại rác");

  await setTechAgentEnabled({ agentId: doc.id, enabled: true }, nguoi);

  // ───────── 4.3 CHƯA CÓ KHOÁ API ⇒ BLOCKED, KHÔNG giả vờ thành công ─────────
  const idChuaCauHinh = await taoViec("p2a-runner: chưa cấu hình executor");
  const rChua = await runAgentOnTask({ taskId: idChuaCauHinh, agentKey: "documentation", executor: new ScriptedExecutor(async () => ({ summary: "", steps: [], finished: true, khongLamDuoc: null, error: null, chiPhi: KHONG_TON }), false), repoRoot: repo, baseCommit: base, actor: may });
  assert.equal(rChua.status, "BLOCKED");
  assert.ok(rChua.reason?.includes("CHƯA CẤU HÌNH"), "thiếu khoá phải nói thẳng, không được coi là xong");

  // ───────── 4.4 Mức rủi ro NGOÀI quyền agent thì không chạy ─────────
  const idR2 = await taoViec("p2a-runner: việc chạm lương", "PAYROLL");
  const r2 = await runAgentOnTask({ taskId: idR2, agentKey: "documentation", executor: ghiDoc, repoRoot: repo, baseCommit: base, actor: may });
  assert.equal(r2.status, "BLOCKED");
  assert.ok(r2.reason?.includes("R2"), "agent R0 không được chạm việc R2");

  // ───────── 4.5 LƯỢT CHẠY THẬT: cây riêng, nhánh riêng, cổng thật, commit thật ─────────
  const idOk = await taoViec("p2a-runner: viết một trang tài liệu");
  const ok = await runAgentOnTask({ taskId: idOk, agentKey: "documentation", executor: ghiDoc, repoRoot: repo, baseCommit: base, actor: may, gates: ["typecheck", "lint"] });
  assert.equal(ok.status, "SUCCEEDED", `lượt chạy phải thành công — ${ok.reason ?? ""}`);
  assert.ok(ok.branch?.startsWith("ai/documentation/"), "nhánh phải mang tên agent và mã việc");
  assert.equal(ok.baseCommit, base, "base SHA phải là commit ĐÃ VÀO KHO");
  assert.ok(ok.resultCommit, "phải có commit kết quả");
  assert.notEqual(ok.resultCommit, base, "commit kết quả khác base");
  assert.deepEqual(ok.filesChanged, ["docs/p2a-agent.md"], "đo tệp đổi bằng git, không hỏi agent");
  assert.equal(ok.gates.typecheck, "PASSED");
  assert.equal(ok.gates.lint, "PASSED");
  assert.equal(ok.gates.test, "UNKNOWN", "cổng KHÔNG chạy vẫn là CHƯA XÁC MINH — không tự thành ĐẠT");
  // Nhánh và commit CÒN NGUYÊN sau khi cây làm việc đã dọn: xoá nhánh là xoá bằng chứng.
  const nhanhConLai = execFileSync("git", ["branch", "--list", ok.branch!], { cwd: repo, encoding: "utf8" });
  assert.ok(nhanhConLai.includes(ok.branch!), "nhánh phải còn sau khi dọn cây làm việc");
  const noiDung = execFileSync("git", ["show", `${ok.branch}:docs/p2a-agent.md`], { cwd: repo, encoding: "utf8" });
  assert.ok(noiDung.includes("agent viết"), "nội dung agent ghi phải thật sự nằm trong commit");

  // Bằng chứng vào sổ, không phải chỉ trong trí nhớ tiến trình.
  const run = await db.query.techAgentRuns.findFirst({ where: eq(schema.techAgentRuns.id, ok.runId!) });
  assert.equal(run?.status, "SUCCEEDED");
  assert.equal(run?.baseCommit, base);
  assert.equal(run?.resultCommit, ok.resultCommit);
  assert.ok(run?.worktree, "đường dẫn cây làm việc phải được ghi lại");
  assert.ok(run?.heartbeatAt, "phải có nhịp tim");
  assert.deepEqual(run?.filesChanged, ["docs/p2a-agent.md"]);
  assert.ok((run?.testsRun ?? "").includes("typecheck"), "lệnh đã chạy phải ghi nguyên văn");

  // ───────── 4.6 CỔNG ĐỎ ⇒ KHÔNG COMMIT ─────────
  const repoDo = repoTam();
  writeFileSync(path.join(repoDo, "package.json"), JSON.stringify({ name: "x", scripts: { typecheck: "node -e \"process.exit(1)\"", lint: "node -e \"process.exit(0)\"" } }, null, 2));
  execFileSync("git", ["add", "-A"], { cwd: repoDo });
  execFileSync("git", ["-c", "user.email=t@t.local", "-c", "user.name=T", "commit", "-q", "-m", "do"], { cwd: repoDo });
  const baseDo = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDo, encoding: "utf8" }).trim();
  const idDo = await taoViec("p2a-runner: cổng đỏ thì không commit");
  const rDo = await runAgentOnTask({ taskId: idDo, agentKey: "documentation", executor: ghiDoc, repoRoot: repoDo, baseCommit: baseDo, actor: may, gates: ["typecheck"] });
  assert.equal(rDo.status, "FAILED");
  assert.equal(rDo.gates.typecheck, "FAILED", "exit code THẬT quyết định cổng, không phải lời khai của agent");
  assert.equal(rDo.resultCommit, null, "cổng đỏ thì KHÔNG có commit nào");

  // ───────── 4.5b TỆP TRONG THƯ MỤC MỚI PHẢI ĐƯỢC ĐẾM TỪNG TỆP ─────────
  /*
    `git status --porcelain` mặc định GỘP một thư mục chưa theo dõi thành một dòng `docs/xyz/`.
    Đo ở việc TECH-6 (lượt chạy #42): agent tạo `docs/baselines/BASELINE-TEMPLATE.json`, sổ ghi
    `docs/baselines/`, git sau commit thấy tên tệp đầy đủ — bước nghiệm thu đánh KHÔNG ĐẠT một
    lượt chạy đã làm xong việc.

    Lỗi chỉ lộ ra đúng lần agent tạo một THƯ MỤC MỚI, nên nó nằm im qua mọi lượt chạy trước. Bài
    kiểm này dựng đúng tình huống ấy.
  */
  const idThuMuc = await taoViec("p2a-runner: agent tạo thư mục mới");
  const ghiThuMucMoi = new ScriptedExecutor(async (job) => {
    job.workspace.writeFile("docs/moi/a.md", "# a\n");
    job.workspace.writeFile("docs/moi/b.md", "# b\n");
    return { summary: "Đã ghi hai tệp trong một thư mục mới.", steps: [], finished: true, khongLamDuoc: null, error: null, chiPhi: KHONG_TON };
  });
  const rThuMuc = await runAgentOnTask({ taskId: idThuMuc, agentKey: "documentation", executor: ghiThuMucMoi, repoRoot: repo, baseCommit: base, actor: may, gates: ["typecheck"] });
  assert.equal(rThuMuc.status, "SUCCEEDED", `phải chạy xong — ${rThuMuc.reason ?? ""}`);
  assert.deepEqual(
    [...rThuMuc.filesChanged].sort(),
    ["docs/moi/a.md", "docs/moi/b.md"],
    "phải đếm TỪNG TỆP — gộp thành `docs/moi/` là ghi sai vết kiểm toán, và làm bước nghiệm thu đánh trượt một lượt chạy đã xong việc",
  );
  const runThuMuc = await db.query.techAgentRuns.findFirst({ where: eq(schema.techAgentRuns.id, rThuMuc.runId!) });
  assert.deepEqual([...(runThuMuc?.filesChanged ?? [])].sort(), ["docs/moi/a.md", "docs/moi/b.md"], "và sổ phải giữ đúng danh sách ấy");

  // ───────── 4.6b AGENT KHAI KHÔNG LÀM ĐƯỢC ⇒ BLOCKED, KHÔNG COMMIT, KHÔNG CHẠY CỔNG ─────────
  /*
    Lượt chạy #39 (việc TECH-5, 22/09/2026) nhận một đề bài đòi ĐO PRODUCTION, thứ máy Actions
    không chạm được. Không có lối ra nào mang nghĩa "không làm được ở đây", nên nó gọi `finish`
    kèm một tệp số tự nghĩ ra. Khối này khoá lối ra ấy lại.

    Điểm phải đo là agent vẫn GHI TỆP trước khi nhận ra: bản nháp dở KHÔNG được vào kho, nếu không
    lối ra trung thực lại đẻ ra đúng thứ rác mà nó sinh ra để chặn.
  */
  /*
    CÂY RIÊNG VỚI CỔNG LUÔN XANH — ĐỂ ĐỘT BIẾN "DỜI PHÉP KIỂM XUỐNG SAU" THẬT SỰ COMMIT ĐƯỢC.

    Nếu cổng ĐỎ thì runner bỏ qua bước commit vì một lý do KHÁC, và khẳng định "nhánh còn trỏ vào
    base" sẽ xanh mà không chứng minh gì — đúng cái bẫy đã làm đột biến ấy sống sót lần đầu.
  */
  const repoChan = repoTam();
  const baseChan = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoChan, encoding: "utf8" }).trim();
  const idKhongLam = await taoViec("p2a-runner: việc đòi đo production");
  const boCuoc = new ScriptedExecutor(async (job) => {
    job.workspace.writeFile("docs/p2a-nhap-do.md", "# bản nháp dở dang\n");
    return {
      summary: "",
      steps: [],
      finished: true,
      khongLamDuoc: { lyDo: "Đề bài đòi số đo production; máy chạy dùng CSDL rỗng dùng-một-lần.", canGi: "Một tệp số đo đã có sẵn trong kho." },
      error: null,
      chiPhi: KHONG_TON,
    };
  });
  const rKhongLam = await runAgentOnTask({ taskId: idKhongLam, agentKey: "documentation", executor: boCuoc, repoRoot: repoChan, baseCommit: baseChan, actor: may, gates: ["typecheck", "lint"] });
  assert.equal(rKhongLam.status, "BLOCKED", "agent khai không làm được ⇒ BLOCKED, KHÔNG phải FAILED");
  /*
    ĐO BẰNG DẤU VẾT THẬT, KHÔNG ĐỌC ĐỐI TƯỢNG TRẢ VỀ.

    Bản đầu của khối này khẳng định `rKhongLam.resultCommit === null` và `gates.typecheck ===
    "UNKNOWN"`. Cả hai XANH kể cả khi phép kiểm bị dời xuống SAU cổng và SAU commit — vì nhánh
    BLOCKED dựng kết quả từ `rong` (giá trị rỗng), nên hai trường ấy luôn rỗng bất kể chuyện gì
    đã thật sự xảy ra. Đột biến "dời phép kiểm xuống cuối" SỐNG SÓT.

    Hai khẳng định dưới đo thứ KHÔNG nói dối được: nhánh git trỏ vào đâu, và lệnh cổng có chạy
    hay không (nó để lại một tệp dấu ở thư mục tạm CHUNG, nên tiến trình con ghi được và bài kiểm
    đọc được).
  */
  assert.equal(rKhongLam.resultCommit, null, "bản nháp dở KHÔNG được vào kho");
  const troVao = execFileSync("git", ["rev-parse", rKhongLam.branch!], { cwd: repoChan, encoding: "utf8" }).trim();
  assert.equal(troVao, baseChan, "nhánh phải còn trỏ đúng base — một commit ở đây là bản nháp dở đã lọt vào kho");
  /*
    "KHÔNG CHẠY CỔNG" ĐO BẰNG THỨ TỰ TRONG MÃ NGUỒN, KHÔNG ĐO BẰNG DẤU VẾT.

    Đã thử đo bằng dấu vết — một script cổng ghi tệp mốc ở thư mục tạm — và nó KHÔNG đáng tin trên
    máy Windows: lệnh không chạy được vì lý do của hệ điều hành, tệp mốc không xuất hiện, và khẳng
    định xanh mà chẳng chứng minh gì. Đúng lớp lỗi AGENTS.md mục 65 gọi tên: bài kiểm đang đo CÁI
    MÁY chứ không đo mã nguồn.

    Thứ tự trong mã đọc được như nhau trên mọi nền, và nó chính là tính chất cần khoá — cùng kỹ
    thuật `tests/agent-scopes.test.ts` dùng để ghim "NEVER_WRITE kiểm TRƯỚC writeGlobs".
  */
  const maRunner = readFileSync(path.join(process.cwd(), "lib/agents/runner.ts"), "utf8");
  const thanRunner = maRunner.replace(/\/\*[\s\S]*?\*\//g, "");
  const iKhai = thanRunner.indexOf("outcome.khongLamDuoc");
  const iCong = thanRunner.indexOf("const canChay = opts.gates");
  const iCommit = thanRunner.indexOf("await ws.commit(");
  assert.ok(iKhai > 0 && iCong > 0 && iCommit > 0, "phải đọc được cả ba mốc trong runner");
  assert.ok(iKhai < iCong, "phép kiểm lời khai phải đứng TRƯỚC vòng chạy cổng — bốn cổng đo CÂY LÀM VIỆC nên chúng xanh đều cho một lượt chạy chẳng giao gì");
  assert.ok(iKhai < iCommit, "và TRƯỚC bước commit — bản nháp dở không phải sản phẩm bàn giao");
  assert.ok(rKhongLam.reason?.includes("KHÔNG LÀM ĐƯỢC"), "lý do phải đọc ra được là không làm được, không phải một câu lỗi chung");
  assert.ok(rKhongLam.reason?.includes("cần:"), "và phải nói CẦN GÌ — một lời từ chối không kèm lối ra thì người đọc không làm gì được với nó");
  /*
    CỔNG KHÔNG CHẠY, và điều đó phải đọc ra được. Bốn cổng đo CÂY LÀM VIỆC nên chúng xanh đều cho
    một lượt chạy chẳng giao gì — in bốn dấu ✓ cạnh một lượt chạy không làm được việc là đúng thứ
    AGENTS.md mục 65 gọi là dấu ✓ thay cho một câu trung thực.
  */
  assert.equal(rKhongLam.gates.typecheck, "UNKNOWN", "cổng KHÔNG được chạy cho lượt chạy bị chặn — và CHƯA CHẠY phải in ra là CHƯA XÁC MINH");
  assert.equal(rKhongLam.gates.lint, "UNKNOWN");
  const runChan = await db.query.techAgentRuns.findFirst({ where: eq(schema.techAgentRuns.id, rKhongLam.runId!) });
  assert.equal(runChan?.status, "BLOCKED", "sổ phải ghi BLOCKED — gộp vào CANCELLED là giấu mất việc phải sửa ĐỀ BÀI");
  assert.equal(runChan?.error, "", "không phải một lỗi: đây là lượt chạy làm đúng việc của nó");
  assert.ok((runChan?.summary ?? "").includes("cần:"), "sổ phải giữ lại CẦN GÌ, không chỉ giữ lời từ chối");

  // ───────── 4.6c EXECUTOR THẬT: lời gọi công cụ PHẢI biến thành lời khai ─────────
  /*
    KHỐI 4.6b DÙNG `ScriptedExecutor`, TỨC LÀ NÓ BỎ QUA HẲN EXECUTOR THẬT.

    Nó chứng minh runner TÔN TRỌNG `khongLamDuoc`, nhưng không chứng minh có gì từng ĐẶT giá trị
    ấy vào. Đột biến "executor nuốt lời khai của agent" (`khongLamDuoc = null` ngay trong nhánh
    xử lý) SỐNG SÓT qua cả bộ kiểm thử — hàng rào đúng, đường nối đứt, và bài kiểm không thấy.

    Khối này nối lại đúng đoạn còn hở: một provider GIẢ trả về lời gọi công cụ `khong_lam_duoc`,
    chạy qua `AiAgentExecutor` THẬT, rồi qua runner THẬT, rồi vào sổ THẬT.
  */
  const nhaCungCapGia: AiProvider = {
    name: "gia",
    model: "gia-1",
    schemaDialect: "anthropic",
    async complete() {
      return {
        content: [{ type: "tool_use" as const, id: "t1", name: "khong_lam_duoc", input: { ly_do: "Đề bài đòi đo production; máy này có CSDL rỗng.", can_gi: "Một tệp số đo có sẵn trong kho." } }],
        stopReason: "tool_use" as const,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: "gia-1",
        latencyMs: 1,
      };
    },
  };
  const idThat = await taoViec("p2a-runner: executor thật khai không làm được");
  const rThat = await runAgentOnTask({ taskId: idThat, agentKey: "documentation", executor: new AiAgentExecutor(nhaCungCapGia), repoRoot: repo, baseCommit: base, actor: may, gates: ["typecheck"] });
  assert.equal(rThat.status, "BLOCKED", "lời gọi công cụ của model phải đi hết đường tới trạng thái BLOCKED");
  assert.ok(rThat.reason?.includes("CSDL rỗng"), "LÝ DO của model phải tới được người đọc, không bị thay bằng một câu chung");
  assert.ok(rThat.reason?.includes("tệp số đo"), "và CẦN GÌ cũng vậy");
  const runThat = await db.query.techAgentRuns.findFirst({ where: eq(schema.techAgentRuns.id, rThat.runId!) });
  assert.equal(runThat?.status, "BLOCKED");

  /* Và công cụ phải THẬT SỰ được chào ra cho model — không khai thì model không gọi được. */
  const congCu = AGENT_TOOLS.find((t) => t.name === "khong_lam_duoc");
  assert.ok(congCu, "AGENT_TOOLS phải có lối ra khong_lam_duoc");
  const batBuoc = (congCu!.inputSchema as { required?: string[] }).required ?? [];
  for (const truong of ["ly_do", "can_gi"]) {
    assert.ok(batBuoc.includes(truong), `${truong} phải BẮT BUỘC — một lời từ chối không kèm lý do và lối ra thì người đọc không làm gì được với nó`);
  }

  // ───────── 4.7 AGENT KHÔNG GHI ĐƯỢC NGOÀI PHẠM VI ─────────
  const idNgoai = await taoViec("p2a-runner: thử ghi ngoài phạm vi");
  const ghiBay = new ScriptedExecutor(async (job) => {
    const a = job.workspace.writeFile("lib/queries/tech.ts", "// chiếm quyền");
    const b = job.workspace.writeFile("../../../etc/passwd", "x");
    const c = job.workspace.writeFile(".env", "STOLEN=1");
    const d = job.workspace.readFile(".env");
    assert.ok(!a.ok && !b.ok && !c.ok && !d.ok, "cả bốn đường phải bị chặn");
    return { summary: "Đã thử và bị chặn.", steps: [], finished: true, khongLamDuoc: null, error: null, chiPhi: KHONG_TON };
  });
  const rNgoai = await runAgentOnTask({ taskId: idNgoai, agentKey: "documentation", executor: ghiBay, repoRoot: repo, baseCommit: base, actor: may, gates: [] });
  assert.equal(rNgoai.resultCommit, null, "không ghi được gì thì không có commit");
  assert.deepEqual(rNgoai.filesChanged, [], "không tệp nào bị đổi");
  assert.ok(existsSync(path.join(repo, ".env")), ".env của kho gốc phải còn nguyên");
  assert.equal(readFileSync(path.join(repo, ".env"), "utf8"), "SECRET=khong-duoc-doc\n", ".env KHÔNG được sửa");

  // ───────── 4.8 KHÔNG HAI LƯỢT SONG SONG TRÊN CÙNG MỘT VIỆC ─────────
  const idSong = await taoViec("p2a-runner: chống chạy song song");
  const mo = await startTechAgentRun({ agentId: doc.id, taskId: idSong, branch: "ai/documentation/treo" }, may);
  assert.ok("ok" in mo);
  const rSong = await runAgentOnTask({ taskId: idSong, agentKey: "documentation", executor: ghiDoc, repoRoot: repo, baseCommit: base, actor: may });
  assert.equal(rSong.status, "BLOCKED");
  assert.ok(rSong.reason?.includes("đang mở"), "phải chặn vì đã có lượt chạy mở — hai lượt sẽ ghi đè bằng chứng của nhau");

  // ───────── 4.9 NÂNG RỦI RO GIỮA CHỪNG ⇒ DỪNG TRƯỚC KHI COMMIT ─────────
  const idNang = await taoViec("p2a-runner: bị nâng rủi ro giữa chừng");
  const nangGiuaChung = new ScriptedExecutor(async (job) => {
    job.workspace.writeFile("docs/p2a-nang.md", "# nội dung\n");
    // Người đè mức rủi ro NGAY TRONG LÚC agent đang làm — đúng kịch bản đặc tả đòi.
    await overrideTechTaskRisk({ taskId: idNang, risk: "R2", reason: "Chủ shop phát hiện tài liệu này mô tả cách tính lương" }, nguoi);
    return { summary: "Đã ghi xong.", steps: [], finished: true, khongLamDuoc: null, error: null, chiPhi: KHONG_TON };
  });
  const rNang = await runAgentOnTask({ taskId: idNang, agentKey: "documentation", executor: nangGiuaChung, repoRoot: repo, baseCommit: base, actor: may, gates: [] });
  assert.equal(rNang.status, "BLOCKED", "việc bị nâng lên R2 giữa chừng thì phải dừng");
  assert.ok(rNang.reason?.includes("NÂNG"), "và nói rõ vì sao");
  assert.equal(rNang.resultCommit, null, "KHÔNG đưa gì vào kho");
  const runNang = await db.query.techAgentRuns.findFirst({ where: eq(schema.techAgentRuns.id, rNang.runId!) });
  assert.equal(runNang?.status, "CANCELLED", "lượt chạy phải được đóng lại đàng hoàng, không bỏ treo");

  // ───────── 4.10 AI actor KHÔNG mang khoá tài khoản người ─────────
  const suKien = await db.query.techTaskEvents.findMany({ where: eq(schema.techTaskEvents.taskId, idOk) });
  const cuaMay = suKien.filter((e) => e.actorKind === "AI_AGENT");
  assert.ok(cuaMay.length > 0, "lượt chạy của agent phải để lại dấu trong nhật ký việc");
  for (const e of cuaMay) assert.equal(e.actorId, null, "AGENTS.md mục 34: actor AI KHÔNG BAO GIỜ mang users.id");
  const cuaNguoi = suKien.filter((e) => e.actorKind === "HUMAN");
  for (const e of cuaNguoi) assert.equal(e.actorAgentId, null, "và ngược lại: người không mang khoá agent");

  // Dọn
  rmSync(repo, { recursive: true, force: true });
  rmSync(repoDo, { recursive: true, force: true });
  await db.delete(schema.techAgentRuns);
  await db.delete(schema.techTasks);
  await db.delete(schema.techAgents);

  console.log("✓ Runner agent: agent tắt/chưa cấu hình/sai mức rủi ro đều BLOCKED · cây + nhánh riêng từ base đã vào kho · cổng đo bằng exit code thật · cổng đỏ thì không commit · ghi ngoài phạm vi bị chặn · không chạy song song · nâng rủi ro giữa chừng thì dừng trước commit · actor AI không mang khoá người");
}

/* ═════════════════ 6 · CHÍN HÀNG RÀO (mục J của đặc tả Phase 2A) ═════════════════ */

/**
 * ═══════════ MỘT DANH SÁCH, CHÍN CÂU TRẢ LỜI ═══════════
 *
 * Bốn khối trên đã kiểm từng cơ chế một. Khối này kiểm ĐÚNG CHÍN ĐIỀU chủ shop đòi phải còn
 * chặn được sau khi Phòng Tech AI có agent thật, và cố ý viết lại thành một danh sách đọc thẳng
 * — không phải vì thiếu phép kiểm, mà vì một hàng rào chỉ có giá trị khi có người đọc được nó
 * mà không phải lần theo bốn tệp.
 *
 * KIỂM TRÊN BẢN SAO, KHÔNG TẤN CÔNG PRODUCTION: kho git tạm + CSDL kiểm thử. Đúng yêu cầu
 * "chứng minh bằng test/fixture, không phải bằng cách thử phá máy chủ thật".
 */
export async function testPhase2aBarriers() {
  const db = await getDb();
  const nguoi: TechActor = { kind: "HUMAN", id: null, name: "p2a-chu-shop" };
  const may: TechActor = { kind: "AI_AGENT", id: null, name: "agent:documentation" };

  await seedTechAgents(nguoi);
  const doc = (await db.query.techAgents.findMany()).find((a) => a.key === "documentation");
  assert.ok(doc, "phải có agent tài liệu");

  const repo = repoTam();
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const ghiDoc = new ScriptedExecutor(async (job) => {
    job.workspace.writeFile("docs/p2a-rao-can.md", "# Thử\n");
    return { summary: "Đã ghi.", steps: [], finished: true, khongLamDuoc: null, error: null, chiPhi: KHONG_TON };
  });
  const taoViec = async (title: string, taskType: Parameters<typeof createTechTask>[0]["taskType"], module: Parameters<typeof createTechTask>[0]["module"]) => {
    const r = await createTechTask({ title, description: "p2a-rao-can", taskType, module, priority: "P3", source: "OWNER" }, nguoi);
    assert.ok("ok" in r, "tạo được việc");
    return r as { ok: true; id: string; code: string; risk: string };
  };

  // ───────── RÀO 3 · AGENT ĐANG TẮT ⇒ BLOCKED (kiểm TRƯỚC khi bật) ─────────
  const vTat = await taoViec("p2a-rao-can: agent tắt", "DOCS", "TECH");
  const rTat = await runAgentOnTask({ taskId: vTat.id, agentKey: "documentation", executor: ghiDoc, repoRoot: repo, baseCommit: base, actor: may });
  assert.equal(rTat.status, "BLOCKED", "RÀO 3: agent đang tắt thì không chạy");
  assert.equal(rTat.runId, null, "RÀO 3: chặn trước khi mở lượt chạy, không để lại rác");

  await setTechAgentEnabled({ agentId: doc.id, enabled: true }, nguoi);

  // ───────── RÀO 1 · VIỆC R1 ⇒ BLOCKED ─────────
  const vR1 = await taoViec("p2a-rao-can: sửa hạ tầng deploy", "INFRA", "PLATFORM");
  assert.equal(vR1.risk, "R1", "việc hạ tầng phải được MÁY xếp R1 (nếu luật đổi, bài kiểm này phải đổi theo có chủ ý)");
  const rR1 = await runAgentOnTask({ taskId: vR1.id, agentKey: "documentation", executor: ghiDoc, repoRoot: repo, baseCommit: base, actor: may });
  assert.equal(rR1.status, "BLOCKED", "RÀO 1: agent tài liệu chỉ được R0");
  assert.ok(rR1.reason?.includes("R1"), "RÀO 1: lời từ chối phải nói ra mức rủi ro thật của việc");
  assert.equal(rR1.resultCommit, null, "RÀO 1: không commit gì");

  // ───────── RÀO 2 · VIỆC R2 ⇒ BLOCKED ─────────
  const vR2 = await taoViec("p2a-rao-can: đổi cách tính lương", "FEATURE", "PAYROLL");
  assert.equal(vR2.risk, "R2", "việc chạm lương phải được MÁY xếp R2");
  const rR2 = await runAgentOnTask({ taskId: vR2.id, agentKey: "documentation", executor: ghiDoc, repoRoot: repo, baseCommit: base, actor: may });
  assert.equal(rR2.status, "BLOCKED", "RÀO 2: R2 không bao giờ mở cho agent ở Phase 2A");
  assert.ok(rR2.reason?.includes("R2"), "RÀO 2: nói rõ vì sao");

  // ───────── RÀO 7 · CHƯA CÓ KHOÁ AI ⇒ BLOCKED nói đúng "CHƯA CẤU HÌNH", không giả success ─────────
  const vChua = await taoViec("p2a-rao-can: chưa có khoá AI", "DOCS", "TECH");
  const rChua = await runAgentOnTask({
    taskId: vChua.id,
    agentKey: "documentation",
    executor: new ScriptedExecutor(async () => {
      assert.fail("RÀO 7: executor CHƯA sẵn sàng thì không được chạy một vòng nào");
    }, false),
    repoRoot: repo,
    baseCommit: base,
    actor: may,
  });
  assert.equal(rChua.status, "BLOCKED", "RÀO 7: thiếu khoá API là BLOCKED");
  assert.ok(rChua.reason?.includes("CHƯA CẤU HÌNH"), "RÀO 7: phải nói thẳng là thiếu cấu hình — 'xong' và 'không chạy được' là hai câu trả lời khác nhau");

  // ───────── RÀO 5 · LỆNH CẤM ⇒ TỪ CHỐI, kèm lý do ─────────
  const vLenh = await taoViec("p2a-rao-can: thử lệnh cấm", "DOCS", "TECH");
  const daThu: string[] = [];
  const thuLenhCam = new ScriptedExecutor(async (job) => {
    for (const argv of [["git", "push", "origin", "main"], ["git", "merge", "main"], ["ssh", "root@vps"], ["psql", "$DATABASE_URL"], ["printenv"], ["curl", "https://evil.example"], ["npm", "install", "x"]]) {
      const r = await job.workspace.run(argv);
      assert.ok("blocked" in r, `RÀO 5: \`${argv.join(" ")}\` phải bị HÀNG RÀO chặn, không phải chạy rồi mới hỏng`);
      assert.ok("blocked" in r && r.reason.length > 10, `RÀO 5: từ chối \`${argv[0]}\` phải nói được vì sao`);
      daThu.push(argv[0]);
    }
    return { summary: "Đã thử và bị chặn hết.", steps: [], finished: true, khongLamDuoc: null, error: null, chiPhi: KHONG_TON };
  });
  const rLenh = await runAgentOnTask({ taskId: vLenh.id, agentKey: "documentation", executor: thuLenhCam, repoRoot: repo, baseCommit: base, actor: may, gates: [] });
  assert.equal(daThu.length, 7, "RÀO 5: cả bảy lệnh đều phải đi qua hàng rào");
  assert.equal(rLenh.resultCommit, null, "RÀO 5: không ghi được gì thì không có commit");

  // ───────── RÀO 6 · GHI NGOÀI PHẠM VI ⇒ THẤT BẠI, và kho gốc còn nguyên ─────────
  const vGhi = await taoViec("p2a-rao-can: ghi ngoài phạm vi", "DOCS", "TECH");
  const thuGhiNgoai = new ScriptedExecutor(async (job) => {
    for (const p of ["lib/tech/service.ts", "AGENTS.md", ".env", "../../../etc/passwd", ".github/workflows/deploy-vps.yml"]) {
      assert.ok(!job.workspace.writeFile(p, "x").ok, `RÀO 6: KHÔNG ghi được \`${p}\``);
    }
    assert.ok(!job.workspace.readFile(".env").ok, "RÀO 6: KHÔNG đọc được .env");
    return { summary: "Đã thử và bị chặn hết.", steps: [], finished: true, khongLamDuoc: null, error: null, chiPhi: KHONG_TON };
  });
  const rGhi = await runAgentOnTask({ taskId: vGhi.id, agentKey: "documentation", executor: thuGhiNgoai, repoRoot: repo, baseCommit: base, actor: may, gates: [] });
  assert.deepEqual(rGhi.filesChanged, [], "RÀO 6: không tệp nào đổi");
  assert.equal(readFileSync(path.join(repo, ".env"), "utf8"), "SECRET=khong-duoc-doc\n", "RÀO 6: .env của kho gốc nguyên vẹn");

  // ───────── RÀO 4 · NÂNG R0 → R2 GIỮA CHỪNG ⇒ DỪNG TRƯỚC KHI COMMIT ─────────
  const vNang = await taoViec("p2a-rao-can: bị nâng rủi ro giữa chừng", "DOCS", "TECH");
  assert.equal(vNang.risk, "R0", "bắt đầu ở R0 — nếu không thì bài kiểm này không kiểm cái nó nói");
  const nangGiuaChung = new ScriptedExecutor(async (job) => {
    job.workspace.writeFile("docs/p2a-rao-can.md", "# đã viết xong\n");
    await overrideTechTaskRisk({ taskId: vNang.id, risk: "R2", reason: "Chủ shop phát hiện việc này chạm tới cách tính lương" }, nguoi);
    return { summary: "Xong.", steps: [], finished: true, khongLamDuoc: null, error: null, chiPhi: KHONG_TON };
  });
  const rNang = await runAgentOnTask({ taskId: vNang.id, agentKey: "documentation", executor: nangGiuaChung, repoRoot: repo, baseCommit: base, actor: may, gates: [] });
  assert.equal(rNang.status, "BLOCKED", "RÀO 4: quyền được xét LẠI lúc sắp commit, không chỉ lúc bắt đầu");
  assert.equal(rNang.resultCommit, null, "RÀO 4: KHÔNG đưa gì vào kho");
  const runNang = await db.query.techAgentRuns.findFirst({ where: eq(schema.techAgentRuns.id, rNang.runId ?? "") });
  assert.equal(runNang?.status, "CANCELLED", "RÀO 4: lượt chạy phải được ĐÓNG LẠI đàng hoàng, không bỏ treo — một dòng RUNNING vĩnh viễn chặn mọi lượt sau trên cùng việc");

  // ───────── RÀO 8 · AGENT KHÔNG TỰ PHÊ DUYỆT ─────────
  const vDuyet = await taoViec("p2a-rao-can: thử tự duyệt", "FEATURE", "PAYROLL");
  const rDuyet = await decideTechApproval({ taskId: vDuyet.id, decision: "APPROVED", note: "agent tự ký" }, may);
  assert.ok("error" in rDuyet, "RÀO 8: agent KHÔNG phê duyệt được");
  assert.ok(rDuyet.error.includes("người"), "RÀO 8: và nói rõ cổng này cần một con người");
  const rDe = await overrideTechTaskRisk({ taskId: vDuyet.id, risk: "R0", reason: "agent tự hạ mức rủi ro của chính mình" }, may);
  assert.ok("error" in rDe, "RÀO 8: agent cũng KHÔNG tự hạ được mức rủi ro — đó là cùng một cổng, đi vòng cửa sau");
  const rBat = await setTechAgentEnabled({ agentId: doc.id, enabled: true }, may);
  assert.ok("error" in rBat, "RÀO 8: agent KHÔNG tự bật được agent nào, kể cả chính nó");

  /*
    ───────── RÀO 9 · AGENT KHÔNG TỰ MERGE / DEPLOY ─────────

    Ba đường, và đường thứ ba là đường dễ quên nhất: ERP không kích hoạt được deploy (client
    GitHub chỉ `GET`), nhưng sổ `tech_deployments` là sổ QUAN SÁT — một dòng agent gõ vào trông y
    hệt một dòng lượt đồng bộ nạp về, nên một lượt deploy CHƯA TỪNG XẢY RA vẫn đọc ra như đã xảy
    ra, và phép đối chiếu commit đứng trên một quan sát bịa.
  */
  const vDeploy = await taoViec("p2a-rao-can: thử tự đưa lên production", "DOCS", "TECH");
  for (const b of ["TRIAGED", "BUILDING", "REVIEW", "QA"] as const) {
    const r = await setTechTaskStatus({ taskId: vDeploy.id, to: b, note: "đi qua các khâu bình thường" }, nguoi);
    assert.ok("ok" in r, `chuẩn bị: người đưa việc tới ${b}`);
  }
  const rSan = await setTechTaskStatus({ taskId: vDeploy.id, to: "READY_TO_DEPLOY", note: "agent tự dán nhãn sẵn sàng" }, may);
  assert.ok("error" in rSan, "RÀO 9: agent KHÔNG tự dán được nhãn 'sẵn sàng deploy' — đó là AI tự chấm mình ở đúng chỗ tốn kém nhất");
  // Người đưa việc tới READY_TO_DEPLOY, rồi agent thử bước cuối cùng: tự bấm deploy.
  const nguoiSan = await setTechTaskStatus({ taskId: vDeploy.id, to: "READY_TO_DEPLOY", note: "chủ shop duyệt và dán nhãn" }, nguoi);
  assert.ok("ok" in nguoiSan, "người vẫn dán được nhãn — cổng chặn AGENT, không chặn việc");
  const rDang = await setTechTaskStatus({ taskId: vDeploy.id, to: "DEPLOYING", note: "agent tự bấm deploy" }, may);
  assert.ok("error" in rDang, "RÀO 9: agent KHÔNG tự chuyển việc sang ĐANG DEPLOY — hai bước, hai lá chắn, vì một việc đã duyệt vẫn có thể bị xếp lại thành R2");

  const rGhiDeploy = await recordTechDeployment({ commitSha: "deadbeef1234", branch: "main", status: "SUCCEEDED", taskId: vDeploy.id, notes: "agent tự ghi" }, may);
  assert.ok("error" in rGhiDeploy, "RÀO 9: agent KHÔNG ghi được một lượt deploy vào sổ quan sát");
  // Người vẫn làm được — cổng chặn AGENT, không phải chặn việc.
  const cuaNguoi = await recordTechDeployment({ commitSha: "cafebabe5678", branch: "main", status: "SUCCEEDED", taskId: vDeploy.id, notes: "chủ shop ghi tay" }, nguoi);
  assert.ok("ok" in cuaNguoi, "người vẫn ghi được sổ quan sát — nếu không thì đây là lỗi, không phải hàng rào");
  const suaCuaMay = await updateTechDeployment({ deploymentId: cuaNguoi.id, status: "SUCCEEDED", healthResult: "PASSED" }, may);
  assert.ok("error" in suaCuaMay, "RÀO 9: agent cũng KHÔNG sửa được dòng người đã ghi");
  // Và agent KHÔNG có lệnh merge/push trong tay ngay từ tầng hàng rào lệnh.
  for (const argv of [["git", "push", "origin", "main"], ["git", "merge", "main"], ["git", "commit", "-m", "x"]]) {
    assert.ok(!checkCommand(argv).allowed, `RÀO 9: \`${argv.join(" ")}\` không nằm trong tay agent`);
  }

  /*
    ───────── RÀO 7b · "AGENT HỎNG" VÀ "KHOÁ HỎNG" LÀ HAI CÂU KHÁC NHAU ─────────

    Đây là lời nói dối tốn kém nhất mà Phase 2A có thể kể: đổ cho agent một thứ agent chưa từng
    chạy. Một lượt 429 là hết hạn mức của khoá, không phải agent viết sai tài liệu — và hai thứ đó
    sửa ở hai nơi khác hẳn. Đọc MÃ TRẠNG THÁI trước, câu chữ sau: câu chữ đổi theo phiên bản SDK.
  */
  const caLoi: [unknown, string][] = [
    [Object.assign(new Error("Incorrect API key provided"), { status: 401 }), "AUTH_FAILED"],
    [Object.assign(new Error("permission denied"), { status: 403 }), "AUTH_FAILED"],
    [Object.assign(new Error("Rate limit reached"), { status: 429 }), "QUOTA_OR_RATE_LIMIT"],
    [Object.assign(new Error("overloaded"), { status: 529 }), "PROVIDER_ERROR"],
    [Object.assign(new Error("bad gateway"), { status: 502 }), "PROVIDER_ERROR"],
    // KHÔNG có mã trạng thái (lỗi mạng, hoặc SDK gói lại) ⇒ mới dò câu chữ.
    [new Error("401 Unauthorized"), "AUTH_FAILED"],
    [new Error("Your credit balance is too low"), "QUOTA_OR_RATE_LIMIT"],
    [new Error("ECONNRESET"), "PROVIDER_ERROR"],
  ];
  for (const [loi, mong] of caLoi) {
    const v = classifyProviderError(loi);
    assert.equal(v.verdict, mong, `RÀO 7b: "${loi instanceof Error ? loi.message : String(loi)}" phải xếp là ${mong}, không phải ${v.verdict}`);
    assert.ok(v.detail.length > 0 && v.detail.length <= 200, "RÀO 7b: lời giải thích phải có và phải CẮT NGẮN — thân lỗi của một số nhà cung cấp vọng lại header, và header mang khoá");
  }

  rmSync(repo, { recursive: true, force: true });
  await db.delete(schema.techDeployments);
  await db.delete(schema.techAgentRuns);
  await db.delete(schema.techTasks);
  await db.delete(schema.techAgents);

  console.log("✓ Chín hàng rào Phase 2A: R1 chặn · R2 chặn · agent tắt chặn · nâng rủi ro giữa chừng thì dừng trước commit · 7 lệnh cấm bị từ chối kèm lý do · 5 đường ghi ngoài phạm vi bị chặn và .env nguyên vẹn · thiếu khoá API nói CHƯA CẤU HÌNH chứ không giả xong · agent không duyệt/không hạ rủi ro/không tự bật · agent không dán nhãn sẵn sàng deploy, không tự chuyển sang ĐANG DEPLOY, không ghi và không sửa sổ deploy (người vẫn làm được cả ba) · 8 ca lỗi nhà cung cấp xếp đúng AUTH_FAILED / QUOTA_OR_RATE_LIMIT / PROVIDER_ERROR (không đổ cho agent)");
}

/* ═════════════════ 5 · QUÉT MÃ NGUỒN ═════════════════ */

export function testPhase2aSourceGuards() {
  const doc = (p: string) => readFileSync(path.join(goc, p), "utf8");

  // ───────── 5.1 Tệp "use client" KHÔNG được import tích hợp GitHub (token ở đó) ─────────
  const quet = (dir: string, acc: string[] = []): string[] => {
    const full = path.join(goc, dir);
    if (!existsSync(full)) return acc;
    for (const e of readdirSync(full)) {
      const con = path.join(dir, e);
      if (statSync(path.join(goc, con)).isDirectory()) quet(con, acc);
      else if (/\.(ts|tsx)$/.test(e)) acc.push(con);
    }
    return acc;
  };
  const tep = [...quet("app"), ...quet("components"), ...quet("lib"), ...quet("hooks")];
  const pham: string[] = [];
  for (const f of tep) {
    const src = doc(f);
    if (!/^\s*["']use client["']/m.test(src)) continue;
    if (/from\s+["']@\/lib\/integrations\/github/.test(src)) pham.push(f);
    if (/from\s+["']@\/lib\/agents\//.test(src)) pham.push(f);
  }
  assert.deepEqual(pham, [], `Tệp "use client" KHÔNG được import tích hợp GitHub hay runner agent — token và quyền chạy lệnh nằm ở đó:\n${pham.join("\n")}`);

  /*
    ───────── 5.2 Client GitHub chỉ ĐỌC ─────────

    Quét MÃ, không quét văn xuôi: chú thích trong tệp có nhắc `cancelled` như một giá trị GitHub
    trả về, và một bộ dò theo chuỗi thô sẽ bắt nhầm nó. Bỏ chú thích trước rồi mới dò — nếu không,
    lá chắn này sẽ dạy người ta viết chú thích né nó.
  */
  const ghRaw = doc("lib/integrations/github/client.ts");
  const gh = ghRaw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .join("\n");
  for (const m of ['method: "POST"', 'method: "PUT"', 'method: "PATCH"', 'method: "DELETE"', "/dispatches", "/cancel", "/rerun"]) {
    assert.ok(!gh.includes(m), `client GitHub phải CHỈ ĐỌC — tìm thấy \`${m}\` trong mã`);
  }
  assert.ok(gh.includes('method: "GET"'), "…và phải nói rõ là GET");

  // ───────── 5.3 Token KHÔNG bao giờ được in ra ─────────
  for (const f of ["lib/integrations/github/client.ts", "lib/integrations/github/deployments.ts"]) {
    const src = doc(f);
    assert.ok(!/console\.(log|error|warn)\([^)]*token/i.test(src), `${f}: không được log token`);
  }
  assert.ok(gh.includes("maskToken"), "phải có hàm che token để in ra được mà không dùng lại được");

  // ───────── 5.4 Runner là nơi DUY NHẤT commit — agent không có lệnh đó ─────────
  const sandbox = doc("lib/constants/agent-sandbox.ts");
  const dsLenh = sandbox.slice(sandbox.indexOf("DOCUMENTATION_COMMANDS"), sandbox.indexOf("FORBIDDEN_PATTERNS"));
  for (const cam of ["commit", "push", "merge"]) {
    assert.ok(!dsLenh.includes(`"${cam}"`), `agent KHÔNG được có lệnh \`git ${cam}\` trong danh sách cho phép`);
  }

  // ───────── 5.5 Phase 2A không có autonomous merge/deploy ở bất kỳ đâu trong đường agent ─────────
  for (const f of ["lib/agents/runner.ts", "lib/agents/executor.ts", "lib/agents/workspace.ts", "scripts/agent-run.ts"]) {
    const src = doc(f);
    assert.ok(!/["'`]push["'`]|git.{0,3}push/.test(src.replace(/\*[^*]*\*/g, "")) || src.includes("KHÔNG merge"), `${f}: không được có đường đẩy nhánh lên kho chung`);
  }

  /*
    ───────── 5.6 ĐƯỜNG CẤU HÌNH PHẢI TỚI ĐƯỢC MÁY CHỦ ─────────

    Một tích hợp chỉ-đọc hoàn chỉnh trong `lib/` mà không có đường đưa token xuống VPS là một
    tích hợp không bao giờ chạy: trang Deploy sẽ mãi mãi nói "chưa cấu hình", và không ai đọc
    dòng chữ đó như một lỗi cấu hình — họ đọc nó như "chưa có lượt deploy nào". Ba chỗ dưới đây
    là toàn bộ đường đi của một biến môi trường trong kho này, và thiếu một chỗ là đứt cả đường.
  */
  const deployYml = doc(".github/workflows/deploy-vps.yml");
  const opsYml = doc(".github/workflows/ops-vps.yml");
  const installSh = doc("scripts/install-vps.sh");
  for (const bien of ["ERP_GITHUB_TOKEN", "ERP_GITHUB_REPO", "ERP_GITHUB_DEPLOY_WORKFLOW"]) {
    assert.ok(deployYml.includes(`envs: ERP_BRANCH`) && deployYml.includes(`,${bien},`), `deploy-vps.yml phải truyền ${bien} xuống VPS (danh sách envs)`);
    assert.ok(new RegExp(`export .*\\b${bien}\\b`).test(deployYml), `deploy-vps.yml phải export ${bien} trong phiên SSH — biến không export thì bootstrap không thấy`);
    assert.ok(installSh.includes(bien), `install-vps.sh phải ghi ${bien} vào .env`);
    assert.ok(opsYml.includes(bien), `ops-vps.yml phải có ${bien} cho thao tác apply-tech-github-env`);
  }
  assert.ok(opsYml.includes("apply-tech-github-env"), "ops-vps.yml phải có thao tác apply-tech-github-env để đặt cấu hình mà KHÔNG phải deploy");

  /*
    ───────── 5.6b TÊN KHO DO WORKFLOW KHAI, KHÔNG DO NGƯỜI GÕ LẠI ─────────

    `github.repository` là thứ workflow deploy biết chắc chắn — nó ĐANG triển khai kho đó. Bắt chủ
    shop gõ lại "truyenhkm5group-stack/hkt" vào một ô cấu hình là thêm một chỗ để gõ sai, cho một
    thông tin máy đã cầm sẵn trong tay. Ô `vars.` giữ lại để đổi được khi cần, nhưng KHÔNG ai phải
    điền nó cho trường hợp bình thường.
  */
  assert.ok(/ERP_GITHUB_REPO: \$\{\{ vars\.ERP_GITHUB_REPO \|\| github\.repository \}\}/.test(deployYml), "deploy-vps.yml phải tự suy ERP_GITHUB_REPO từ github.repository");
  assert.ok(/ERP_GITHUB_DEPLOY_WORKFLOW: \$\{\{ vars\.ERP_GITHUB_DEPLOY_WORKFLOW \|\| 'deploy-vps\.yml' \}\}/.test(deployYml), "…và ERP_GITHUB_DEPLOY_WORKFLOW phải có mặc định, không bắt ai khai");

  /*
    ───────── 5.6c TOKEN LÀ TUỲ CHỌN, VÀ MÀN HÌNH PHẢI NÓI ĐÚNG THẾ ─────────

    Kho này PUBLIC. Một dòng chữ khiến chủ shop tưởng phải tạo PAT mới chạy được Phase 2A là một
    rào cản tự dựng — tốn của họ một buổi và không bảo vệ thứ gì, vì dữ liệu đó ai cũng đọc được.
  */
  const theGithub = doc("app/(dashboard)/integrations/page.tsx");
  const khoiThe = theGithub.slice(theGithub.indexOf('initials="GH"'), theGithub.indexOf('provider="github"'));
  assert.ok(/KHÔNG bắt buộc|không cần token|KHÔNG cần token/.test(khoiThe), "thẻ GitHub ở trang Kết nối dữ liệu phải nói rõ token KHÔNG bắt buộc với kho public");
  const khoiOpsMoTa = opsYml.slice(opsYml.indexOf("- apply-tech-github-env"), opsYml.indexOf("- apply-tech-github-env") + 200);
  assert.ok(/TUỲ CHỌN/.test(khoiOpsMoTa), "mô tả thao tác trong danh sách ops phải nói rõ đây là TUỲ CHỌN");

  /*
    ───────── 5.7 CHỈ GHI KHI CÓ GIÁ TRỊ ─────────

    Secret chưa đặt mà ghi đè rỗng thì sổ deploy im lặng ngừng cập nhật — cùng đúng cái bẫy mà
    khối SePay trong install-vps.sh đã phải học một lần. Nên đường ghi phải đi qua mệnh đề
    "có giá trị mới ghi", ở CẢ HAI nơi ghi .env.
  */
  assert.ok(/\[ -n "\$\{ERP_GITHUB_TOKEN:-\}" \] && upsert_env ERP_GITHUB_TOKEN/.test(installSh), "install-vps.sh: ERP_GITHUB_TOKEN chỉ được ghi khi Secret CÓ giá trị");
  const khoiOps = opsYml.slice(opsYml.indexOf("apply-tech-github-env)"), opsYml.indexOf("sepay-verify)"));
  assert.ok(/if \[ -z "\$\{ERP_GITHUB_TOKEN:-\}" \]/.test(khoiOps), "apply-tech-github-env: Secret trống thì DỪNG, không ghi đè rỗng");

  /*
    ───────── 5.8 THAO TÁC ĐẶT CẤU HÌNH KHÔNG ĐƯỢC DEPLOY, KHÔNG ĐƯỢC IN SECRET ─────────

    Chủ shop yêu cầu rõ: thao tác này chỉ ghi .env, khởi động lại dịch vụ cần thiết và thử kết
    nối. Kho mã này PUBLIC nên log Actions ai cũng đọc được — in `$ERP_GITHUB_TOKEN` một lần là
    công bố nó vĩnh viễn, không rút lại được kể cả khi xoá lần chạy.
  */
  assert.ok(!/echo[^\n]*\$\{?ERP_GITHUB_TOKEN\}?(?![:#])/.test(khoiOps.replace(/\$\{#ERP_GITHUB_TOKEN\}/g, "")), "apply-tech-github-env: KHÔNG được in giá trị token (chỉ được in độ dài)");
  assert.ok(khoiOps.includes("${#ERP_GITHUB_TOKEN}"), "…và phải in ĐỘ DÀI để người vận hành biết đã ghi được gì");
  for (const cam of ["bootstrap.sh", "install-vps.sh", "db:migrate", "--apply"]) {
    assert.ok(!khoiOps.includes(cam), `apply-tech-github-env: KHÔNG được chạy \`${cam}\` — nó đặt cấu hình, không deploy và không ghi dữ liệu`);
  }

  console.log('✓ Quét mã nguồn Phase 2A: không tệp "use client" nào chạm tích hợp GitHub / runner · client GitHub chỉ GET · không log token · agent không có lệnh commit/push/merge · đường cấu hình ERP_GITHUB_* thông từ Secret tới .env · tên kho tự suy từ github.repository · token khai rõ là TUỲ CHỌN ở cả UI lẫn ops · apply-tech-github-env không deploy và không in secret');
}
