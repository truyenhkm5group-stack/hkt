/**
 * Cấu hình nền tảng nhân sự AI: cờ tính năng, nấc quyền hạn, đơn giá mô hình.
 *
 * BA TẦNG, hẹp thắng rộng: mặc định trong mã → biến môi trường → bảng `settings` (khoá `ai.config`).
 * Mọi nhánh lỗi (JSON hỏng, khoá lạ, CSDL không đọc được) đều rơi về phía HẸP HƠN — không lần
 * triển khai nào được biến thành một con bot tự nhắn khách vì một tệp cấu hình sai.
 */
import { AI_CONFIG_KEY, clampMode, DEFAULT_AI_FLAGS, type AgentMode, type AiFeatureFlags, AGENT_MODES } from "@/lib/constants/ai";
import { getSettingJson } from "@/lib/settings";

function readEnv(name: string, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readEnvInt(name: string, fallback: number) {
  const value = Number(readEnv(name));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readEnvBool(name: string, fallback: boolean) {
  const value = readEnv(name).toLowerCase();
  if (!value) return fallback;
  return value === "1" || value === "true" || value === "yes";
}

/** Đơn giá một mô hình, VND cho MỘT TRIỆU token. Không khai = chi phí CHƯA BIẾT (null). */
export type ModelPrice = { inputVndPerMillion: number; outputVndPerMillion: number };

export type AiSettings = AiFeatureFlags & {
  /** Nấc quyền hạn ghi đè theo từng nhân sự (`{ sales: "SHADOW" }`). */
  modes: Record<string, AgentMode>;
  /** Đơn giá theo `provider:model`. Thiếu = chi phí null. */
  pricing: Record<string, ModelPrice>;
};

export const aiEnv = {
  /** Nhà cung cấp mô hình mặc định. `stub` = không gọi mạng, dùng cho kiểm thử và khi chưa có khoá. */
  get provider() {
    return readEnv("AI_PROVIDER", "stub");
  },
  get apiKey() {
    return readEnv("AI_API_KEY") || readEnv("ANTHROPIC_API_KEY");
  },
  get baseUrl() {
    return readEnv("AI_BASE_URL", "https://api.anthropic.com").replace(/\/$/, "");
  },
  /** Tên mô hình KHÔNG được ghi cứng trong logic — chỉ đọc từ đây. */
  get economyModel() {
    return readEnv("AI_MODEL_ECONOMY");
  },
  get strongModel() {
    return readEnv("AI_MODEL_STRONG");
  },
  get timeoutMs() {
    return readEnvInt("AI_TIMEOUT_MS", 20_000);
  },
  get maxOutputTokens() {
    return readEnvInt("AI_MAX_OUTPUT_TOKENS", 1_024);
  },
  /** Nấc quyền hạn mặc định khi CSDL chưa có dòng nhân sự nào. */
  get defaultMode(): AgentMode {
    const raw = readEnv("AI_DEFAULT_MODE", "SHADOW").toUpperCase();
    return (AGENT_MODES as readonly string[]).includes(raw) ? clampMode(raw as AgentMode) : "SHADOW";
  },
  get modelCallsEnabled() {
    return readEnvBool("AI_MODEL_CALLS_ENABLED", false);
  },
  /** Hội thoại được phép nhận tin thật để kiểm thử vòng khép kín (một mã, phân tách bằng dấu phẩy). */
  get testConversationIds() {
    return readEnv("AI_TEST_CONVERSATION_IDS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  },
  /** Bí mật trong URL webhook chat Pancake. Rỗng = webhook đóng (401), không phải mở toang. */
  get chatWebhookSecret() {
    return readEnv("PANCAKE_CHAT_WEBHOOK_SECRET");
  },
};

function sanitizeMode(value: unknown, fallback: AgentMode): AgentMode {
  const raw = String(value ?? "").toUpperCase();
  return (AGENT_MODES as readonly string[]).includes(raw) ? clampMode(raw as AgentMode) : fallback;
}

function sanitizePricing(value: unknown): Record<string, ModelPrice> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, ModelPrice> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const price = raw as Record<string, unknown>;
    const input = Number(price.inputVndPerMillion);
    const output = Number(price.outputVndPerMillion);
    // Đơn giá không hợp lệ thì BỎ khoá đó đi: thà chi phí "chưa biết" còn hơn một con số bịa.
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue;
    out[key] = { inputVndPerMillion: input, outputVndPerMillion: output };
  }
  return out;
}

/** Đọc cấu hình đã hợp nhất. Không cache: cấu hình an toàn phải có hiệu lực ngay khi đổi. */
export async function getAiSettings(): Promise<AiSettings> {
  const stored = await getSettingJson<Record<string, unknown>>(AI_CONFIG_KEY, {}).catch(() => ({}) as Record<string, unknown>);
  const flags: AiFeatureFlags = {
    enabled: typeof stored.enabled === "boolean" ? stored.enabled : DEFAULT_AI_FLAGS.enabled,
    modelCallsEnabled: typeof stored.modelCallsEnabled === "boolean" ? stored.modelCallsEnabled : aiEnv.modelCallsEnabled,
    ingestEnabled: typeof stored.ingestEnabled === "boolean" ? stored.ingestEnabled : DEFAULT_AI_FLAGS.ingestEnabled,
    maxRunsPerHour: Number.isFinite(Number(stored.maxRunsPerHour)) && Number(stored.maxRunsPerHour) > 0 ? Number(stored.maxRunsPerHour) : DEFAULT_AI_FLAGS.maxRunsPerHour,
    dailyCostCapVnd: Number.isFinite(Number(stored.dailyCostCapVnd)) && Number(stored.dailyCostCapVnd) >= 0 ? Number(stored.dailyCostCapVnd) : DEFAULT_AI_FLAGS.dailyCostCapVnd,
    testConversationIds: Array.isArray(stored.testConversationIds)
      ? stored.testConversationIds.map((v) => String(v).trim()).filter(Boolean)
      : aiEnv.testConversationIds,
  };
  const modes: Record<string, AgentMode> = {};
  if (stored.modes && typeof stored.modes === "object") {
    for (const [key, value] of Object.entries(stored.modes as Record<string, unknown>)) modes[key] = sanitizeMode(value, aiEnv.defaultMode);
  }
  return { ...flags, modes, pricing: sanitizePricing(stored.pricing) };
}

/**
 * Nấc quyền hạn có hiệu lực của một nhân sự AI: dòng CSDL → ghi đè trong settings → mặc định env,
 * và luôn bị kẹp dưới trần `MAX_ALLOWED_MODE`. Tắt tổng thì trả `OFF` bất kể khai gì.
 */
export function effectiveMode(agentKey: string, dbMode: string | null | undefined, settings: AiSettings): AgentMode {
  if (!settings.enabled) return "OFF";
  const override = settings.modes[agentKey];
  if (override) return override;
  return sanitizeMode(dbMode, aiEnv.defaultMode);
}
