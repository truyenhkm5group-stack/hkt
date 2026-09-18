import assert from "node:assert/strict";
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
import { __setGithubFetchForTests } from "@/lib/integrations/github/client";
import { syncGithubDeployments, verifyDeployments } from "@/lib/integrations/github/deployments";
import { adaptTechTasks } from "@/lib/queries/work-adapters";
import { createTechTask, overrideTechTaskRisk, seedTechAgents, setTechAgentEnabled, startTechAgentRun, type TechActor } from "@/lib/tech/service";

import { runAgentOnTask } from "@/lib/agents/runner";
import type { AgentExecutor, AgentJob, AgentOutcome } from "@/lib/agents/executor";

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

function fakeGithub(runs: unknown[]) {
  __setGithubFetchForTests((async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/runs?")) return new Response(JSON.stringify({ workflow_runs: runs }), { status: 200 });
    return new Response(JSON.stringify({ name: "Deploy", state: "active" }), { status: 200 });
  }) as typeof fetch);
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
    ───────── 2.8 Chưa cấu hình ⇒ BỎ QUA có lý do, KHÔNG phải lỗi ─────────

    Phải xoá CẢ BA biến: `token()` có chuỗi dự phòng `ERP_GITHUB_TOKEN → GITHUB_TOKEN → GH_TOKEN`
    (cố ý, để máy CI đã có sẵn token dùng được ngay). Chỉ xoá biến đầu thì trên một máy có
    `GITHUB_TOKEN` bài kiểm sẽ đi tiếp và gọi mạng thật — xanh ở chỗ này, đỏ ở máy khác.
  */
  const giuToken = { erp: process.env.ERP_GITHUB_TOKEN, gh: process.env.GITHUB_TOKEN, gh2: process.env.GH_TOKEN };
  delete process.env.ERP_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  const chuaBat = await syncGithubDeployments({ limit: 5 });
  assert.ok(chuaBat.skippedReason && chuaBat.skippedReason.includes("ERP_GITHUB_TOKEN"), "phải nói THIẾU ĐÚNG CÁI GÌ");
  assert.equal(chuaBat.scanned, 0);
  assert.equal(chuaBat.errors, 0, "chưa bật KHÔNG phải lỗi");

  // Trả lại môi trường đúng như lúc mượn — bài kiểm sau có thể cần token thật.
  if (giuToken.erp) process.env.ERP_GITHUB_TOKEN = giuToken.erp;
  if (giuToken.gh) process.env.GITHUB_TOKEN = giuToken.gh;
  if (giuToken.gh2) process.env.GH_TOKEN = giuToken.gh2;
  __setGithubFetchForTests(null);
  delete process.env.ERP_GITHUB_REPO;
  delete process.env.ERP_COMMIT;
  await db.delete(schema.techDeployments).where(eq(schema.techDeployments.provider, "GITHUB_ACTIONS"));
  console.log("✓ Đọc deploy từ GitHub: 6 ca ánh xạ · idempotent (chạy lại không nhân đôi) · chạy lại workflow là dòng riêng · bốn câu trả lời đối chiếu · chưa cấu hình thì BỎ QUA có lý do");
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
    return { summary: "Đã ghi docs/p2a-agent.md.", steps: [], finished: true, error: null };
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
  const rChua = await runAgentOnTask({ taskId: idChuaCauHinh, agentKey: "documentation", executor: new ScriptedExecutor(async () => ({ summary: "", steps: [], finished: true, error: null }), false), repoRoot: repo, baseCommit: base, actor: may });
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

  // ───────── 4.7 AGENT KHÔNG GHI ĐƯỢC NGOÀI PHẠM VI ─────────
  const idNgoai = await taoViec("p2a-runner: thử ghi ngoài phạm vi");
  const ghiBay = new ScriptedExecutor(async (job) => {
    const a = job.workspace.writeFile("lib/queries/tech.ts", "// chiếm quyền");
    const b = job.workspace.writeFile("../../../etc/passwd", "x");
    const c = job.workspace.writeFile(".env", "STOLEN=1");
    const d = job.workspace.readFile(".env");
    assert.ok(!a.ok && !b.ok && !c.ok && !d.ok, "cả bốn đường phải bị chặn");
    return { summary: "Đã thử và bị chặn.", steps: [], finished: true, error: null };
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
    return { summary: "Đã ghi xong.", steps: [], finished: true, error: null };
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

  console.log('✓ Quét mã nguồn Phase 2A: không tệp "use client" nào chạm tích hợp GitHub / runner · client GitHub chỉ GET · không log token · agent không có lệnh commit/push/merge');
}
