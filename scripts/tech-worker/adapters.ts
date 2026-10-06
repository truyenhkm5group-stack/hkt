import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { assertBillingBoundary, buildChildEnv, type TechExecutionProvider } from "@/lib/constants/tech-worker";

/**
 * ═══════════ LỚP ADAPTER THI HÀNH — MỌI LỜI GỌI MODEL ĐI QUA ĐÂY ═══════════
 *
 * docs/tech-control-plane/README.md mục 4. Một adapter = một cách chạy agent trong một cây làm việc. Mặt phẳng
 * điều khiển không biết (và không cần biết) adapter gọi gì bên dưới: thêm nhà cung cấp mới là thêm một lớp ở
 * đây, không sửa hàng đợi.
 *
 * Cả hai adapter hiện có chạy CÙNG một CLI (Claude Code, headless `-p`), khác nhau ĐÚNG MỘT điều: môi trường
 * tiến trình con. Gói thuê bao: không khoá API nào (`assertBillingBoundary` kiểm lần cuối ngay trước `spawn`).
 * API: đúng một khoá, đọc từ biến RIÊNG của worker.
 *
 * `spawn` với `shell: false` và đường dẫn tới `claude.exe` thật — không bật `shell: true` để chạy được `.cmd`
 * (AGENTS.md mục 65: không đổi một tính chất bảo mật để lấy màu xanh).
 */

export type AgentRunRequest = {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  /** Công cụ được phép — danh sách CHO PHÉP của Claude Code. */
  allowedTools: string[];
  model?: string;
  maxTurns?: number;
  onLog: (level: "info" | "warn" | "error", line: string) => void;
  signal: AbortSignal;
};

export type AgentRunResult = {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** Câu kết của model (đoạn `result` cuối). KHÔNG phải kết cục — worker tự đo bằng cổng. */
  resultText: string;
  model: string;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
};

export interface ExecutionAdapter {
  provider: TechExecutionProvider;
  /** Chạy được không, và nếu không thì vì sao — đọc TRƯỚC khi xin việc. */
  check(): Promise<{ ok: true } | { ok: false; reason: string }>;
  run(req: AgentRunRequest): Promise<AgentRunResult>;
}

/** Tìm `claude.exe` / `claude` thật. Biến `TECH_WORKER_CLAUDE_BIN` thắng mọi phỏng đoán. */
export function resolveClaudeBin(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.TECH_WORKER_CLAUDE_BIN && existsSync(env.TECH_WORKER_CLAUDE_BIN)) return env.TECH_WORKER_CLAUDE_BIN;
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? ["claude.exe"] : ["claude"];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      if (existsSync(p)) return p;
    }
    // Cài bằng npm trên Windows: `claude.cmd` trỏ tới `node_modules/@anthropic-ai/claude-code/bin/claude.exe`.
    const npmExe = path.join(d, "node_modules", "@anthropic-ai", "claude-code", "bin", process.platform === "win32" ? "claude.exe" : "claude");
    if (existsSync(npmExe)) return npmExe;
  }
  return null;
}

type StreamEvent = {
  type?: string;
  subtype?: string;
  result?: string;
  total_cost_usd?: number;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: { model?: string; content?: { type: string; text?: string; name?: string }[] };
};

class ClaudeCodeAdapter implements ExecutionAdapter {
  constructor(
    readonly provider: "SUBSCRIPTION_CLAUDE_CODE" | "ANTHROPIC_API",
    private readonly apiKey: string | null,
  ) {}

  async check() {
    const bin = resolveClaudeBin();
    if (!bin) return { ok: false as const, reason: "Không tìm thấy Claude Code CLI (claude.exe) — cài Claude Code hoặc đặt TECH_WORKER_CLAUDE_BIN." };
    if (this.provider === "ANTHROPIC_API" && !this.apiKey) return { ok: false as const, reason: "Worker API thiếu TECH_WORKER_ANTHROPIC_API_KEY — không mượn khoá của máy." };
    try {
      buildChildEnv(this.provider, process.env, this.apiKey);
    } catch (e) {
      return { ok: false as const, reason: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true as const };
  }

  run(req: AgentRunRequest): Promise<AgentRunResult> {
    const bin = resolveClaudeBin();
    if (!bin) return Promise.reject(new Error("Không tìm thấy Claude Code CLI"));
    const env = buildChildEnv(this.provider, process.env, this.apiKey);
    assertBillingBoundary(this.provider, env);
    const args = [
      "-p",
      req.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      req.allowedTools.join(","),
      "--no-session-persistence",
    ];
    if (req.model) args.push("--model", req.model);
    if (req.maxTurns) args.push("--max-turns", String(req.maxTurns));

    return new Promise((resolve) => {
      const child = spawn(bin, args, { cwd: req.cwd, env: env as NodeJS.ProcessEnv, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const out: AgentRunResult = { exitCode: null, timedOut: false, aborted: false, resultText: "", model: "", costUsd: null, inputTokens: 0, outputTokens: 0 };
      let buf = "";
      const onLine = (line: string) => {
        if (!line.trim()) return;
        let ev: StreamEvent;
        try {
          ev = JSON.parse(line) as StreamEvent;
        } catch {
          req.onLog("info", line.slice(0, 500));
          return;
        }
        if (ev.type === "system" && ev.model) out.model = ev.model;
        if (ev.type === "assistant" && ev.message?.content) {
          if (ev.message.model) out.model = ev.message.model;
          for (const c of ev.message.content) {
            if (c.type === "text" && c.text) req.onLog("info", c.text.slice(0, 500));
            if (c.type === "tool_use" && c.name) req.onLog("info", `→ ${c.name}`);
          }
        }
        if (ev.type === "result") {
          out.resultText = ev.result ?? "";
          if (typeof ev.total_cost_usd === "number") out.costUsd = ev.total_cost_usd;
          out.inputTokens = ev.usage?.input_tokens ?? 0;
          out.outputTokens = ev.usage?.output_tokens ?? 0;
        }
      };
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          onLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      child.stderr.on("data", (d: Buffer) => req.onLog("warn", d.toString("utf8").slice(0, 500)));
      const kill = () => {
        if (!child.killed) child.kill();
      };
      const timer = setTimeout(() => {
        out.timedOut = true;
        kill();
      }, req.timeoutMs);
      const onAbort = () => {
        out.aborted = true;
        kill();
      };
      req.signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", (code) => {
        clearTimeout(timer);
        req.signal.removeEventListener("abort", onAbort);
        if (buf) onLine(buf);
        out.exitCode = code;
        resolve(out);
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        req.onLog("error", `Không chạy được Claude Code: ${e.message}`);
        resolve(out);
      });
    });
  }
}

export function createAdapter(provider: TechExecutionProvider, env: NodeJS.ProcessEnv = process.env): ExecutionAdapter {
  if (provider === "SUBSCRIPTION_CLAUDE_CODE") return new ClaudeCodeAdapter("SUBSCRIPTION_CLAUDE_CODE", null);
  if (provider === "ANTHROPIC_API") return new ClaudeCodeAdapter("ANTHROPIC_API", env.TECH_WORKER_ANTHROPIC_API_KEY?.trim() || null);
  throw new Error(`Không có adapter worker cho ${provider}`);
}
