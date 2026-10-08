"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import {
  addCostEntryAsOperator,
  changeSubscriptionAsOperator,
  createCustomerAsOperator,
  finalizeStatementAsOperator,
  moveWorkspaceAsOperator,
  reconcileSubscriptionsAsOperator,
  resendActivationAsOperator,
  retryProvisioningAsOperator,
  subscribeProductAsOperator,
  updateAccountAsOperator,
  voidCostEntryAsOperator,
} from "@/lib/saas/console";

/**
 * Vỏ Next của SaaS Control Plane (`/platform/customers`, `/platform/products`): đọc phiên → lõi `lib/saas/console.ts` (hỏi
 * lại người vận hành, zod, lý do bắt buộc, nhật ký nền tảng) → làm mới trang. Không logic nào ở đây.
 */
function refresh(accountCode?: string | null) {
  revalidatePath("/platform/customers");
  revalidatePath("/platform/products");
  if (accountCode) revalidatePath(`/platform/customers/${accountCode}`);
}

export async function createCustomerAction(input: unknown) {
  const user = await requirePermission("platform:operate");
  const r = await createCustomerAsOperator(user, input);
  if ("ok" in r) refresh(r.accountCode);
  return r;
}

/** «Gửi lại liên kết kích hoạt» (trang khách): người nhận do lõi tra từ workspace — trình duyệt chỉ gửi mã workspace + lý do. */
export async function resendActivationAction(input: unknown, accountCode: string) {
  const user = await requirePermission("platform:operate");
  const r = await resendActivationAsOperator(user, input);
  if ("ok" in r) refresh(accountCode);
  return r;
}

export async function subscribeProductAction(input: unknown, accountCode: string) {
  const user = await requirePermission("platform:operate");
  const r = await subscribeProductAsOperator(user, input);
  if ("ok" in r) refresh(accountCode);
  return r;
}

export async function changeSubscriptionAction(input: unknown, accountCode: string) {
  const user = await requirePermission("platform:operate");
  const r = await changeSubscriptionAsOperator(user, input);
  if ("ok" in r) refresh(accountCode);
  return r;
}

export async function retryProvisioningAction(input: unknown, accountCode: string) {
  const user = await requirePermission("platform:operate");
  const r = await retryProvisioningAsOperator(user, input);
  refresh(accountCode);
  return r;
}

export async function updateAccountAction(input: unknown) {
  const user = await requirePermission("platform:operate");
  const r = await updateAccountAsOperator(user, input);
  if ("ok" in r) refresh((input as { accountCode?: string })?.accountCode ?? null);
  return r;
}

export async function moveWorkspaceAction(input: unknown, accountCode: string) {
  const user = await requirePermission("platform:operate");
  const r = await moveWorkspaceAsOperator(user, input);
  if ("ok" in r) refresh(accountCode);
  return r;
}

export async function reconcileSubscriptionsAction(input: unknown, accountCode: string) {
  const user = await requirePermission("platform:operate");
  const r = await reconcileSubscriptionsAsOperator(user, input);
  if ("ok" in r) refresh(accountCode);
  return r;
}

export async function addCostEntryAction(input: unknown, accountCode?: string) {
  const user = await requirePermission("platform:operate");
  const r = await addCostEntryAsOperator(user, input);
  if ("ok" in r) refresh(accountCode);
  return r;
}

export async function voidCostEntryAction(input: unknown, accountCode?: string) {
  const user = await requirePermission("platform:operate");
  const r = await voidCostEntryAsOperator(user, input);
  if ("ok" in r) refresh(accountCode);
  return r;
}

export async function finalizeStatementAction(input: unknown) {
  const user = await requirePermission("platform:operate");
  const r = await finalizeStatementAsOperator(user, input);
  if ("ok" in r) refresh((input as { accountCode?: string })?.accountCode ?? null);
  return r;
}
