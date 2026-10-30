"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import { createFollowupDraftCore, saveEmailSequenceSettingsCore, type FollowupResult } from "@/lib/wholesale/email-sequence-core";

/** Vỏ Next của chuỗi thư nhắc. Lõi (`lib/wholesale/email-sequence-core.ts`) tự kiểm quyền, phạm vi, «đến hạn», hàng rào. */

export async function createFollowupDraftAction(leadId: string, input: unknown): Promise<CoreResult<FollowupResult>> {
  const user = await requireUser();
  const r = await createFollowupDraftCore(user, leadId, input);
  if ("ok" in r) revalidatePath("/wholesale/outbox");
  return r;
}

export async function saveEmailSequenceSettingsAction(input: unknown): Promise<CoreResult> {
  const user = await requireUser();
  const r = await saveEmailSequenceSettingsCore(user, input);
  if ("ok" in r) revalidatePath("/wholesale/outbox");
  return r;
}
