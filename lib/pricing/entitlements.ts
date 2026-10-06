/**
 * ═══════════ ENTITLEMENT + HẠN MỨC THƯƠNG MẠI — CHỈ MÁY CHỦ (docs/platform/pricing-billing-foundation.md §4–5) ═══════════
 *
 * Mã nghiệp vụ hỏi ĐÚNG HAI câu, không bao giờ hỏi tên gói:
 *  · `hasFeature("ai_order_creation")` — gói (+ ghi đè, + giữ từ trước) có quyền dùng tính năng này không;
 *  · `checkUsageQuota("aiConversations")` — ô hạn mức tháng này đang ở mức nào, lượt sắp tới có bị CHẶN không. Mặc định
 *    KHÔNG BAO GIỜ chặn (mức áp `SOFT`, công tắc trần cứng của nền tảng TẮT) — nơi gọi đọc `message` để nhắc.
 *
 * Đọc ở mặt phẳng điều khiển (`platform_plans` · `platform_org_pricing` · `platform_settings`), đệm 10 giây trong tiến trình
 * như tình trạng thu phí; lượt ghi của người vận hành xoá đệm ngay. Bảng chưa có (máy chưa migrate 0222) ⇒ coi như không
 * có dòng ghi đè — không ai mất tính năng vì một lỗi đọc.
 */
import { eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { DEFAULT_PLAN_KEY, planKeyOf } from "@/lib/entitlements/check";
import { recordAiUsage, type AiUsageEntry } from "@/lib/ai-usage/ledger";
import { currentOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { readPeriodUsage } from "@/lib/platform/usage-meter";
import type { Organization } from "@/lib/platform/types";
import { applyQuotaOverrides, parseCommercial, planQuotas, QUOTA_KEYS, type PlanCommercial, type QuotaKey } from "@/lib/pricing/catalog";
import { featureGranted, FEATURE_KEYS, parseFeatureOverrides, type FeatureDecision, type FeatureKey } from "@/lib/pricing/features";
import { DEFAULT_GUARD_CONFIG, evaluateQuota, parseGuardConfig, type Enforcement, type GuardConfig, type QuotaVerdict } from "@/lib/pricing/guard";
import { usagePeriodOf, type MeterKey, type MeterReadings } from "@/lib/pricing/meter";
import { invalidatePriceBook, plansForOrg } from "@/lib/pricing/price-book";
import type { PlanPrice } from "@/lib/pricing/versions";

export const PRICING_GUARD_KEY = "platform.pricing.guard";
const TTL_MS = 10_000;

export type OrgPricingRow = { grandfathered: boolean; featureOverrides: Partial<Record<FeatureKey, boolean>>; quotaOverrides: unknown; enforcement: Enforcement; reason: string | null; updatedByEmail: string | null; updatedAt: string | null };
const NO_ROW: OrgPricingRow = { grandfathered: false, featureOverrides: {}, quotaOverrides: {}, enforcement: "SOFT", reason: null, updatedByEmail: null, updatedAt: null };

type Holder = { __erpOrgPricing?: Map<string, { at: number; row: OrgPricingRow }>; __erpPricingGuard?: { at: number; cfg: GuardConfig } };
const holder = globalThis as unknown as Holder;
if (!holder.__erpOrgPricing) holder.__erpOrgPricing = new Map();
const rowCache = holder.__erpOrgPricing;

export function invalidatePricing(orgCode?: string) {
  if (orgCode) rowCache.delete(orgCode);
  else rowCache.clear();
  holder.__erpPricingGuard = undefined;
  quotaUsageCache.clear();
  invalidatePriceBook(orgCode);
}

export async function readOrgPricingRow(orgCode: string, opts: { fresh?: boolean } = {}): Promise<OrgPricingRow> {
  const hit = rowCache.get(orgCode);
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.row;
  let row = NO_ROW;
  try {
    const pdb = await getPlatformDb();
    const r = await pdb.query.platformOrgPricing.findFirst({ where: eq(schema.platformOrgPricing.orgCode, orgCode) });
    if (r) {
      const enforcement: Enforcement = r.enforcement === "OFF" || r.enforcement === "HARD" ? r.enforcement : "SOFT";
      row = { grandfathered: r.grandfathered, featureOverrides: parseFeatureOverrides(r.featureOverrides), quotaOverrides: r.quotaOverrides ?? {}, enforcement, reason: r.reason ?? null, updatedByEmail: r.updatedByEmail ?? null, updatedAt: r.updatedAt?.toISOString() ?? null };
    }
  } catch {
    // Lỗi đọc ⇒ như không có dòng: mức áp SOFT (không chặn), tính năng theo gói.
    row = NO_ROW;
  }
  rowCache.set(orgCode, { at: Date.now(), row });
  return row;
}

/** Ngưỡng Margin Guard đang hiệu lực (mặc định của chủ shop + ghi đè thưa ở `platform.pricing.guard`). */
export async function readGuardConfig(opts: { fresh?: boolean } = {}): Promise<GuardConfig> {
  const hit = holder.__erpPricingGuard;
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.cfg;
  let cfg = DEFAULT_GUARD_CONFIG;
  try {
    const pdb = await getPlatformDb();
    const r = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, PRICING_GUARD_KEY) });
    cfg = parseGuardConfig(r?.value);
  } catch {
    cfg = DEFAULT_GUARD_CONFIG;
  }
  holder.__erpPricingGuard = { at: Date.now(), cfg };
  return cfg;
}

