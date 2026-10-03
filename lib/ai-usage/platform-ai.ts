/**
 * ═══════════ AI DO NỀN TẢNG TRẢ TIỀN (nguồn `PLATFORM`) — CẤU HÌNH, MẶC ĐỊNH TẮT (docs/platform/ai-usage.md §2) ═══════════
 *
 * Thuần: đọc qua `readEnv` (mặc định `process.env`), không CSDL, không mạng. Nhánh PLATFORM của `getBuilderAi` chỉ mở khi
 * ĐỦ BA điều — thiếu một là KHÔNG có nhánh, và KHÔNG rơi về khoá nào khác:
 *   (a) `PLATFORM_AI_ENABLED=1` VÀ `PLATFORM_AI_API_KEY` khác rỗng (tệp này);
 *   (b) gói của tổ chức có `platformCreditUsdPerMonth > 0`;
 *   (c) còn credit tháng này (`checkAiQuota(orgCode, "PLATFORM")`).
 *
 * ─── KHOÁ NỀN TẢNG KHÁC KHOÁ CỦA NHÀ ───
 * Không bao giờ đọc `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `OPENAI_API_KEY` (khoá của VNX) cho tổ chức khác. Nếu
 * người cấu hình dán CHÍNH khoá của nhà vào `PLATFORM_AI_API_KEY` thì nhánh bị TỪ CHỐI (so khớp, không in giá trị): tiền
 * của nền tảng phải đi một tài khoản riêng để hoá đơn của VNX không gánh khách.
 *
 * ─── MODEL PHẢI CÓ GIÁ ───
 * Credit tính bằng USD; model không có trong bảng giá (`giaCuaModel`) thì không trừ được credit ⇒ nhánh TỪ CHỐI (chưa
 * biết giá ≠ miễn phí, luật 42).
 *
 * Chưa có quyết định của chủ nền tảng ⇒ không có giá trị nào của ba biến này ở `.env.example`, GitHub Secrets hay workflow
 * deploy (launch-gates.md mục D).
 */
import { giaCuaModel } from "@/lib/ai/provider";
import { MODEL_BY_TIER } from "@/lib/ai/router";

export const PLATFORM_AI_ENV = { enabled: "PLATFORM_AI_ENABLED", apiKey: "PLATFORM_AI_API_KEY", model: "PLATFORM_AI_MODEL", provider: "PLATFORM_AI_PROVIDER" } as const;

/**
 * Nhà cung cấp của khoá nền tảng (0193, docs/platform/quick-start.md). `anthropic` (mặc định — hành vi cũ) hoặc `gemini`
 * (rẻ nhất cho chatbot bán hàng: Flash-Lite ~1/10 giá Haiku). Giá trị lạ ⇒ KHÔNG sẵn sàng, không đoán.
 */
export const PLATFORM_AI_PROVIDERS = ["anthropic", "gemini"] as const;
export type PlatformAiProviderName = (typeof PLATFORM_AI_PROVIDERS)[number];
/** Model mặc định khi không khai `PLATFORM_AI_MODEL` — phải có trong bảng giá (`giaCuaModel`). */
export const PLATFORM_GEMINI_DEFAULT_MODEL = "gemini-3.5-flash-lite";

/** Khoá môi trường của TỔ CHỨC NHÀ — chỉ để SO (khoá nền tảng không được trùng), không bao giờ để dùng. */
const HOME_KEY_ENVS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY"] as const;

export type EnvReader = (name: string) => string | undefined;

export type PlatformAiConfig = { ready: true; apiKey: string; model: string; provider: PlatformAiProviderName } | { ready: false; reason: string };

export const defaultEnvReader: EnvReader = (name) => process.env[name];

export function platformAiConfig(readEnv: EnvReader = defaultEnvReader): PlatformAiConfig {
  if ((readEnv(PLATFORM_AI_ENV.enabled) ?? "").trim() !== "1") return { ready: false, reason: `AI của nền tảng chưa bật (${PLATFORM_AI_ENV.enabled}≠1).` };
  const apiKey = (readEnv(PLATFORM_AI_ENV.apiKey) ?? "").trim();
  if (!apiKey) return { ready: false, reason: `AI của nền tảng bật nhưng thiếu ${PLATFORM_AI_ENV.apiKey}.` };
  for (const name of HOME_KEY_ENVS) {
    const home = (readEnv(name) ?? "").trim();
    if (home && home === apiKey) return { ready: false, reason: `${PLATFORM_AI_ENV.apiKey} trùng khoá AI của tổ chức nhà — nền tảng phải dùng tài khoản AI riêng.` };
  }
  const providerRaw = (readEnv(PLATFORM_AI_ENV.provider) ?? "").trim().toLowerCase() || "anthropic";
  if (!(PLATFORM_AI_PROVIDERS as readonly string[]).includes(providerRaw)) return { ready: false, reason: `${PLATFORM_AI_ENV.provider}=«${providerRaw}» không hợp lệ — dùng anthropic hoặc gemini.` };
  const provider = providerRaw as PlatformAiProviderName;
  const model = (readEnv(PLATFORM_AI_ENV.model) ?? "").trim() || (provider === "gemini" ? PLATFORM_GEMINI_DEFAULT_MODEL : MODEL_BY_TIER.anthropic.copilot);
  if (!giaCuaModel(model)) return { ready: false, reason: `Model ${model} chưa có trong bảng giá — không trừ được credit nền tảng.` };
  return { ready: true, apiKey, model, provider };
}
