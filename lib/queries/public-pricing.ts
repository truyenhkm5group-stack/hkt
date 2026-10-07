import { HOME_PLAN_KEY } from "@/lib/entitlements/kinds";
import { parseCommercial, planQuotas, trialDaysOf, type QuotaKey } from "@/lib/pricing/catalog";
import { FEATURE_KEYS, FEATURE_SPEC, type FeatureKey } from "@/lib/pricing/features";
import { catalogPlans } from "@/lib/pricing/price-book";
import { TAX_MODE_LABEL, type Included, type OverageSpec } from "@/lib/pricing/versions";
import { getPublicSiteData, planIncludesAi, type PublicSiteData } from "@/lib/queries/public-site";

/**
 * DỮ LIỆU CỦA TRANG GIÁ CÔNG KHAI `/pricing` (0222 · 0228). Cùng giới hạn với trang giới thiệu (`public-site.ts`): chỉ đọc BẢNG
 * GIÁ ĐANG NIÊM YẾT (phiên bản CATALOG hiện hành) và chế độ đăng ký — không một dòng dữ liệu khách nào
 * (`tests/pricing-billing.test.ts` khoá danh sách import). Mọi giá / hạn mức / đơn giá vượt đọc từ phiên bản — trang không gõ
 * lại số nào.
 */
export type PublicPricingPlan = {
  key: string;
  name: string;
  description: string | null;
  /** Giá tháng; `null` = không tự mua (Dùng thử · «Liên hệ»). */
  priceVnd: number | null;
  yearlyPriceVnd: number | null;
  monthlyOnYearlyVnd: number | null;
  yearlyFreeMonths: number;
  /** Gói hợp đồng: «Từ … ₫ · Liên hệ». */
  priceFromVnd: number | null;
  trialDays: number | null;
  contactSales: boolean;
  highlight: boolean;
  /** `undefined` = gói chưa khai ô đó (trang không in dòng ấy) · `null` = không giới hạn. */
  quotas: Record<QuotaKey, number | null | undefined>;
  /** Hạn mức GỒM của phiên bản giá: khách AI (đồng hồ thu chính), fanpage, người dùng, fair-use, đơn. */
  included: Included;
  overage: OverageSpec;
  /** Tính năng in được: gói khai VÀ cửa hàng tự đăng ký dùng được hôm nay (`publicClaim`). Gói chưa khai ⇒ rỗng — không hứa. */
  features: FeatureKey[];
  aiIncluded: boolean;
  hasAiSales: boolean;
};

/**
 * Gói in ở `/pricing`: gói của bảng giá đang niêm yết có `listed`, VÀ (có giá HOẶC «Liên hệ» HOẶC là gói dùng thử). Đọc lỗi
 * ⇒ rỗng (ẩn bảng giá — không bao giờ in một giá đoán).
 */
export async function getPublicPricing(): Promise<{ site: PublicSiteData; plans: PublicPricingPlan[]; versionLabel: string | null; taxNote: string | null }> {
  const [site, catalog] = await Promise.all([getPublicSiteData(), catalogPlans().catch(() => ({ version: null, plans: [] }))]);
  const plans: PublicPricingPlan[] = [];
  for (const r of catalog.plans) {
    const price = r.planPrice;
    if (r.key === HOME_PLAN_KEY || !price || !price.listed) continue;
    const c = parseCommercial(r.commercial);
    const trialDays = price.trialDays ?? trialDaysOf(r.key);
    const priced = typeof r.priceVnd === "number" && r.priceVnd > 0 && !price.contactSales;
    if (!(priced || price.contactSales || trialDays)) continue;
    plans.push({
      key: r.key,
      name: r.name,
      description: r.description,
      priceVnd: priced ? r.priceVnd : null,
      yearlyPriceVnd: priced ? r.yearlyPriceVnd : null,
      monthlyOnYearlyVnd: priced && r.yearlyPriceVnd !== null ? Math.floor(r.yearlyPriceVnd / 12) : null,
      yearlyFreeMonths: r.yearlyFreeMonths,
      priceFromVnd: price.priceFromVnd,
      trialDays,
      contactSales: price.contactSales,
      highlight: price.highlight,
      quotas: planQuotas(r.limits, c),
      included: price.included,
      overage: price.overage,
      features: (price.features ?? c.features ?? []).filter((k) => FEATURE_SPEC[k].publicClaim).sort((a, b) => FEATURE_KEYS.indexOf(a) - FEATURE_KEYS.indexOf(b)),
      aiIncluded: planIncludesAi(r.limits),
      hasAiSales: (price.features ?? []).includes("ai_sales"),
    });
  }
  const v = catalog.version;
  return { site, plans, versionLabel: v?.label ?? null, taxNote: v ? (v.taxNote ?? TAX_MODE_LABEL[v.taxMode]) : null };
}
