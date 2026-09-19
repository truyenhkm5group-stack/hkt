/**
 * BỘ ĐỊNH TUYẾN MÔ HÌNH — leo nấc RULE → ECONOMY → STRONG → HUMAN.
 *
 * Dây chuyền gọi bộ này với một BƯỚC (`understand`, `generate`…) và một lược đồ kết quả mong đợi.
 * Bộ định tuyến lo phần còn lại: chọn nhà cung cấp, đặt trần thời gian, kiểm lược đồ đầu ra, ghi
 * token / chi phí / độ trễ, và leo nấc khi nấc dưới không kết luận được.
 *
 * HAI ĐIỀU PHẢI GIỮ
 *
 * 1. Hết nấc mà vẫn không có kết quả hợp lệ thì kết luận là `HUMAN` — CHUYỂN NGƯỜI, không phải
 *    "trả về giá trị mặc định". Một giá trị mặc định ở đây là một lời khẳng định bịa ra.
 * 2. Chi phí là ƯỚC TÍNH và có thể là CHƯA BIẾT (`null`). Chưa khai đơn giá cho một mô hình thì
 *    chi phí lượt đó là `null`, không phải 0đ — y hệt luật tiền của ERP.
 */
import { z } from "zod";
import { getAiSettings, aiEnv, type AiSettings, type ModelPrice } from "@/lib/ai-workforce/config";
import { getLiveProvider, defaultProviderName } from "@/lib/ai-workforce/providers";
import { ModelTimeoutError, ModelUnavailableError, type ModelMessage } from "@/lib/ai-workforce/providers/types";
import { CONFIDENCE_FLOOR, type EscalationReason, type RouteTier } from "@/lib/constants/ai";
import { normalizeProviderError } from "@/lib/constants/provider-health";
import { circuitEnabled, recordFailure, recordSuccess, shouldSkip } from "@/lib/ai-workforce/circuit";

/** Cấu hình định tuyến của một bản nhân sự (lưu ở `ai_agent_versions.routing`). */
export type RoutingConfig = {
  provider?: string;
  models?: Partial<Record<RouteTier, string>>;
  /** Nấc mô hình được phép dùng, theo thứ tự leo. Rỗng = chỉ chạy nấc luật. */
  tiers?: RouteTier[];
  maxOutputTokens?: number;
  timeoutMs?: number;
};

export const DEFAULT_ROUTING: Required<Pick<RoutingConfig, "tiers">> & RoutingConfig = {
  tiers: ["ECONOMY", "STRONG"],
};

export function parseRouting(raw: unknown): RoutingConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_ROUTING };
  const value = raw as Record<string, unknown>;
  const tiers = Array.isArray(value.tiers) ? (value.tiers.filter((t) => t === "ECONOMY" || t === "STRONG") as RouteTier[]) : DEFAULT_ROUTING.tiers;
  const models: Partial<Record<RouteTier, string>> = {};
  if (value.models && typeof value.models === "object") {
    for (const [k, v] of Object.entries(value.models as Record<string, unknown>)) {
      if ((k === "ECONOMY" || k === "STRONG") && typeof v === "string" && v.trim()) models[k] = v.trim();
    }
  }
  return {
    provider: typeof value.provider === "string" && value.provider.trim() ? value.provider.trim() : undefined,
    models,
    tiers,
    maxOutputTokens: Number.isFinite(Number(value.maxOutputTokens)) ? Number(value.maxOutputTokens) : undefined,
    timeoutMs: Number.isFinite(Number(value.timeoutMs)) ? Number(value.timeoutMs) : undefined,
  };
}

/** Bốn rổ token của một lần gọi mô hình. */
export type TokenUsage = { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheWriteInputTokens: number };

/**
 * Chi phí ước tính của một lần gọi, VND. `null` = CHƯA BIẾT.
 *
 * Trả `null` trong HAI trường hợp, và cả hai đều là "chưa biết" chứ không phải "bằng 0":
 *   1. Mô hình chưa có trong bảng giá.
 *   2. Lần gọi CÓ token đệm nhưng bảng giá chưa khai đơn giá cho rổ đệm đó. Lấy giá đầu vào
 *      thường áp cho token đệm sẽ báo đắt gấp mười lần thực tế; bỏ qua chúng thì báo rẻ hơn thực
 *      tế. Cả hai đều là một con số bịa, nên câu trả lời đúng là CHƯA BIẾT.
 *
 * Đơn giá khai theo VND cho MỘT TRIỆU token, giống cách các nhà cung cấp niêm yết.
 */
