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

/** `name` chỉ đổi NHÃN (vd `anthropic-platform` cho khoá của nền tảng) — đường gửi, địa chỉ, cách đọc khoá giữ nguyên. */
export type ByokOptions = { apiKey: string; model?: string | null; fetch?: typeof fetch; name?: string };

export class ByokAnthropicProvider implements AiProvider {
  readonly name: string;
  readonly model: string;
  readonly schemaDialect: AiSchemaDialect = "anthropic";
  private client: Anthropic;

  constructor(opts: ByokOptions) {
    this.name = opts.name ?? "anthropic-byok";
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
      reasoning: { effort: req.reasoning ?? "medium" },
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

/**
 * ═══════════ GEMINI (Google AI Studio) — KHOÁ CỦA TỔ CHỨC (01/10/2026) ═══════════
 *
 * Chủ nền tảng: bot fanpage của tổ chức nhà chạy `gemini-2.5-flash-lite` (container `chatbot/`) đủ tốt và rẻ (~25 ₫ / tin trả
 * lời đo trên production), trong khi bot của tổ chức khách trên OpenAI vừa đắt vừa kém. Provider này gọi THẲNG REST
 * `generateContent` (không SDK — cùng hàng rào: địa chỉ HẰNG, khoá truyền tường minh qua header `x-goog-api-key`, không bao
 * giờ đọc biến môi trường của nhà, không theo chuyển hướng).
 *
 *  · Hội thoại: `assistant` ⇒ `model`; `tool_use` ⇒ `functionCall`; `tool_result` ⇒ `functionResponse` (tên tool tra theo
 *    `toolUseId`). Lượt liền nhau cùng vai GỘP thành một (Gemini đòi xen kẽ).
 *  · Gemini 2.5 trả `thoughtSignature` kèm `functionCall` khi có suy luận và đòi GỬI LẠI nguyên văn ở lượt sau — lưu trong
 *    `id` của khối `tool_use` (sau dấu `|`), vì `AiBlock` không có ô riêng.
 *  · Mức suy luận: dòng `gemini-2.5-flash*` nhận `thinkingBudget` (low = 0 — tắt, medium = 1024, high = 4096); dòng
 *    `gemini-3*` nhận `thinkingLevel` (low · medium · high — không tắt hẳn được). Google trả 400 vì cấu hình suy nghĩ ⇒ gửi
 *    lại MỘT lần KHÔNG kèm cấu hình đó (mặc định của Google) thay vì làm hỏng lượt chat. Model khác để mặc định.
 *  · Model mặc định `gemini-3.5-flash-lite` (02/10/2026: khoá Gemini MỚI gọi `gemini-2.5-flash-lite` nhận 404 «no longer
 *    available to new users», Google chỉ sang 3.5-flash-lite).
 *  · Schema tool: Gemini nhận TẬP CON OpenAPI (không `additionalProperties`…) ⇒ giữ đúng các khoá nó nhận (`toGeminiSchema`).
 *  · Quá tải (429 / 500 / 503 — log bot nhà đầy «Gemini 503 high demand») ⇒ thử lại sau 2 giây · 4 giây rồi mới báo lỗi.
 */
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash-lite";

/** Cấu hình suy nghĩ theo dòng model. HÀM THUẦN. */
export function geminiThinkingConfig(model: string, reasoning: AiRequest["reasoning"]): Record<string, unknown> | null {
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: reasoning === "high" ? 4096 : reasoning === "medium" ? 1024 : 0 };
  if (/^gemini-3/.test(model) && reasoning) return { thinkingLevel: reasoning };
  return null;
}
const GEMINI_SCHEMA_KEYS = new Set(["type", "description", "enum", "properties", "required", "items", "format", "nullable", "minimum", "maximum"]);
const GEMINI_RETRY_MS = [2_000, 4_000];
const GEMINI_TIMEOUT_MS = 120_000;

/** JSON Schema ⇒ tập con Gemini nhận được. HÀM THUẦN. */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue;
    if (k === "properties" && v && typeof v === "object") out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    else if (k === "items") out[k] = toGeminiSchema(v);
    else out[k] = v;
  }
  return out;
}

type GeminiPart = { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { name?: string; args?: unknown }; functionResponse?: { name: string; response: Record<string, unknown> } };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };
type GeminiResponse = { candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[]; usageMetadata?: Record<string, number>; modelVersion?: string; error?: { message?: string } };

