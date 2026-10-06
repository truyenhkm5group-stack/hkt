/**
 * ═══════════ KHÁCH NỘI BỘ VÀO GÓI THƯỜNG NHỎ NHẤT VỪA SỐ DÙNG THẬT — CHẠY THỬ MẶC ĐỊNH — CHỈ MÁY CHỦ (docs/saas/PRICING_V1.md §9) ═══════════
 *
 * VNXCommerce (tài khoản `vnxcommerce`, INTERNAL / INTERNAL_CHARGEBACK) dùng ĐÚNG gói / entitlement / đồng hồ như khách ngoài.
 * Hàm này đo số dùng THẬT của KỲ ĐÃ QUA (tháng trước, đo trọn kỳ) → `smallestFittingPlan` → in bảng kê chargeback ước tính
 * bằng CÙNG `computeOverage` của hoá đơn khách ngoài. KHÔNG tự gán trong migration, KHÔNG gán khi một số đo còn thiếu.
 *
 * `apply: true` (người vận hành, có lý do) ghi `platform_organizations.plan` của workspace (cột mà `planKeyOf` đọc — sứ mệnh
 * saas-b đưa workspace nhà về đọc đúng cột này) + ghim phiên bản giá hiện hành, nhật ký `ORG_PLAN_SET`. Không tạo hoá đơn.
 * Từ chối gán khi trần AI KỸ THUẬT của gói đích (`platform_plans.limits.ai`, lượt / tháng · trần tiền) thấp hơn số dùng AI thật
 * của kỳ đo — đổi gói không được là cách lặng lẽ chặn AI đang chạy.
 */
