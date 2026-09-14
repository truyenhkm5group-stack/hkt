/**
 * CỔNG CÔNG CỤ — ranh giới duy nhất giữa nhân sự AI và ERP.
 *
 * Nhân sự AI không có kết nối CSDL, không có `getDb()`, không có server action. Nó chỉ gọi được
 * những gì đăng ký ở đây, và mỗi lời gọi đi qua đủ sáu chốt:
 *
 *   1. Công cụ có trong sổ đăng ký không (`TOOL_CATALOG`).
 *   2. Bản nhân sự này có được phép gọi nó không (`allowedTools`).
 *   3. Nấc quyền hạn hiện tại có đủ cao không (`minMode`) — ở SHADOW mọi công cụ GHI đều bị chặn.
 *   4. Tham số có đúng lược đồ không (zod) — mô hình đưa rác thì dừng ở đây.
 *   5. Trần thời gian — công cụ treo không được treo cả dây chuyền.
 *   6. Ghi sổ: kể cả lần BỊ TỪ CHỐI, vì "con bot đã ĐỊNH làm gì" là thông tin đáng giá nhất.
 *
 * Lần bị từ chối KHÔNG ném lỗi: nó là một kết quả hợp lệ mà dây chuyền phải xử lý (thường là
 * chuyển người). Ném lỗi ở đây sẽ biến một chính sách an toàn thành một sự cố.
 */
import { z } from "zod";
import { modeAtLeast, type AgentMode } from "@/lib/constants/ai";
import { TOOL_CATALOG, TOOL_TIMEOUT_MS, type ToolName, type ToolOutcome } from "@/lib/constants/ai-tools";
import type { RunRecorder } from "@/lib/ai/runs";
import { getAgent } from "@/lib/ai/registry";

/** Nấc quyền hạn THẬT của một nhân sự, đọc từ CSDL. `null` = không đọc được ⇒ phải từ chối. */
async function verifiedMode(agentKey: string): Promise<AgentMode | null> {
  try {
    const agent = await getAgent(agentKey);
    return agent?.mode ?? null;
  } catch {
    return null;
  }
}

export type ToolContext = {
  agentKey: string;
  mode: AgentMode;
  /** Công cụ mà BẢN nhân sự này được phép gọi. */
  allowedTools: readonly string[];
  /** Sổ lượt chạy; thiếu thì công cụ vẫn chạy nhưng không để lại dấu vết (chỉ dùng trong kiểm thử). */
  run?: RunRecorder | null;
  /** Hội thoại đang xử lý — vài công cụ ghi cần nó để biết ghi vào đâu. */
  conversationId?: string | null;
};

export type ToolResult<T> =
  | { ok: true; outcome: "OK"; value: T }
  | { ok: false; outcome: Exclude<ToolOutcome, "OK">; error: string; value?: undefined };

export type ToolDefinition<I, O> = {
  name: ToolName;
  input: z.ZodType<I>;
  /** Mô tả ngắn để đưa vào lời dặn mô hình — KHÔNG chứa dữ liệu khách, không chứa bí mật. */
  describe: string;
  handler: (args: I, ctx: ToolContext) => Promise<O>;
};

const registry = new Map<ToolName, ToolDefinition<unknown, unknown>>();

export function defineTool<I, O>(definition: ToolDefinition<I, O>): ToolDefinition<I, O> {
  if (!TOOL_CATALOG[definition.name]) throw new Error(`Công cụ ${definition.name} chưa khai trong TOOL_CATALOG`);
  registry.set(definition.name, definition as unknown as ToolDefinition<unknown, unknown>);
  return definition;
}

export function registeredTools(): ToolName[] {
  return [...registry.keys()];
}



function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`Công cụ quá ${ms} ms không trả kết quả`)), ms);
    // Không giữ tiến trình sống chỉ vì một bộ đếm giờ.
    if (typeof timer === "object" && timer && "unref" in timer) (timer as { unref: () => void }).unref();
  });
}

