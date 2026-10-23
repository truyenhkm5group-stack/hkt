/**
 * Nối lõi `expandWithAi` vào hệ thống thật (CHỈ MÁY CHỦ): trần của tổ chức (`sourcing.limits`), số lượt đã dùng hôm nay đọc thẳng
 * sổ `platform_ai_usage` (feature 'sourcing', từ 00:00 giờ Việt Nam), chuỗi gác AI của tổ chức (`getBuilderAi`: công tắc tắt AI →
 * khoá riêng → AI nhà → credit nền tảng), hạn mức gói (`checkAiQuota`) và đường ghi sổ duy nhất (`recordAiUsage`).
 */
import { estimateCostUsd } from "@/lib/ai/provider";
import { getBuilderAi } from "@/lib/ai-builder/provider";
import { billingSourceOf } from "@/lib/ai-builder/service";
import { aiUsageByRef, recordAiUsage } from "@/lib/ai-usage/ledger";
import { checkAiQuota } from "@/lib/ai-usage/quota";
import { DEFAULT_SOURCING_LIMITS, SOURCING_LIMITS_KEY, parseSourcingLimits } from "@/lib/constants/sourcing";
import { todayVN, vnStartOfDay } from "@/lib/format";
import { currentOrganization } from "@/lib/platform/context";
import { getSettingJson } from "@/lib/settings";
import type { SourcingAiDeps } from "@/lib/sourcing/ai-expand";

export async function defaultSourcingAiDeps(actorId: string): Promise<SourcingAiDeps> {
  const [org, limits] = await Promise.all([currentOrganization(), getSettingJson<unknown>(SOURCING_LIMITS_KEY, DEFAULT_SOURCING_LIMITS).then(parseSourcingLimits)]);
  return {
    limit: limits.aiCallsPerDay,
    usedToday: async () => {
      const rows = await aiUsageByRef(org.code, ["sourcing"], vnStartOfDay(todayVN()));
      return rows.reduce((s, r) => s + r.turns, 0);
    },
    resolveAi: async () => {
      const b = await getBuilderAi();
      return b.ok ? { ok: true, provider: b.ai.provider, source: billingSourceOf(b.ai.source) } : { ok: false, reason: b.reason };
    },
    checkQuota: async (source) => {
      const q = await checkAiQuota(org.code, source);
      return q.ok ? { ok: true } : { ok: false, error: q.error };
    },
    record: async (r) => {
      await recordAiUsage({
        orgCode: org.code,
        feature: "sourcing",
        workload: "sourcing",
        source: r.source,
        provider: r.provider,
        model: r.model,
        requests: 1,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costUsd: r.usage && r.model ? estimateCostUsd(r.model, r.usage) : null,
        status: r.status,
        actorId,
        ref: "query",
      });
    },
  };
}
