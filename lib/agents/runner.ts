import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { DOCUMENTATION_COMMANDS, DOCUMENTATION_READ_GLOBS, DOCUMENTATION_WRITE_GLOBS } from "@/lib/constants/agent-sandbox";
import type { TechGateResult, TechRisk } from "@/lib/constants/tech";
import { finishTechAgentRun, startTechAgentRun, type TechActor } from "@/lib/tech/service";
import { AgentWorkspace } from "@/lib/agents/workspace";
import type { AgentExecutor } from "@/lib/agents/executor";

/**
 * ═══════════ RUNNER — NƠI MỌI CỔNG ĐƯỢC THI HÀNH ═══════════
 *
 * Executor (model) quyết định NỘI DUNG. Runner quyết định ĐƯỢC PHÉP HAY KHÔNG, và runner tự đo
 * kết quả. Ranh giới đó là cả kiến trúc an toàn của Phase 2A:
 *
 *   · Agent KHÔNG tự chấm mình      — bốn cổng đo bằng EXIT CODE thật của tiến trình con.
 *   · Agent KHÔNG tự commit         — `git add`/`commit` không nằm trong danh sách lệnh của nó.
 *   · Agent KHÔNG tự mở lượt chạy   — runner kiểm quyền trước khi `startTechAgentRun`.
 *   · Agent KHÔNG tự phê duyệt      — `decideTechApproval` từ chối mọi actor không phải HUMAN.
 *
 * ─── KIỂM LẠI MỨC RỦI RO HAI LẦN ───
 *
 * Một lần TRƯỚC khi bắt đầu, một lần TRƯỚC khi commit. Lý do: mức rủi ro đổi được TRONG LÚC lượt
 * chạy đang diễn ra (người đè mức, xem `overrideTechTaskRisk`), và một việc vừa được nâng lên R2
 * thì thứ agent vừa viết KHÔNG được vào kho dưới danh nghĩa một lượt chạy hợp lệ.
 */

export type RunnerResult = {
  status: "SUCCEEDED" | "FAILED" | "BLOCKED";
  runId: string | null;
  branch: string | null;
  baseCommit: string | null;
  resultCommit: string | null;
  filesChanged: string[];
  gates: { typecheck: TechGateResult; lint: TechGateResult; test: TechGateResult; build: TechGateResult };
  summary: string;
  reason: string | null;
};

const KHONG_CHAY: TechGateResult = "UNKNOWN";

export type RunnerOptions = {
  taskId: string;
  agentKey: string;
  executor: AgentExecutor;
  repoRoot: string;
  baseCommit: string;
  actor: TechActor;
  /** Cổng phải chạy sau khi agent xong. Mặc định typecheck + lint (đủ cho một việc tài liệu). */
  gates?: ("typecheck" | "lint" | "test" | "build")[];
  /** Giữ cây làm việc lại để soi bằng tay. Mặc định dọn. */
  keepWorkspace?: boolean;
};

/**
 * Chạy một việc Tech bằng một agent.
 *
 * Trả về `BLOCKED` (kèm lý do) thay vì ném lỗi cho mọi trường hợp "không được phép" — vì đó là kết
 * quả HỢP LỆ của một cổng đang làm đúng việc, không phải một sự cố.
 */
