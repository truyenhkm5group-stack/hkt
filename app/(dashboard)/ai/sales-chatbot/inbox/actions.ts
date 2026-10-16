"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { resyncThreadFromPancake } from "@/lib/sales-chatbot/history";

/**
 * «Bổ sung từ Pancake» cho MỘT hội thoại (P0-B #856): đọc tin của luồng từ Pancake (CHỈ GET), ghi tin thiếu + ảnh thiếu theo khoá
 * `message_id`. Không gửi gì cho khách, không gọi AI. Quyền + kiểm hội thoại / kết nối nằm ở lõi (`ai_sales:manage`).
 */
export async function resyncInboxThreadAction(conversationId: string): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requireUser();
  const r = await resyncThreadFromPancake(user, conversationId);
  if ("ok" in r) revalidatePath("/ai/sales-chatbot/inbox");
  return r;
}
