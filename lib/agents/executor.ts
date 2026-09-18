import type { AiProvider, AiMessage, AiToolDef } from "@/lib/ai/provider";
import type { AgentWorkspace } from "@/lib/agents/workspace";

/**
 * ═══════════ AGENT EXECUTOR — MỘT GIAO DIỆN, NHIỀU CÁCH THỰC THI ═══════════
 *
 * Sổ agent (`tech_agents`) KHÔNG phụ thuộc model: nó khai VAI và QUYỀN, không khai nhà cung cấp.
 * Nhà cung cấp, model và khoá API là CẤU HÌNH MÁY CHỦ (`lib/ai/router.ts`, biến môi trường) —
 * đúng yêu cầu "không gắn AI model cụ thể vào business logic" đã có từ Phase 1.
 *
 * Nhờ giao diện này, ba thứ tách rời nhau:
 *   · WHAT   — việc cần làm (`tech_tasks`)
 *   · WHO    — vai và quyền (`tech_agents`)
 *   · HOW    — ai thực thi (executor + provider + model)
 *
 * Đổi model, đổi nhà cung cấp, hay thay hẳn bằng một cách thực thi khác đều KHÔNG chạm vào sổ agent
 * và không chạm vào luật rủi ro.
 */

export type AgentStep =
  | { kind: "READ"; path: string; ok: boolean; detail: string }
  | { kind: "WRITE"; path: string; ok: boolean; detail: string }
  | { kind: "COMMAND"; command: string; ok: boolean; exitCode: number | null; detail: string }
  | { kind: "BLOCKED"; detail: string }
  | { kind: "NOTE"; detail: string };

export type AgentOutcome = {
  /** Một câu KẾT LUẬN kiểm chứng được. KHÔNG phải dòng suy nghĩ — xem chú thích `tech_agent_runs.summary`. */
  summary: string;
  steps: AgentStep[];
  /** Agent tự nhận là đã xong hay bỏ cuộc. Runner KHÔNG tin nó để chấm cổng — cổng đo bằng exit code. */
  finished: boolean;
  error: string | null;
};

export type AgentJob = {
  taskCode: string;
  taskTitle: string;
  taskDescription: string;
  /** Phạm vi tệp được ghi, để nói thẳng cho executor thay vì để nó dò bằng cách thử và bị chặn. */
  writeGlobs: readonly string[];
  workspace: AgentWorkspace;
};

export interface AgentExecutor {
  readonly key: string;
  /**
   * Đã dùng được chưa. `ok: false` ⇒ lượt chạy phải BLOCKED với lý do rõ ràng, KHÔNG được giả vờ
   * thành công (mục 8 của đặc tả Phase 2A).
   */
  available(): { ok: boolean; reason: string | null };
  run(job: AgentJob): Promise<AgentOutcome>;
}

/* ═════════════════════ BỘ CÔNG CỤ ═════════════════════ */

/**
 * Bốn công cụ, không hơn.
 *
 * KHÔNG có `git_commit`, `git_push`, `list_directory`, `search`. Mỗi công cụ thêm vào là một bề
 * mặt phải canh; bốn cái này đủ để đọc, sửa tài liệu và tự kiểm.
 */
export const AGENT_TOOLS: AiToolDef[] = [
  {
    name: "read_file",
    description: "Đọc một tệp trong kho mã. Chỉ đọc được các đường dẫn thuộc phạm vi của agent.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Đường dẫn tương đối, ví dụ docs/abc.md" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "write_file",
    description: "Ghi đè toàn bộ nội dung một tệp. Chỉ ghi được trong phạm vi cho phép của agent (agent tài liệu: docs/).",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
  },
  {
    name: "run_command",
    description: "Chạy một lệnh trong danh sách cho phép. Truyền dạng mảng đã tách, ví dụ [\"npm\",\"run\",\"typecheck\"]. Không có shell: không dùng được &&, |, ; hay $().",
    inputSchema: { type: "object", properties: { argv: { type: "array", items: { type: "string" } } }, required: ["argv"], additionalProperties: false },
  },
  {
    name: "finish",
    description: "Báo đã làm xong phạm vi việc. Kèm MỘT câu kết luận kiểm chứng được (đã sửa tệp nào, đã chạy lệnh gì).",
    inputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
  },
];

const SYSTEM = `Bạn là agent TÀI LIỆU của Phòng Tech AI trong ERP VNXcommerce.

PHẠM VI: chỉ viết và sửa tài liệu trong thư mục docs/. Bạn KHÔNG sửa mã nguồn, KHÔNG commit,
KHÔNG merge, KHÔNG deploy — runner làm việc commit sau khi bạn xong.

NGÔN NGỮ: tiếng Việt có dấu. Viết như một kỹ sư giải thích cho đồng nghiệp: nói VÌ SAO trước, rồi
mới tới CÁI GÌ. Không quảng cáo, không hình dung từ rỗng.

CÁCH LÀM:
1. Đọc những tệp cần thiết để hiểu đúng thứ mình sắp mô tả. Đừng đoán.
2. Ghi tệp tài liệu trong phạm vi task cho phép.
3. Tự kiểm bằng run_command nếu task yêu cầu.
4. Gọi finish với một câu kết luận kiểm chứng được.

LUẬT:
- Chỉ viết điều bạn ĐỌC ĐƯỢC từ mã nguồn. Không bịa số liệu, không bịa tên hàm.
- Chưa biết thì viết là chưa biết. Không lấp chỗ trống bằng câu nghe hợp lý.
- Lệnh bị chặn thì ĐỪNG thử cách khác để lách — báo lại trong finish.`;

