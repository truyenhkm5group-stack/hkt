import { env } from "@/lib/env";

/**
 * ═══════════ CHỌN PROVIDER + MODEL Ở MỘT CHỖ ═══════════
 *
 * Không rải chuỗi model khắp mã. Ba bậc việc:
 *  · `routine`  — phân loại, tóm tắt rẻ, việc lặp (rẻ, nhanh);
 *  · `copilot`  — trợ lý ERP thường ngày (mặc định của hộp thoại);
 *  · `analysis` — phân tích cho chủ shop, suy luận khó (đắt, chậm).
 *
 * Provider chọn theo `AI_PROVIDER`: `openai` · `anthropic` · `off` · `auto` (mặc định): dùng OpenAI
 * nếu có `OPENAI_API_KEY`, không thì Anthropic nếu có `ANTHROPIC_API_KEY`, không thì tắt.
 * `AI_MODEL` (nếu đặt) ghi đè bậc `copilot` của provider đang dùng.
 */

export type AiTier = "routine" | "copilot" | "analysis";
export type AiProviderName = "openai" | "anthropic";

export const MODEL_BY_TIER: Record<AiProviderName, Record<AiTier, string>> = {
  openai: { routine: "gpt-5.6-luna", copilot: "gpt-5.6-terra", analysis: "gpt-5.6-sol" },
  anthropic: { routine: "claude-haiku-4-5", copilot: "claude-opus-5", analysis: "claude-opus-5" },
};

/** Mức suy luận theo bậc — cùng một thang cho cả hai provider. */
export const EFFORT_BY_TIER: Record<AiTier, "low" | "medium" | "high"> = { routine: "low", copilot: "medium", analysis: "high" };

export function resolveProviderName(): AiProviderName | null {
  const want = env.ai.provider;
  if (want === "off") return null;
  if (want === "openai") return env.ai.openaiConfigured ? "openai" : null;
  if (want === "anthropic") return env.ai.anthropicConfigured ? "anthropic" : null;
  // auto
  if (env.ai.openaiConfigured) return "openai";
  if (env.ai.anthropicConfigured) return "anthropic";
  return null;
}

export function modelFor(provider: AiProviderName, tier: AiTier): string {
  if (tier === "copilot" && env.ai.model) return env.ai.model;
  return MODEL_BY_TIER[provider][tier];
}

/** Lý do AI đang tắt — để UI và trang Kết nối nói đúng secret nào còn thiếu. */
export function aiDisabledReason(): string | null {
  if (resolveProviderName()) return null;
  if (env.ai.provider === "off") return "AI_PROVIDER=off";
  if (env.ai.provider === "openai") return "Thiếu OPENAI_API_KEY";
  if (env.ai.provider === "anthropic") return "Thiếu ANTHROPIC_API_KEY";
  return "Chưa có OPENAI_API_KEY (hoặc ANTHROPIC_API_KEY) trên máy chủ";
}
