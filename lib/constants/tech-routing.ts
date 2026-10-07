/**
 * ═══════════ ĐỊNH TUYẾN MODEL THEO NĂNG LỰC (Pha 6) ═══════════
 *
 * docs/tech-control-plane/README.md mục 13. Tệp THUẦN, CLIENT-SAFE. Không dùng model mạnh nhất cho mọi việc
 * (dogfood 07/10/2026: việc tài liệu R0 chạy mặc định bằng model mạnh nhất của gói, ước tính $4,19 / lượt).
 *
 * Bốn HẠNG, không phải bốn mã model: mã model đổi theo thời gian, hạng thì không. Giá trị mặc định là BÍ DANH của
 * Claude Code (`sonnet` · `opus` · `haiku`) — CLI tự phân giải sang bản mới nhất. Chủ shop đè ở `settings`
 * (`tech.model-routing`, dạng `{ "coding": "sonnet", … }`) mà không cần deploy. Logic nghiệp vụ KHÔNG BAO GIỜ đọc
 * tên model — chỉ đọc hạng.
 */
import type { TechCapability } from "@/lib/constants/tech-capabilities";

export const TECH_MODEL_TIERS = ["cheap", "coding", "reasoning", "critical"] as const;
export type TechModelTier = (typeof TECH_MODEL_TIERS)[number];

export const TECH_MODEL_TIER_LABEL: Record<TechModelTier, string> = {
  cheap: "Rẻ / đơn giản",
  coding: "Viết mã",
  reasoning: "Suy luận",
  critical: "Hệ trọng",
};

/** Hạng theo năng lực. Năng lực lạ ⇒ `coding` (không tự leo lên hạng đắt). */
export const TIER_BY_CAPABILITY: Partial<Record<TechCapability, TechModelTier>> = {
  "write-docs": "cheap",
  handoff: "cheap",
  "unit-test": "coding",
  "fix-bug": "coding",
  "implement-feature": "coding",
  "ci-debug": "coding",
  "repo-audit": "reasoning",
  "architecture-analysis": "reasoning",
};

export const DEFAULT_TIER_MODEL: Record<TechModelTier, string> = {
  cheap: "sonnet",
  coding: "sonnet",
  reasoning: "opus",
  critical: "opus",
};

/** Bí danh hoặc mã model — chữ thường, số, chấm, gạch nối. Chuỗi lạ (khoảng trắng, cờ CLI) bị bỏ, không đi xuống worker. */
export const MODEL_NAME_PATTERN = /^[a-z0-9][a-z0-9.\-]{1,62}$/;

/** Model cho một năng lực: đè hợp lệ ở `settings` thắng mặc định; đè sai hình dạng bị BỎ (rơi về mặc định). */
export function modelForCapability(capability: string, overrides: Partial<Record<string, unknown>> = {}): { tier: TechModelTier; model: string } {
  const tier = TIER_BY_CAPABILITY[capability as TechCapability] ?? "coding";
  const de = overrides[tier];
  const model = typeof de === "string" && MODEL_NAME_PATTERN.test(de) ? de : DEFAULT_TIER_MODEL[tier];
  return { tier, model };
}

export const MODEL_ROUTING_SETTING = "tech.model-routing";
