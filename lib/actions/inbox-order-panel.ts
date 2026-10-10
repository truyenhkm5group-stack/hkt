"use server";

import { requireUser } from "@/lib/auth/session";
import { loadConversationOrderSummary } from "@/lib/sales-chatbot/order-summary";
import type { ConversationCancelledOrder, ConversationOrderSummary } from "@/lib/sales-chatbot/order-verification-shared";

/**
 * «Đơn đang chốt» của một hội thoại cho panel hộp thư (INBOX-V2-B). Panel CHỈ gọi khi nó đang hiện trên màn hình (cột phải ≥ 1280 px,
 * hoặc ngăn kéo «Khách · Đơn» trên điện thoại đã mở) — đóng ngăn kéo thì không tốn câu truy vấn nào. Chỉ ĐỌC; xác nhận đơn đi qua
 * `confirmOrderReviewAction` có sẵn.
 */
export async function inboxOrderSummaryAction(conversationId: string): Promise<{ ok: true; summary: ConversationOrderSummary | null; cancelled: ConversationCancelledOrder | null } | { error: string }> {
  const user = await requireUser();
  const r = await loadConversationOrderSummary(user, conversationId);
  // `cancelled` (10/10/2026): đơn ĐÃ HUỶ gần nhất khi không còn đơn đang mở — khung đơn in dòng «ĐÃ HUỶ» (phần vẽ ở thư mục inbox).
  return r.ok ? { ok: true, summary: r.summary, cancelled: r.cancelled ?? null } : { error: r.error };
}
