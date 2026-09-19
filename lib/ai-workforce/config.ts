/**
 * Cấu hình nền tảng nhân sự AI: cờ tính năng, nấc quyền hạn, đơn giá mô hình.
 *
 * BA TẦNG, hẹp thắng rộng: mặc định trong mã → biến môi trường → bảng `settings` (khoá `ai.config`).
 * Mọi nhánh lỗi (JSON hỏng, khoá lạ, CSDL không đọc được) đều rơi về phía HẸP HƠN — không lần
 * triển khai nào được biến thành một con bot tự nhắn khách vì một tệp cấu hình sai.
 */
import { AI_CONFIG_KEY, clampMode, DEFAULT_AI_FLAGS, SAFEST_HARD_LIMITS, type AgentMode, type AiFeatureFlags, type AiHardLimits, AGENT_MODES } from "@/lib/constants/ai";
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

/**
 * Đơn giá một mô hình, VND cho MỘT TRIỆU token.
 *
 * BỐN RỔ TOKEN, ba mức giá khác nhau — gộp lại là báo sai tiền:
 *   • `input`       token đầu vào tính đủ giá
 *   • `cachedRead`  token đọc lại từ bộ nhớ đệm của nhà cung cấp (rẻ hơn nhiều)
 *   • `cacheWrite`  token ghi vào bộ nhớ đệm (đắt hơn giá đầu vào một chút)
 *   • `output`      token sinh ra
 *
 * Hai rổ đệm là TUỲ CHỌN. Không khai mà lượt chạy có token đệm ⇒ chi phí lượt đó là CHƯA BIẾT
 * (`null`), không phải "tính phần biết được rồi bỏ qua phần còn lại".
 */
export type ModelPrice = {
  inputVndPerMillion: number;
  outputVndPerMillion: number;
  cachedReadVndPerMillion?: number;
  cacheWriteVndPerMillion?: number;
};

export type AiSettings = AiFeatureFlags & {
  /** Nấc quyền hạn ghi đè theo từng nhân sự (`{ sales: "SHADOW" }`). */
  modes: Record<string, AgentMode>;
  /** Đơn giá theo `provider:model`. Thiếu = chi phí null. */
  pricing: Record<string, ModelPrice>;
  /**
   * Chặn cứng cấp môi trường. ĐỌC TỪ `process.env`, KHÔNG BAO GIỜ từ bảng `settings` — xem
   * `AiHardLimits`. Bộ làm sạch cấu hình bên dưới cố tình không đụng tới khoá này.
   */
  hardLimits: AiHardLimits;
  /**
   * PHIÊN BẢN bảng giá đang dùng. Ghi vào từng lượt chạy để một lần đổi giá không làm mọi con số
   * lịch sử đổi nghĩa mà không ai biết. Rỗng = chưa khai giá.
   */
  pricingVersion: string;
};

/**
 * Tên các nhà cung cấp mà nhân sự AI thật sự có (khớp `lib/ai-workforce/providers/index.ts`).
 *
 * Khai ở đây chứ không đọc ngược từ sổ đăng ký nhà cung cấp: sổ ấy import `aiEnv`, nên đọc ngược
 * là một vòng phụ thuộc. Bài kiểm khoá hai danh sách phải khớp nhau.
 */
export const WORKFORCE_PROVIDERS = ["stub", "erp", "anthropic"] as const;

/**
 * Nhà cung cấp CHỈ ĐƯỢC DÙNG Ở BÓNG — đo được, so sánh được, nhưng KHÔNG BAO GIỜ trả lời khách.
 *
 * Đây không phải một cái nhãn nhắc nhở: nó là cái khoá. Ba chỗ cùng đọc danh sách này, và một chỗ
 * bị bỏ sót là đủ để một mô hình chưa ai chấm chất lượng nói chuyện với người mua thật:
 *
 *   1. `aiEnv.provider` — biến môi trường không khai được tên nằm trong danh sách này, nên một
 *      dòng `AI_WORKFORCE_PROVIDER=google` gõ nhầm không đổi được đường chạy.
 *   2. `defaultProviderName()` — không bao giờ tự chọn tên trong danh sách này, kể cả khi đó là
 *      nhà cung cấp duy nhất có khoá.
 *   3. `runModelStep()` — từ chối ngay cả khi cấu hình định tuyến của một bản nhân sự gọi đích
 *      danh, vì cấu hình ấy nằm trong CSDL và sửa được từ màn hình.
 *
 * Bộ so sánh nhiều nhà cung cấp vẫn gọi được chúng: nó đi thẳng qua `getProvider()` chứ không qua
 * đường phục vụ khách, và đó chính là ranh giới cần giữ.
 */
