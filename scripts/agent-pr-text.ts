/**
 * ═══════════ IN TIÊU ĐỀ VÀ THÂN CHO PR DO AGENT TỰ MỞ ═══════════
 *
 *     npm run agent:pr-text -- --task TECH-12
 *
 * Đọc dòng `tech_agent_runs` mới nhất của việc rồi in ra `$GITHUB_OUTPUT` hai giá trị `title` và
 * `body`. Workflow đọc lại chúng và truyền sang cầu nối mở PR.
 *
 * ─── VÌ SAO LÀ MỘT SCRIPT, KHÔNG PHẢI VÀI DÒNG SHELL TRONG YAML ───
 *
 * Chữ của PR là chỗ dễ rò rỉ nhất trong cả nấc này (kho PUBLIC, mô tả PR ai cũng đọc). Luật quyết
 * viết gì nằm ở `lib/constants/agent-pr-text.ts` — hàm THUẦN, có bài kiểm thử đúng thứ nguy hiểm:
 * đưa tiêu đề việc vào rồi khẳng định nó không lọt ra. Ghép chuỗi trong YAML thì không bài kiểm
 * nào chạm tới được, và nó sẽ lặng lẽ khác đi sau vài lần sửa.
 *
 * Script này chỉ làm phần I/O: đọc sổ, gọi hàm thuần, ghi ra tệp output của Actions.
 */
import "dotenv/config";
import { appendFileSync } from "node:fs";
import { desc, eq, or } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { dungThanPr, dungTieuDePr } from "@/lib/constants/agent-pr-text";
import { ensureMigrated } from "@/db/migrate";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Ghi một giá trị NHIỀU DÒNG vào `$GITHUB_OUTPUT`.
 *
 * Định dạng `key=value` một dòng không mang nổi thân PR. Actions có cú pháp heredoc, và dấu phân
 * cách phải là chuỗi KHÔNG thể xuất hiện trong nội dung — nếu không, một thân PR chứa đúng dấu ấy
 * sẽ cắt đôi giá trị và phần sau trở thành cú pháp.
 */
function ghiOutput(key: string, value: string) {
  const out = process.env.GITHUB_OUTPUT;
  const moc = `__ERP_${key.toUpperCase()}_${Date.now().toString(36)}__`;
  if (value.includes(moc)) throw new Error("Dấu phân cách trùng với nội dung — không ghi output.");
  if (!out) {
    console.log(`${key}<<${moc}\n${value}\n${moc}`);
    return;
  }
  appendFileSync(out, `${key}<<${moc}\n${value}\n${moc}\n`, "utf8");
}

async function main() {
  const taskRef = arg("task");
  if (!taskRef) {
    console.error("Thiếu --task.");
    process.exit(1);
  }
  await ensureMigrated();
  const db = await getDb();
  const task = await db.query.techTasks.findFirst({ where: or(eq(schema.techTasks.code, taskRef), eq(schema.techTasks.id, taskRef)) });
  if (!task) {
    console.error(`Không tìm thấy việc ${taskRef}.`);
    process.exit(1);
  }
  const run = await db.query.techAgentRuns.findFirst({
    where: eq(schema.techAgentRuns.taskId, task.id),
    orderBy: [desc(schema.techAgentRuns.startedAt)],
  });
  if (!run) {
    console.error(`Việc ${taskRef} chưa có lượt chạy nào.`);
    process.exit(1);
  }

  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const facts = {
    // MÃ việc, KHÔNG phải `task.title` — xem docblock của `lib/constants/agent-pr-text.ts`.
    taskCode: task.code,
    agentKey: run.agentKey || "documentation",
    runNumber: process.env.GITHUB_RUN_NUMBER ?? "?",
    runUrl: repo && runId ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${runId}` : "",
    filesChanged: Array.isArray(run.filesChanged) ? (run.filesChanged as string[]) : [],
    gates: {
      typecheck: run.typecheckResult ?? "UNKNOWN",
      lint: run.lintResult ?? "UNKNOWN",
      test: run.testResult ?? "UNKNOWN",
      build: run.buildResult ?? "UNKNOWN",
    },
  };
  ghiOutput("title", dungTieuDePr(facts));
  ghiOutput("body", dungThanPr(facts));
  console.log(`Đã dựng chữ PR cho ${task.code} · ${facts.filesChanged.length} tệp.`);
}

/*
  THOÁT TƯỜNG MINH — nếu không, bước này TREO cho tới khi job hết giờ.

  ĐÃ CẮN THẬT, lượt chạy #18: mọi bước trước đều xanh (agent làm xong, bốn cổng PASSED, phạm vi tệp
  đạt, sổ đã chép, nhánh đã đẩy) rồi bước "Dựng tiêu đề và thân PR" đứng im. PGlite giữ một handle
  mở, nên `main()` chạy xong mà vòng lặp sự kiện của Node không bao giờ rỗng.

  Không có lỗi, không có log, không có gì đỏ — chỉ là một bước không bao giờ kết thúc, và job sẽ
  chết sau 60 phút. Mọi script agent khác đã thoát tường minh; đúng cái tôi vừa thêm thì quên.
*/
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("✗ Không dựng được chữ PR:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
