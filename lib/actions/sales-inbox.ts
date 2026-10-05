"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { assignConversationCore, claimConversationCore, handBackToAiCore, releaseConversationCore, sendStaffReplyCore, suggestReplyCore } from "@/lib/sales-chatbot/inbox";

/**
 * ═══════════ SERVER ACTION: HỘP THƯ NGƯỜI (M8) ═══════════
 *
 * Mỏng: phiên → lõi `lib/sales-chatbot/inbox.ts` (quyền ai_sales:view + outreach:send, khung gửi của kênh, chống gửi đôi,
 * quy kết theo khoá tài khoản, bot nhường, sổ sự kiện) → `revalidatePath`. Lỗi nghiệp vụ trả `{ error }`, không ném.
 */

const PATH = "/ai/sales-chatbot/inbox";
type Out<T extends object = object> = ({ ok: true } & T) | { error: string };

function done<T extends object>(r: ({ ok: true } & T) | { ok: false; error: string }): Out<T> {
  if (!r.ok) return { error: r.error };
  revalidatePath(PATH);
  return r;
}

export async function sendStaffReplyAction(conversationId: string, input: { text: string; requestKey: string; confirmPaid?: boolean }): Promise<Out<{ messageId: string; reused: boolean }>> {
  const user = await requireUser();
  return done(await sendStaffReplyCore(user, conversationId, input));
}

export async function claimConversationAction(conversationId: string): Promise<Out> {
  const user = await requireUser();
  return done(await claimConversationCore(user, conversationId));
}

export async function releaseConversationAction(conversationId: string): Promise<Out> {
  const user = await requireUser();
  return done(await releaseConversationCore(user, conversationId));
}

export async function assignConversationAction(conversationId: string, assigneeUserId: string): Promise<Out> {
  const user = await requireUser();
  return done(await assignConversationCore(user, conversationId, assigneeUserId));
}

export async function handBackToAiAction(conversationId: string): Promise<Out> {
  const user = await requireUser();
  const r = done(await handBackToAiCore(user, conversationId));
  if ("ok" in r) revalidatePath("/ai/sales-chatbot");
  return r;
}

export async function suggestReplyAction(conversationId: string): Promise<Out<{ suggestion: string }>> {
  const user = await requireUser();
  const r = await suggestReplyCore(user, conversationId);
  return r.ok ? r : { error: r.error };
}
