"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { can, requireUser } from "@/lib/auth/session";
import type { ChatView } from "@/lib/sales-chatbot/config";
import { audit } from "@/lib/audit";
import { saveFollowupSettings } from "@/lib/sales-chatbot/followup-settings";
import { chatTurn, conversationView, openConversation, resumeConversationToAi } from "@/lib/sales-chatbot/engine";
import { bindOrganization } from "@/lib/platform/background";
import { recordConversationEvent } from "@/lib/sales-chatbot/events";
import { checkLearnNow, learnLessons, rollbackLessons, saveLessons, setLessonsEnabled } from "@/lib/sales-chatbot/lessons";
import { publishPlaybook, rollbackPlaybook, runPlaybookLearning, savePlaybookDraft, startPlaybookLearning, unpublishPlaybook } from "@/lib/sales-chatbot/playbook";
import { saveSalesChatbotConfig, SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { saveOrderSyncConfig } from "@/lib/sales-chatbot/order-sync";

/**
 * Server action của trang «Chatbot bán hàng» (0180): lưu cấu hình và KHUNG THỬ. Khung thử chạy trong tổ chức của PHIÊN
 * (không nhận mã tổ chức từ client), kênh `TEST` — công cụ ghi chỉ mô phỏng, không khách / đơn / tin nhóm thật.
 */

export async function saveSalesChatbotConfigAction(input: unknown): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requireUser();
  const r = await saveSalesChatbotConfig(user, input);
  if (!r.ok) return { error: r.error };
  revalidatePath("/ai/sales-chatbot");
  revalidatePath("/setup");
  return { ok: true, message: r.message };
}

export async function startTestChatAction(): Promise<{ ok: true; view: ChatView } | { error: string }> {
  const user = await requireUser();
  if (!can(user, SALES_CHATBOT_MANAGE)) return { error: "Bạn không có quyền chạy khung thử chatbot (ai_sales:manage)." };
  const conv = await openConversation("TEST", { createdBy: user.email });
  const view = await conversationView(conv.id);
  return view ? { ok: true, view } : { error: "Không mở được hội thoại thử." };
}

export async function sendTestChatAction(conversationId: string, text: string): Promise<{ ok: true; view: ChatView } | { error: string; view?: ChatView | null }> {
  const user = await requireUser();
  if (!can(user, SALES_CHATBOT_MANAGE)) return { error: "Bạn không có quyền chạy khung thử chatbot (ai_sales:manage)." };
  const r = await chatTurn(String(conversationId ?? ""), String(text ?? ""), { channel: "TEST", actorId: user.id });
  if (!r.ok) return { error: r.error, view: r.view ?? null };
  return { ok: true, view: r.view };
}

// ─── «Học từ hội thoại cũ» (lib/sales-chatbot/playbook.ts) — vỏ mỏng: phiên → lõi (kiểm module + quyền lần nữa) ───

type PlaybookResult = { ok: true; message: string } | { error: string };

/** Kiểm điều kiện + đánh dấu lượt chạy; việc nặng (đọc Pancake + AI) chạy SAU phản hồi trong đúng ngữ cảnh tổ chức. */
export async function startPlaybookLearningAction(input: unknown): Promise<PlaybookResult> {
  const user = await requireUser();
  const raw = (input && typeof input === "object" ? input : {}) as { conversations?: unknown; days?: unknown };
  const r = await startPlaybookLearning(user, raw);
  if ("error" in r) return r;
  after(await bindOrganization(async () => void (await runPlaybookLearning({ target: r.target, days: r.days }, { id: user.id, email: user.email }))));
  revalidatePath("/ai/sales-chatbot");
  return { ok: true, message: `Đang học từ tối đa ${r.target} hội thoại trong ${r.days} ngày — vài phút; bấm «Làm mới» để xem.` };
}

export async function savePlaybookDraftAction(text: unknown): Promise<PlaybookResult> {
  const user = await requireUser();
  const r = await savePlaybookDraft(user, text);
  if ("ok" in r) revalidatePath("/ai/sales-chatbot");
  return r;
}