/** Vòng lặp tối đa. Một việc tài liệu không cần nhiều hơn; vượt ngưỡng là dấu hiệu agent đang lạc. */
const MAX_ROUNDS = 24;

/**
 * Executor chạy bằng một `AiProvider`.
 *
 * KHÔNG gọi thẳng SDK của nhà cung cấp nào: nó nhận `AiProvider` — giao diện đã có từ bản AI
 * Copilot, đã có sẵn bản Anthropic, bản OpenAI và bản giả cho kiểm thử. Nhờ vậy bài kiểm chạy được
 * TOÀN BỘ vòng lặp mà không cần mạng và không cần khoá API.
 */
export class AiAgentExecutor implements AgentExecutor {
  readonly key = "ai";
  constructor(
    private readonly provider: AiProvider | null,
    private readonly unavailableReason: string | null = null,
  ) {}

  available() {
    if (this.provider) return { ok: true, reason: null };
    return { ok: false, reason: this.unavailableReason ?? "Chưa cấu hình nhà cung cấp AI (thiếu ANTHROPIC_API_KEY hoặc OPENAI_API_KEY)." };
  }

  async run(job: AgentJob): Promise<AgentOutcome> {
    const steps: AgentStep[] = [];
    if (!this.provider) return { summary: "", steps, finished: false, error: this.available().reason };

    const messages: AiMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `VIỆC ${job.taskCode}: ${job.taskTitle}\n\n${job.taskDescription}\n\n` +
              `Bạn được GHI trong: ${job.writeGlobs.join(", ")}\n` +
              `Cây làm việc đã dựng sẵn trên một nhánh riêng. Bắt đầu đi.`,
          },
        ],
      },
    ];

    let summary = "";
    let finished = false;
    for (let round = 0; round < MAX_ROUNDS && !finished; round += 1) {
      const res = await this.provider.complete({ system: SYSTEM, messages, tools: AGENT_TOOLS, maxTokens: 8000 });
      messages.push({ role: "assistant", content: res.content });

      const calls = res.content.filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use");
      if (!calls.length) {
        // Model nói chuyện mà không gọi công cụ nào: ghi lại rồi dừng — không đoán ý nó.
        const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join(" ").trim();
        steps.push({ kind: "NOTE", detail: text.slice(0, 500) });
        return { summary: summary || text.slice(0, 1000), steps, finished: false, error: "Agent dừng mà không gọi finish." };
      }

      const results: AiMessage["content"] = [];
      for (const call of calls) {
        const input = (call.input ?? {}) as Record<string, unknown>;
        if (call.name === "finish") {
          summary = String(input.summary ?? "").slice(0, 2000);
          finished = true;
          results.push({ type: "tool_result", toolUseId: call.id, content: "Đã ghi nhận." });
          continue;
        }
        if (call.name === "read_file") {
          const r = job.workspace.readFile(String(input.path ?? ""));
          steps.push({ kind: "READ", path: String(input.path ?? ""), ok: r.ok, detail: r.ok ? `${r.content.length} ký tự` : r.reason });
          results.push({ type: "tool_result", toolUseId: call.id, content: r.ok ? r.content : r.reason, isError: !r.ok });
          continue;
        }
        if (call.name === "write_file") {
          const r = job.workspace.writeFile(String(input.path ?? ""), String(input.content ?? ""));
          steps.push({ kind: "WRITE", path: String(input.path ?? ""), ok: r.ok, detail: r.ok ? "đã ghi" : r.reason });
          results.push({ type: "tool_result", toolUseId: call.id, content: r.ok ? `Đã ghi ${r.path}.` : r.reason, isError: !r.ok });
          continue;
        }
        if (call.name === "run_command") {
          const argv = Array.isArray(input.argv) ? input.argv.map((x) => String(x)) : [];
          const r = await job.workspace.run(argv);
          if ("blocked" in r) {
            // LỆNH BỊ CHẶN LÀ MỘT SỰ KIỆN ĐÁNG GHI, không phải một lỗi im lặng.
            steps.push({ kind: "BLOCKED", detail: `${argv.join(" ")} — ${r.reason}` });
            results.push({ type: "tool_result", toolUseId: call.id, content: `BỊ CHẶN: ${r.reason}`, isError: true });
            continue;
          }
          steps.push({ kind: "COMMAND", command: r.command, ok: r.ok, exitCode: r.exitCode, detail: r.ok ? "đạt" : (r.stderr || r.stdout).slice(-800) });
          results.push({ type: "tool_result", toolUseId: call.id, content: `exit=${r.exitCode}\n${(r.stdout + "\n" + r.stderr).slice(-4000)}`, isError: !r.ok });
          continue;
        }
        results.push({ type: "tool_result", toolUseId: call.id, content: `Không có công cụ tên ${call.name}.`, isError: true });
      }
      messages.push({ role: "user", content: results });
    }

    return { summary, steps, finished, error: finished ? null : "Hết số vòng cho phép mà agent chưa gọi finish." };
  }
}
