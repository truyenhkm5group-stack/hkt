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
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TECH_OWNER_ESCALATIONS, type TechOwnerEscalation } from "@/lib/constants/tech";
import { TECH_LEASE, buildChildEnv, forbiddenTouched, isTechExecutionProvider, taskWorktreeDirName, type TechExecutionProvider, type TechRunOutcome } from "@/lib/constants/tech-worker";
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
  timeoutMinutes: number;
  modelTier: string;
  model: string;
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

/**
 * Chạy `npm <args>` BẤT ĐỒNG BỘ (review 07/10: `spawnSync` khoá event loop ⇒ nhịp tim đứng ⇒ lease 5′ hết hạn giữa
 * `npm test` dài ⇒ lượt bị thu hồi dù vẫn đang chạy). `npm` gọi qua `npm-cli.js` + `node`, giữ `shell:false`
 * (AGENTS.md mục 65); không tìm thấy `npm-cli.js` ⇒ báo rõ, không thử `spawn("npm")` (ENOENT trên Windows).
 * Exit code THẬT — model không tự chấm mình.
 */
/**
 * `npm-cli.js` thật: `npm_execpath` (khi chạy qua `npm run tech:worker`), cạnh `node.exe` (Windows), hoặc
 * `<prefix>/lib/node_modules/npm` (Linux / nvm) — review 07/10, mục 5. Không thấy ⇒ `null`, `--check` báo trước khi
 * nhận việc (không đốt lần thử của việc nào).
 */
export function resolveNpmCli(): string | null {
  const ung = [
    process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath) ? process.env.npm_execpath : null,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean) as string[];
  return ung.find((p) => existsSync(p)) ?? null;
}

