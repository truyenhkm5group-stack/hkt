"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { advanceWarrantyClaimCore, createWarrantyCardCore, openWarrantyClaimCore, voidWarrantyCardCore, type WarrantyCardInput, type WarrantyResult } from "@/lib/records/warranty";

/** Vỏ Next của bảo hành. Lõi (`lib/records/warranty.ts`) tự kiểm `warranty:write`. */

function refresh(customerId?: string) {
  revalidatePath("/warranty");
  if (customerId) revalidatePath(`/customers/${customerId}`);
}

export async function createWarrantyCardAction(input: WarrantyCardInput): Promise<WarrantyResult> {
  const user = await requireUser();
  const r = await createWarrantyCardCore(user, input);
  if (r.ok) refresh(input?.customerId);
  return r;
}

export async function voidWarrantyCardAction(id: string, reason: string, customerId?: string): Promise<WarrantyResult> {
  const user = await requireUser();
  const r = await voidWarrantyCardCore(user, id, reason);
  if (r.ok) refresh(customerId);
  return r;
}

export async function openWarrantyClaimAction(cardId: string, input: { issue: string; assigneeUserId: string | null }, customerId?: string): Promise<WarrantyResult> {
  const user = await requireUser();
  const r = await openWarrantyClaimCore(user, cardId, input);
  if (r.ok) refresh(customerId);
  return r;
}

export async function advanceWarrantyClaimAction(
  claimId: string,
  input: { status: string; resolution?: string | null; rejectReason?: string | null; costVnd?: number | null; chargedVnd?: number | null; note?: string | null },
  customerId?: string,
): Promise<WarrantyResult> {
  const user = await requireUser();
  const r = await advanceWarrantyClaimCore(user, claimId, input);
  if (r.ok) refresh(customerId);
  return r;
}
