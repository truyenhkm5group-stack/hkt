"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import {
  addReUnitsCore,
  closeReDepositCore,
  createReProjectCore,
  depositReUnitCore,
  holdReUnitCore,
  lockReUnitCore,
  releaseReHoldCore,
  sellReUnitCore,
  type ReProjectInput,
  type ReResult,
} from "@/lib/records/real-estate";

/** Vỏ Next của bảng hàng BĐS. Lõi (`lib/records/real-estate.ts`) tự kiểm `real_estate:hold` / `real_estate:manage`. */

function refresh() {
  revalidatePath("/real-estate");
}

export async function createReProjectAction(input: ReProjectInput): Promise<ReResult> {
  const user = await requireUser();
  const r = await createReProjectCore(user, input);
  if (r.ok) refresh();
  return r;
}

export async function addReUnitsAction(projectId: string, text: string): Promise<ReResult> {
  const user = await requireUser();
  const r = await addReUnitsCore(user, projectId, text);
  if (r.ok) refresh();
  return r;
}

export async function holdReUnitAction(unitId: string, input: { customerName: string; customerPhone: string }): Promise<ReResult> {
  const user = await requireUser();
  const r = await holdReUnitCore(user, unitId, input);
  if (r.ok) refresh();
  return r;
}

export async function releaseReHoldAction(holdId: string, reason: string): Promise<ReResult> {
  const user = await requireUser();
  const r = await releaseReHoldCore(user, holdId, reason);
  if (r.ok) refresh();
  return r;
}

export async function depositReUnitAction(unitId: string, input: { amount: number; customerName: string; customerPhone: string }): Promise<ReResult> {
  const user = await requireUser();
  const r = await depositReUnitCore(user, unitId, input);
  if (r.ok) refresh();
  return r;
}

export async function closeReDepositAction(depositId: string, input: { outcome: "REFUNDED" | "FORFEITED"; reason: string }): Promise<ReResult> {
  const user = await requireUser();
  const r = await closeReDepositCore(user, depositId, input);
  if (r.ok) refresh();
  return r;
}

export async function sellReUnitAction(unitId: string, contract: string): Promise<ReResult> {
  const user = await requireUser();
  const r = await sellReUnitCore(user, unitId, contract);
  if (r.ok) refresh();
  return r;
}

export async function lockReUnitAction(unitId: string, locked: boolean, reason: string): Promise<ReResult> {
  const user = await requireUser();
  const r = await lockReUnitCore(user, unitId, locked, reason);
  if (r.ok) refresh();
  return r;
}