/** Hội thoại của ERP ⇒ `contents` của Gemini. HÀM THUẦN (bài kiểm gọi thẳng). */
export function toGeminiContents(messages: AiRequest["messages"]): GeminiContent[] {
  const names = new Map<string, string>();
  const out: GeminiContent[] = [];
  for (const m of messages) {
    const parts: GeminiPart[] = [];
    for (const b of m.content) {
      if (b.type === "text") {
        if (b.text) parts.push({ text: b.text });
      } else if (b.type === "tool_use") {
        names.set(b.id, b.name);
        const bar = b.id.indexOf("|");
        parts.push({ functionCall: { name: b.name, args: b.input ?? {} }, ...(bar > 0 ? { thoughtSignature: b.id.slice(bar + 1) } : {}) });
      } else {
        let response: unknown;
        try {
          response = JSON.parse(b.content);
        } catch {
          response = b.content;
        }
        parts.push({ functionResponse: { name: names.get(b.toolUseId) ?? "tool", response: response && typeof response === "object" && !Array.isArray(response) ? (response as Record<string, unknown>) : { content: response } } });
      }
    }
    if (!parts.length) continue;
    const role = m.role === "assistant" ? "model" : "user";
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  }
  return out;
}

export class ByokGeminiProvider implements AiProvider {
  readonly name = "gemini-byok";
  readonly model: string;
  readonly schemaDialect: AiSchemaDialect = "openai";
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ByokOptions & { sleep?: (ms: number) => Promise<void> }) {
    this.model = opts.model?.trim() || GEMINI_DEFAULT_MODEL;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const started = Date.now();
    const thinkingConfig = geminiThinkingConfig(this.model, req.reasoning);
    const generationConfig: Record<string, unknown> = { maxOutputTokens: req.maxTokens ?? 4000, ...(thinkingConfig ? { thinkingConfig } : {}) };
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: toGeminiContents(req.messages),
      generationConfig,
      ...(req.tools.length ? { tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.inputSchema) })) }] } : {}),
    };
    const url = `${GEMINI_BASE_URL}/models/${encodeURIComponent(this.model)}:generateContent`;
    let data = null as GeminiResponse | null;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey }, body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS) });
      data = (await res.json().catch(() => null)) as GeminiResponse | null;
      if (res.ok) break;
      if ([429, 500, 503].includes(res.status) && attempt < GEMINI_RETRY_MS.length) {
        await this.sleep(GEMINI_RETRY_MS[attempt]);
        continue;
      }
      if (res.status === 400 && "thinkingConfig" in generationConfig && /thinking/i.test(String(data?.error?.message ?? ""))) {
        delete generationConfig.thinkingConfig;
        continue;
      }
      throw new Error(`Gemini trả lỗi HTTP ${res.status}: ${String(data?.error?.message ?? "").slice(0, 300).split(this.apiKey).join("…")}`);
    }
    const cand = data?.candidates?.[0];
    const content: AiBlock[] = [];
    let calls = 0;
    for (const [i, p] of (cand?.content?.parts ?? []).entries()) {
      if (p.functionCall?.name) {
        calls += 1;
        const id = `g${i}_${Math.random().toString(36).slice(2, 10)}${p.thoughtSignature ? `|${p.thoughtSignature}` : ""}`;
        content.push({ type: "tool_use", id, name: p.functionCall.name, input: p.functionCall.args ?? {} });
      } else if (typeof p.text === "string" && p.text && !p.thought) content.push({ type: "text", text: p.text });
    }
    const u = data?.usageMetadata ?? {};
    const cached = Number(u.cachedContentTokenCount ?? 0);
    return {
      content,
      stopReason: calls ? "tool_use" : cand?.finishReason === "MAX_TOKENS" ? "max_tokens" : cand?.finishReason === "SAFETY" ? "refusal" : "end_turn",
      usage: { inputTokens: Math.max(0, Number(u.promptTokenCount ?? 0) - cached), outputTokens: Number(u.candidatesTokenCount ?? 0) + Number(u.thoughtsTokenCount ?? 0), cacheReadTokens: cached, cacheWriteTokens: 0 },
      model: data?.modelVersion || this.model,
      latencyMs: Date.now() - started,
    };
  }
}
