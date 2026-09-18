import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkCommand, checkReadPath, checkWritePath, sandboxEnv, type AllowedCommand } from "@/lib/constants/agent-sandbox";

/**
 * ═══════════ CÂY LÀM VIỆC CỦA MỘT LƯỢT CHẠY AGENT ═══════════
 *
 * Tệp này là nơi DUY NHẤT trong đường chạy agent được chạm vào hệ tệp và tiến trình con. Mọi lời
 * gọi đi qua hàng rào ở `lib/constants/agent-sandbox.ts` — và hàng rào đó là HÀM THUẦN, kiểm thử
 * được từng ca mà không cần dựng agent nào.
 *
 * ─── BỐN LUẬT ───
 *
 * 1. **Mỗi lượt chạy một cây riêng** (AGENTS.md mục 9). Hai lượt KHÔNG BAO GIỜ dùng chung thư mục:
 *    đó là thứ đã làm `main` đỏ bốn lần trong một buổi chiều.
 * 2. **Cây dựng từ một BASE SHA ĐÃ VÀO KHO.** Không dựng từ cây làm việc đang bẩn của ai đó —
 *    nếu không, lượt chạy mang theo việc dở của người khác và không ai đọc ngược được.
 * 3. **`spawn` KHÔNG QUA SHELL.** `shell: false` nghĩa là `&&`, `;`, `|`, `$(…)`, backtick không
 *    có nghĩa gì: chúng chỉ là ký tự trong một tham số. Nối thêm lệnh thứ hai là điều không biểu
 *    diễn được, chứ không phải điều bị cấm.
 * 4. **Tiến trình con nhận một môi trường TỐI THIỂU.** Không `ANTHROPIC_API_KEY`, không
 *    `DATABASE_URL`, không token GitHub. Một tệp kiểm thử mà agent vừa sửa cũng không đọc được gì.
 */

export type CommandResult = { command: string; exitCode: number; ok: boolean; stdout: string; stderr: string; durationMs: number; timedOut: boolean };

/** Trần đầu ra giữ lại. Một lượt `npm test` in vài nghìn dòng; giữ hết là nhồi vào prompt và vào CSDL. */
const MAX_OUTPUT = 20_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

function tail(s: string) {
  return s.length <= MAX_OUTPUT ? s : `…(cắt bớt ${s.length - MAX_OUTPUT} ký tự)\n${s.slice(-MAX_OUTPUT)}`;
}

export class AgentWorkspace {
  readonly root: string;
  readonly branch: string;
  readonly baseCommit: string;
  private readonly repoRoot: string;
  private readonly allowedCommands: readonly AllowedCommand[];
  private readonly readGlobs: readonly string[];
  private readonly writeGlobs: readonly string[];
  /** Tệp agent đã ghi — dùng làm bằng chứng, không tin lời khai của agent. */
  readonly written = new Set<string>();

  private constructor(init: {
    root: string;
    branch: string;
    baseCommit: string;
    repoRoot: string;
    allowedCommands: readonly AllowedCommand[];
    readGlobs: readonly string[];
    writeGlobs: readonly string[];
  }) {
    this.root = init.root;
    this.branch = init.branch;
    this.baseCommit = init.baseCommit;
    this.repoRoot = init.repoRoot;
    this.allowedCommands = init.allowedCommands;
    this.readGlobs = init.readGlobs;
    this.writeGlobs = init.writeGlobs;
  }

