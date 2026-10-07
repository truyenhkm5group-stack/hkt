"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { operateOrgAiConnection, saveOrgChatbotEngine } from "@/lib/saas/operator-ai";

/**
 * Vỏ mỏng cho khối «AI của workspace» (`/platform/org/<mã>`): phiên → lõi ở `lib/saas/operator-ai.ts` (kiểm người vận hành,
 * lý do, ngữ cảnh tổ chức đích, hai nhật ký) → làm mới trang. Mã tổ chức đến từ form nhưng lõi kiểm lại nó và quyền.
 */
const pathOf = (input: unknown) => {
  const code = input && typeof input === "object" && typeof (input as { orgCode?: unknown }).orgCode === "string" ? (input as { orgCode: string }).orgCode : "";
  return `/platform/org/${encodeURIComponent(code)}`;
};

export async function saveOrgChatbotEngineAction(input: unknown): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requirePermission("platform:operate");
  const r = await saveOrgChatbotEngine(user, input);
  if ("ok" in r) revalidatePath(pathOf(input));
  return r;
}

export async function operateOrgAiConnectionAction(input: unknown): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requirePermission("platform:operate");
  const r = await operateOrgAiConnection(user, input);
  if ("ok" in r) revalidatePath(pathOf(input));
  return r;
}