export const SHADOW_ONLY_PROVIDERS = ["google"] as const;

/** Tất cả tên nhà cung cấp có thật — hai danh sách trên KHÔNG được giao nhau (có bài kiểm). */
export const ALL_PROVIDERS = [...WORKFORCE_PROVIDERS, ...SHADOW_ONLY_PROVIDERS] as const;

export function isShadowOnlyProvider(name: string): boolean {
  return (SHADOW_ONLY_PROVIDERS as readonly string[]).includes(name);
}

export const aiEnv = {
  /**
   * NHÀ CUNG CẤP KHAI TAY — rỗng nghĩa là "để hệ thống tự chọn".
   *
   * Chỉ đọc `AI_WORKFORCE_PROVIDER`. KHÔNG đọc `AI_PROVIDER` nữa: biến ấy thuộc về tầng AI của ERP
   * (`lib/ai/router.ts`) với MỘT BỘ GIÁ TRỊ KHÁC (`auto | openai | anthropic | off`), và hai hệ
   * cùng đọc một biến là hai hệ cùng hiểu sai. Cầu nối `erp` đọc thẳng biến ấy qua chính bộ định
   * tuyến của ERP, nên nhân sự AI không cần diễn giải lại nó.
   *
   * Việc chọn mặc định nằm ở `providers/index.ts::defaultProviderName()`: tầng ERP trước, khoá
   * riêng sau, `stub` cuối cùng.
   */
  get provider() {
    const rieng = readEnv("AI_WORKFORCE_PROVIDER");
    return (WORKFORCE_PROVIDERS as readonly string[]).includes(rieng) ? rieng : "";
  },
  /**
   * Khoá RIÊNG của nhân sự AI — chỉ dùng cho nhà cung cấp `anthropic` viết tay, và đó nay là
   * ĐƯỜNG LUI. Đường chính là tầng AI của ERP với khoá đang chạy thật cho AI Copilot.
   */
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
  /**
   * Khoá Google — RIÊNG, và cố ý không dùng chung với bất cứ khoá nào đang phục vụ khách. Có khoá
   * này KHÔNG bật được Gemini lên đường trả lời khách (xem `SHADOW_ONLY_PROVIDERS`); nó chỉ mở
   * đường cho bộ so sánh ở bóng.
   */
  get googleApiKey() {
    return readEnv("GOOGLE_AI_API_KEY");
  },
  get googleBaseUrl() {
    return readEnv("GOOGLE_AI_BASE_URL", "https://generativelanguage.googleapis.com").replace(/\/$/, "");
  },
  /** Tên mô hình Gemini KHÔNG ghi cứng trong mã — chọn mẫu nào là quyết định của người vận hành. */
  get googleEconomyModel() {
    return readEnv("AI_MODEL_GOOGLE_ECONOMY");
  },
  get googleStrongModel() {
    return readEnv("AI_MODEL_GOOGLE_STRONG");
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
  /**
   * CẦU DAO NHÀ CUNG CẤP — TẮT mặc định.
   *
   * Bật lên là đổi hành vi đường chạy thật: các lượt gọi tới một nhà cung cấp đang bị coi là hỏng
   * sẽ bị BỎ QUA. Đó là điều đúng nên làm, nhưng nó phải do người bật sau khi đọc số đo, không
   * phải tự có hiệu lực vì một lượt phát hành — nhất là khi đang có phiên soát chạy trên bản chạy
   * thử. Khi tắt, số đo VẪN tích luỹ, nên đọc được "nếu bật thì đã bỏ qua bao nhiêu lượt" trước
   * khi bật.
   */
  get circuitBreakerEnabled() {
    return readEnvBool("AI_CIRCUIT_BREAKER_ENABLED", false);
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
  /**
   * CHẶN CỨNG. Mặc định CẤM, và chỉ đúng một chuỗi mở được: `"true"`. Không nhận `1`, `yes`, `on`
   * — một công tắc mà gõ kiểu gì cũng bật được là một công tắc sẽ bị bật nhầm.
   */
  get hardLimits(): AiHardLimits {
    const bat = (name: string) => readEnv(name).toLowerCase() === "true";
    /*
      CỜ CŨ `AI_ALLOW_CUSTOMER_SEND` CHỈ CÒN NGHĨA "NHÂN VIÊN BẤM GỬI".

      Nó từng gộp cả hai nghĩa. Mọi môi trường đang chạy đều đặt nó `false`, nên cách quy đổi này
      không mở thêm gì cho ai. Nhưng nếu một ngày có người bật nó lên để nhân viên gửi được, thì
      nghĩa "máy tự gửi" KHÔNG đi kèm — muốn máy tự gửi phải gõ đúng `AI_ALLOW_AUTO_SEND=true`,
      một cái tên không thể bật nhầm mà không biết mình đang bật gì.

      Nói cách khác: cờ cũ chỉ đi được về phía HẸP HƠN nghĩa nó từng có.
    */
    return {
      allowAutoSend: bat("AI_ALLOW_AUTO_SEND"),
      allowHumanApprovedSend: bat("AI_ALLOW_HUMAN_APPROVED_SEND") || bat("AI_ALLOW_CUSTOMER_SEND"),
      allowOrderCreate: bat("AI_ALLOW_ORDER_CREATE"),
    };
  },
};

function sanitizeMode(value: unknown, fallback: AgentMode): AgentMode {
  const raw = String(value ?? "").toUpperCase();
  return (AGENT_MODES as readonly string[]).includes(raw) ? clampMode(raw as AgentMode) : fallback;
}

/** Đơn giá tuỳ chọn: chỉ nhận khi là số hợp lệ; sai kiểu ⇒ `undefined` (CHƯA KHAI), không ⇒ 0. */
function optionalPrice(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
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
    out[key] = {
      inputVndPerMillion: input,
      outputVndPerMillion: output,
      cachedReadVndPerMillion: optionalPrice(price.cachedReadVndPerMillion),
      cacheWriteVndPerMillion: optionalPrice(price.cacheWriteVndPerMillion),
    };
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
    // `settings` đè biến môi trường, y như `modelCallsEnabled`: bật/tắt cầu dao là một quyết định
    // VẬN HÀNH, và bắt người vận hành phải triển khai lại container để thử tắt nó là cái giá sai.
    circuitBreakerEnabled:
      typeof stored.circuitBreakerEnabled === "boolean" ? stored.circuitBreakerEnabled : aiEnv.circuitBreakerEnabled,
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
  const pricing = sanitizePricing(stored.pricing);
  const declaredVersion = typeof stored.pricingVersion === "string" ? stored.pricingVersion.trim() : "";
  return {
    ...flags,
    modes,
    pricing,
    // Đọc thẳng từ môi trường. `stored` KHÔNG được tham gia vào dòng này — đó là toàn bộ ý nghĩa
    // của "chặn cứng", và `tests/sales-agent.test.ts` khoá lại điều đó.
    hardLimits: aiEnv.hardLimits,
    // Có bảng giá mà quên đặt tên phiên bản thì vẫn phải có một nhãn đọc được, nếu không hai kỳ
    // khác giá sẽ trông giống hệt nhau khi đọc lại.
    pricingVersion: declaredVersion || (Object.keys(pricing).length ? "chua-dat-ten" : ""),
  };
}

/**
 * Nấc quyền hạn có hiệu lực của một nhân sự AI: dòng CSDL → ghi đè trong settings → mặc định env,
 * và luôn bị kẹp dưới trần `MAX_ALLOWED_MODE`. Tắt tổng thì trả `OFF` bất kể khai gì.
 */
export { SAFEST_HARD_LIMITS };

export function effectiveMode(agentKey: string, dbMode: string | null | undefined, settings: AiSettings): AgentMode {
  if (!settings.enabled) return "OFF";
  const override = settings.modes[agentKey];
  if (override) return override;
  return sanitizeMode(dbMode, aiEnv.defaultMode);
}
