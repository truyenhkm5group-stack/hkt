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

export const PLATFORM_AI_ENV = { enabled: "PLATFORM_AI_ENABLED", apiKey: "PLATFORM_AI_API_KEY", model: "PLATFORM_AI_MODEL" } as const;

/** Khoá môi trường của TỔ CHỨC NHÀ — chỉ để SO (khoá nền tảng không được trùng), không bao giờ để dùng. */
const HOME_KEY_ENVS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"] as const;

export type EnvReader = (name: string) => string | undefined;

export type PlatformAiConfig = { ready: true; apiKey: string; model: string } | { ready: false; reason: string };

export const defaultEnvReader: EnvReader = (name) => process.env[name];

export function platformAiConfig(readEnv: EnvReader = defaultEnvReader): PlatformAiConfig {
  if ((readEnv(PLATFORM_AI_ENV.enabled) ?? "").trim() !== "1") return { ready: false, reason: `AI của nền tảng chưa bật (${PLATFORM_AI_ENV.enabled}≠1).` };
  const apiKey = (readEnv(PLATFORM_AI_ENV.apiKey) ?? "").trim();
  if (!apiKey) return { ready: false, reason: `AI của nền tảng bật nhưng thiếu ${PLATFORM_AI_ENV.apiKey}.` };
  for (const name of HOME_KEY_ENVS) {
    const home = (readEnv(name) ?? "").trim();
    if (home && home === apiKey) return { ready: false, reason: `${PLATFORM_AI_ENV.apiKey} trùng khoá AI của tổ chức nhà — nền tảng phải dùng tài khoản AI riêng.` };
  }
  const model = (readEnv(PLATFORM_AI_ENV.model) ?? "").trim() || MODEL_BY_TIER.anthropic.copilot;
  if (!giaCuaModel(model)) return { ready: false, reason: `Model ${model} chưa có trong bảng giá — không trừ được credit nền tảng.` };
  return { ready: true, apiKey, model };
}
