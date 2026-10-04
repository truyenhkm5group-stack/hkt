"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { saveModeConfig } from "@/lib/sales-chatbot/operating-mode";

/** Vỏ Next của «Chế độ vận hành» (lib/sales-chatbot/operating-mode.ts): phiên → lõi (kiểm module + ai_sales:manage). */
export async function saveModeAction(input: { mode: string; aiSharePct: number; restartExperiment: boolean }): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requireUser();
  const r = await saveModeConfig(user, { mode: input?.mode, aiSharePct: input?.aiSharePct, restartExperiment: input?.restartExperiment === true });
  if ("ok" in r) {
    revalidatePath("/ai/sales-chatbot");
    revalidatePath("/ai/sales-chatbot/copilot");
  }
  return r;
}
