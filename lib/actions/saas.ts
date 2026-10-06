"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import {
  addCostEntryAsOperator,
  changeSubscriptionAsOperator,
  createAccountAsOperator,
  createCustomerAsOperator,
  finalizeStatementAsOperator,
  moveWorkspaceAsOperator,
  reconcileSubscriptionsAsOperator,
  retryProvisioningAsOperator,
  subscribeProductAsOperator,
  updateAccountAsOperator,
  voidCostEntryAsOperator,
} from "@/lib/saas/console";

/**
 * Vỏ Next của SaaS Control Plane (`/platform/customers`, `/platform/products`): đọc phiên → lõi `lib/saas/console.ts` (hỏi
 * lại người vận hành, zod, lý do bắt buộc, nhật ký nền tảng) → làm mới trang. Không logic nào ở đây.
 */
async function op() {
  return requirePermission("platform:operate");
}

function refresh(accountCode?: string | null) {
  revalidatePath("/platform/customers");
  revalidatePath("/platform/products");
  if (accountCode) revalidatePath(`/platform/customers/${accountCode}`);
}

export async function createCustomerAction(input: unknown) {
  const r = await createCustomerAsOperator(await op(), input);
  if ("ok" in r) refresh(r.accountCode);
  return r;
}

export async function createAccountAction(input: unknown) {
  const r = await createAccountAsOperator(await op(), input);
  if ("ok" in r) refresh(r.code);
  return r;
}

export async function subscribeProductAction(input: unknown, accountCode: string) {
  const r = await subscribeProductAsOperator(await op(), input);
  if ("ok" in r) refresh(accountCode);
  return r;
}

export async function changeSubscriptionAction(input: unknown, accountCode: string) {
  const r = await changeSubscriptionAsOperator(await op(), input);
  if ("ok" in r) refresh(accountCode);
  return r;
}

export async function retryProvisioningAction(input: unknown, accountCode: string) {
  const r = await retryProvisioningAsOperator(await op(), input);
  refresh(accountCode);
  return r;
}

export async function updateAccountAction(input: unknown) {
  const r = await updateAccountAsOperator(await op(), input);
  if ("ok" in r) refresh((input as { accountCode?: string })?.accountCode ?? null);
  return r;
}

export async function moveWorkspaceAction(input: unknown, accountCode: string) {
  const r = await moveWorkspaceAsOperator(await op(), input);
  if ("ok" in r) refresh(accountCode);
  return r;
}

export async function reconcileSubscriptionsAction(input: unknown, accountCode: string) {
  const r = await reconcileSubscriptionsAsOperator(await op(), input);
  if ("ok" in r) refresh(accountCode);
  return r;
}

export async function addCostEntryAction(input: unknown, accountCode?: string) {
  const r = await addCostEntryAsOperator(await op(), input);
  if ("ok" in r) refresh(accountCode);
  return r;
}

export async function voidCostEntryAction(input: unknown, accountCode?: string) {
  const r = await voidCostEntryAsOperator(await op(), input);
  if ("ok" in r) refresh(accountCode);
  return r;
}

export async function finalizeStatementAction(input: unknown) {
  const r = await finalizeStatementAsOperator(await op(), input);
  if ("ok" in r) refresh((input as { accountCode?: string })?.accountCode ?? null);
  return r;
}
