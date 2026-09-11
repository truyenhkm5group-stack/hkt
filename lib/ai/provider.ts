import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";

/**
 * ═══════════ LỚP PROVIDER — AI LAYER KHÔNG KHOÁ VÀO MỘT MODEL ═══════════
 *
 * Copilot chỉ nói chuyện với `AiProvider` bằng các hình dạng tối giản dưới đây (text · tool_use ·
 * tool_result). Bản Anthropic ánh xạ sang SDK chính thức; bản Fake dùng cho kiểm thử và benchmark.
 * Thêm provider khác = thêm một file, không đụng copilot.
 */

export type AiToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };

export type AiBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export type AiMessage = { role: "user" | "assistant"; content: AiBlock[] };

export type AiUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

export type AiRequest = { system: string; messages: AiMessage[]; tools: AiToolDef[]; maxTokens?: number };

export type AiResponse = { content: AiBlock[]; stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other"; usage: AiUsage; model: string; latencyMs: number };

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  complete(req: AiRequest): Promise<AiResponse>;
}

/** Giá USD / 1M token — bảng trong mã để ước tính chi phí; không phải hoá đơn. */
const PRICE_PER_MTOK: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export function estimateCostUsd(model: string, usage: AiUsage): number {
  const p = PRICE_PER_MTOK[model] ?? PRICE_PER_MTOK["claude-opus-5"];
  const usd = (usage.inputTokens * p.input + usage.outputTokens * p.output + usage.cacheReadTokens * p.cacheRead + usage.cacheWriteTokens * p.cacheWrite) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic;
  constructor(model = env.ai.model) {
    this.model = model;
    // Khoá đọc từ môi trường bởi SDK (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN) — không truyền tay, không log.
    this.client = new Anthropic({ maxRetries: 2, timeout: 60_000 });
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const started = Date.now();
    const res = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? 4000,
      // Prompt hệ thống ổn định ⇒ đệm được; phần bối cảnh thay đổi nằm trong messages.
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      thinking: { type: "adaptive" },
      output_config: { effort: (env.ai.effort as "low" | "medium" | "high" | "xhigh" | "max") ?? "medium" },
      // Từ chối vì chính sách ⇒ máy chủ tự chạy lại trên model dự phòng trong cùng một lần gọi.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Beta.BetaTool["input_schema"], strict: true })),
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content.map((b) =>
          b.type === "text"
            ? ({ type: "text", text: b.text } as const)
            : b.type === "tool_use"
              ? ({ type: "tool_use", id: b.id, name: b.name, input: b.input } as const)
              : ({ type: "tool_result", tool_use_id: b.toolUseId, content: b.content, is_error: b.isError ?? false } as const),
        ),
      })),
    });
    const content: AiBlock[] = [];
    for (const block of res.content) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      else if (block.type === "tool_use") content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
    }
    const stop = res.stop_reason;
    return {
      content,
      stopReason: stop === "end_turn" || stop === "tool_use" || stop === "max_tokens" || stop === "refusal" ? stop : "other",
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      },
      model: res.model,
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * Provider giả cho kiểm thử / benchmark: trả lời theo kịch bản, đếm được số lần gọi, đo được chi
 * phí vòng lặp của chính copilot (không tính mạng).
 */
export class FakeProvider implements AiProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  calls: AiRequest[] = [];
  constructor(private script: ((req: AiRequest, round: number) => AiResponse | Omit<AiResponse, "usage" | "model" | "latencyMs">)[] = []) {}
  async complete(req: AiRequest): Promise<AiResponse> {
    const round = this.calls.length;
    this.calls.push(req);
    const step = this.script[round] ?? this.script[this.script.length - 1];
    const out = step ? step(req, round) : { content: [{ type: "text" as const, text: "(fake) không có kịch bản" }], stopReason: "end_turn" as const };
    return { usage: { inputTokens: 1200, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: this.model, latencyMs: 0, ...out };
  }
}

let cached: AiProvider | null = null;
export function getAiProvider(): AiProvider | null {
  if (cached) return cached;
  if (env.ai.provider === "off" || !env.ai.configured) return null;
  cached = new AnthropicProvider();
  return cached;
}
/** Chỉ cho kiểm thử. */
export function setAiProviderForTests(p: AiProvider | null) {
  cached = p;
}
