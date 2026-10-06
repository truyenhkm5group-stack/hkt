/**
 * ═══════════ WORKER HEADLESS CỦA MẶT PHẲNG ĐIỀU KHIỂN /tech ═══════════
 *
 *   npm run tech:worker            # chạy mãi: nhịp tim 30″, xin việc khi rảnh
 *   npm run tech:worker -- --once  # nhận đúng một việc, làm xong thì thoát (dogfood / kiểm tay)
 *   npm run tech:worker -- --check # chỉ kiểm cấu hình + adapter, không xin việc
 *
 * Biến môi trường (không bao giờ in giá trị):
 *   TECH_WORKER_URL     gốc ERP, ví dụ https://erp.vnxcommerce.com
 *   TECH_WORKER_TOKEN   khoá RIÊNG của worker (tw_<id>.<secret>) — tạo ở /tech/workers, hiện đúng một lần
 *   TECH_WORKER_REPO    một bản clone của kho (worktree được dựng TỪ đây, không bao giờ sửa trong nó)
 *   TECH_WORKER_ROOT    thư mục chứa cây làm việc (mặc định: thư mục cha của TECH_WORKER_REPO)
 *   TECH_WORKER_ANTHROPIC_API_KEY   chỉ cho worker ANTHROPIC_API
 *
 * Không có `DATABASE_URL`: worker chỉ nói chuyện với ERP qua `/api/tech/worker/*`. Không mở PR, không gộp,
 * không deploy (Pha 3 thêm yêu cầu mở PR qua máy chủ — bằng danh tính bot, để chủ shop duyệt được).
 * Không chạy được việc ⇒ báo `BLOCKED` / `NEEDS_OWNER` kèm lý do; không bao giờ chờ một lời nhắc tương tác.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TECH_OWNER_ESCALATIONS, type TechOwnerEscalation } from "@/lib/constants/tech";
import { TECH_LEASE, isTechExecutionProvider, taskWorktreeDirName, type TechExecutionProvider, type TechRunOutcome } from "@/lib/constants/tech-worker";
import { buildAgentPrompt, gatesForTask, parseAgentResult, toolAllowlist } from "./tech-worker/brief";
import { createAdapter, type ExecutionAdapter } from "./tech-worker/adapters";

const VERSION = "tech-worker/1";
const args = new Set(process.argv.slice(2));
const ONCE = args.has("--once");
const CHECK = args.has("--check");

const cfg = {
  url: (process.env.TECH_WORKER_URL ?? "").replace(/\/+$/, ""),
  token: process.env.TECH_WORKER_TOKEN ?? "",
  repo: process.env.TECH_WORKER_REPO ?? "",
  root: process.env.TECH_WORKER_ROOT ?? "",
  timeoutMin: Number(process.env.TECH_WORKER_TIMEOUT_MIN ?? 45),
};

type Claimed = {
  runId: string;
  taskId: string;
  code: string;
  title: string;
  description: string;
  taskType: string;
  module: string;
  risk: string;
  capability: string;
  attempt: number;
  maxAttempts: number;
  leaseGeneration: number;
  branch: string;
  /** Việc sửa CI: làm tiếp trên nhánh của PR đang mở thay vì mở nhánh mới. */
  existingBranch: boolean;
  mission: { code: string; title: string; definitionOfDone: string } | null;
};

type Active = { task: Claimed; abort: AbortController; logs: { level: "info" | "warn" | "error"; line: string }[]; progressPct: number; step: string };
const active = new Map<string, Active>();

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function api<T>(op: string, body: unknown = {}): Promise<{ status: number; data: T }> {
  const res = await fetch(`${cfg.url}/api/tech/worker/${op}`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}

function git(cwd: string, ...a: string[]): string {
  return execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Chạy một lệnh cổng (exit code THẬT — model không tự chấm mình). `npm` gọi qua `npm-cli.js` + `node`, giữ `shell:false`. */
function runGate(cwd: string, script: string, env: NodeJS.ProcessEnv): "PASSED" | "FAILED" {
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const r = existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, "run", script], { cwd, env, stdio: "ignore", shell: false, timeout: 40 * 60_000 })
    : spawnSync("npm", ["run", script], { cwd, env, stdio: "ignore", shell: false, timeout: 40 * 60_000 });
  return r.status === 0 ? "PASSED" : "FAILED";
}

