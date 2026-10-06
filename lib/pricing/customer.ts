/**
 * ═══════════ MÀN KHÁCH: GÓI · KỲ · SỐ DÙNG THEO ĐƠN VỊ DỄ HIỂU — CHỈ MÁY CHỦ ═══════════
 *
 * Đọc cho `/settings/plan` của CHÍNH tổ chức người xem (mã tổ chức do trang lấy từ PHIÊN). Khách thấy: gói, giá tháng / năm,
 * ngày gia hạn, "3.245 / 5.000 hội thoại AI" + phần trăm + mức, tính năng gói có. Khách KHÔNG thấy token, model hay chi phí
 * AI của nền tảng — đó là việc của người vận hành (`lib/pricing/admin.ts`).
 */
import { readSubscriptionTerms } from "@/lib/billing/standing";
import { billingStanding, vnDate } from "@/lib/billing/rules";
import { findOrganization } from "@/lib/platform/organizations";
import { readPeriodUsage } from "@/lib/platform/usage-meter";
import { getPlanUsage } from "@/lib/entitlements/check";
import { monthlyOnYearlyVnd, yearlyPriceVnd, type QuotaKey } from "@/lib/pricing/catalog";
import { evaluateQuota, usageLine, type QuotaVerdict } from "@/lib/pricing/guard";
import { featureGranted, FEATURE_KEYS, type FeatureDecision } from "@/lib/pricing/features";
import { readGuardConfig, resolveOrgPricing, QUOTA_METER } from "@/lib/pricing/entitlements";
import { usagePeriodOf } from "@/lib/pricing/meter";
import { readAiCustomerUsage } from "@/lib/pricing/ai-customer";
import { orgPriceVersion } from "@/lib/pricing/price-book";
import { estimateBill, fairUseVerdict, usageAlert, type BillEstimate, type FairUseVerdict, type MeterCoverage, type UsageAlert } from "@/lib/pricing/versions";

export type CustomerQuotaRow = QuotaVerdict & { line: string };

/** Một ô "đã dùng / gồm" của bảng giá có phiên bản (0226). `used = null` = chưa đo · `included = null` = không giới hạn. */
export type CustomerMeterRow = { used: number | null; included: number | null | undefined; alert: UsageAlert };

/**
 * Phần V1 của màn khách: khách AI (đồng hồ thu chính) · fanpage · người dùng · sức khoẻ fair-use · hoá đơn ước tính / phần
 * vượt. KHÔNG có token / model / chi phí nhà cung cấp.
 */
export type CustomerBillingMeter = {
  versionLabel: string | null;
  pinned: boolean;
  taxNote: string | null;
  aiCustomers: CustomerMeterRow & { coverage: MeterCoverage; note: string | null };
  fanpages: CustomerMeterRow;
  users: CustomerMeterRow;
  fairUse: FairUseVerdict;
  estimate: BillEstimate | null;
  /** Gói có AI bán hàng không (gói Inbox không có) — đọc từ entitlement, không so tên gói. */
  aiSales: boolean;
};

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
  /** Bảng giá có phiên bản (0226). `null` = tổ chức chưa có dòng giá ở phiên bản nào (máy chưa migrate 0226). */
  meter: CustomerBillingMeter | null;
};

export async function loadCustomerPlan(orgCode: string, now: Date = new Date()): Promise<CustomerPlanView | null> {
  const org = await findOrganization(orgCode);
  if (!org || org.isHome) return null;
  const [pricing, config, terms, planUsage] = await Promise.all([resolveOrgPricing(org), readGuardConfig(), readSubscriptionTerms(org.code), getPlanUsage(org.code)]);
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
  const features = FEATURE_KEYS.map((key) => featureGranted({ key, isHome: false, grandfathered: pricing.row.grandfathered, overrides: pricing.row.featureOverrides, planFeatures: c?.features ?? null }));
  const price = pricing.plan?.planPrice ?? null;
  let meter: CustomerBillingMeter | null = null;
  if (price) {
    const [version, ac] = await Promise.all([orgPriceVersion(org.code, now), readAiCustomerUsage([org.code], period, now)]);
    const alerts = version.version?.alerts;
    const aiRead = ac.get(org.code) ?? { value: null, coverage: "NOT_MEASURED" as const, note: null };
    const fanpagesUsed = usage.readings.fanpages_active;
    const inc = price.included;
    // Hạn mức người dùng / fanpage đọc từ phiên bản giá (ghi đè của người vận hành thắng — `pricing.quotas`).
    const usersInc = pricing.quotas.users !== undefined ? pricing.quotas.users : inc.users;
    const fanpagesInc = pricing.quotas.fanpages !== undefined ? pricing.quotas.fanpages : inc.fanpages;
    const fair = fairUseVerdict({ aiConversations: usage.readings.ai_conversations, aiReplies: usage.readings.outgoing_ai_messages }, inc, alerts);
    const trial = price.trialDays !== null;
    meter = {
      versionLabel: version.version?.label ?? null,
      pinned: version.pinned,
      taxNote: version.version ? (version.version.taxNote ?? null) : null,
      aiCustomers: { used: aiRead.value, included: inc.aiCustomers, alert: usageAlert(aiRead.value, inc.aiCustomers, alerts), coverage: aiRead.coverage, note: aiRead.note },
      fanpages: { used: fanpagesUsed, included: fanpagesInc, alert: usageAlert(fanpagesUsed, fanpagesInc, alerts) },
      users: { used: usersUsed, included: usersInc, alert: usageAlert(usersUsed, usersInc, alerts) },
      fairUse: fair,
      estimate: estimateBill({ ...price, included: { ...inc, users: usersInc, fanpages: fanpagesInc } }, { aiCustomers: aiRead.value, aiCustomersCoverage: aiRead.coverage, fanpages: fanpagesUsed, users: usersUsed, aiConversations: usage.readings.ai_conversations, aiReplies: usage.readings.outgoing_ai_messages }, { trial }),
      aiSales: features.find((f) => f.key === "ai_sales")?.granted ?? false,
    };
  }
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
    features,
    errors: usage.errors,
    meter,
  };
}
