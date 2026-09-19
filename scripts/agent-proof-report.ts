/**
 * ═══════════ IN BẰNG CHỨNG CỦA MỘT LƯỢT CHẠY AGENT ═══════════
 *
 *     npm run agent:proof-report -- --task TECH-1
 *
 * Đọc dòng `tech_agent_runs` mới nhất của việc, đối chiếu với thứ GIT thật sự thấy, rồi kết luận
 * ĐẠT / KHÔNG ĐẠT. Ghi `bang-chung-agent.json` để đính kèm làm hiện vật.
 *
 * ─── HAI NGUỒN, KHÔNG PHẢI MỘT ───
 *
 * Sổ nói agent đổi những tệp nào; `git diff --name-only` nói kho thật sự đổi những tệp nào. Bài
 * này so HAI nguồn đó với nhau và với danh sách cho phép. Chỉ đọc sổ là tin lời kể của chính
 * đường ghi ra nó — nếu runner có lỗi ở khâu đo, sổ và git sẽ cùng sai một kiểu và không ai thấy.
 *
 * ─── KHÔNG SỬA HỘ ───
 *
 * Thấy tệp thứ hai thì in ra và trả mã thoát khác 0. Không xoá, không `git checkout` về, không
 * "dọn cho sạch rồi tính là đạt" — che một lượt hỏng đầu tiên là dạy cả hệ thống nói dối.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ensureMigrated } from "@/db/migrate";

/** Phạm vi ghi của vai tài liệu trong lượt kiểm chứng này. Đúng một tệp. */
const CHO_PHEP = ["docs/ai-tech-agent-runner-proof.md"];

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function git(...a: string[]): string {
  try {
    return execFileSync("git", a, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

async function main() {
  const taskRef = (arg("task") ?? "").trim();
  if (!taskRef) {
    console.error("Thiếu --task.");
    process.exit(1);
  }
  await ensureMigrated();
  const db = await getDb();
  const task = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.code, taskRef) });
  if (!task) {
    console.error(`Không tìm thấy việc ${taskRef}.`);
    process.exit(1);
  }
  const run = await db.query.techAgentRuns.findFirst({
    where: eq(schema.techAgentRuns.taskId, task.id),
    orderBy: [desc(schema.techAgentRuns.startedAt)],
  });
  if (!run) {
    console.error(`Việc ${taskRef} chưa có lượt chạy agent nào — runner chưa mở được sổ.`);
    process.exit(1);
  }
  const agent = run.agentId ? await db.query.techAgents.findFirst({ where: eq(schema.techAgents.id, run.agentId) }) : null;

  const tepTheoSo = (run.filesChanged as string[] | null) ?? [];
  // Git là trọng tài. Không có commit thì so với nhánh; không có nhánh thì không có gì để so.
  const tepTheoGit = run.resultCommit
    ? git("diff", "--name-only", `${run.baseCommit}..${run.resultCommit}`).split("\n").filter(Boolean)
    : run.branch
      ? git("diff", "--name-only", `${run.baseCommit}..${run.branch}`).split("\n").filter(Boolean)
      : [];

  const ngoaiPhamVi = tepTheoGit.filter((f) => !CHO_PHEP.includes(f));
  const lechSoVoiSo = JSON.stringify([...tepTheoGit].sort()) !== JSON.stringify([...tepTheoSo].sort());

  const bangChung = {
    task: { code: task.code, title: task.title, risk: task.risk, module: task.module, taskType: task.taskType },
    run: {
      id: run.id,
      agent: agent?.key ?? run.agentId,
      status: run.status,
      startedAt: run.startedAt?.toISOString() ?? null,
      endedAt: run.endedAt?.toISOString() ?? null,
      baseCommit: run.baseCommit,
      resultCommit: run.resultCommit || null,
      branch: run.branch,
      filesChanged: tepTheoSo,
      gates: { typecheck: run.typecheckResult, lint: run.lintResult, test: run.testResult, build: run.buildResult },
      commandsRun: run.testsRun,
      summary: run.summary,
      error: run.error || null,
      worktree: run.worktree,
    },
    git: { filesChanged: tepTheoGit, outOfScope: ngoaiPhamVi, showStat: run.resultCommit ? git("show", "--stat", "--oneline", run.resultCommit) : "" },
    allowlist: CHO_PHEP,
  };
  writeFileSync("bang-chung-agent.json", JSON.stringify(bangChung, null, 2));

  console.log("══════════ BẰNG CHỨNG LƯỢT CHẠY AGENT ══════════");
  console.log(`việc          ${task.code} · ${task.title}`);
  console.log(`rủi ro        ${task.risk} (máy xếp, không ai đè)`);
  console.log(`agent         ${agent?.key ?? run.agentId}`);
  console.log(`run ID        ${run.id}`);
  console.log(`trạng thái    ${run.status}`);
  console.log(`bắt đầu       ${run.startedAt?.toISOString() ?? "—"}`);
  console.log(`kết thúc      ${run.endedAt?.toISOString() ?? "—"}`);
  console.log(`base SHA      ${run.baseCommit}`);
  console.log(`nhánh         ${run.branch}`);
  console.log(`commit        ${run.resultCommit || "(không có)"}`);
  console.log(`tệp (sổ)      ${tepTheoSo.join(", ") || "(không)"}`);
  console.log(`tệp (git)     ${tepTheoGit.join(", ") || "(không)"}`);
  console.log(`cổng          typecheck=${run.typecheckResult} lint=${run.lintResult} test=${run.testResult} build=${run.buildResult}`);
  console.log(`lệnh đã chạy  ${run.testsRun || "(không)"}`);
  console.log(`tóm tắt       ${(run.summary || "").slice(0, 400)}`);
  if (run.error) console.log(`lỗi           ${run.error.slice(0, 400)}`);
  if (bangChung.git.showStat) console.log(`\n${bangChung.git.showStat}`);
  console.log("═══════════════════════════════════════════════");

  const hong: string[] = [];
  if (ngoaiPhamVi.length) hong.push(`agent đổi ${ngoaiPhamVi.length} tệp NGOÀI phạm vi: ${ngoaiPhamVi.join(", ")}`);
  if (lechSoVoiSo) hong.push(`sổ và git không khớp — sổ ghi [${tepTheoSo.join(", ")}], git thấy [${tepTheoGit.join(", ")}]`);
  if (run.status !== "SUCCEEDED") hong.push(`lượt chạy kết thúc ở ${run.status}, không phải SUCCEEDED`);
  if (!run.resultCommit) hong.push("không có commit kết quả");
  for (const [ten, ket] of [["typecheck", run.typecheckResult], ["lint", run.lintResult], ["test", run.testResult], ["build", run.buildResult]] as const) {
    if (ket === "FAILED") hong.push(`cổng ${ten} ĐỎ`);
  }

  if (hong.length) {
    console.log("\n✗ LƯỢT CHẠY KHÔNG ĐẠT:");
    for (const h of hong) console.log(`  · ${h}`);
    console.log("  KHÔNG sửa hộ agent rồi tính là đạt — ghi nhận đúng như nó đã xảy ra.");
    process.exit(1);
  }
  console.log("\n✓ ĐẠT: đúng một tệp trong phạm vi · bốn cổng xanh từ mã thoát thật · có commit thật.");
  console.log("  CHƯA merge, CHƯA deploy — chờ người xem.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Lỗi:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
