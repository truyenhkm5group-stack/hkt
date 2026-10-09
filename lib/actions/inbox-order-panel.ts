"use server";

import { requireUser } from "@/lib/auth/session";
import { loadConversationOrderSummary } from "@/lib/sales-chatbot/order-summary";
import type { ConversationOrderSummary } from "@/lib/sales-chatbot/order-verification-shared";

/**
 * «Đơn đang chốt» của một hội thoại cho panel hộp thư (INBOX-V2-B). Panel CHỈ gọi khi nó đang hiện trên màn hình (cột phải ≥ 1280 px,
 * hoặc ngăn kéo «Khách · Đơn» trên điện thoại đã mở) — đóng ngăn kéo thì không tốn câu truy vấn nào. Chỉ ĐỌC; xác nhận đơn đi qua
 * `confirmOrderReviewAction` có sẵn.
 */
export async function inboxOrderSummaryAction(conversationId: string): Promise<{ ok: true; summary: ConversationOrderSummary | null } | { error: string }> {
  const user = await requireUser();
  const r = await loadConversationOrderSummary(user, conversationId);
  return r.ok ? { ok: true, summary: r.summary } : { error: r.error };
}