function npmCi(cwd: string, env: NodeJS.ProcessEnv): boolean {
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const r = existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, "ci", "--no-audit", "--no-fund", "--prefer-offline"], { cwd, env, stdio: "ignore", shell: false, timeout: 20 * 60_000 })
    : spawnSync("npm", ["ci", "--no-audit", "--no-fund", "--prefer-offline"], { cwd, env, stdio: "ignore", shell: false, timeout: 20 * 60_000 });
  return r.status === 0;
}

async function complete(t: Claimed, body: Record<string, unknown>) {
  const r = await api<{ ok?: true; error?: string; taskStatus?: string }>("complete", { runId: t.runId, leaseGeneration: t.leaseGeneration, ...body });
  log(`${t.code}: complete → ${r.status} ${r.data.taskStatus ?? r.data.error ?? ""}`);
}

/** Một việc, từ đầu tới cuối. Mọi nhánh lỗi đều kết thúc bằng MỘT lời gọi `complete` (hoặc lease tự hết hạn). */
async function execute(adapter: ExecutionAdapter, provider: TechExecutionProvider, t: Claimed) {
  const a: Active = { task: t, abort: new AbortController(), logs: [], progressPct: 0, step: "dựng cây làm việc" };
  active.set(t.runId, a);
  const push = (level: "info" | "warn" | "error", line: string) => a.logs.push({ level, line });
  const root = cfg.root || path.dirname(path.resolve(cfg.repo));
  const dir = path.join(root, taskWorktreeDirName(t.code, t.attempt));
  let baseCommit = "";
  try {
    // 1. Cây riêng từ origin/main VỪA FETCH — không bao giờ từ main cục bộ hay một cây đang bẩn.
    git(cfg.repo, "fetch", "origin", "main", "--quiet");
    baseCommit = git(cfg.repo, "rev-parse", "origin/main");
    if (existsSync(dir)) {
      // Cùng việc + cùng lần thử mà thư mục còn đó ⇒ di sản của một lần sập TRƯỚC KHI báo kết quả. Gỡ cây (nhánh giữ nguyên).
      try {
        git(cfg.repo, "worktree", "remove", "--force", dir);
      } catch {
        rmSync(dir, { recursive: true, force: true });
        git(cfg.repo, "worktree", "prune");
      }
    }
    if (t.existingBranch) {
      // Sửa CI đỏ: lấy ĐÚNG đỉnh nhánh của PR trên remote; đẩy lên lại cùng nhánh (fast-forward) ⇒ PR tự cập nhật.
      git(cfg.repo, "fetch", "origin", t.branch, "--quiet");
      baseCommit = git(cfg.repo, "rev-parse", `origin/${t.branch}`);
      git(cfg.repo, "worktree", "add", "--no-track", "-B", t.branch, dir, `origin/${t.branch}`);
    } else {
      git(cfg.repo, "worktree", "add", "--no-track", "-b", t.branch, dir, "origin/main");
    }
    push("info", `Cây ${dir} · nhánh ${t.branch} · base ${baseCommit.slice(0, 12)}`);
    await api("start", { runId: t.runId, leaseGeneration: t.leaseGeneration, baseCommit, worktree: dir });

    // 2. Phụ thuộc — cổng cần node_modules.
    a.step = "cài phụ thuộc";
    a.progressPct = 10;
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ERP_READ_ONLY: "1", CI: "1" };
    delete childEnv.TECH_WORKER_TOKEN;
    delete childEnv.TECH_WORKER_ANTHROPIC_API_KEY;
    delete childEnv.DATABASE_URL;
    if (!npmCi(dir, childEnv)) {
      await complete(t, { outcome: "BLOCKED" satisfies TechRunOutcome, error: "npm ci thất bại trong cây làm việc của worker", branch: t.branch });
      return;
    }

    // 3. Agent làm.
    a.step = "agent đang làm";
    a.progressPct = 20;
    const res = await adapter.run({
      prompt: buildAgentPrompt(t),
      cwd: dir,
      timeoutMs: cfg.timeoutMin * 60_000,
      allowedTools: toolAllowlist(),
      maxTurns: 80,
      onLog: push,
      signal: a.abort.signal,
    });
    if (a.abort.signal.aborted) {
      push("warn", "Máy chủ yêu cầu DỪNG — không commit gì.");
      return; // máy chủ đã đổi trạng thái việc; lease hết hạn / đã bị thu.
    }
    const cost = { usd: res.costUsd, inputTokens: res.inputTokens, outputTokens: res.outputTokens, estimated: provider === "SUBSCRIPTION_CLAUDE_CODE" };
    if (res.timedOut) {
      await complete(t, { outcome: "FAILED", error: `Quá ${cfg.timeoutMin} phút`, model: res.model, cost, branch: t.branch });
      return;
    }

    // 4. Kết cục do agent KHAI (chỉ để đọc lý do NEEDS_OWNER / BLOCKED) — thành công vẫn phải qua cổng đo thật.
    const khai = parseAgentResult(existsSync(path.join(dir, ".tech-result.json")) ? readFileSync(path.join(dir, ".tech-result.json"), "utf8") : "");
    rmSync(path.join(dir, ".tech-result.json"), { force: true });
    if (khai.outcome === "NEEDS_OWNER" || khai.outcome === "BLOCKED") {
      const esc = TECH_OWNER_ESCALATIONS.includes(khai.ownerEscalation as TechOwnerEscalation) ? (khai.ownerEscalation as TechOwnerEscalation) : "UNKNOWN_HIGH_RISK_STATE";
      await complete(t, {
        outcome: khai.outcome,
        summary: khai.summary,
        error: khai.summary,
        model: res.model,
        cost,
        branch: t.branch,
        ...(khai.outcome === "NEEDS_OWNER" ? { ownerEscalation: esc, ownerAction: khai.ownerAction || khai.summary } : {}),
      });
      return;
    }

    const doi = git(dir, "status", "--porcelain");
    if (!doi) {
      await complete(t, { outcome: "FAILED", error: "Agent không thay đổi tệp nào.", summary: res.resultText.slice(0, 2000), model: res.model, cost, branch: t.branch });
      return;
    }

    // 5. Cổng — exit code thật.
    a.step = "chạy cổng";
    a.progressPct = 70;
    const gates: Record<string, "PASSED" | "FAILED" | "SKIPPED"> = {};
    for (const g of gatesForTask(t)) {
      gates[g] = runGate(dir, g === "test" ? "test" : g, childEnv);
      push(gates[g] === "PASSED" ? "info" : "error", `cổng ${g}: ${gates[g]}`);
      if (gates[g] === "FAILED") break;
    }
    if (Object.values(gates).includes("FAILED")) {
      await complete(t, { outcome: "FAILED", error: `Cổng đỏ: ${Object.entries(gates).filter(([, v]) => v === "FAILED").map(([k]) => k).join(", ")}`, gates, model: res.model, cost, branch: t.branch, summary: khai.summary });
      return;
    }

    // 6. Worker commit + đẩy (agent không có quyền git). Không PR ở đây — Pha 3.
    a.step = "commit + đẩy nhánh";
    a.progressPct = 90;
    git(dir, "add", "-A");
    const files = git(dir, "diff", "--cached", "--name-only").split("\n").filter(Boolean);
    git(dir, "-c", "user.name=tech-worker", "-c", "user.email=tech-worker@users.noreply.github.com", "commit", "-q", "-m", `${t.code}: ${t.title}\n\n${(khai.summary || res.resultText).slice(0, 3000)}\n\nWorker: ${VERSION} · lượt ${t.runId} · lần thử ${t.attempt}`);
    const resultCommit = git(dir, "rev-parse", "HEAD");
    git(dir, "push", "-q", "origin", `${t.branch}:${t.branch}`);
    await complete(t, {
      outcome: "SUCCEEDED",
      summary: (khai.summary || res.resultText).slice(0, 8000),
      branch: t.branch,
      resultCommit,
      filesChanged: files,
      testsRun: Object.keys(gates).map((g) => `npm run ${g}`).join(" && "),
      gates,
      model: res.model,
      cost,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0].slice(0, 1000) : String(e);
    push("error", msg);
    await complete(t, { outcome: "FAILED", error: msg, branch: t.branch }).catch(() => undefined);
  } finally {
    // Gỡ cây, GIỮ nhánh (bằng chứng). Cây bẩn thì vẫn gỡ: mọi thứ đáng giữ đã nằm trong commit hoặc đã báo lỗi.
    try {
      if (existsSync(dir)) git(cfg.repo, "worktree", "remove", "--force", dir);
    } catch {
      /* lần dọn sau */
    }
    active.delete(t.runId);
  }
}