import { and, eq, gte, isNull, lt, ne, sql } from "drizzle-orm";
import { getDbFor, getPlatformDb, schema } from "@/db";
import { parseAiLimits, type AiLimits } from "@/lib/ai-usage/types";
import { getPlanUsage, listPlans } from "@/lib/entitlements/check";
import { platformAudit, type PlatformActor } from "@/lib/platform/audit";
import { findOrganization, getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { readFanpagesActive } from "@/lib/platform/saas-ledger";
import { readAiCustomerUsage } from "@/lib/pricing/ai-customer";
import { invalidatePricing } from "@/lib/pricing/entitlements";
import { loadPriceBook, pinOrgPriceVersion } from "@/lib/pricing/price-book";
import { computeOverage, currentCatalogVersion, smallestFittingPlan, type FitResult, type MeterCoverage, type OverageResult } from "@/lib/pricing/versions";
import { periodRange } from "@/lib/saas/ledger";

export type AiLimitCheck = { requests: number; costUsd: number; limits: AiLimits | null; wouldExceed: boolean; note: string | null };

export type InternalFitReport = {
  orgCode: string;
  periodMonth: string;
  versionKey: string | null;
  currentPlanKey: string | null;
  usage: { aiCustomers: number | null; aiCustomersCoverage: MeterCoverage; aiCustomersNote: string | null; fanpages: number | null; users: number | null; needsAiSales: boolean };
  fit: FitResult;
  /** Trần AI kỹ thuật của gói đích so với số dùng AI thật của kỳ đo. */
  aiLimits: AiLimitCheck | null;
  /** Bảng kê chargeback ƯỚC TÍNH nếu gán gói vừa tìm: giá gói + phần vượt (cùng phép tính với khách ngoài). */
  chargeback: { planVnd: number | null; overage: OverageResult | null; totalVnd: number | null } | null;
  applied: boolean;
  message: string;
};

/** Kỳ đã qua gần nhất (tháng lịch giờ VN) dạng `YYYY-MM-01`. */
export function previousPeriodMonth(now: Date): string {
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  const y = vn.getUTCMonth() === 0 ? vn.getUTCFullYear() - 1 : vn.getUTCFullYear();
  const m = vn.getUTCMonth() === 0 ? 12 : vn.getUTCMonth();
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/** Trần AI kỹ thuật của gói có chặn số dùng AI thật không — THUẦN. Trần `null` = không giới hạn. */
export function aiLimitCheck(usage: { requests: number; costUsd: number }, limits: AiLimits | null): AiLimitCheck {
  if (!limits) return { ...usage, limits, wouldExceed: false, note: "Gói đích chưa khai trần AI kỹ thuật." };
  const overReq = limits.requestsPerMonth !== null && usage.requests > limits.requestsPerMonth;
  const overCost = limits.costUsdPerMonth.hard !== null && usage.costUsd > limits.costUsdPerMonth.hard;
  const note =
    overReq || overCost
      ? `Trần AI kỹ thuật của gói (${limits.requestsPerMonth ?? "∞"} lượt / tháng · trần ${limits.costUsdPerMonth.hard ?? "∞"} USD) thấp hơn số dùng thật (${usage.requests} lượt · ${usage.costUsd.toFixed(2)} USD) — khai ghi đè AI cho tổ chức trước khi gán, không thì AI bị chặn.`
      : null;
  return { ...usage, limits, wouldExceed: overReq || overCost, note };
}

export async function planInternalFit(opts: { orgCode?: string; periodMonth?: string; now?: Date; apply?: boolean; reason?: string; actor?: PlatformActor; email?: string | null; source?: "SCRIPT" | "TEST" }): Promise<InternalFitReport> {
  const now = opts.now ?? new Date();
  const org = opts.orgCode ? await findOrganization(opts.orgCode) : await getHomeOrganization();
  if (!org) throw new Error(`Không có tổ chức «${opts.orgCode}».`);
  const periodMonth = opts.periodMonth ?? previousPeriodMonth(now);
  const range = periodRange(periodMonth);
  const book = await loadPriceBook({ fresh: true });
  const catalog = currentCatalogVersion(book, now);
  const prices = catalog ? book.prices.filter((p) => p.versionKey === catalog.key) : [];

  const pdb = await getPlatformDb();
  const subs = await pdb
    .select({ productKey: schema.platformProductSubscriptions.productKey })
    .from(schema.platformProductSubscriptions)
    .where(and(eq(schema.platformProductSubscriptions.orgCode, org.code), isNull(schema.platformProductSubscriptions.endedAt)));
  const needsAiSales = subs.some((s) => s.productKey === "chotdon");
  const ac = (await readAiCustomerUsage([org.code], range, new Date(Math.min(now.getTime(), range.to.getTime())))).get(org.code) ?? { value: null, coverage: "NOT_MEASURED" as const, note: null };
  // Số dùng chỉ được dùng khi ĐO TRỌN kỳ — cận dưới không phải số để chọn gói.
  const aiCustomers = ac.coverage === "MEASURED" ? ac.value : null;
  const users = await getPlanUsage(org.code)
    .then((u) => u.rows.find((r) => r.kind === "users")?.used ?? null)
    .catch(() => null);
  const fanpages = await getDbFor(org)
    .then((db) => readFanpagesActive(db))
    .catch(() => null);
  const usage = { aiCustomers, aiCustomersCoverage: ac.coverage, aiCustomersNote: ac.note, fanpages, users, needsAiSales };
  const fit = smallestFittingPlan({ aiCustomers, fanpages, users, needsAiSales }, prices);
  let aiLimits: AiLimitCheck | null = null;
  if (fit.plan) {
    const a = schema.platformAiUsage;
    const [ai] = await pdb
      .select({ requests: sql<number>`coalesce(sum(${a.requests}), 0)::int`, cost: sql<number>`coalesce(sum(${a.costUsd}), 0)::float8` })
      .from(a)
      .where(and(eq(a.orgCode, org.code), gte(a.at, range.from), lt(a.at, range.to), ne(a.status, "BLOCKED_QUOTA"), ne(a.billingSource, "BYOK")));
    const planRow = (await listPlans()).find((p) => p.key === fit.plan!.planKey);
    aiLimits = aiLimitCheck({ requests: Number(ai?.requests ?? 0), costUsd: Number(ai?.cost ?? 0) }, planRow ? parseAiLimits(planRow.limits).limits : null);
  }
  const chargeback = fit.plan
    ? (() => {
        const overage = computeOverage(fit.plan, { aiCustomers, aiCustomersCoverage: ac.coverage, fanpages, users, aiConversations: null, aiReplies: null });
        return { planVnd: fit.plan.monthlyVnd, overage, totalVnd: fit.plan.monthlyVnd === null || overage.totalVnd === null ? null : fit.plan.monthlyVnd + overage.totalVnd };
      })()
    : null;
  const currentPlanKey = org.plan?.trim() || null;
  const base: InternalFitReport = { orgCode: org.code, periodMonth, versionKey: catalog?.key ?? null, currentPlanKey, usage, fit, aiLimits, chargeback, applied: false, message: fit.reason };
  if (!opts.apply) return { ...base, message: `CHẠY THỬ — ${fit.reason}${aiLimits?.note ? ` · ${aiLimits.note}` : ""}` };

  const reason = (opts.reason ?? "").trim();
  if (reason.length < 5) return { ...base, message: "Không gán: cần lý do (ít nhất 5 ký tự)." };
  if (!fit.plan || !catalog) return { ...base, message: `Không gán: ${fit.reason}` };
  if (aiLimits?.wouldExceed) return { ...base, message: `Không gán: ${aiLimits.note}` };
  if (currentPlanKey === fit.plan.planKey) return { ...base, message: `Đã ở gói «${fit.plan.name}» — không đổi gì.` };
  const target = fit.plan;
  const t = schema.platformOrganizations;
  const won = await pdb.transaction(async (tx) => {
    // Ghi CÓ ĐIỀU KIỆN theo gói vừa đọc — hai người bấm cùng lúc thì lượt sau không đè im lặng.
    const rows = await tx
      .update(t)
      .set({ plan: target.planKey, updatedAt: now })
      .where(and(eq(t.code, org.code), currentPlanKey === null ? isNull(t.plan) : eq(t.plan, currentPlanKey)))
      .returning({ id: t.id });
    if (!rows.length) return false;
    await pinOrgPriceVersion(org.code, catalog.key, { source: opts.source === "TEST" ? "TEST" : "OPERATOR", reason, email: opts.email ?? null, tx });
    return true;
  });
  invalidateOrganizations();
  invalidatePricing(org.code);
  if (!won) return { ...base, message: "Không gán: gói vừa được người khác đổi — chạy thử lại." };
  await platformAudit({ action: "ORG_PLAN_SET", targetOrgCode: org.code, subject: "plan", before: { plan: currentPlanKey }, after: { plan: target.planKey, priceVersionKey: catalog.key, usage, chargebackVnd: chargeback?.totalVnd ?? null }, reason, source: opts.source ?? "SCRIPT", actor: opts.actor ?? null });
  return { ...base, applied: true, message: `Đã gán «${org.code}» vào gói «${target.name}» (phiên bản ${catalog.key}).` };
}
