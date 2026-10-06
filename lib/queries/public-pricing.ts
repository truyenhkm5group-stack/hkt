import { listPlans } from "@/lib/entitlements/check";
import { HOME_PLAN_KEY } from "@/lib/entitlements/kinds";
import { monthlyOnYearlyVnd, parseCommercial, planQuotas, trialDaysOf, yearlyPriceVnd, type QuotaKey } from "@/lib/pricing/catalog";
import { FEATURE_KEYS, FEATURE_SPEC, type FeatureKey } from "@/lib/pricing/features";
import { getPublicSiteData, planIncludesAi, type PublicSiteData } from "@/lib/queries/public-site";

/**
 * DỮ LIỆU CỦA TRANG GIÁ CÔNG KHAI `/pricing` (0222). Cùng giới hạn với trang giới thiệu (`public-site.ts`): chỉ đọc gói cước ở
 * `platform_plans` và chế độ đăng ký — không một dòng dữ liệu khách nào (`tests/pricing-billing.test.ts` khoá danh sách import).
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
  trialDays: number | null;
  contactSales: boolean;
  highlight: boolean;
  /** `undefined` = gói chưa khai ô đó (trang không in dòng ấy) · `null` = không giới hạn. */
  quotas: Record<QuotaKey, number | null | undefined>;
  /** Tính năng in được: gói khai VÀ cửa hàng tự đăng ký dùng được hôm nay (`publicClaim`). Gói chưa khai ⇒ rỗng — không hứa. */
  features: FeatureKey[];
  aiIncluded: boolean;
};

/**
 * Gói in ở `/pricing`: người vận hành bật «hiện ở trang giá» (`commercial.publicListed`) và gói có giá, HOẶC «Liên hệ», HOẶC
 * là gói dùng thử. Mọi giá / hạn mức đọc từ `platform_plans` — trang không gõ lại số nào. Đọc lỗi ⇒ rỗng (ẩn bảng giá).
 */
export async function getPublicPricing(): Promise<{ site: PublicSiteData; plans: PublicPricingPlan[] }> {
  const [site, rows] = await Promise.all([getPublicSiteData(), listPlans().catch(() => [])]);
  const plans: PublicPricingPlan[] = [];
  for (const r of rows) {
    if (r.key === HOME_PLAN_KEY) continue;
    const c = parseCommercial(r.commercial);
    const trialDays = trialDaysOf(r.key);
    const priced = typeof r.priceVnd === "number" && r.priceVnd > 0;
    if (!c.publicListed || !(priced || c.contactSales || trialDays)) continue;
    plans.push({
      key: r.key,
      name: r.name,
      description: r.description,
      priceVnd: priced ? r.priceVnd : null,
      yearlyPriceVnd: yearlyPriceVnd(r.priceVnd, r.yearlyFreeMonths),
      monthlyOnYearlyVnd: monthlyOnYearlyVnd(r.priceVnd, r.yearlyFreeMonths),
      yearlyFreeMonths: r.yearlyFreeMonths,
      trialDays,
      contactSales: c.contactSales,
      highlight: c.highlight,
      quotas: planQuotas(r.limits, c),
      features: (c.features ?? []).filter((k) => FEATURE_SPEC[k].publicClaim).sort((a, b) => FEATURE_KEYS.indexOf(a) - FEATURE_KEYS.indexOf(b)),
      aiIncluded: planIncludesAi(r.limits),
    });
  }
  return { site, plans };
}
