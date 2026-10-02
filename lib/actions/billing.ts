"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import type { RenewalQuote } from "@/lib/billing/rules";
import {
  createRenewalInvoice,
  markInvoicePaidManually,
  previewRenewal,
  reconcileBillingAsOperator,
  resolveBillingPayment,
  setBillingReceiver,
  setOrgBilling,
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

export async function createRenewalInvoiceAction(input: { planKey: string; months: number }): Promise<BillingResult> {
  const user = await requirePermission("settings:manage");
  const r = await createRenewalInvoice(user, input ?? {});
  if ("ok" in r) revalidatePath("/settings/plan");
  return "ok" in r ? { ok: true, message: r.message } : r;
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

export async function setPlanPriceAction(input: { planKey: string; priceVnd: number | null; reason: string }): Promise<BillingResult> {
  const user = await requirePermission("platform:operate");
  const r = await setPlanPrice(user, input ?? {});
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