export type OrgPricing = {
  orgCode: string;
  isHome: boolean;
  /** Giá / phần thương mại theo PHIÊN BẢN giá của tổ chức (0226, `lib/pricing/price-book.ts`). */
  plan: { key: string; name: string; priceVnd: number | null; yearlyFreeMonths: number; limits: unknown; commercial: PlanCommercial; priceVersionKey: string | null; planPrice: PlanPrice | null } | null;
  /** Gói khai trên tổ chức không có trong bảng ⇒ đang áp gói Dùng thử. */
  fellBack: boolean;
  row: OrgPricingRow;
  /** Hạn mức hiệu lực (gói + ghi đè). `undefined` = chưa khai · `null` = không giới hạn. */
  quotas: Record<QuotaKey, number | null | undefined>;
};

export async function resolveOrgPricing(org: Pick<Organization, "code" | "isHome" | "plan">): Promise<OrgPricing> {
  const row = org.isHome ? NO_ROW : await readOrgPricingRow(org.code);
  // Gói "như hoá đơn của tổ chức đọc" — giá + phần thương mại theo phiên bản đã ghim (0226).
  const plans = await plansForOrg(org.code);
  const key = planKeyOf(org);
  const hit = plans.find((p) => p.key === key);
  const p = hit ?? plans.find((x) => x.key === DEFAULT_PLAN_KEY) ?? null;
  const commercial = parseCommercial(p?.commercial);
  const quotas = org.isHome ? (Object.fromEntries(QUOTA_KEYS.map((k) => [k, null])) as Record<QuotaKey, null>) : applyQuotaOverrides(planQuotas(p?.limits, commercial), row.quotaOverrides);
  return {
    orgCode: org.code,
    isHome: org.isHome,
    plan: p ? { key: p.key, name: p.name, priceVnd: p.priceVnd, yearlyFreeMonths: p.yearlyFreeMonths, limits: p.limits, commercial, priceVersionKey: p.priceVersionKey, planPrice: p.planPrice } : null,
    fellBack: !org.isHome && !hit,
    row,
    quotas,
  };
}

async function targetOrg(orgCode?: string): Promise<Organization | null> {
  return findOrganization(orgCode ?? (await currentOrganization()).code);
}

/** Mọi tính năng và vì sao có / không — màn khách và màn người vận hành. */
export async function featureDecisions(orgCode?: string): Promise<FeatureDecision[]> {
  const org = await targetOrg(orgCode);
  if (!org) return FEATURE_KEYS.map((key) => ({ key, granted: false, source: "PLAN" as const }));
  const pricing = await resolveOrgPricing(org);
  return FEATURE_KEYS.map((key) => featureGranted({ key, isHome: org.isHome, grandfathered: pricing.row.grandfathered, overrides: pricing.row.featureOverrides, planFeatures: pricing.plan?.commercial.features ?? null }));
}

/**
 * CÂU HỎI DUY NHẤT mã nghiệp vụ được hỏi về tính năng. `orgCode` bỏ trống ⇒ tổ chức của ngữ cảnh (phiên / job).
 * Không xác định được tổ chức ⇒ `false` (không biết là của ai thì không cấp).
 */
