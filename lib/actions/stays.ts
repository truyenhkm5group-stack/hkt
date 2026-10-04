"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import {
  cancelStayBookingCore,
  createStayBookingCore,
  createStayUnitCore,
  importStayIcsCore,
  markStayTurnoverCore,
  rotateStayIcalTokenCore,
  updateStayBookingDetailsCore,
  updateStayUnitCore,
  type StayBookingInput,
  type StayImportResult,
  type StaysResult,
  type StayUnitInput,
} from "@/lib/records/stays";

/** Vỏ Next của lưu trú. Lõi (`lib/records/stays.ts`) tự kiểm `stays:write`. */

function refresh() {
  revalidatePath("/stays");
}

export async function createStayUnitAction(input: StayUnitInput): Promise<StaysResult> {
  const user = await requireUser();
  const r = await createStayUnitCore(user, input);
  if (r.ok) refresh();
  return r;
}

export async function updateStayUnitAction(id: string, input: StayUnitInput): Promise<StaysResult> {
  const user = await requireUser();
  const r = await updateStayUnitCore(user, id, input);
  if (r.ok) refresh();
  return r;
}

export async function rotateStayIcalTokenAction(id: string): Promise<StaysResult> {
  const user = await requireUser();
  const r = await rotateStayIcalTokenCore(user, id);
  if (r.ok) refresh();
  return r;
}

export async function createStayBookingAction(input: StayBookingInput): Promise<StaysResult> {
  const user = await requireUser();
  const r = await createStayBookingCore(user, input);
  if (r.ok) refresh();
  return r;
}

export async function updateStayBookingDetailsAction(id: string, input: { guestName: string; guestPhone: string; guests: number | null; amountVnd: number | null; note: string }): Promise<StaysResult> {
  const user = await requireUser();
  const r = await updateStayBookingDetailsCore(user, id, input);
  if (r.ok) refresh();
  return r;
}

export async function cancelStayBookingAction(id: string, reason: string): Promise<StaysResult> {
  const user = await requireUser();
  const r = await cancelStayBookingCore(user, id, reason);
  if (r.ok) refresh();
  return r;
}

export async function importStayIcsAction(input: { unitId: string; channel: string; text: string; apply: boolean }): Promise<StayImportResult> {
  const user = await requireUser();
  const r = await importStayIcsCore(user, input);
  if (r.ok && r.applied) refresh();
  return r;
}

export async function markStayTurnoverAction(unitId: string, day: string, done: boolean): Promise<StaysResult> {
  const user = await requireUser();
  const r = await markStayTurnoverCore(user, unitId, day, done);
  if (r.ok) refresh();
  return r;
}
