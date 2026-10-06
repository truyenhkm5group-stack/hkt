/**
 * ═══════════ ENTITLEMENT HIỆU LỰC THEO SẢN PHẨM — CHỈ MÁY CHỦ (docs/saas/ENTITLEMENTS.md) ═══════════
 *
 *   Product → Capability → Feature → Entitlement
 *
 * Hiệu lực = THUÊ BAO cho phép dùng (thương mại) ∧ MODULE bật (kỹ thuật, cổng đường dẫn đã có) ∧ TÍNH NĂNG theo gói + ghi
 * đè (`lib/pricing/features.ts`, không bao giờ so tên gói). Ba chiều đọc ở ba chỗ đã có; tệp này chỉ GHÉP, không tính lại.
 *
 * Cờ tính năng (feature flag, `lib/constants/platform-flags.ts`) là công tắc KỸ THUẬT (tung dần, tắt khẩn) — không bao giờ
 * dùng làm hệ thuê bao, và không đi qua đây.
 */
import { getEnabledModules } from "@/lib/platform/capabilities";
import { featureDecisions } from "@/lib/pricing/entitlements";
import type { FeatureDecision } from "@/lib/pricing/features";
import { accountOfWorkspace, liveSubscriptions } from "@/lib/saas/accounts";
import { PRODUCTS, productDef, productFeatures, type ProductDef } from "@/lib/saas/catalog";
import { billingStanding, vnDate } from "@/lib/billing/rules";
import { readSubscriptionTerms } from "@/lib/billing/standing";
import { readEverPaidOrgs } from "@/lib/platform/saas-ledger";
import { effectiveSubscriptionStatus, subscriptionGrantsUse, type BillingMode, type EffectiveSubscriptionStatus } from "@/lib/saas/policy";

export type CapabilityState = { key: string; label: string; modulesOn: boolean; missingModules: string[] };

export type ProductEntitlement = {
  orgCode: string;
  productKey: string;
  subscriptionId: string | null;
  /** `null` = workspace không có thuê bao sống của sản phẩm này. */
  status: EffectiveSubscriptionStatus | null;
  grantsUse: boolean;
  capabilities: CapabilityState[];
  features: (FeatureDecision & { effective: boolean })[];
};

export async function subscriptionStatusFor(orgCode: string, productKey: string, now: Date = new Date()): Promise<{ subscriptionId: string | null; status: EffectiveSubscriptionStatus | null }> {
  const sub = (await liveSubscriptions(orgCode)).find((s) => s.productKey === productKey);
  if (!sub) return { subscriptionId: null, status: null };
  const account = await accountOfWorkspace(orgCode);
  const terms = await readSubscriptionTerms(orgCode);
  const standing = billingStanding(terms, vnDate(now)).kind;
  const paid = await readEverPaidOrgs();
  return { subscriptionId: sub.id, status: effectiveSubscriptionStatus({ state: sub.state as "ACTIVE" | "PAUSED" | "CANCELED", billingMode: (account?.billingMode ?? "EXTERNAL_INVOICE") as BillingMode, standing, hasPaidInvoice: paid.has(orgCode) }) };
}

/** Toàn bộ entitlement của một sản phẩm trên một workspace — màn người vận hành, cổng khách, SDK. */
export async function productEntitlement(orgCode: string, productKey: string, opts: { now?: Date; catalog?: readonly ProductDef[] } = {}): Promise<ProductEntitlement> {
  const product = productDef(productKey, opts.catalog ?? PRODUCTS);
  if (!product) throw new Error(`Sản phẩm "${productKey}" không có trong danh mục.`);
  const [{ subscriptionId, status }, enabled, decisions] = await Promise.all([subscriptionStatusFor(orgCode, productKey, opts.now), getEnabledModules(orgCode), featureDecisions(orgCode)]);
  const grantsUse = status !== null && subscriptionGrantsUse(status);
  const mine = new Set(productFeatures(product));
  return {
    orgCode,
    productKey,
    subscriptionId,
    status,
    grantsUse,
    capabilities: product.capabilities.map((c) => {
      const missing = c.modules.filter((m) => !enabled.has(m));
      return { key: c.key, label: c.label, modulesOn: missing.length === 0, missingModules: missing };
    }),
    features: decisions.filter((d) => mine.has(d.key)).map((d) => ({ ...d, effective: grantsUse && d.granted })),
  };
}