/**
 * Gọi một công cụ ERP thay cho nhân sự AI. KHÔNG BAO GIỜ ném — mọi kết cục đều là một
 * `ToolResult` đọc được, và mọi kết cục đều được ghi sổ.
 */
export async function callTool<T = unknown>(ctx: ToolContext, name: ToolName, rawArgs: unknown, options: { timeoutMs?: number } = {}): Promise<ToolResult<T>> {
  const startedAt = Date.now();
  const record = async (outcome: ToolOutcome, result: unknown, error: string | null) => {
    await ctx.run?.tool({ tool: name, outcome, args: rawArgs, result, error, latencyMs: Date.now() - startedAt });
  };

  const declaration = TOOL_CATALOG[name];
  if (!declaration) {
    await record("DENIED", null, `Công cụ không có trong sổ đăng ký: ${name}`);
    return { ok: false, outcome: "DENIED", error: `Công cụ không tồn tại: ${name}` };
  }
  const definition = registry.get(name);
  if (!definition) {
    await record("ERROR", null, `Công cụ đã khai nhưng chưa cài đặt: ${name}`);
    return { ok: false, outcome: "ERROR", error: `Công cụ chưa cài đặt: ${name}` };
  }
  if (!ctx.allowedTools.includes(name)) {
    await record("DENIED", null, `Bản nhân sự "${ctx.agentKey}" không được phép gọi ${name}`);
    return { ok: false, outcome: "DENIED", error: `Nhân sự AI này không được cấp công cụ ${name}` };
  }
  if (!modeAtLeast(ctx.mode, declaration.minMode)) {
    const reason = `${name} cần nấc ${declaration.minMode}, đang chạy ở nấc ${ctx.mode}`;
    await record("DENIED", null, reason);
    return { ok: false, outcome: "DENIED", error: reason };
  }

  // CHỐT CHẶN CỨNG cho công cụ GHI: nấc quyền hạn đọc lại từ CSDL, KHÔNG tin `ctx.mode` mà nơi
  // gọi đưa xuống. Chốt trên đã đủ cho luồng bình thường; chốt này bịt trường hợp `ctx` bị dựng
  // sai ở đâu đó — vì với công cụ ghi, một lần lọt là một hành động thật trên dữ liệu của khách.
  // Đọc CSDL hỏng cũng là TỪ CHỐI: mọi nhánh lỗi phải rơi về phía hẹp hơn.
  if (declaration.kind === "WRITE") {
    const verified = await verifiedMode(ctx.agentKey);
    if (!verified) {
      const reason = `Không xác minh được nấc quyền hạn của "${ctx.agentKey}" từ CSDL — từ chối ${name}`;
      await record("DENIED", null, reason);
      return { ok: false, outcome: "DENIED", error: reason };
    }
    if (!modeAtLeast(verified, declaration.minMode)) {
      const reason = `${name}: nấc thật trong CSDL là ${verified}, cần ${declaration.minMode}`;
      await record("DENIED", null, reason);
      return { ok: false, outcome: "DENIED", error: reason };
    }
  }

  const parsed = definition.input.safeParse(rawArgs);
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? "Tham số không hợp lệ";
    await record("DENIED", null, `Tham số sai lược đồ: ${reason}`);
    return { ok: false, outcome: "DENIED", error: `Tham số không hợp lệ: ${reason}` };
  }

  try {
    const value = (await Promise.race([definition.handler(parsed.data, ctx), timeout(options.timeoutMs ?? TOOL_TIMEOUT_MS)])) as T;
    await record("OK", value, null);
    return { ok: true, outcome: "OK", value };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outcome: ToolOutcome = /quá \d+ ms/.test(message) ? "TIMEOUT" : "ERROR";
    await record(outcome, null, message);
    return { ok: false, outcome, error: message };
  }
}
