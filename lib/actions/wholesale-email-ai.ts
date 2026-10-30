"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import { aiDraftEmailCore, discardAiDraftCore, promoteAiDraftCore, saveEmailAiSettingsCore, type DraftResult } from "@/lib/wholesale/email-ai-draft";

/** Vỏ Next của «AI soạn email». Lõi (`lib/wholesale/email-ai-draft.ts`) tự kiểm quyền, phạm vi, trần / ngày, hàng rào bịa đặt. */

function refresh(leadId?: string) {
  revalidatePath("/wholesale/outbox");
  if (leadId) revalidatePath(`/wholesale/leads/${leadId}`);
}

export async function aiDraftEmailAction(leadId: string): Promise<CoreResult<DraftResult>> {
  const user = await requireUser();
  const r = await aiDraftEmailCore(user, leadId);
  if ("ok" in r) refresh(leadId);
  return r;
}

export async function promoteAiDraftAction(id: string, input: unknown): Promise<CoreResult<{ outboxId: string; editRatio: number }>> {
  const user = await requireUser();
  const r = await promoteAiDraftCore(user, id, input);
  if ("ok" in r) refresh();
  return r;
}

export async function discardAiDraftAction(id: string, reason: string): Promise<CoreResult> {
  const user = await requireUser();
  const r = await discardAiDraftCore(user, id, reason);
  if ("ok" in r) refresh();
  return r;
}

export async function saveEmailAiSettingsAction(input: unknown): Promise<CoreResult> {
  const user = await requireUser();
  const r = await saveEmailAiSettingsCore(user, input);
  if ("ok" in r) refresh();
  return r;
}
