/**
 * ═══════════ MÀN KHÁCH: GÓI · KỲ · SỐ DÙNG THEO ĐƠN VỊ DỄ HIỂU — CHỈ MÁY CHỦ ═══════════
 *
 * Đọc cho `/settings/plan` của CHÍNH tổ chức người xem (mã tổ chức do trang lấy từ PHIÊN). Khách thấy: gói, giá tháng / năm,
 * ngày gia hạn, "3.245 / 5.000 hội thoại AI" + phần trăm + mức, tính năng gói có. Khách KHÔNG thấy token, model hay chi phí
 * AI của nền tảng — đó là việc của người vận hành (`lib/pricing/admin.ts`).
 *
 * Trang có khung nào là `loadPlanPageFrame` — hai vị từ, không hỏi loại tài khoản (Phase 14 · review PR #622):
 *  · khung THANH TOÁN hiện khi workspace CÓ THỂ bị khoá thanh toán — CÙNG vị từ với cổng ghi (`billingLockApplies`);
 *  · khung HẠN MỨC THÁNG hiện khi có khung thanh toán, hoặc khi gói đang gán còn một ô hạn mức có trần (ô `checkUsageQuota`
 *    thật sự so). Nhà mang gói không trần nào ⇒ không khung, như trước; gán cho nhà một gói có trần ⇒ khung tự hiện.
 */
import { readSubscriptionTerms } from "@/lib/billing/standing";
import { billingStanding, vnDate } from "@/lib/billing/rules";
import { findOrganization } from "@/lib/platform/organizations";
import { readPeriodUsage } from "@/lib/platform/usage-meter";
import { getPlanUsage } from "@/lib/entitlements/check";
import { monthlyOnYearlyVnd, yearlyPriceVnd, type QuotaKey } from "@/lib/pricing/catalog";
import { evaluateQuota, usageLine, type QuotaVerdict } from "@/lib/pricing/guard";
import { featureGranted, FEATURE_KEYS, type FeatureDecision } from "@/lib/pricing/features";
import { readGuardConfig, resolveOrgPricing, QUOTA_METER, type OrgPricing } from "@/lib/pricing/entitlements";
import { usagePeriodOf } from "@/lib/pricing/meter";
import { billingLockApplies } from "@/lib/saas/policy";

export type CustomerQuotaRow = QuotaVerdict & { line: string };

export type CustomerPlanView = {
  planName: string;
  priceVnd: number | null;
  yearlyPriceVnd: number | null;
  monthlyOnYearlyVnd: number | null;
  /** Ngày gia hạn = ngày cuối đã trả (`paid_through`); `null` = chưa thu phí. */
  paidThrough: string | null;
  periodLabel: string;
  resetsOn: string;
  measuredAt: string;
  quotas: CustomerQuotaRow[];
  features: FeatureDecision[];
  /** Câu lỗi khi một nguồn đếm hỏng — số của nguồn đó in «—». */
  errors: string[];
};

export type PlanPageFrame = { billing: boolean; monthlyQuotas: boolean };

/** Hai vị từ của trang gói — thuần (xem đầu tệp). */
export function planPageFrame(org: Parameters<typeof billingLockApplies>[0], pricing: Pick<OrgPricing, "quotas">): PlanPageFrame {
  const billing = billingLockApplies(org);
  const capped = Object.values(pricing.quotas).some((q) => typeof q === "number");
  return { billing, monthlyQuotas: billing || capped };
}

/** Khung của trang `/settings/plan` cho một workspace. Không có workspace ⇒ không khung nào. */
export async function loadPlanPageFrame(orgCode: string): Promise<PlanPageFrame> {
  const org = await findOrganization(orgCode);
  if (!org) return { billing: false, monthlyQuotas: false };
  return planPageFrame(org, await resolveOrgPricing(org));
}

export async function loadCustomerPlan(orgCode: string, now: Date = new Date()): Promise<CustomerPlanView | null> {
  const org = await findOrganization(orgCode);
  if (!org) return null;
  const pricing = await resolveOrgPricing(org);
  if (!planPageFrame(org, pricing).monthlyQuotas) return null;
  const [config, terms, planUsage] = await Promise.all([readGuardConfig(), readSubscriptionTerms(org.code), getPlanUsage(org.code)]);
  const period = usagePeriodOf(now);
  const usage = await readPeriodUsage(org, period, now);
  const c = pricing.plan?.commercial;
  const usersUsed = planUsage.rows.find((r) => r.kind === "users")?.used ?? null;
  const keys: QuotaKey[] = ["aiConversations", "aiMessages", "orders", "fanpages", "users"];
  const quotas = keys.map((key) => {
    const used = key === "users" ? usersUsed : usage.readings[QUOTA_METER[key]];
    const v = evaluateQuota({ key, used, included: pricing.quotas[key], policy: c?.overage.policy ?? "SOFT_ONLY", unitPriceVnd: key === "users" ? null : (c?.overage.unitPricesVnd[key] ?? null), graceAllowancePct: c?.overage.graceAllowancePct ?? 0, limitMode: c?.limitModes[key] ?? "SOFT", enforcement: pricing.row.enforcement, config });
    return { ...v, line: usageLine(key, used, pricing.quotas[key]) };
  });
  const standing = billingStanding(terms, vnDate(now));
  return {
    planName: pricing.plan?.name ?? "—",
    priceVnd: pricing.plan?.priceVnd ?? null,
    yearlyPriceVnd: yearlyPriceVnd(pricing.plan?.priceVnd ?? null, pricing.plan?.yearlyFreeMonths ?? 0),
    monthlyOnYearlyVnd: monthlyOnYearlyVnd(pricing.plan?.priceVnd ?? null, pricing.plan?.yearlyFreeMonths ?? 0),
    paidThrough: standing.kind === "NOT_BILLED" ? (terms?.paidThrough ?? null) : standing.paidThrough,
    periodLabel: period.label,
    resetsOn: period.resetsOn,
    measuredAt: usage.measuredAt,
    quotas,
    features: FEATURE_KEYS.map((key) => featureGranted({ key, grandfathered: pricing.row.grandfathered, overrides: pricing.row.featureOverrides, planFeatures: c?.features ?? null })),
    errors: usage.errors,
  };
}