function npmAsync(cwd: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<number | null> {
  const npmCli = resolveNpmCli();
  if (!npmCli) return Promise.reject(new Error(`Không tìm thấy npm-cli.js (npm_execpath / cạnh ${process.execPath} / lib/node_modules)`));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [npmCli, ...args], { cwd, env: env as NodeJS.ProcessEnv, stdio: "ignore", shell: false, windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function runGate(cwd: string, script: string, env: Record<string, string>): Promise<"PASSED" | "FAILED"> {
  return (await npmAsync(cwd, ["run", script], env, 40 * 60_000)) === 0 ? "PASSED" : "FAILED";
}

async function npmCi(cwd: string, env: Record<string, string>): Promise<boolean> {
  return (await npmAsync(cwd, ["ci", "--no-audit", "--no-fund", "--prefer-offline"], env, 20 * 60_000)) === 0;
}

async function complete(t: Claimed, body: Record<string, unknown>) {
  // Đã nộp kết quả ⇒ thôi đập nhịp cho lượt này (dogfood 07/10: một nhịp lọt ra sau khi nộp, máy chủ trả DỪNG/RUN_CLOSED).
  active.delete(t.runId);
  const r = await api<{ ok?: true; error?: string; taskStatus?: string }>("complete", { runId: t.runId, leaseGeneration: t.leaseGeneration, ...body });
  log(`${t.code}: complete → ${r.status} ${r.data.taskStatus ?? r.data.error ?? ""}`);
}

/** Một việc, từ đầu tới cuối. Mọi nhánh lỗi đều kết thúc bằng MỘT lời gọi `complete` (hoặc lease tự hết hạn). */
async function execute(adapter: ExecutionAdapter, provider: TechExecutionProvider, t: Claimed) {
  const a: Active = { task: t, abort: new AbortController(), logs: [], progressPct: 0, step: "dựng cây làm việc" };
  active.set(t.runId, a);
  const push = (level: "info" | "warn" | "error", line: string) => a.logs.push({ level, line });
  const root = cfg.root || path.dirname(path.resolve(cfg.repo));
  const dir = path.join(root, taskWorktreeDirName(t.code, t.leaseGeneration));
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
    /*
      MÔI TRƯỜNG CỦA `npm ci` VÀ CÁC CỔNG = DANH SÁCH CHO PHÉP (review 07/10, lỗi CHẶN): cổng chạy CHÍNH mã agent vừa
      viết, nên nó chỉ được thấy đúng thứ tiến trình agent thấy — không token GitHub, không khoá API, không CSDL, không
      biến nào "quên xoá". Dùng lại `buildChildEnv` của gói thuê bao (không khoá API nào) cho mọi worker.
    */
    const childEnv = buildChildEnv("SUBSCRIPTION_CLAUDE_CODE", process.env, null);
    /*
      Cổng chạy mã agent viết: thư mục NHÀ của nó trỏ sang một thư mục tạm, để `~/.git-credentials`, cấu hình GitHub
      CLI, chứng thực Claude Code của máy không nằm trong tầm đọc (review 07/10, mục 1). Bộ đệm npm vẫn ở
      LOCALAPPDATA (Windows) nên `npm ci --prefer-offline` không chậm đi. Vận hành: worker nên chạy dưới tài khoản hệ
      điều hành RIÊNG (docs mục 8).
    */
    const nhaTam = path.join(root, `.gate-home-${t.code.toLowerCase().replace(/[^a-z0-9-]/g, "")}`);
    mkdirSync(nhaTam, { recursive: true });
    childEnv.HOME = nhaTam;
    childEnv.USERPROFILE = nhaTam;
    childEnv.APPDATA = path.join(nhaTam, "AppData");
    childEnv.XDG_CONFIG_HOME = path.join(nhaTam, ".config");
    // Git for Windows khai `credential.helper=manager` ở cấu hình HỆ THỐNG (review 07/10, mục A): tắt cấu hình hệ
    // thống / toàn cục và mọi lời nhắc, để mã trong cổng không `git credential fill` ra token của máy.
    childEnv.GIT_CONFIG_NOSYSTEM = "1";
    childEnv.GIT_CONFIG_GLOBAL = path.join(nhaTam, ".gitconfig");
    childEnv.GIT_TERMINAL_PROMPT = "0";
    childEnv.GCM_INTERACTIVE = "never";
    if (!(await npmCi(dir, childEnv))) {
      await complete(t, { outcome: "BLOCKED" satisfies TechRunOutcome, error: "npm ci thất bại trong cây làm việc của worker", branch: t.branch });
      return;
    }

    // 3. Agent làm.
    a.step = "agent đang làm";
    a.progressPct = 20;
    const res = await adapter.run({
      prompt: buildAgentPrompt(t),
      cwd: dir,
      // Trần do máy chủ cấp (ngân sách); biến môi trường chỉ được HẠ thêm, không nới.
      timeoutMs: Math.min(cfg.timeoutMin, t.timeoutMinutes || cfg.timeoutMin) * 60_000,
      allowedTools: toolAllowlist(),
      // Model do máy chủ định tuyến (hạng theo năng lực) — không dùng model mạnh nhất cho mọi việc.
      model: t.model || undefined,
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

    // 5. ĐƯỜNG CẤM — kiểm TRƯỚC khi chạy cổng (cổng thực thi mã agent) và trước khi đẩy (CI chạy workflow của nhánh).
    git(dir, "add", "-A");
    // `--no-renames`: đổi tên `lib/auth/x.ts` → `lib/x.ts` phải lộ CẢ đường cũ (review 07/10, mục 4).
    const files = git(dir, "diff", "--cached", "--no-renames", "--name-only").split("\n").filter(Boolean);
    const cam = forbiddenTouched(files);
    if (cam.length) {
      await complete(t, { outcome: "BLOCKED", error: `Agent sửa đường cấm (${cam.join(", ")}) — không chạy cổng, không đẩy. Việc này cần người làm hoặc nâng chính sách.`, filesChanged: files, model: res.model, cost, branch: t.branch });
      return;
    }

    // 6. Cổng — exit code thật.
    a.step = "chạy cổng";
    a.progressPct = 70;
    const gates: Record<string, "PASSED" | "FAILED" | "SKIPPED"> = {};
    for (const g of gatesForTask(t)) {
      gates[g] = await runGate(dir, g === "test" ? "test" : g, childEnv);
      push(gates[g] === "PASSED" ? "info" : "error", `cổng ${g}: ${gates[g]}`);
      if (gates[g] === "FAILED") break;
    }
    if (Object.values(gates).includes("FAILED")) {
      await complete(t, { outcome: "FAILED", error: `Cổng đỏ: ${Object.entries(gates).filter(([, v]) => v === "FAILED").map(([k]) => k).join(", ")}`, gates, model: res.model, cost, branch: t.branch, summary: khai.summary });
      return;
    }

    // 7. Worker commit + đẩy (agent không có quyền git). PR do máy chủ yêu cầu bằng danh tính bot.
    a.step = "commit + đẩy nhánh";
    a.progressPct = 90;
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
  const npmOk = resolveNpmCli();
  const ok = npmOk ? await adapter.check() : ({ ok: false, reason: "Không tìm thấy npm-cli.js — cổng / npm ci sẽ không chạy được" } as const);
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
