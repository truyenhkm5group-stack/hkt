import type { SessionUser } from "@/lib/auth/session";
import { formatVND } from "@/lib/format";
import { loadInboxThread } from "@/lib/sales-chatbot/inbox";
import type { InboxOrder, InboxThread } from "@/lib/sales-chatbot/inbox-shared";
import { customerFacing, customerInboxThread } from "@/lib/saas/visibility";

/**
 * NỘI DUNG MỘT HỘI THOẠI cho khung chat của hộp thư — MỘT đường cho cả hai lối mở: trang (`page.tsx`, mở bằng đường dẫn / tải lại)
 * và route GET `/api/ai-sales/inbox-thread` (bấm hội thoại khác trong danh sách — chỉ tải hội thoại, KHÔNG dựng lại danh sách).
 * Đo HSLC 10/10/2026 (ops inbox-perf-probe): chuyển hội thoại 450–930 ms phía máy chủ, trong đó `listInbox` chạy lại 350–800 ms
 * còn `loadInboxThread` chỉ 30–210 ms. Workspace KHÁCH: lý do AI không trả lời + dấu vết từng tin lọc ở MÁY CHỦ (visibility.ts),
 * nên lối nào cũng phải đi qua đây — một lối lọc, một lối không lọc là rò chữ nội bộ.
 */
export type InboxThreadPayload = { ok: true; thread: InboxThread; ordersSummary: (InboxOrder & { totalText: string })[] } | { ok: false; error: string };

export async function inboxThreadPayload(user: SessionUser, conversationId: string): Promise<InboxThreadPayload> {
  const loaded = await loadInboxThread(user, conversationId);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const thread = customerFacing(user.organization) ? customerInboxThread(loaded.thread) : loaded.thread;
  return { ok: true, thread, ordersSummary: thread.orders.map((o) => ({ ...o, totalText: formatVND(o.total) })) };
}