  /**
   * Dựng cây làm việc mới từ một base SHA.
   *
   * `git worktree add -b <branch> <path> <sha>` — nhánh mới, thư mục mới, base đã vào kho. Nhánh
   * trùng tên thì LỖI chứ không ghi đè: hai lượt chạy cùng nhánh là hai lượt ghi đè bằng chứng của
   * nhau.
   */
  static async create(opts: {
    repoRoot: string;
    branch: string;
    baseCommit: string;
    allowedCommands: readonly AllowedCommand[];
    readGlobs: readonly string[];
    writeGlobs: readonly string[];
    /** Thư mục cha của cây. Mặc định một thư mục tạm riêng cho lượt chạy. */
    parentDir?: string;
  }): Promise<AgentWorkspace> {
    const parent = opts.parentDir ?? mkdtempSync(path.join(tmpdir(), "erp-agent-"));
    mkdirSync(parent, { recursive: true });
    const root = path.join(parent, opts.branch.replace(/[^\w.-]+/g, "-"));
    if (existsSync(root)) throw new Error(`Cây làm việc ${root} đã tồn tại — hai lượt chạy không được dùng chung thư mục.`);

    const res = await rawGit(opts.repoRoot, ["worktree", "add", "-b", opts.branch, root, opts.baseCommit]);
    if (!res.ok) throw new Error(`Không dựng được cây làm việc: ${res.stderr || res.stdout}`);

    /*
      `node_modules` dùng lại của kho gốc bằng liên kết tượng trưng. Cài lại cho mỗi lượt chạy tốn
      vài phút và cần MẠNG — mà `npm install` nằm trong danh sách cấm đúng vì lý do đó.
    */
    const nm = path.join(opts.repoRoot, "node_modules");
    if (existsSync(nm) && !existsSync(path.join(root, "node_modules"))) {
      const { symlinkSync } = await import("node:fs");
      try {
        symlinkSync(nm, path.join(root, "node_modules"), "dir");
      } catch {
        // Không có `node_modules` thì lệnh `npm` sẽ hỏng và được ghi lại như một cổng ĐỎ — đúng.
      }
    }
    return new AgentWorkspace({ root, branch: opts.branch, baseCommit: opts.baseCommit, repoRoot: opts.repoRoot, allowedCommands: opts.allowedCommands, readGlobs: opts.readGlobs, writeGlobs: opts.writeGlobs });
  }

