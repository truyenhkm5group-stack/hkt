"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { saveOrderNotificationPreset, sendTestNotification } from "@/lib/messaging/presets";

/**
 * Server action của «Thông báo nhóm» (0180) — mỏng: phiên → lõi `lib/messaging/presets.ts` (quyền `workflow:manage`, zod,
 * lưu luật qua dịch vụ luật) → `revalidatePath`. Lỗi nghiệp vụ trả `{ error }`.
 */

export async function saveNotificationPresetAction(input: unknown): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requireUser();
  const r = await saveOrderNotificationPreset(user, input);
  if (!r.ok) return { error: r.error };
  revalidatePath("/settings/notifications");
  revalidatePath("/settings/workflows");
  revalidatePath("/setup");
  return { ok: true, message: r.message };
}

export async function sendTestNotificationAction(input: unknown): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requireUser();
  const r = await sendTestNotification(user, input);
  if (!r.ok) return { error: r.error };
  revalidatePath("/settings/notifications");
  return { ok: true, message: r.message };
}
