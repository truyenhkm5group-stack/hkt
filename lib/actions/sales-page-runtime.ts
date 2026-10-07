"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { savePageRuntime } from "@/lib/sales-chatbot/page-runtime";

/** Vỏ Next của «Bot Chốt Đơn theo page» (lib/sales-chatbot/page-runtime.ts): phiên → lõi (module + ai_sales:manage + chỉ nhà). */
export async function savePageRuntimeAction(input: { pageId: string; mode: string; acknowledgeLegacyBot?: boolean }): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requireUser();
  const r = await savePageRuntime(user, input?.pageId, input?.mode, { acknowledgeLegacyBot: input?.acknowledgeLegacyBot === true });
  if ("ok" in r) revalidatePath("/ai/sales-chatbot");
  return r;
}
