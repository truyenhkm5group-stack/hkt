"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { closePackageCore, createAppointmentCore, createPackageCore, setAppointmentStatusCore, updateAppointmentCore, type AppointmentInput, type AppointmentResult, type PackageInput } from "@/lib/records/appointments";

/** Vỏ Next của lịch hẹn + liệu trình. Lõi (`lib/records/appointments.ts`) tự kiểm `appointments:write`. */

function refresh(customerId?: string) {
  revalidatePath("/appointments");
  if (customerId) revalidatePath(`/customers/${customerId}`);
}

export async function createAppointmentAction(input: AppointmentInput): Promise<AppointmentResult> {
  const user = await requireUser();
  const r = await createAppointmentCore(user, input);
  if (r.ok) refresh(input?.customerId);
  return r;
}

export async function updateAppointmentAction(id: string, input: AppointmentInput): Promise<AppointmentResult> {
  const user = await requireUser();
  const r = await updateAppointmentCore(user, id, input);
  if (r.ok) refresh(input?.customerId);
  return r;
}

export async function setAppointmentStatusAction(id: string, input: { status: string; reason?: string }, customerId?: string): Promise<AppointmentResult> {
  const user = await requireUser();
  const r = await setAppointmentStatusCore(user, id, input);
  if (r.ok) refresh(customerId);
  return r;
}

export async function createPackageAction(customerId: string, input: PackageInput): Promise<AppointmentResult> {
  const user = await requireUser();
  const r = await createPackageCore(user, customerId, input);
  if (r.ok) refresh(customerId);
  return r;
}

export async function closePackageAction(id: string, reason: string, customerId: string): Promise<AppointmentResult> {
  const user = await requireUser();
  const r = await closePackageCore(user, id, reason);
  if (r.ok) refresh(customerId);
  return r;
}
