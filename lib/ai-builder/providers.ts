import Anthropic, { type ClientOptions as AnthropicOptions } from "@anthropic-ai/sdk";
import OpenAI, { type ClientOptions as OpenAiOptions } from "openai";
import { anthropicCapsOf, type AiBlock, type AiProvider, type AiRequest, type AiResponse } from "@/lib/ai/provider";
import { MODEL_BY_TIER } from "@/lib/ai/router";
import { toDialectSchema, type AiSchemaDialect } from "@/lib/ai/schema-dialect";

/**
 * ═══════════ PROVIDER "MANG KHOÁ CỦA TỔ CHỨC" (Phase 8 · §1) — CHỈ MÁY CHỦ ═══════════
 *
 * Provider của lớp AI sẵn có (`lib/ai/provider.ts`) đọc khoá từ `.env` của TỔ CHỨC NHÀ và chặn mọi tổ chức khác bằng
 * `assertHomeCredentials`. AI Builder cần điều ngược lại cho tổ chức mang khoá riêng: khoá đến từ kết nối ĐÃ GIẢI MÃ
 * của CHÍNH tổ chức (`openActiveConnection`) và KHÔNG có đường nào lẫn sang môi trường của nhà:
 *
 *  · `apiKey` truyền tường minh; `authToken: null` (SDK Anthropic mặc định đọc `ANTHROPIC_AUTH_TOKEN` — gửi kèm token
 *    của nhà là để nhà trả tiền cho tổ chức khác); `organization` / `project` của OpenAI cũng `null` vì cùng lý do;
 *  · `baseURL` là HẰNG SỐ — SDK mặc định đọc `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`, tức một biến của nhà có thể
 *    đổi nơi khoá của tổ chức bị gửi tới;
 *  · model mặc định lấy từ bảng hằng `MODEL_BY_TIER` (không qua `modelFor`, vì nó đọc `AI_MODEL` của nhà).
 *
 * Hình dạng vào/ra là `AiProvider` của lớp AI sẵn có, nên phương ngữ schema (`toDialectSchema`) và bảng năng lực model
 * (`anthropicCapsOf`) là CÙNG một luật với Copilot — không có luật thứ hai.
 */

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";
/** Một lượt soạn blueprint có người đang chờ trước màn hình — hết 5 phút thì báo lỗi thay vì treo. */
export const BUILDER_TIMEOUT_MS = 300_000;

export type ByokOptions = { apiKey: string; model?: string | null; fetch?: typeof fetch };

export class ByokAnthropicProvider implements AiProvider {
  readonly name = "anthropic-byok";
  readonly model: string;
  readonly schemaDialect: AiSchemaDialect = "anthropic";
  private client: Anthropic;

  constructor(opts: ByokOptions) {
    this.model = opts.model?.trim() || MODEL_BY_TIER.anthropic.copilot;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      authToken: null,
      baseURL: ANTHROPIC_BASE_URL,
      maxRetries: 2,
      timeout: BUILDER_TIMEOUT_MS,
      ...(opts.fetch ? { fetch: opts.fetch as AnthropicOptions["fetch"] } : {}),
    });
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const started = Date.now();
    const caps = anthropicCapsOf(this.model);
    const res = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? 4000,
      system: [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }],
      ...(caps.adaptiveThinking ? { thinking: { type: "adaptive" as const } } : {}),
      ...(caps.effort ? { output_config: { effort: "medium" as const } } : {}),
      ...(caps.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      // Không `strict`: schema blueprint có ô `unknown` (trang, điều kiện) mà chế độ strict không nhận; cổng thật là
      // `validateBlueprint` ở máy chủ. Không ép `tool_choice`: câu trả lời không qua công cụ bị máy chủ BỎ.
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: toDialectSchema(t.inputSchema, this.schemaDialect) as Anthropic.Beta.BetaTool["input_schema"] })),
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
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, cacheReadTokens: res.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0 },
      model: res.model,
      latencyMs: Date.now() - started,
    };
  }
}

export class ByokOpenAiProvider implements AiProvider {
  readonly name = "openai-byok";
  readonly model: string;
  readonly schemaDialect: AiSchemaDialect = "openai";
  private client: OpenAI;

  constructor(opts: ByokOptions) {
    this.model = opts.model?.trim() || MODEL_BY_TIER.openai.copilot;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      organization: null,
      project: null,
      webhookSecret: null,
      baseURL: OPENAI_BASE_URL,
      maxRetries: 2,
      timeout: BUILDER_TIMEOUT_MS,
      ...(opts.fetch ? { fetch: opts.fetch as OpenAiOptions["fetch"] } : {}),
    });
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const started = Date.now();
    const input: OpenAI.Responses.ResponseInputItem[] = [];
    for (const m of req.messages) {
      const texts = m.content.filter((b): b is Extract<AiBlock, { type: "text" }> => b.type === "text");
      if (texts.length) input.push({ type: "message", role: m.role, content: texts.map((t) => t.text).join("\n") } as OpenAI.Responses.EasyInputMessage);
      for (const b of m.content) {
        if (b.type === "tool_use") input.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
        else if (b.type === "tool_result") input.push({ type: "function_call_output", call_id: b.toolUseId, output: b.content });
      }
    }
    const res = await this.client.responses.create({
      model: this.model,
      instructions: req.system,
      input,
      max_output_tokens: req.maxTokens ?? 4000,
      reasoning: { effort: "medium" },
      store: false,
      tools: req.tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: toDialectSchema(t.inputSchema, this.schemaDialect), strict: false })),
    });
    const content: AiBlock[] = [];
    let sawCall = false;
    for (const item of res.output) {
      if (item.type === "message") {
        const text = item.content.map((c) => (c.type === "output_text" ? c.text : "")).join("");
        if (text) content.push({ type: "text", text });
      } else if (item.type === "function_call") {
        sawCall = true;
        let parsed: unknown;
        try {
          parsed = JSON.parse(item.arguments || "{}");
        } catch {
          // JSON hỏng KHÔNG được sửa hộ: máy chủ báo lại cho AI như một lỗi của bộ kiểm.
          parsed = { __raw: String(item.arguments).slice(0, 200) };
        }
        content.push({ type: "tool_use", id: item.call_id, name: item.name, input: parsed });
      }
    }
    const u = res.usage;
    const cached = u?.input_tokens_details?.cached_tokens ?? 0;
    return {
      content,
      stopReason: sawCall ? "tool_use" : res.status === "incomplete" ? "max_tokens" : res.status === "completed" ? "end_turn" : "other",
      usage: { inputTokens: Math.max(0, (u?.input_tokens ?? 0) - cached), outputTokens: u?.output_tokens ?? 0, cacheReadTokens: cached, cacheWriteTokens: 0 },
      model: res.model,
      latencyMs: Date.now() - started,
    };
  }
}
