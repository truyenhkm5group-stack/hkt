import OpenAI, { type ClientOptions } from "openai";
import type { AiBlock, AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";

/**
 * ═══════════ OPENAI — RESPONSES API ═══════════
 *
 * Ánh xạ hình dạng tối giản của copilot sang Responses API:
 *  · system          → `instructions` (ổn định ⇒ OpenAI tự đệm prefix);
 *  · user text       → item `message` role user;
 *  · assistant text  → item `message` role assistant;
 *  · tool_use        → item `function_call` (call_id · name · arguments JSON);
 *  · tool_result     → item `function_call_output` (call_id · output).
 * Khoá API do SDK đọc từ `OPENAI_API_KEY`; không truyền tay, không log. `fetch` tiêm được để kiểm thử
 * không mạng.
 */
export class OpenAiProvider implements AiProvider {
  readonly name = "openai";
  readonly model: string;
  private client: OpenAI;
  constructor(model: string, private effort: "low" | "medium" | "high" = "medium", fetchImpl?: typeof fetch) {
    this.model = model;
    this.client = new OpenAI({ maxRetries: 2, timeout: 60_000, ...(fetchImpl ? { fetch: fetchImpl as ClientOptions["fetch"] } : {}) });
  }

  private toInput(req: AiRequest): OpenAI.Responses.ResponseInputItem[] {
    const items: OpenAI.Responses.ResponseInputItem[] = [];
    for (const m of req.messages) {
      const texts = m.content.filter((b): b is Extract<AiBlock, { type: "text" }> => b.type === "text");
      if (texts.length) items.push({ type: "message", role: m.role, content: texts.map((t) => t.text).join("\n") } as OpenAI.Responses.EasyInputMessage);
      for (const b of m.content) {
        if (b.type === "tool_use") items.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
        else if (b.type === "tool_result") items.push({ type: "function_call_output", call_id: b.toolUseId, output: b.content });
      }
    }
    return items;
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const started = Date.now();
    const res = await this.client.responses.create({
      model: this.model,
      instructions: req.system,
      input: this.toInput(req),
      max_output_tokens: req.maxTokens ?? 4000,
      reasoning: { effort: this.effort },
      // Không lưu hội thoại phía OpenAI: ERP tự giữ lịch sử và tự audit.
      store: false,
      tools: req.tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.inputSchema, strict: true })),
    });
    const content: AiBlock[] = [];
    let sawCall = false;
    for (const item of res.output) {
      if (item.type === "message") {
        const text = item.content.map((c) => (c.type === "output_text" ? c.text : "")).join("");
        if (text) content.push({ type: "text", text });
        if (item.content.some((c) => c.type === "refusal")) return { content, stopReason: "refusal", usage: usageOf(res), model: res.model, latencyMs: Date.now() - started };
      } else if (item.type === "function_call") {
        sawCall = true;
        let input: unknown = {};
        try {
          input = JSON.parse(item.arguments || "{}");
        } catch {
          input = { __raw: item.arguments };
        }
        content.push({ type: "tool_use", id: item.call_id, name: item.name, input });
      }
    }
    const stopReason: AiResponse["stopReason"] = sawCall ? "tool_use" : res.status === "incomplete" && res.incomplete_details?.reason === "max_output_tokens" ? "max_tokens" : res.status === "completed" ? "end_turn" : "other";
    return { content, stopReason, usage: usageOf(res), model: res.model, latencyMs: Date.now() - started };
  }
}

function usageOf(res: OpenAI.Responses.Response) {
  const u = res.usage;
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  return { inputTokens: Math.max(0, (u?.input_tokens ?? 0) - cached), outputTokens: u?.output_tokens ?? 0, cacheReadTokens: cached, cacheWriteTokens: 0 };
}
