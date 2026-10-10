import { useSyncExternalStore } from "react";
import { mergeReadConfirmation, type InboxReadConfirmation } from "@/lib/sales-chatbot/inbox-read-shared";

/**
 * BỘ NHỚ XÁC NHẬN ĐỌC của trang hộp thư (trình duyệt) — một chỗ cho ba nơi vẽ: danh sách (vá hàng · thành viên thẻ), thẻ «Tin khách
 * chưa đọc» (bộ đếm) và âm báo. Khung chat ghi vào đây khi máy chủ xác nhận một lượt đọc (`POST /api/ai-sales/inbox-read`). Chỉ
 * sống trong phiên trang: tải lại trang thì bản máy chủ đã mới hơn mọi lượt đọc cũ, không còn gì để vá. Máy chủ KHÔNG bao giờ ghi vào
 * đây (ảnh chụp phía máy chủ luôn rỗng) — dữ liệu của người này không lọt sang lượt dựng của người khác.
 */

type Reads = ReadonlyMap<string, InboxReadConfirmation>;
const EMPTY: Reads = new Map();
let snapshot: Reads = EMPTY;
const listeners = new Set<() => void>();

export function recordInboxRead(c: InboxReadConfirmation): void {
  const next = new Map(snapshot);
  next.set(c.conversationId, mergeReadConfirmation(snapshot.get(c.conversationId), c));
  snapshot = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Xác nhận đọc đã nhận trong phiên trang này (theo mã hội thoại). */
export function useInboxReads(): Reads {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY,
  );
}