async function beat() {
  const runs = [...active.values()].map((a) => ({
    runId: a.task.runId,
    leaseGeneration: a.task.leaseGeneration,
    progressPct: a.progressPct,
    step: a.step,
    logs: a.logs.splice(0, TECH_LEASE.maxLogLinesPerBeat).map((l) => ({ level: l.level, line: l.line.slice(0, TECH_LEASE.maxLogLineChars) })),
  }));
  try {
    const r = await api<{ runs?: { runId: string; action: string; reason?: string }[] }>("heartbeat", { version: VERSION, runs });
    for (const x of r.data.runs ?? []) {
      if (x.action === "ABORT") {
        log(`máy chủ yêu cầu DỪNG lượt ${x.runId}: ${x.reason ?? ""}`);
        active.get(x.runId)?.abort.abort();
      }
    }
  } catch (e) {
    log(`nhịp tim lỗi: ${e instanceof Error ? e.message : e} — sẽ thử lại`);
  }
}

async function main() {
  const thieu = Object.entries({ TECH_WORKER_URL: cfg.url, TECH_WORKER_TOKEN: cfg.token, TECH_WORKER_REPO: cfg.repo }).filter(([, v]) => !v).map(([k]) => k);
  if (thieu.length) {
    console.error(`Thiếu biến môi trường: ${thieu.join(", ")}`);
    process.exit(2);
  }
  if (!existsSync(path.join(cfg.repo, ".git"))) {
    console.error("TECH_WORKER_REPO không phải một kho git.");
    process.exit(2);
  }
  const hello = await api<{ worker?: { key: string; provider: string; enabled: boolean }; openRuns?: { runId: string }[]; error?: string }>("hello");
  if (hello.status !== 200 || !hello.data.worker) {
    console.error(`Máy chủ từ chối khoá worker (HTTP ${hello.status}).`);
    process.exit(2);
  }
  const provider = hello.data.worker.provider;
  if (!isTechExecutionProvider(provider)) throw new Error(`Provider lạ: ${provider}`);
  const adapter = createAdapter(provider);
  const ok = await adapter.check();
  log(`worker ${hello.data.worker.key} · ${provider} · ${os.hostname()} · adapter ${ok.ok ? "SẴN SÀNG" : `KHÔNG CHẠY ĐƯỢC: ${ok.reason}`}`);
  if (hello.data.openRuns?.length) log(`còn ${hello.data.openRuns.length} lượt mở từ lần chạy trước — không nhận lại; lease của chúng sẽ hết hạn và việc được thả về hàng đợi.`);
  if (CHECK || !ok.ok) process.exit(ok.ok ? 0 : 3);

  const hb = setInterval(() => void beat(), TECH_LEASE.heartbeatSeconds * 1000);
  await beat();
  for (;;) {
    if (active.size === 0) {
      const r = await api<{ task: Claimed | null; reason?: string }>("claim");
      if (r.data.task) {
        log(`${r.data.task.code}: nhận việc (lần ${r.data.task.attempt}/${r.data.task.maxAttempts}) → ${r.data.task.branch}`);
        await execute(adapter, provider, r.data.task);
        await beat();
        if (ONCE) break;
        continue;
      }
      if (ONCE) {
        log(`không có việc: ${r.data.reason ?? r.status}`);
        break;
      }
    }
    await new Promise((res) => setTimeout(res, 60_000));
  }
  clearInterval(hb);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
