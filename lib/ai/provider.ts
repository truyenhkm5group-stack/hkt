import Anthropic from "@anthropic-ai/sdk";
import { EFFORT_BY_TIER, modelFor, resolveProviderName, type AiProviderName, type AiTier } from "@/lib/ai/router";
import { OpenAiProvider } from "@/lib/ai/providers/openai";
import { env } from "@/lib/env";
import { usdPriceFor } from "@/lib/constants/ai-model-pricing";

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

/**
 * Chi phí USD ước tính của một lượt gọi. `null` = CHƯA KHAI GIÁ, không phải 0.
 *
 * Đơn giá KHÔNG còn nằm ở tệp này. Trước đây có một bảng `PRICE_PER_MTOK` ngay đây, song song với
 * `lib/constants/ai-model-pricing.ts` của nhân sự bán hàng — hai bảng cho cùng một mô hình, và khi
 * một bên đổi giá thì hai tầng AI của cùng một shop báo hai con số khác nhau về cùng một hoá đơn.
 * Giờ cả hai đọc chung một sổ.
 */
export function estimateCostUsd(model: string, usage: AiUsage): number | null {
  const p = usdPriceFor(model);
  if (!p) return null;
  // Bốn rổ token, và hai rổ đệm là TUỲ CHỌN: chưa khai giá đệm mà lượt gọi CÓ token đệm thì chi
  // phí là CHƯA BIẾT. Lấy giá vào thường áp cho token đệm sẽ báo đắt gấp nhiều lần thực tế.
  if (usage.cacheReadTokens > 0 && p.cachedInputUsdPerMillion === undefined) return null;
  if (usage.cacheWriteTokens > 0 && p.cacheWriteUsdPerMillion === undefined) return null;
  const usd =
    (usage.inputTokens * p.inputUsdPerMillion +
      usage.outputTokens * p.outputUsdPerMillion +
      usage.cacheReadTokens * (p.cachedInputUsdPerMillion ?? 0) +
      usage.cacheWriteTokens * (p.cacheWriteUsdPerMillion ?? 0)) /
    1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic;
  constructor(model: string, private effort: "low" | "medium" | "high" = "medium", timeoutMs = 60_000) {
    this.model = model;
    // Khoá đọc từ môi trường bởi SDK (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN) — không truyền tay, không log.
    this.client = new Anthropic({ maxRetries: 2, timeout: timeoutMs });
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const started = Date.now();
    const res = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? 4000,
      // Prompt hệ thống ổn định ⇒ đệm được; phần bối cảnh thay đổi nằm trong messages.
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      thinking: { type: "adaptive" },
      output_config: { effort: this.effort },
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

const cached = new Map<AiTier, AiProvider>();
let override: AiProvider | null | undefined;

/**
 * Dựng một provider cho MỘT tên mô hình cụ thể.
 *
 * Tách ra khỏi `getAiProvider()` để thứ khác trong ERP dùng lại được đúng lớp này — cùng SDK, cùng
 * số lần thử lại, cùng cách đọc khoá — mà không phải chép một client thứ hai. Nhân sự bán hàng là
 * nơi gọi đầu tiên: nó chọn mô hình theo nấc riêng của nó, nên không dùng được `getAiProvider()`
 * vốn khoá vào ba bậc của copilot.
 */
export function makeAiProvider(name: AiProviderName, model: string, effort: "low" | "medium" | "high", timeoutMs?: number): AiProvider {
  return name === "openai" ? new OpenAiProvider(model, effort, undefined, timeoutMs) : new AnthropicProvider(model, effort, timeoutMs);
}

/** Provider cho một bậc việc — chọn theo `lib/ai/router.ts`. `null` = AI chưa cấu hình. */
export function getAiProvider(tier: AiTier = "copilot"): AiProvider | null {
  if (override !== undefined) return override;
  const hit = cached.get(tier);
  if (hit) return hit;
  const name = resolveProviderName();
  if (!name) return null;
  const effort = (env.ai.effort as "low" | "medium" | "high") || EFFORT_BY_TIER[tier];
  const p = makeAiProvider(name, modelFor(name, tier), effort);
  cached.set(tier, p);
  return p;
}
/** Chỉ cho kiểm thử: ép một provider (hoặc `null` = tắt); `undefined` = bỏ ép. */
export function setAiProviderForTests(p: AiProvider | null | undefined) {
  override = p;
  cached.clear();
}

/**
 * Thử kết nối AI cho trang Kết nối dữ liệu: một lượt gọi rẻ (bậc routine, không tool). Không trả
 * khoá; lỗi được provider SDK diễn giải (401 = khoá sai, 429 = hết hạn mức…).
 */
export async function testAiConnection(): Promise<{ provider: string; model: string; latencyMs: number; answer: string }> {
  const p = getAiProvider("routine");
  if (!p) throw new Error("AI chưa được cấu hình (thiếu OPENAI_API_KEY hoặc ANTHROPIC_API_KEY)");
  const res = await p.complete({ system: "Trả lời đúng một từ: OK", messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }], tools: [], maxTokens: 16 });
  const answer = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim().slice(0, 40);
  return { provider: p.name, model: res.model || p.model, latencyMs: res.latencyMs, answer };
}