  /** Đọc một tệp trong phạm vi cho phép. */
  readFile(rel: string): { ok: true; content: string } | { ok: false; reason: string } {
    const v = checkReadPath(rel, this.readGlobs);
    if (!v.allowed) return { ok: false, reason: v.reason };
    const full = path.join(this.root, v.path);
    if (!full.startsWith(this.root + path.sep)) return { ok: false, reason: "Đường dẫn ra ngoài cây làm việc." };
    if (!existsSync(full)) return { ok: false, reason: `Không có tệp \`${v.path}\`.` };
    try {
      return { ok: true, content: readFileSync(full, "utf8").slice(0, 200_000) };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Ghi một tệp trong phạm vi cho phép. Tạo thư mục cha nếu cần. */
  writeFile(rel: string, content: string): { ok: true; path: string } | { ok: false; reason: string } {
    const v = checkWritePath(rel, this.writeGlobs);
    if (!v.allowed) return { ok: false, reason: v.reason };
    const full = path.join(this.root, v.path);
    if (!full.startsWith(this.root + path.sep)) return { ok: false, reason: "Đường dẫn ra ngoài cây làm việc." };
    try {
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content, "utf8");
      this.written.add(v.path);
      return { ok: true, path: v.path };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Chạy một lệnh ĐÃ ĐƯỢC PHÉP.
   *
   * Kết quả là EXIT CODE THẬT, không phải lời khai của model. Đây là điểm mấu chốt của cả Phase
   * 2A: AI không được tự chấm mình (mục 11 của đặc tả).
   */
  async run(argv: readonly string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CommandResult | { blocked: true; reason: string }> {
    const verdict = checkCommand(argv, this.allowedCommands);
    if (!verdict.allowed) return { blocked: true, reason: verdict.reason };
    return exec(argv, this.root, timeoutMs);
  }

  /** Tệp đang đổi so với base — ĐO từ git, không hỏi agent. */
  async changedFiles(): Promise<string[]> {
    const r = await rawGit(this.root, ["status", "--porcelain"]);
    if (!r.ok) return [];
    return r.stdout
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
  }

  /**
   * Commit những gì agent đã ghi.
   *
   * RUNNER commit, không phải agent — `git add`/`git commit` cố ý KHÔNG nằm trong danh sách lệnh
   * của agent. Nếu agent tự commit được thì bằng chứng của lượt chạy do chính đối tượng bị kiểm
   * tra tạo ra.
   *
   * CHỈ `git add` đúng những tệp nằm trong phạm vi GHI — không bao giờ `git add -A` (AGENTS.md
   * mục 9: không add mù cả cây).
   */
  async commit(message: string, author: { name: string; email: string }): Promise<{ ok: boolean; commit: string | null; detail: string }> {
    const changed = await this.changedFiles();
    const inScope = changed.filter((f) => checkWritePath(f, this.writeGlobs).allowed);
    const outOfScope = changed.filter((f) => !checkWritePath(f, this.writeGlobs).allowed);
    if (outOfScope.length) {
      return { ok: false, commit: null, detail: `Có tệp đổi NGOÀI phạm vi cho phép: ${outOfScope.join(", ")} — không commit.` };
    }
    if (!inScope.length) return { ok: false, commit: null, detail: "Không có tệp nào đổi — không có gì để commit." };

    const add = await rawGit(this.root, ["add", "--", ...inScope]);
    if (!add.ok) return { ok: false, commit: null, detail: add.stderr || add.stdout };
    const c = await exec(
      ["git", "-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-m", message],
      this.root,
      60_000,
    );
    if (!c.ok) return { ok: false, commit: null, detail: c.stderr || c.stdout };
    const sha = await rawGit(this.root, ["rev-parse", "HEAD"]);
    return { ok: true, commit: sha.stdout.trim() || null, detail: `Đã commit ${inScope.length} tệp.` };
  }

  /**
   * Dọn cây làm việc — GIỮ NGUYÊN nhánh và commit.
   *
   * Xoá nhánh là xoá bằng chứng của lượt chạy. Thư mục thì bỏ đi được vì mọi thứ đáng giữ đã nằm
   * trong kho git.
   */
  async cleanup(): Promise<void> {
    await rawGit(this.repoRoot, ["worktree", "remove", "--force", this.root]).catch(() => undefined);
    try {
      if (existsSync(this.root)) rmSync(this.root, { recursive: true, force: true });
    } catch {
      // Dọn không được thì thôi — cây nằm trong thư mục tạm của hệ điều hành.
    }
  }
}

/**
 * Lệnh `git` của RUNNER — không đi qua hàng rào của agent.
 *
 * Tách hẳn khỏi `AgentWorkspace.run()` là cố ý: runner cần `worktree add`, `add`, `commit`,
 * `rev-parse` — đúng những thứ agent KHÔNG được phép. Hàm này không bao giờ nhận đầu vào từ model.
 */
async function rawGit(cwd: string, args: string[]): Promise<CommandResult> {
  return exec(["git", ...args], cwd, 120_000);
}

/** Chạy tiến trình con: không shell, môi trường tối thiểu, có hạn giờ. */
function exec(argv: readonly string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      // KHÔNG SHELL: ký tự điều khiển mất hết ý nghĩa, không nối được lệnh thứ hai.
      shell: false,
      /*
        `NodeJS.ProcessEnv` đòi `NODE_ENV` nên phải ép kiểu — nhưng giá trị thì đúng là thứ
        `sandboxEnv()` trả về: một đối tượng CHỈ có các khoá trong danh sách cho phép.
      */
      env: sandboxEnv(process.env) as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"] as const,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > MAX_OUTPUT * 4) stdout = stdout.slice(-MAX_OUTPUT * 2);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > MAX_OUTPUT * 4) stderr = stderr.slice(-MAX_OUTPUT * 2);
    });
    const done = (code: number) => {
      clearTimeout(timer);
      resolve({ command: argv.join(" "), exitCode: code, ok: code === 0 && !timedOut, stdout: tail(stdout), stderr: tail(stderr), durationMs: Date.now() - started, timedOut });
    };
    child.on("error", (e) => {
      stderr += `\n${e.message}`;
      done(127);
    });
    child.on("close", (code) => done(code ?? 1));
  });
}
