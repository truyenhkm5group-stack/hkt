/**
 * Nhà cung cấp Anthropic (Messages API).
 *
 * BÍ MẬT: khoá chỉ đọc từ biến môi trường, không bao giờ đi vào nhật ký, lời dặn hay CSDL.
 * Kho mã này là PUBLIC — một lần lộ là lộ vĩnh viễn.
 *
 * Tên mô hình KHÔNG ghi cứng trong logic nghiệp vụ: nó đến từ cấu hình định tuyến của bản nhân sự
 * hoặc biến môi trường, nên đổi mô hình không phải sửa mã.
 */
import { aiEnv } from "@/lib/ai/config";
import type { RouteTier } from "@/lib/constants/ai";
import { ModelTimeoutError, ModelUnavailableError, type CompletionRequest, type CompletionResult, type ModelProvider } from "@/lib/ai/providers/types";

/** Tên trường theo Messages API: bốn rổ token, ba mức giá. */
type AnthropicUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
type AnthropicContent = { type?: string; text?: string };
type AnthropicResponse = { content?: AnthropicContent[]; usage?: AnthropicUsage; model?: string; error?: { message?: string } };

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";

  available() {
    return Boolean(aiEnv.apiKey);
  }

  defaultModel(tier: RouteTier) {
    return tier === "STRONG" ? aiEnv.strongModel : aiEnv.economyModel;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.available()) throw new ModelUnavailableError("Anthropic: chưa cấu hình AI_API_KEY");
    if (!request.model) throw new ModelUnavailableError("Anthropic: chưa cấu hình tên mô hình (AI_MODEL_ECONOMY / AI_MODEL_STRONG)");
    let response: Response;
    try {
      response = await fetch(`${aiEnv.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": aiEnv.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: AbortSignal.timeout(request.timeoutMs),
        cache: "no-store",
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new ModelTimeoutError(`Anthropic: quá ${request.timeoutMs} ms không phản hồi`);
      }
      throw new ModelUnavailableError(`Anthropic: không kết nối được (${error instanceof Error ? error.message : String(error)})`);
    }
    const text = await response.text();
    let body: AnthropicResponse = {};
    try {
      body = JSON.parse(text) as AnthropicResponse;
    } catch {
      throw new Error(`Anthropic: phản hồi không phải JSON (HTTP ${response.status})`);
    }
    if (!response.ok) throw new Error(`Anthropic: HTTP ${response.status} ${body.error?.message ?? ""}`.trim());
    const content = (body.content ?? []).filter((c) => c.type === "text" || typeof c.text === "string");
    return {
      text: content.map((c) => c.text ?? "").join("").trim(),
      inputTokens: Number(body.usage?.input_tokens ?? 0),
      outputTokens: Number(body.usage?.output_tokens ?? 0),
      cacheReadInputTokens: Number(body.usage?.cache_read_input_tokens ?? 0),
      cacheWriteInputTokens: Number(body.usage?.cache_creation_input_tokens ?? 0),
      model: body.model || request.model,
      provider: this.name,
    };
  }
}
