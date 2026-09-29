"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { setOrgAiControl, setPlatformAiEnabled, type AiControlResult } from "@/lib/ai-usage/control";

/**
 * ═══════════ SERVER ACTION: CÔNG TẮC AI + GHI ĐÈ HẠN MỨC AI (docs/platform/ai-usage.md §4) ═══════════
 *
 * Vỏ của Next: đọc phiên (`requirePermission`) → lõi `lib/ai-usage/control.ts` (kiểm LẠI người vận hành nền tảng, lý do,
 * nhật ký nền tảng) → `revalidatePath`. Không tin cờ nào từ client.
 */

export async function setPlatformAiEnabledAction(input: { enabled: boolean; reason: string }): Promise<AiControlResult> {
  const user = await requirePermission("platform:operate");
  const r = await setPlatformAiEnabled(user, input);
  if ("ok" in r) revalidatePath("/platform");
  return r;
}

export async function setOrgAiControlAction(input: { orgCode: string; disabled?: boolean; limits?: Record<string, string | number | null>; reason: string }): Promise<AiControlResult> {
  const user = await requirePermission("platform:operate");
  const r = await setOrgAiControl(user, input);
  if ("ok" in r) {
    revalidatePath("/platform");
    revalidatePath(`/platform/org/${input.orgCode}`);
  }
  return r;
}