export async function runAgentOnTask(opts: RunnerOptions): Promise<RunnerResult> {
  const db = await getDb();
  const rong: RunnerResult = {
    status: "BLOCKED",
    runId: null,
    branch: null,
    baseCommit: opts.baseCommit,
    resultCommit: null,
    filesChanged: [],
    gates: { typecheck: KHONG_CHAY, lint: KHONG_CHAY, test: KHONG_CHAY, build: KHONG_CHAY },
    summary: "",
    reason: null,
  };

  /* ───────── 1. Việc và agent phải có thật ───────── */
  const task = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, opts.taskId) });
  if (!task) return { ...rong, reason: "Không tìm thấy việc này." };
  const agent = await db.query.techAgents.findFirst({ where: eq(schema.techAgents.key, opts.agentKey) });
  if (!agent) return { ...rong, reason: `Không có agent \`${opts.agentKey}\` trong sổ. Khởi tạo sổ agent ở /tech/agents trước.` };

  /* ───────── 2. Agent phải đang BẬT ───────── */
  if (!agent.enabled) return { ...rong, reason: `Agent “${agent.name}” đang TẮT — chủ shop chưa bật nó.` };

  /* ───────── 3. Mức rủi ro của việc phải nằm trong quyền của agent ───────── */
  if (!agent.allowedRisks.includes(task.risk)) {
    return { ...rong, reason: `Việc ${task.code} ở mức ${task.risk}, agent “${agent.name}” chỉ được phép ${agent.allowedRisks.join(", ") || "(chưa khai mức nào)"}.` };
  }

  /* ───────── 4. Ba quyền chưa tồn tại máy thi hành ───────── */
  if (agent.canMerge || agent.canDeploy || agent.canRunProdWrite) {
    return { ...rong, reason: "Phase 2A không chạy agent mang quyền merge / deploy / ghi production — máy thi hành cho những việc đó chưa được xây." };
  }

  /* ───────── 5. Không hai lượt chạy song song trên cùng một việc ───────── */
  const dangChay = await db.query.techAgentRuns.findFirst({
    where: and(eq(schema.techAgentRuns.taskId, opts.taskId), eq(schema.techAgentRuns.status, "RUNNING")),
  });
  if (dangChay) {
    return { ...rong, reason: `Việc ${task.code} đã có một lượt chạy đang mở (${dangChay.id}). Đóng nó trước — hai lượt song song sẽ ghi đè bằng chứng của nhau.` };
  }

  /* ───────── 6. Executor phải dùng được — chưa có khoá thì BLOCKED, KHÔNG giả vờ xong ───────── */
  const san = opts.executor.available();
  if (!san.ok) return { ...rong, reason: `CHƯA CẤU HÌNH: ${san.reason}` };

  /* ───────── 7. Mở lượt chạy ───────── */
  const branch = `ai/${agent.key}/${task.code}-${Date.now().toString(36)}`;
  const mo = await startTechAgentRun({ agentId: agent.id, taskId: task.id, branch, baseCommit: opts.baseCommit }, opts.actor);
  if ("error" in mo) return { ...rong, reason: mo.error };
  const runId = mo.id;

  let ws: AgentWorkspace | null = null;
  try {
    /* ───────── 8. Cây làm việc riêng, dựng từ base SHA ĐÃ VÀO KHO ───────── */
    ws = await AgentWorkspace.create({
      repoRoot: opts.repoRoot,
      branch,
      baseCommit: opts.baseCommit,
      allowedCommands: DOCUMENTATION_COMMANDS,
      readGlobs: DOCUMENTATION_READ_GLOBS,
      writeGlobs: DOCUMENTATION_WRITE_GLOBS,
    });
    await db.update(schema.techAgentRuns).set({ worktree: ws.root, heartbeatAt: new Date() }).where(eq(schema.techAgentRuns.id, runId));

    /* ───────── 9. Agent làm việc ───────── */
    const outcome = await opts.executor.run({
      taskCode: task.code,
      taskTitle: task.title,
      taskDescription: task.description,
      writeGlobs: DOCUMENTATION_WRITE_GLOBS,
      workspace: ws,
    });
    await db.update(schema.techAgentRuns).set({ heartbeatAt: new Date() }).where(eq(schema.techAgentRuns.id, runId));

    /* ───────── 10. KIỂM LẠI MỨC RỦI RO — việc có thể đã bị nâng trong lúc chạy ───────── */
    const sauKhiChay = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, opts.taskId), columns: { risk: true, code: true, status: true } });
    const riskMoi = (sauKhiChay?.risk ?? task.risk) as TechRisk;
    if (riskMoi !== task.risk && !agent.allowedRisks.includes(riskMoi)) {
      const ly = `Việc ${task.code} bị NÂNG từ ${task.risk} lên ${riskMoi} trong lúc lượt chạy đang diễn ra — dừng trước bước commit, không đưa gì vào kho.`;
      await finishTechAgentRun({ runId, status: "CANCELLED", summary: ly, error: ly }, opts.actor);
      return { ...rong, status: "BLOCKED", runId, branch, reason: ly };
    }

    /* ───────── 11. BỐN CỔNG — đo bằng EXIT CODE, không hỏi agent ───────── */
    const canChay = opts.gates ?? ["typecheck", "lint"];
    const gates = { typecheck: KHONG_CHAY, lint: KHONG_CHAY, test: KHONG_CHAY, build: KHONG_CHAY } as RunnerResult["gates"];
    const lenh: Record<string, string[]> = { typecheck: ["npm", "run", "typecheck"], lint: ["npm", "run", "lint"], test: ["npm", "test"], build: ["npm", "run", "build"] };
    const daChay: string[] = [];
    for (const g of canChay) {
      const r = await ws.run(lenh[g]);
      if ("blocked" in r) {
        gates[g] = KHONG_CHAY;
        continue;
      }
      daChay.push(`${lenh[g].join(" ")} (exit=${r.exitCode})`);
      gates[g] = r.ok ? "PASSED" : "FAILED";
      await db.update(schema.techAgentRuns).set({ heartbeatAt: new Date() }).where(eq(schema.techAgentRuns.id, runId));
    }

    const filesChanged = await ws.changedFiles();
    const congDo = Object.values(gates).some((v) => v === "FAILED");

    /* ───────── 12. Commit — CHỈ khi agent xong, có tệp đổi, và không cổng nào đỏ ───────── */
    let resultCommit: string | null = null;
    let commitDetail = "";
    if (!outcome.finished) {
      commitDetail = "Agent chưa gọi finish — không commit.";
    } else if (!filesChanged.length) {
      commitDetail = "Không tệp nào đổi — không có gì để commit.";
    } else if (congDo) {
      commitDetail = "Có cổng ĐỎ — không commit. Bằng chứng giữ nguyên trong cây làm việc.";
    } else {
      const c = await ws.commit(
        `${task.code}: ${task.title}\n\n${outcome.summary.slice(0, 1000)}\n\nLượt chạy agent: ${runId}\nAgent: ${agent.key} (${agent.role})\nCổng đã chạy: ${daChay.join(" · ") || "(không có)"}`,
        { name: `ERP agent ${agent.key}`, email: "agent@erp.local" },
      );
      resultCommit = c.commit;
      commitDetail = c.detail;
    }

    const status: RunnerResult["status"] = congDo || !outcome.finished ? "FAILED" : "SUCCEEDED";
    const summary = [outcome.summary, commitDetail].filter(Boolean).join(" ").slice(0, 4000);

    await finishTechAgentRun(
      {
        runId,
        status: status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
        summary,
        resultCommit: resultCommit ?? "",
        testsRun: daChay.join(" · "),
        typecheckResult: gates.typecheck,
        lintResult: gates.lint,
        testResult: gates.test,
        buildResult: gates.build,
        filesChanged,
        error: outcome.error ?? (congDo ? "Có cổng kiểm thử ĐỎ." : ""),
      },
      opts.actor,
    );

    return { status, runId, branch, baseCommit: opts.baseCommit, resultCommit, filesChanged, gates, summary, reason: outcome.error };
  } catch (e) {
    const loi = e instanceof Error ? e.message : String(e);
    await finishTechAgentRun({ runId, status: "FAILED", summary: "Lượt chạy hỏng giữa chừng.", error: loi }, opts.actor).catch(() => undefined);
    return { ...rong, status: "FAILED", runId, branch, reason: loi };
  } finally {
    // Dọn cây, GIỮ nhánh và commit: xoá nhánh là xoá bằng chứng.
    if (ws && !opts.keepWorkspace) await ws.cleanup().catch(() => undefined);
  }
}

