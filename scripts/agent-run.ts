/**
 * ═══════════ CHẠY MỘT AGENT TRÊN MỘT VIỆC TECH ═══════════
 *
 * Chạy: npm run agent:run -- --task TECH-12 [--agent documentation] [--gates typecheck,lint] [--keep]
 *
 * ─── VÌ SAO LÀ CLI CHỨ KHÔNG PHẢI MỘT NÚT TRONG ERP ───
 *
 * Runner cần `git`, `npm` và một cây làm việc thật. Container production chạy một bản Next.js ĐÃ
 * DỰNG — trong đó không có kho git, không có `node_modules` của dev, và không nên có. Nhét runner
 * vào đó là biến máy chủ bán hàng thành máy build.
 *
 * Nên: lượt chạy diễn ra trên máy có kho mã (máy chủ shop, hoặc máy của người vận hành), còn SỔ
 * (`tech_agent_runs`) nằm ở CSDL mà `DATABASE_URL` trỏ tới. Mặt phẳng điều khiển và nơi thi hành
 * tách nhau — đúng như Phase 1 đã dựng.
 *
 * KHÔNG merge, KHÔNG push, KHÔNG deploy. Script này chỉ tạo nhánh và commit; người xem rồi quyết.
 */
import { eq, or } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { getDb, schema } from "@/db";
import { AiAgentExecutor } from "@/lib/agents/executor";
import { runAgentOnTask } from "@/lib/agents/runner";
import { getAiProvider } from "@/lib/ai/provider";
import { aiDisabledReason } from "@/lib/ai/router";
import { systemActor } from "@/lib/constants/actor";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const taskRef = arg("task");
  if (!taskRef) {
    console.error("Thiếu --task. Ví dụ: npm run agent:run -- --task TECH-12");
    process.exit(1);
  }
  const agentKey = arg("agent") ?? "documentation";
  const gates = (arg("gates") ?? "typecheck,lint").split(",").map((g) => g.trim()).filter(Boolean) as ("typecheck" | "lint" | "test" | "build")[];
  const repoRoot = arg("repo") ?? process.cwd();

  /*
    BASE SHA PHẢI LÀ MỘT COMMIT ĐÃ VÀO KHO. Lấy `HEAD` của kho gốc chứ không phải cây làm việc
    đang bẩn: nếu không, lượt chạy mang theo việc dở của người khác và không ai đọc ngược được
    nó đã đứng trên nền nào (AGENTS.md mục 9).
  */
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();

  const db = await getDb();
  const task = await db.query.techTasks.findFirst({ where: or(eq(schema.techTasks.code, taskRef), eq(schema.techTasks.id, taskRef)) });
  if (!task) {
    console.error(`Không tìm thấy việc \`${taskRef}\`.`);
    process.exit(1);
  }

  const provider = getAiProvider("copilot");
  const executor = new AiAgentExecutor(provider, aiDisabledReason());

  console.log(`▶ ${task.code} · ${task.title}`);
  console.log(`  agent=${agentKey} · base=${baseCommit.slice(0, 12)} · cổng=${gates.join(",")}`);
  const san = executor.available();
  if (!san.ok) console.log(`  ⚠ executor chưa dùng được: ${san.reason}`);

  const res = await runAgentOnTask({
    taskId: task.id,
    agentKey,
    executor,
    repoRoot,
    baseCommit,
    // MÁY làm — `id: null` có nghĩa rõ ràng và khác hẳn "chưa biết ai" (AGENTS.md mục 34).
    actor: { kind: "AI_AGENT", name: `agent:${agentKey}`, ...systemActor(`agent:${agentKey}`) },
    gates,
    keepWorkspace: process.argv.includes("--keep"),
  });

  console.log(`\n${res.status === "SUCCEEDED" ? "✓" : res.status === "BLOCKED" ? "⛔" : "✗"} ${res.status}`);
  if (res.reason) console.log(`  lý do: ${res.reason}`);
  if (res.runId) console.log(`  lượt chạy: ${res.runId}`);
  if (res.branch) console.log(`  nhánh: ${res.branch}`);
  if (res.resultCommit) console.log(`  commit: ${res.resultCommit}`);
  if (res.filesChanged.length) console.log(`  tệp đổi: ${res.filesChanged.join(", ")}`);
  console.log(`  cổng: typecheck=${res.gates.typecheck} lint=${res.gates.lint} test=${res.gates.test} build=${res.gates.build}`);
  if (res.summary) console.log(`  tóm tắt: ${res.summary.slice(0, 500)}`);
  console.log("\nKHÔNG merge, KHÔNG push, KHÔNG deploy — người xem rồi quyết.");
  process.exit(res.status === "SUCCEEDED" ? 0 : 1);
}

main().catch((e) => {
  console.error("✗ Lượt chạy hỏng:", e instanceof Error ? e.message : e);
  process.exit(1);
});
