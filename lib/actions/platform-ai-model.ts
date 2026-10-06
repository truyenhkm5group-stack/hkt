"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { probePlatformAiModelAsOperator, rollbackPlatformAiPolicy, setPlatformAiPolicy, type PlatformAiResult } from "@/lib/ai-usage/platform-ai-admin";

/**
 * ═══════════ SERVER ACTION — PLATFORM AI MODEL CONTROL (docs/platform/ai-model-control.md) ═══════════
 *
 * Vỏ của Next: phiên `platform:operate` → lõi `lib/ai-usage/platform-ai-admin.ts` (lõi hỏi lại người vận hành, kiểm lý do,
 * ghi nhật ký nền tảng) → `revalidatePath`. Tổ chức khách không có quyền này, nên không có đường nào đổi model của AI dùng
 * chung từ phía khách.
 */

export async function probePlatformAiModelAction(input: { model: string }): Promise<PlatformAiResult> {
  const user = await requirePermission("platform:operate");
  const r = await probePlatformAiModelAsOperator(user, input ?? {});
  if ("ok" in r) revalidatePath("/platform/saas");
  return r;
}

export async function setPlatformAiPolicyAction(input: { primaryModel: string; fallbackModel: string; canaryPct: number; reason: string }): Promise<PlatformAiResult> {
  const user = await requirePermission("platform:operate");
  const r = await setPlatformAiPolicy(user, input ?? {});
  if ("ok" in r) revalidatePath("/platform/saas");
  return r;
}

export async function rollbackPlatformAiPolicyAction(input: { reason: string }): Promise<PlatformAiResult> {
  const user = await requirePermission("platform:operate");
  const r = await rollbackPlatformAiPolicy(user, input ?? {});
  if ("ok" in r) revalidatePath("/platform/saas");
  return r;
}