/**
 * LƯỢT CHẠY MỒ CÔI — tiến trình chết giữa chừng.
 *
 * Không có bước này thì một lượt chạy nằm mãi ở `RUNNING`: thẻ "agent đang chạy" nói dối vĩnh viễn,
 * và cổng "không hai lượt song song" chặn luôn mọi lượt sau trên cùng việc. Nhịp tim (`heartbeat_at`)
 * là thứ phân biệt "đang chạy thật" với "đã chết" — mốc đứng im quá lâu nghĩa là không ai còn cập
 * nhật nó.
 *
 * KHÔNG tự chạy theo lịch ở Phase 2A: gọi từ CLI khi cần. Một job tự đóng lượt chạy của người khác
 * là thứ phải có người quyết.
 */
export async function reapStaleRuns(staleMinutes = 45, actor: TechActor = { kind: "SYSTEM", name: "job:agent-reaper" }) {
  const db = await getDb();
  const nguong = new Date(Date.now() - staleMinutes * 60_000);
  const rows = await db.query.techAgentRuns.findMany({ where: eq(schema.techAgentRuns.status, "RUNNING") });
  const cu = rows.filter((r) => (r.heartbeatAt ?? r.startedAt) < nguong);
  for (const r of cu) {
    await finishTechAgentRun(
      {
        runId: r.id,
        status: "FAILED",
        summary: "Lượt chạy không đập nhịp nữa — tiến trình nhiều khả năng đã chết.",
        error: `Không có nhịp tim từ ${(r.heartbeatAt ?? r.startedAt).toISOString()}; ngưỡng ${staleMinutes} phút.`,
      },
      actor,
    );
  }
  return { checked: rows.length, reaped: cu.length, ids: cu.map((r) => r.id) };
}

/** Lượt chạy đang mở của một tập việc — dùng cho màn hình và cho chính cổng chống chạy song song. */
export async function activeRunsFor(taskIds: string[]) {
  if (!taskIds.length) return [];
  const db = await getDb();
  return db.query.techAgentRuns.findMany({
    where: and(inArray(schema.techAgentRuns.taskId, taskIds), eq(schema.techAgentRuns.status, "RUNNING")),
  });
}
