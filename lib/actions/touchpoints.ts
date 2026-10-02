"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { recordTouchpointCore, setReorderSettingCore, type TouchInput, type TouchResult } from "@/lib/records/touchpoints";

/** Vỏ Next của sổ liên hệ khách + cài đặt nhắc mua lại. Lõi (`lib/records/touchpoints.ts`) tự kiểm quyền. */

export async function recordTouchpointAction(customerId: string, input: TouchInput): Promise<TouchResult> {
  const user = await requireUser();
  const r = await recordTouchpointCore(user, customerId, input);
  if (r.ok) {
    revalidatePath("/customers/reorder");
    revalidatePath(`/customers/${customerId}`);
  }
  return r;
}

export async function setReorderSettingAction(input: { defaultCycleDays: number | null; dueSoonDays: number }): Promise<TouchResult> {
  const user = await requireUser();
  const r = await setReorderSettingCore(user, input);
  if (r.ok) revalidatePath("/customers/reorder");
  return r;
}
