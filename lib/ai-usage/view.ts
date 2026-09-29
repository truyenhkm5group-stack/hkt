/**
 * ═══════════ DỮ LIỆU MÀN HÌNH DÙNG AI (docs/platform/ai-usage.md §5) — CHỈ MÁY CHỦ, CHỈ ĐỌC ═══════════
 *
 *  · `/settings/plan` — tổ chức xem sổ của CHÍNH mình (mã tổ chức lấy từ PHIÊN, không từ URL).
 *  · `/platform/org/<mã>` + `/platform` — người vận hành nền tảng; kiểm `platformOperatorDenial` Ở ĐÂY (hàm nhìn xuyên
 *    ranh giới tổ chức), không chỉ ở trang.
 * Không trả prompt, câu trả lời, khoá hay email — chỉ số đếm, model, nguồn, trạng thái. Tiền chưa biết là `null`.
 */
import type { SessionUser } from "@/lib/auth/session";
import { listOrganizations } from "@/lib/platform/organizations";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { AI_CONTROL_CACHE_MS, aiKillSwitchDenial, readOrgAiControl, readPlatformAiSwitch, type OrgAiControl, type PlatformAiSwitch } from "@/lib/ai-usage/control";
import { aiUsageDaily, aiUsageOverview, sourceUsage, topOrgsByAiCost, type AiTopOrgRow, type AiUsageDayRow, type AiUsageTotals } from "@/lib/ai-usage/ledger";
import { PLATFORM_AI_ENV, platformAiConfig } from "@/lib/ai-usage/platform-ai";
import { resolveAiLimits, type ResolvedAiLimits } from "@/lib/ai-usage/quota";
import type { AiBillingSource, AiSourceUsage } from "@/lib/ai-usage/types";

export type OrgAiUsageView = {
  orgCode: string;
  limits: ResolvedAiLimits;
  disabledReason: string | null;
  today: AiUsageTotals[];
  month: AiUsageTotals[];
  /** Mức dùng đang đem so với hạn mức, theo nguồn tính hạn mức (BYOK · PLATFORM). */
  quotaUsage: Record<Exclude<AiBillingSource, "HOME">, AiSourceUsage>;
  cacheSeconds: number;
};

export async function loadOrgAiUsage(orgCode: string, now: Date = new Date()): Promise<OrgAiUsageView> {
  const [limits, disabledReason, overview, byok, platform] = await Promise.all([
    resolveAiLimits(orgCode),
    aiKillSwitchDenial(orgCode),
    aiUsageOverview(orgCode, now),
    sourceUsage(orgCode, "BYOK", now),
    sourceUsage(orgCode, "PLATFORM", now),
  ]);
  return { orgCode, limits, disabledReason, today: overview.today, month: overview.month, quotaUsage: { BYOK: byok, PLATFORM: platform }, cacheSeconds: Math.round(AI_CONTROL_CACHE_MS / 1000) };
}

export type OperatorOrgAiView = OrgAiUsageView & { control: OrgAiControl; daily: AiUsageDayRow[] };

export async function loadOperatorOrgAi(user: SessionUser, orgCode: string, now: Date = new Date()): Promise<{ ok: true; value: OperatorOrgAiView } | { ok: false; error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { ok: false, error: denial };
  const [base, control, daily] = await Promise.all([loadOrgAiUsage(orgCode, now), readOrgAiControl(orgCode, { fresh: true }), aiUsageDaily(orgCode, 31, now)]);
  return { ok: true, value: { ...base, control, daily } };
}

export type PlatformAiSummary = {
  platformSwitch: PlatformAiSwitch;
  /** Nhánh nền tảng có sẵn sàng không — chỉ cờ + lý do, không bao giờ giá trị khoá. */
  platformProvider: { ready: boolean; reason: string | null; envNames: typeof PLATFORM_AI_ENV };
  top: (AiTopOrgRow & { orgName: string | null })[];
  cacheSeconds: number;
};

export async function loadPlatformAiSummary(user: SessionUser, now: Date = new Date()): Promise<{ ok: true; value: PlatformAiSummary } | { ok: false; error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { ok: false, error: denial };
  const [platformSwitch, top, orgs] = await Promise.all([readPlatformAiSwitch({ fresh: true }), topOrgsByAiCost(10, now), listOrganizations()]);
  const cfg = platformAiConfig();
  return {
    ok: true,
    value: {
      platformSwitch,
      platformProvider: { ready: cfg.ready, reason: cfg.ready ? null : cfg.reason, envNames: PLATFORM_AI_ENV },
      top: top.map((r) => ({ ...r, orgName: orgs.find((o) => o.code === r.orgCode)?.name ?? null })),
      cacheSeconds: Math.round(AI_CONTROL_CACHE_MS / 1000),
    },
  };
}
