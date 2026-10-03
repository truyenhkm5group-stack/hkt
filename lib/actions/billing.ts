"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import type { AddonQuote, InvoiceInfo } from "@/lib/billing/addons";
import type { RenewalQuote } from "@/lib/billing/rules";
import {
  createAddonInvoice,
  createRenewalInvoice,
  markInvoicePaidManually,
  markVatIssued,
  previewAddon,
  previewRenewal,
  reconcileBillingAsOperator,
  resolveBillingPayment,
  setBillingReceiver,
  setInvoiceInfo,
  setOrgAddons,
  setOrgBilling,
  setPlanAddonPrices,
  setPlanPrice,
  voidInvoice,
  type BillingResult,
} from "@/lib/billing/service";

/**
 * ═══════════ SERVER ACTION THU PHÍ (docs/platform/billing.md) ═══════════
 *
 * Vỏ của Next: đọc phiên → lõi ở `lib/billing/service.ts` (lõi kiểm lại người vận hành / tổ chức, lý do, nhật ký) →
 * `revalidatePath`. Hai nhóm:
 *  · KHÁCH (`settings:manage`, trang /settings/plan) — báo giá, tạo mã thanh toán. Mã tổ chức lấy từ PHIÊN, không từ
 *    trình duyệt: một tổ chức không tạo được hoá đơn cho tổ chức khác.
 *  · NGƯỜI VẬN HÀNH (`platform:operate`, /platform) — mọi lượt sửa còn lại.
 */

export async function previewRenewalAction(input: { planKey: string; months: number }): Promise<RenewalQuote | { error: string }> {
  const user = await requirePermission("settings:manage");
  const org = user.organization;
  if (!org || org.isHome) return { error: "Tổ chức nhà không trả phí thuê bao." };
  return previewRenewal(org.code, String(input?.planKey ?? ""), Number(input?.months));
}

export async function createRenewalInvoiceAction(input: { planKey: string; months: number; vat?: boolean }): Promise<BillingResult> {
  const user = await requirePermission("settings:manage");
  const r = await createRenewalInvoice(user, input ?? {});
  if ("ok" in r) revalidatePath("/settings/plan");
  return "ok" in r ? { ok: true, message: r.message } : r;
}

export async function previewAddonAction(input: { kind: string; blocks: number }): Promise<AddonQuote | { error: string }> {
  const user = await requirePermission("settings:manage");
  const org = user.organization;
  if (!org || org.isHome) return { error: "Tổ chức nhà không trả phí thuê bao." };
  return previewAddon(org.code, input ?? {});
}

export async function createAddonInvoiceAction(input: { kind: string; blocks: number; vat?: boolean }): Promise<BillingResult> {
  const user = await requirePermission("settings:manage");
  const r = await createAddonInvoice(user, input ?? {});
  if ("ok" in r) revalidatePath("/settings/plan");
  return "ok" in r ? { ok: true, message: r.message } : r;
}

export async function setInvoiceInfoAction(input: { info?: InvoiceInfo; clear?: boolean }): Promise<BillingResult> {
  const user = await requirePermission("settings:manage");
  const r = await setInvoiceInfo(user, input ?? {});
  if ("ok" in r) revalidatePath("/settings/plan");
  return r;
}

/** Làm mới /platform và MỌI trang /platform/org/<mã> — không nhận mã tổ chức từ trình duyệt chỉ để làm mới. */
function refreshOperator() {
  revalidatePath("/platform");
  revalidatePath("/platform/org/[code]", "page");
}

export async function setOrgBillingAction(input: { orgCode: string; enabled: boolean; paidThrough: string; graceDays: number | string; reason: string }): Promise<BillingResult> {
  const user = await requirePermission("platform:operate");
  const r = await setOrgBilling(user, input ?? {});
  if ("ok" in r) refreshOperator();
  return r;
}

export async function markInvoicePaidAction(input: { invoiceId: string; amountVnd: number; ref: string; reason: string }): Promise<BillingResult> {
  const user = await requirePermission("platform:operate");
  const r = await markInvoicePaidManually(user, input ?? {});
  if ("ok" in r) refreshOperator();
  return r;
}

export async function voidInvoiceAction(input: { invoiceId: string; reason: string }): Promise<BillingResult> {
  const user = await requirePermission("platform:operate");
  const r = await voidInvoice(user, input ?? {});
  if ("ok" in r) refreshOperator();
  return r;
}

export async function setPlanPriceAction(input: { planKey: string; priceVnd: number | null; yearlyFreeMonths?: number; reason: string }): Promise<BillingResult> {
  const user = await requirePermission("platform:operate");
  const r = await setPlanPrice(user, input ?? {});
  if ("ok" in r) refreshOperator();
  return r;
}

export async function setPlanAddonPricesAction(input: { planKey: string; prices: Record<string, number | null>; reason: string }): Promise<BillingResult> {
  const user = await requirePermission("platform:operate");
  const r = await setPlanAddonPrices(user, input ?? {});
  if ("ok" in r) refreshOperator();
  return r;
}

export async function setOrgAddonsAction(input: { orgCode: string; blocks: Record<string, number>; reason: string }): Promise<BillingResult> {
  const user = await requirePermission("platform:operate");
  const r = await setOrgAddons(user, input ?? {});
  if ("ok" in r) refreshOperator();
  return r;
}

export async function markVatIssuedAction(input: { invoiceId: string; vatRef: string }): Promise<BillingResult> {
  const user = await requirePermission("platform:operate");
  const r = await markVatIssued(user, input ?? {});
  if ("ok" in r) refreshOperator();
  return r;
}

export async function setBillingReceiverAction(input: { bin: string; accountNumber: string; accountName: string; reason: string }): Promise<BillingResult> {
  const user = await requirePermission("platform:operate");
  const r = await setBillingReceiver(user, input ?? {});
  if ("ok" in r) refreshOperator();
  return r;
}

export async function reconcileBillingAction(): Promise<BillingResult> {
  const user = await requirePermission("platform:operate");
  const r = await reconcileBillingAsOperator(user);
  refreshOperator();
  return r;
}

export async function resolveBillingPaymentAction(input: { paymentId: string; reason: string }): Promise<BillingResult> {
  const user = await requirePermission("platform:operate");
  const r = await resolveBillingPayment(user, input ?? {});
  if ("ok" in r) refreshOperator();
  return r;
}