export async function publishPlaybookAction(): Promise<PlaybookResult> {
  const user = await requireUser();
  const r = await publishPlaybook(user);
  if ("ok" in r) revalidatePath("/ai/sales-chatbot");
  return r;
}

export async function rollbackPlaybookAction(version: unknown): Promise<PlaybookResult> {
  const user = await requireUser();
  const r = await rollbackPlaybook(user, version);
  if ("ok" in r) revalidatePath("/ai/sales-chatbot");
  return r;
}

export async function unpublishPlaybookAction(): Promise<PlaybookResult> {
  const user = await requireUser();
  const r = await unpublishPlaybook(user);
  if ("ok" in r) revalidatePath("/ai/sales-chatbot");
  return r;
}

// ─── «Bot tự học» (lib/sales-chatbot/lessons.ts) ───

export async function setLessonsEnabledAction(enabled: boolean): Promise<PlaybookResult> {
  const user = await requireUser();
  const r = await setLessonsEnabled(user, Boolean(enabled));
  if ("ok" in r) revalidatePath("/ai/sales-chatbot");
  return r;
}

export async function saveLessonsAction(lessons: unknown): Promise<PlaybookResult> {
  const user = await requireUser();
  const r = await saveLessons(user, lessons);
  if ("ok" in r) revalidatePath("/ai/sales-chatbot");
  return r;
}

export async function rollbackLessonsAction(): Promise<PlaybookResult> {
  const user = await requireUser();
  const r = await rollbackLessons(user);
  if ("ok" in r) revalidatePath("/ai/sales-chatbot");
  return r;
}

/** «Học ngay»: kiểm quyền rồi học SAU phản hồi, trong đúng ngữ cảnh tổ chức. */
export async function learnLessonsNowAction(): Promise<PlaybookResult> {
  const user = await requireUser();
  const r = await checkLearnNow(user);
  if ("error" in r) return r;
  after(await bindOrganization(async () => void (await learnLessons({ force: true, actor: { id: user.id, name: user.email } }))));
  return r;
}

/** «Trả lại cho AI» — người đã xử lý xong hội thoại CẦN NGƯỜI XỬ LÝ; tin khách kế tiếp bot trả lời lại. */
export async function resumeConversationAction(id: string): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requireUser();
  if (!can(user, SALES_CHATBOT_MANAGE)) return { error: "Bạn không có quyền điều khiển chatbot bán hàng (ai_sales:manage)." };
  const done = await resumeConversationToAi(String(id ?? ""));
  if (!done) return { error: "Hội thoại không ở trạng thái cần người xử lý." };
  const at = new Date();
  await recordConversationEvent(String(id), { type: "ai.resumed", actorKind: "HUMAN", actorUserId: user.id, occurredAt: at, key: `resume:${at.toISOString()}` });
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_CHAT_RESUME_AI", entity: "SALES_CHAT_CONVERSATION", entityId: String(id), reason: "Người xử lý xong — trả hội thoại lại cho AI" });
  revalidatePath("/ai/sales-chatbot");
  return { ok: true, message: "Đã trả hội thoại lại cho AI" };
}

/** Follow-up tự động (0185): bật / tắt + lịch (phút). */
export async function saveFollowupSettingsAction(input: { enabled: boolean; stepsMinutes: number[] }): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requireUser();
  const r = await saveFollowupSettings(user, { enabled: input?.enabled, stepsMinutes: input?.stepsMinutes });
  if ("error" in r) return r;
  revalidatePath("/ai/sales-chatbot");
  return { ok: true, message: "Đã lưu follow-up tự động" };
}

/** Ghi đơn từ hội thoại fanpage — công tắc RIÊNG, độc lập với bật / tắt bot. */
export async function saveOrderSyncAction(enabled: boolean): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requireUser();
  const r = await saveOrderSyncConfig(user, enabled === true);
  if ("error" in r) return r;
  revalidatePath("/ai/sales-chatbot");
  return r;
}
