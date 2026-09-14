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
import { getAiSettings, aiEnv, type AiSettings, type ModelPrice } from "@/lib/ai/config";
import { getProvider, defaultProviderName } from "@/lib/ai/providers";
import { ModelTimeoutError, ModelUnavailableError, type ModelMessage } from "@/lib/ai/providers/types";
import { CONFIDENCE_FLOOR, type EscalationReason, type RouteTier } from "@/lib/constants/ai";

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

/**
 * Chi phí ước tính của một lần gọi, VND. `null` = CHƯA BIẾT (chưa khai đơn giá cho mô hình đó).
 * Đơn giá khai theo VND cho MỘT TRIỆU token, giống cách các nhà cung cấp niêm yết.
 */
export function estimateCostVnd(provider: string, model: string, inputTokens: number, outputTokens: number, pricing: Record<string, ModelPrice>): number | null {
  const price = pricing[`${provider}:${model}`] ?? pricing[model];
  if (!price) return null;
  const vnd = (inputTokens / 1_000_000) * price.inputVndPerMillion + (outputTokens / 1_000_000) * price.outputVndPerMillion;
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
  costVnd: number | null;
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
  const provider = getProvider(providerName);
  if (!provider || !provider.available()) {
    return { tier: "HUMAN", value: null, attempts, escalation: "MODEL_ERROR" };
  }
  const tiers = routing.tiers?.length ? routing.tiers : DEFAULT_ROUTING.tiers;
  let lastReason: EscalationReason = "MODEL_ERROR";

  for (const tier of tiers) {
    const model = routing.models?.[tier] || provider.defaultModel(tier);
    if (!model) {
      lastReason = "MODEL_ERROR";
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
      const costVnd = estimateCostVnd(result.provider, result.model, result.inputTokens, result.outputTokens, settings.pricing);
      const attempt: ModelAttempt = {
        tier,
        provider: result.provider,
        model: result.model,
        ok: true,
        step: input.step,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costVnd,
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
      attempts.push({
        tier,
        provider: providerName,
        model,
        ok: false,
        step: input.step,
        inputTokens: 0,
        outputTokens: 0,
        costVnd: null,
        latencyMs,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
      if (error instanceof ModelUnavailableError) break;
    }
  }
  return { tier: "HUMAN", value: null, attempts, escalation: lastReason };
}