export function estimateCostVnd(provider: string, model: string, usage: TokenUsage, pricing: Record<string, ModelPrice>): number | null {
  const price = pricing[`${provider}:${model}`] ?? pricing[model];
  if (!price) return null;
  if (usage.cacheReadInputTokens > 0 && price.cachedReadVndPerMillion === undefined) return null;
  if (usage.cacheWriteInputTokens > 0 && price.cacheWriteVndPerMillion === undefined) return null;
  const vnd =
    (usage.inputTokens / 1_000_000) * price.inputVndPerMillion +
    (usage.outputTokens / 1_000_000) * price.outputVndPerMillion +
    (usage.cacheReadInputTokens / 1_000_000) * (price.cachedReadVndPerMillion ?? 0) +
    (usage.cacheWriteInputTokens / 1_000_000) * (price.cacheWriteVndPerMillion ?? 0);
  // Tiền trong ERP là số nguyên VND; làm tròn lên để không bao giờ báo rẻ hơn thực tế.
  return Math.ceil(vnd);
}

export type ModelAttempt = {
  tier: RouteTier;
  provider: string;
  model: string;
  ok: boolean;
  step: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costVnd: number | null;
  /** Bảng giá nào đã ra con số trên. Rỗng = chưa khai giá ⇒ `costVnd` phải là null. */
  pricingVersion: string;
  latencyMs: number;
  error: string | null;
};

export type RouteOutcome<T> =
  | { tier: RouteTier; value: T; attempts: ModelAttempt[]; escalation: EscalationReason | null }
  | { tier: "HUMAN"; value: null; attempts: ModelAttempt[]; escalation: EscalationReason };

