/**
 * Nhà cung cấp Google Gemini (Generative Language API) — THÁCH THỨC, KHÔNG PHỤC VỤ KHÁCH.
 *
 * Tệp này chỉ dựng ĐƯỜNG GỌI. Việc nó không bao giờ nằm trên đường trả lời khách được khoá ở chỗ
 * khác và khoá bằng danh sách, không bằng thiện chí: `SHADOW_ONLY_PROVIDERS` trong
 * `lib/ai-workforce/config.ts` — `defaultProviderName()` không trả về nó, biến môi trường không
 * khai được nó, và `runModelStep()` từ chối nó ngay cả khi cấu hình định tuyến của một bản nhân sự
 * gọi đích danh.
 *
 * BÍ MẬT: khoá chỉ đọc từ biến môi trường. Kho mã này là PUBLIC.
 *
 * ─── BA CHỖ DỄ BÁO SAI TIỀN, ĐỀU NẰM Ở `usageMetadata` ───
 *
 * Gemini đếm token khác Anthropic, và chép thẳng ba con số sang bốn rổ của hợp đồng là báo sai
 * hoá đơn theo cả hai chiều:
 *
 *   1. `promptTokenCount` ĐÃ BAO GỒM `cachedContentTokenCount`. Đưa nguyên nó vào rổ "đầu vào
 *      tính đủ giá" là tính tiền đủ giá cho phần token đang được giảm giá — báo ĐẮT hơn thực tế.
 *   2. `thoughtsTokenCount` (token suy luận) được tính tiền theo GIÁ ĐẦU RA nhưng KHÔNG nằm trong
 *      `candidatesTokenCount`. Bỏ qua nó là báo RẺ hơn thực tế, và ở các mẫu có suy luận thì phần
 *      bỏ sót ấy lớn hơn phần trả lời.
 *   3. Bộ đệm ngầm của Gemini KHÔNG tính tiền lượt ghi. Rổ `cacheWriteInputTokens` vì vậy là 0
 *      THẬT — khác hẳn "chưa biết" — nên để 0 ở đây là một lời khẳng định đúng, không phải một
 *      giá trị mặc định che chỗ trống.
 */
import { aiEnv } from "@/lib/ai-workforce/config";
import type { RouteTier } from "@/lib/constants/ai";
import {
  ModelTimeoutError,
  ModelUnavailableError,
  type CompletionRequest,
  type CompletionResult,
  type ModelProvider,
} from "@/lib/ai-workforce/providers/types";

type GeminiUsage = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
};
type GeminiPart = { text?: string };
type GeminiCandidate = { content?: { parts?: GeminiPart[] }; finishReason?: string };
type GeminiResponse = {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsage;
  modelVersion?: string;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
};

/** Số không âm; thiếu trường ⇒ 0. Ở đây 0 là "nhà cung cấp không báo rổ này", không phải chỗ trống. */
function dem(value: number | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export class GoogleProvider implements ModelProvider {
  /** Tên này đi vào `ai_model_calls.provider` và khoá tra bảng giá `google:<mẫu>`. */
  readonly name = "google";

  available() {
    return Boolean(aiEnv.googleApiKey) && Boolean(aiEnv.googleEconomyModel || aiEnv.googleStrongModel);
  }

  defaultModel(tier: RouteTier) {
    return tier === "STRONG" ? aiEnv.googleStrongModel : tier === "ECONOMY" ? aiEnv.googleEconomyModel : "";
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const key = aiEnv.googleApiKey;
    if (!key) throw new ModelUnavailableError("Google: chưa cấu hình GOOGLE_AI_API_KEY");
    if (!request.model) throw new ModelUnavailableError("Google: chưa cấu hình tên mô hình (AI_MODEL_GOOGLE_ECONOMY / AI_MODEL_GOOGLE_STRONG)");

    let response: Response;
    try {
      response = await fetch(`${aiEnv.googleBaseUrl}/v1beta/models/${encodeURIComponent(request.model)}:generateContent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Khoá đi ở HEADER, không ở chuỗi truy vấn: URL bị ghi vào nhật ký proxy và nhật ký lỗi.
          "x-goog-api-key": key,
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: request.system }] },
          // Gemini gọi lượt của trợ lý là `model`; gửi `assistant` thì API từ chối cả yêu cầu.
          contents: request.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
          generationConfig: {
            maxOutputTokens: request.maxOutputTokens,
            ...(request.json ? { responseMimeType: "application/json" } : {}),
          },
        }),
        signal: AbortSignal.timeout(request.timeoutMs),
        cache: "no-store",
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new ModelTimeoutError(`Google: quá ${request.timeoutMs} ms không phản hồi`);
      }
      throw new ModelUnavailableError(`Google: không kết nối được (${error instanceof Error ? error.message : String(error)})`);
    }

    const text = await response.text();
    let body: GeminiResponse = {};
    try {
      body = JSON.parse(text) as GeminiResponse;
    } catch {
      throw new Error(`Google: phản hồi không phải JSON (HTTP ${response.status})`);
    }
    if (!response.ok) throw new Error(`Google: HTTP ${response.status} ${body.error?.message ?? ""}`.trim());

    // Bị chặn vì chính sách nội dung là MỘT LOẠI RIÊNG, không phải "trả lời rỗng": để bộ định tuyến
    // coi đó là sai lược đồ rồi leo nấc là trả tiền thêm một lượt cho câu mà mô hình đã từ chối.
    const blocked = body.promptFeedback?.blockReason;
    if (blocked) throw new ModelUnavailableError(`Google: bị chặn (${blocked})`);

    const usage = body.usageMetadata ?? {};
    const cached = dem(usage.cachedContentTokenCount);
    const prompt = dem(usage.promptTokenCount);

    return {
      text: (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim(),
      // TRỪ phần đệm ra khỏi phần tính đủ giá (điểm 1 ở đầu tệp). Kẹp sàn 0 phòng khi nhà cung cấp
      // báo hai con số không nhất quán — token âm thì phép nhân giá ra một khoản tiền ÂM.
      inputTokens: Math.max(0, prompt - cached),
      // CỘNG token suy luận vào đầu ra (điểm 2 ở đầu tệp).
      outputTokens: dem(usage.candidatesTokenCount) + dem(usage.thoughtsTokenCount),
      cacheReadInputTokens: cached,
      cacheWriteInputTokens: 0,
      // Tên mô hình THẬT API báo về — bảng giá tra theo cái này, không theo cái đã yêu cầu.
      model: body.modelVersion || request.model,
      provider: this.name,
    };
  }
}
