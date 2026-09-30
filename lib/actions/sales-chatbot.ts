"use server";

import { revalidatePath } from "next/cache";
import { can, requireUser } from "@/lib/auth/session";
import type { ChatView } from "@/lib/sales-chatbot/config";
import { chatTurn, conversationView, openConversation } from "@/lib/sales-chatbot/engine";
import { saveSalesChatbotConfig, SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";

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