export type ModelStepInput<T> = {
  /** Tên bước trong dây chuyền — ghi vào sổ chi phí để đọc được tiền đi đâu. */
  step: string;
  system: string;
  messages: ModelMessage[];
  /** Lược đồ kết quả. Mô hình trả sai lược đồ = KHÔNG có kết quả, không phải "gần đúng". */
  schema: z.ZodType<T>;
  routing: RoutingConfig;
  /** Đọc độ tin từ kết quả đã hợp lệ; dưới ngưỡng thì leo nấc tiếp. */
  confidenceOf?: (value: T) => number | null;
  settings?: AiSettings;
};

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Mô hình hay bọc JSON trong ```json … ``` hoặc kèm lời dẫn; cắt lấy khối ngoặc đầu tiên.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.search(/[[{]/);
  if (start < 0) throw new Error("Không tìm thấy JSON trong phản hồi");
  const body = candidate.slice(start);
  return JSON.parse(body);
}

/**
 * Chạy một bước cần mô hình, leo nấc cho tới khi có kết quả hợp lệ hoặc hết nấc.
 * Không bao giờ ném: mọi thất bại đều thành `tier: "HUMAN"` kèm lý do đọc được.
 */
export async function runModelStep<T>(input: ModelStepInput<T>): Promise<RouteOutcome<T>> {
  const settings = input.settings ?? (await getAiSettings());
  const attempts: ModelAttempt[] = [];
  if (!settings.enabled || !settings.modelCallsEnabled) {
    return { tier: "HUMAN", value: null, attempts, escalation: "POLICY_REQUIRES_HUMAN" };
  }
  const routing = input.routing;
  const providerName = routing.provider || defaultProviderName();
  // ĐƯỜNG PHỤC VỤ KHÁCH ⇒ `getLiveProvider`: nhà cung cấp chỉ-ở-bóng trả về null ở đây, kể cả khi
  // `routing.provider` gọi đích danh nó. Cấu hình định tuyến nằm trong CSDL và sửa được từ màn
  // hình, nên nó KHÔNG phải một thẩm quyền đủ để đưa một mô hình chưa ai chấm ra trước mặt khách.
  const provider = getLiveProvider(providerName);
  if (!provider || !provider.available()) {
    // CHƯA CẤU HÌNH khác hẳn MÔ HÌNH LỖI: một cái là thiếu khoá / thiếu tên mô hình (việc của
    // người vận hành), cái kia là nhà cung cấp hỏng (việc của nhà cung cấp). Gộp hai lý do lại
    // thì màn hình quan sát không nói được phải đi sửa ở đâu.
    return { tier: "HUMAN", value: null, attempts, escalation: "MODEL_NOT_CONFIGURED" };
  }
  const tiers = routing.tiers?.length ? routing.tiers : DEFAULT_ROUTING.tiers;
  let lastReason: EscalationReason = "MODEL_ERROR";

  /*
    CẦU DAO — hỏi TRƯỚC khi gọi, không phải sau khi hỏng.

    Nhà cung cấp vừa hỏng theo một nhóm lỗi mà thử lại là vô ích (hết hạn mức, khoá sai) thì lượt
    này bỏ qua luôn, và kết luận là CHUYỂN NGƯỜI — đúng cái kết luận mà lượt gọi kia sẽ dẫn tới,
    chỉ khác là không tốn một lượt gọi mạng và một khoảng chờ của khách.

    `shouldSkip()` trả `false` khi cầu dao đang TẮT nhưng vẫn ĐẾM, nên số đo tích luỹ trước khi ai
    bật nó. Không có nhánh nào ở đây biết tên một nhà cung cấp nào.
  */
  if (shouldSkip(providerName)) {
    return { tier: "HUMAN", value: null, attempts, escalation: "MODEL_NOT_CONFIGURED" };
  }

  for (const tier of tiers) {
    const model = routing.models?.[tier] || provider.defaultModel(tier);
    if (!model) {
      lastReason = "MODEL_NOT_CONFIGURED";
      continue;
    }
    const startedAt = Date.now();
    try {
      const result = await provider.complete({
        model,
        system: input.system,
        messages: input.messages,
        maxOutputTokens: routing.maxOutputTokens ?? aiEnv.maxOutputTokens,
        timeoutMs: routing.timeoutMs ?? aiEnv.timeoutMs,
        json: true,
      });
      const latencyMs = Date.now() - startedAt;
      const costVnd = estimateCostVnd(result.provider, result.model, result, settings.pricing);
      const attempt: ModelAttempt = {
        tier,
        provider: result.provider,
        model: result.model,
        ok: true,
        step: input.step,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cachedInputTokens: result.cacheReadInputTokens,
        costVnd,
        pricingVersion: costVnd === null ? "" : settings.pricingVersion,
        latencyMs,
        error: null,
      };
      let parsed: T;
      try {
        parsed = input.schema.parse(extractJson(result.text));
      } catch (error) {
        attempt.ok = false;
        attempt.error = `Sai lược đồ: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`;
        attempts.push(attempt);
        lastReason = "SCHEMA_INVALID";
        continue;
      }
      attempts.push(attempt);
      // Gọi được VÀ đúng lược đồ ⇒ nhà cung cấp khoẻ, đóng cầu dao lại nếu nó đang mở.
      recordSuccess(result.provider);
      recordSuccess(providerName);
      const confidence = input.confidenceOf?.(parsed) ?? null;
      if (confidence !== null && confidence < CONFIDENCE_FLOOR.MODEL) {
        lastReason = "LOW_CONFIDENCE";
        continue;
      }
      return { tier, value: parsed, attempts, escalation: attempts.length > 1 ? lastReason : null };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const timeout = error instanceof ModelTimeoutError;
      lastReason = timeout ? "MODEL_TIMEOUT" : "MODEL_ERROR";
      /*
        Phân loại lời lỗi rồi GHI NHỚ. Phân loại bằng chính bộ chuẩn hoá mà phép dò sức khoẻ dùng,
        nên hai chỗ không bao giờ nói hai điều khác nhau về cùng một lời lỗi.

        Ghi nhớ kể cả khi cầu dao đang tắt: số đo phải có sẵn để đọc TRƯỚC khi quyết định bật.
      */
      const nhomLoi = normalizeProviderError({
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : undefined,
      });
      recordFailure(providerName, nhomLoi);
      attempts.push({
        tier,
        provider: providerName,
        model,
        ok: false,
        step: input.step,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        // Lần gọi hỏng: KHÔNG biết nhà cung cấp có tính tiền token đã nhận hay không ⇒ CHƯA BIẾT.
        costVnd: null,
        pricingVersion: "",
        latencyMs,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
      /*
        HAI LÝ DO DỪNG HẲN, không leo nấc tiếp:

        · `ModelUnavailableError` — như trước.
        · Cầu dao vừa mở vì một nhóm lỗi mà thử lại vô ích. Leo lên nấc MẠNH của CÙNG một nhà cung
          cấp đã hết hạn mức thì cũng hết hạn mức — nấc là chuyện của mô hình, hạn mức là chuyện
          của tài khoản. Chỉ dừng khi cầu dao đang BẬT: khi tắt thì giữ nguyên hành vi cũ từng
          dòng một, để việc bật/tắt là thứ duy nhất đổi hành vi.
      */
      if (error instanceof ModelUnavailableError) break;
      if (circuitEnabled() && shouldSkip(providerName)) break;
    }
  }
  return { tier: "HUMAN", value: null, attempts, escalation: lastReason };
}