export async function hasFeature(key: FeatureKey, opts: { orgCode?: string } = {}): Promise<boolean> {
  const org = await targetOrg(opts.orgCode);
  if (!org) return false;
  const pricing = await resolveOrgPricing(org);
  return featureGranted({ key, isHome: org.isHome, grandfathered: pricing.row.grandfathered, overrides: pricing.row.featureOverrides, planFeatures: pricing.plan?.commercial.features ?? null }).granted;
}

/** Ô hạn mức ⇒ đồng hồ đo đếm nó. `users` đếm ở `lib/entitlements` (bộ đếm người dùng đã có), không đo lại ở đây. */
export const QUOTA_METER: Record<Exclude<QuotaKey, "users">, MeterKey> = {
  aiConversations: "ai_conversations",
  aiMessages: "outgoing_ai_messages",
  orders: "orders_created_by_ai",
  fanpages: "fanpages_active",
};

const QUOTA_USAGE_TTL_MS = 60_000;
const quotaUsageCache = new Map<string, { at: number; readings: MeterReadings; period: string }>();

/** Đọc số dùng của kỳ, đệm 60 giây; tới 80% hạn mức thì đếm lại tươi (như `checkEntitlement`). */
async function readingsFor(org: Organization, now: Date, fresh: boolean): Promise<MeterReadings> {
  const period = usagePeriodOf(now);
  const hit = quotaUsageCache.get(org.code);
  if (!fresh && hit && hit.period === period.label && now.getTime() - hit.at < QUOTA_USAGE_TTL_MS) return hit.readings;
  const r = await readPeriodUsage(org, period, now);
  quotaUsageCache.set(org.code, { at: now.getTime(), readings: r.readings, period: period.label });
  return r.readings;
}

/**
 * Ô hạn mức `key` của tổ chức đang ở đâu, và lượt sắp tới (dùng thêm `delta`) có bị CHẶN không. Mặc định không bao giờ
 * chặn: chặn cần đủ bốn điều kiện (`lib/pricing/guard.ts`). Không đọc được số dùng ⇒ `UNKNOWN`, không chặn.
 */
export async function checkUsageQuota(key: Exclude<QuotaKey, "users">, opts: { orgCode?: string; delta?: number; now?: Date } = {}): Promise<QuotaVerdict> {
  const now = opts.now ?? new Date();
  const org = await targetOrg(opts.orgCode);
  const config = await readGuardConfig();
  if (!org) return evaluateQuota({ key, used: null, included: undefined, policy: "SOFT_ONLY", graceAllowancePct: 0, limitMode: "SOFT", enforcement: "SOFT", config });
  const pricing = await resolveOrgPricing(org);
  const included = pricing.quotas[key];
  const c = pricing.plan?.commercial;
  const evalWith = (used: number | null) =>
    evaluateQuota({ key, used, included, policy: c?.overage.policy ?? "SOFT_ONLY", unitPriceVnd: c?.overage.unitPricesVnd[key] ?? null, graceAllowancePct: c?.overage.graceAllowancePct ?? 0, limitMode: c?.limitModes[key] ?? "SOFT", enforcement: pricing.row.enforcement, config, delta: opts.delta });
  if (org.isHome || included === null || included === undefined) return evalWith(null);
  let readings = await readingsFor(org, now, false);
  let verdict = evalWith(readings[QUOTA_METER[key]]);
  if (verdict.level === "WARN" || verdict.level === "LIMIT") {
    readings = await readingsFor(org, now, true);
    verdict = evalWith(readings[QUOTA_METER[key]]);
  }
  return verdict;
}

/**
 * GHI MỘT SỰ KIỆN DÙNG AI CÓ KHOÁ (đồng hồ đo). Đây là `recordAiUsage` (đường ghi DUY NHẤT của sổ AI) với khoá sự kiện BẮT
 * BUỘC: gọi lại cùng khoá ⇒ `{ recorded: false }`, không dòng thứ hai, không tính tiền hai lần.
 *
 * NỐI VÀO ĐƯỜNG GỌI AI BÁN HÀNG (`lib/sales-chatbot/*`) LÀ VIỆC CỦA SỨ MỆNH ai-sales-reliability — tệp này không sửa ở đó.
 */
export async function recordUsageEvent(entry: AiUsageEntry & { eventKey: string }): Promise<{ recorded: boolean }> {
  if (!entry.eventKey?.trim()) throw new Error("Sự kiện đo dùng phải có khoá sự kiện (usageEventKey).");
  return recordAiUsage(entry);
}
