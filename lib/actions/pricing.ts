"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import type { CommercialInput } from "@/lib/pricing/catalog";
import { setAiUnitPrices, setOrgPricing, setPlanCommercial, setPricingGuard, setPricingMargin, type PricingResult } from "@/lib/pricing/admin";
import { setOrgPriceVersion } from "@/lib/pricing/price-book";

/**
 * ═══════════ SERVER ACTION CẤU HÌNH GIÁ (0222 · docs/platform/pricing-billing-foundation.md) ═══════════
 *
 * Vỏ của Next: đọc phiên (`platform:operate`) → lõi ở `lib/pricing/admin.ts` (lõi hỏi lại người vận hành, kiểm lý do, ghi
 * nhật ký nền tảng) → `revalidatePath`. Chỉ người vận hành nền tảng; khách không có action nào ở đây.
 */

export async function setPlanCommercialAction(input: CommercialInput & { planKey: string; reason: string }): Promise<PricingResult> {
  const user = await requirePermission("platform:operate");
  const r = await setPlanCommercial(user, input ?? {});
  if ("ok" in r) {
    revalidatePath("/platform");
    revalidatePath("/pricing");
  }
  return r;
}

export async function setOrgPricingAction(input: { orgCode: string; grandfathered?: boolean; featureOverrides?: Record<string, boolean>; quotaOverrides?: Record<string, number | null>; enforcement?: string; reason: string }): Promise<PricingResult> {
  const user = await requirePermission("platform:operate");
  const r = await setOrgPricing(user, input ?? {});
  if ("ok" in r) revalidatePath("/platform/saas");
  return r;
}

export async function setPricingGuardAction(input: { config: Record<string, unknown>; reason: string }): Promise<PricingResult> {
  const user = await requirePermission("platform:operate");
  const r = await setPricingGuard(user, input ?? {});
  if ("ok" in r) revalidatePath("/platform/saas");
  return r;
}

export async function setAiUnitPricesAction(input: { prices: Record<string, { input: number; output: number }>; reason: string }): Promise<PricingResult> {
  const user = await requirePermission("platform:operate");
  const r = await setAiUnitPrices(user, input ?? {});
  if ("ok" in r) revalidatePath("/platform/saas");
  return r;
}

/** Dải biên lãi gộp chiếu (0226 · đích 75–85 · cảnh báo < 70 · nguy cấp < 60). */
export async function setPricingMarginAction(input: { config: Record<string, unknown>; reason: string }): Promise<PricingResult> {
  const user = await requirePermission("platform:operate");
  const r = await setPricingMargin(user, input ?? {});
  if ("ok" in r) revalidatePath("/platform/saas");
  return r;
}

/** Chuyển một tổ chức sang một phiên bản giá (0226) — có lý do, vào nhật ký nền tảng. */
export async function setOrgPriceVersionAction(input: { orgCode: string; versionKey: string; reason: string }): Promise<PricingResult> {
  const user = await requirePermission("platform:operate");
  const r = await setOrgPriceVersion(user, input ?? {});
  if ("ok" in r) {
    revalidatePath("/platform/saas");
    revalidatePath("/platform/customers");
  }
  return r;
}
