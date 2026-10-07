"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { adjustAiBalance, aiTopupStatus, createAiTopupIntent, reverseAiUsageCharge, setLowBalanceThreshold, type TopupResult, type TopupStatusResult } from "@/lib/billing/ai-balance";
import { setAiBalanceEnabled, type KillSwitchResult } from "@/lib/platform/kill-switches";

/**
 * ═══════════ SERVER ACTION SỐ DƯ AI (docs/saas/AI_BALANCE_V1.md) ═══════════
 *
 * Vỏ của Next: đọc phiên → lõi ở `lib/billing/ai-balance.ts` (lõi kiểm lại quyền, cờ, tổ chức) → `revalidatePath`.
 *  · KHÁCH (`settings:manage`, /settings/ai-balance): tạo phiếu nạp, hỏi trạng thái, đặt ngưỡng báo số dư thấp. Mã tổ chức
 *    lấy từ PHIÊN, không từ trình duyệt — một shop không tạo / đọc được phiếu của shop khác.
 *  · NGƯỜI VẬN HÀNH (`platform:operate`, /platform/ai-balance): tặng / điều chỉnh / hoàn, bật / tắt từng tổ chức.
 */

export async function createAiTopupAction(input: { amountVnd: unknown }): Promise<TopupResult> {
  const user = await requirePermission("settings:manage");
  return createAiTopupIntent(user, { amountVnd: input?.amountVnd });
}

export async function aiTopupStatusAction(input: { intentId: unknown }): Promise<TopupStatusResult> {
  const user = await requirePermission("settings:manage");
  const r = await aiTopupStatus(user, input?.intentId);
  if ("ok" in r && r.status === "PAID") revalidatePath("/settings/ai-balance");
  return r;
}

export async function setLowBalanceAction(input: { amountVnd: unknown }): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requirePermission("settings:manage");
  const r = await setLowBalanceThreshold(user, { amountVnd: input?.amountVnd });
  if ("ok" in r) revalidatePath("/settings/ai-balance");
  return r;
}

export async function adjustAiBalanceAction(input: { orgCode: unknown; kind: unknown; amountVnd: unknown; reason: unknown; requestKey: unknown }): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requirePermission("platform:operate");
  const r = await adjustAiBalance(user, input ?? {});
  if ("ok" in r) revalidatePath("/platform/ai-balance");
  return r;
}

export async function reverseAiUsageChargeAction(input: { orgCode: unknown; chargeId: unknown; reason: unknown }): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requirePermission("platform:operate");
  const r = await reverseAiUsageCharge(user, input ?? {});
  if ("ok" in r) revalidatePath("/platform/ai-balance");
  return r;
}

export async function setAiBalanceEnabledAction(input: { orgCode: unknown; enabled: unknown; reason: unknown }): Promise<KillSwitchResult> {
  const user = await requirePermission("platform:operate");
  const r = await setAiBalanceEnabled(user, input ?? {});
  if ("ok" in r) revalidatePath("/platform/ai-balance");
  return r;
}
